import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { applyToFile } from "../fs/applyToFile.ts";
import type { ApplyInput } from "../fs/applyToFile.ts";
import { revertToFile } from "../fs/revertToFile.ts";
import type { RevertInput } from "../fs/revertToFile.ts";
import { applyCssProperty } from "../fs/applyCssProperty.ts";
import type { ApplyCssPropertyInput } from "../fs/applyCssProperty.ts";
import { applyStyledProperty } from "../fs/applyStyledProperty.ts";
import type { ApplyStyledPropertyInput } from "../fs/applyStyledProperty.ts";
import { RecentApplies } from "../state/recentApplies.ts";
import { CurrentSelection } from "../state/selection.ts";
import type { Selection } from "../state/selection.ts";
import { SessionToken, parseBearer } from "../state/auth.ts";

export type ServerOptions = {
  /** Absolute path inside which all /apply and /propose writes are constrained. */
  workspaceRoot: string;
  /** Optional pre-built buffer (tests inject their own). */
  recentApplies?: RecentApplies;
  /** Optional pre-built selection state (tests inject their own). */
  currentSelection?: CurrentSelection;
  /** Optional pre-loaded session token (tests inject their own). */
  sessionToken?: SessionToken;
  /**
   * Pinned allowed origins. Empty means any origin (compat with v0.1).
   * Production: pass the dev URL, e.g. `["http://localhost:3000"]`.
   */
  allowedOrigins?: readonly string[];
};

export type ServerContext = {
  options: ServerOptions;
  recentApplies: RecentApplies;
  currentSelection: CurrentSelection;
  sessionToken: SessionToken;
};

/**
 * Build (but do not start) the local HTTP server. Callers do `.listen(port)`.
 * Tests pass `port: 0` to get a random port; the CLI binds 7790.
 */
export function createServer(options: ServerOptions): http.Server {
  const ctx: ServerContext = {
    options,
    recentApplies: options.recentApplies ?? new RecentApplies(),
    currentSelection: options.currentSelection ?? new CurrentSelection(),
    sessionToken: options.sessionToken ?? new SessionToken(),
  };
  return http.createServer((req, res) => {
    void handle(req, res, ctx).catch((err) => {
      writeJson(res, 500, {
        ok: false,
        reason: "internal-error",
        details: (err as Error).message,
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  // CORS — accept any localhost origin so the overlay (running on whatever
  // port `next dev` chose) can call us. v0.1 will tighten this to the
  // active dev URL once we have the per-session token in place.
  const origin = req.headers.origin;
  const allowed = ctx.options.allowedOrigins ?? [];
  const originAllowed = allowed.length === 0 || (origin && allowed.includes(origin));

  // CORS — when an allowlist is configured, only echo the actual origin if
  // it matches. With no allowlist (v0.1 behavior), echo `*` for the spike.
  if (allowed.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (originAllowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? "/";

  // /health is always open — it's a sanity ping with no surface to abuse.
  if (req.method === "GET" && url === "/health") {
    writeJson(res, 200, { ok: true });
    return;
  }

  // Origin check applies to /token too. The bootstrap is the most-attacked
  // endpoint — refusing wrong-origin requests is what closes the hole the
  // spike left open.
  if (!originAllowed) {
    writeJson(res, 403, {
      ok: false,
      reason: "origin-not-allowed",
      details: `Origin ${origin ?? "(missing)"} is not in the allowlist`,
    });
    return;
  }

  if (req.method === "GET" && url === "/token") {
    writeJson(res, 200, { token: ctx.sessionToken.get() });
    return;
  }

  // Everything below requires the bearer token.
  const bearer = parseBearer(req.headers.authorization);
  if (!ctx.sessionToken.matches(bearer)) {
    writeJson(res, 401, {
      ok: false,
      reason: "unauthorized",
      details:
        "Include `Authorization: Bearer <token>` (fetch the token from GET /token).",
    });
    return;
  }

  if (req.method === "GET" && url === "/recent") {
    // Diagnostic / introspection — the overlay can show a history list later.
    writeJson(res, 200, { ok: true, applies: ctx.recentApplies.list() });
    return;
  }

  if (req.method === "GET" && url === "/assets") {
    await dispatchAssets(res, ctx);
    return;
  }

  if (req.method === "POST" && url === "/apply") {
    await dispatchMutation(req, res, ctx, false);
    return;
  }

  if (req.method === "POST" && url === "/propose") {
    await dispatchMutation(req, res, ctx, true);
    return;
  }

  if (req.method === "POST" && url === "/revert") {
    await dispatchRevert(req, res, ctx);
    return;
  }

  if (req.method === "POST" && url === "/apply-css-prop") {
    await dispatchCssProperty(req, res, ctx);
    return;
  }

  if (req.method === "POST" && url === "/apply-styled-prop") {
    await dispatchStyledProperty(req, res, ctx);
    return;
  }

  if (req.method === "GET" && url === "/selection") {
    writeJson(res, 200, {
      ok: true,
      selection: ctx.currentSelection.get(),
    });
    return;
  }

  if (req.method === "POST" && url === "/selection") {
    await dispatchSelection(req, res, ctx);
    return;
  }

  if (req.method === "DELETE" && url === "/selection") {
    ctx.currentSelection.clear();
    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, {
    ok: false,
    reason: "not-found",
    details: `No route for ${req.method} ${url}`,
  });
}

async function dispatchMutation(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
  dryRun: boolean,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, {
      ok: false,
      reason: "invalid-json",
      details: (err as Error).message,
    });
    return;
  }

  const outcome = await applyToFile(body as ApplyInput, {
    workspaceRoot: ctx.options.workspaceRoot,
    dryRun,
  });

  if (outcome.ok) {
    // Record only real applies — /propose is dryRun and shouldn't show up
    // in the revert history.
    if (!dryRun) {
      const input = body as ApplyInput;
      // Persist the actual previous value so undo can swap back even
      // when the client originally sent before=null (asset picker UX).
      const beforeForBuffer = outcome.previousValue ?? input.before ?? "";
      ctx.recentApplies.push({
        file: input.file,
        line: input.line,
        col: input.col,
        before: beforeForBuffer,
        after: input.after,
        appliedAt: Date.now(),
      });
    }
    writeJson(res, 200, { ok: true, diff: outcome.diff });
    return;
  }

  writeJson(res, outcome.status, {
    ok: false,
    reason: outcome.reason,
    details: outcome.details,
  });
}

async function dispatchRevert(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, {
      ok: false,
      reason: "invalid-json",
      details: (err as Error).message,
    });
    return;
  }

  const outcome = await revertToFile(
    body as RevertInput,
    { workspaceRoot: ctx.options.workspaceRoot, dryRun: false },
    ctx.recentApplies,
  );

  if (outcome.ok) {
    writeJson(res, 200, { ok: true, diff: outcome.diff });
    return;
  }

  writeJson(res, outcome.status, {
    ok: false,
    reason: outcome.reason,
    details: outcome.details,
  });
}

async function dispatchCssProperty(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, {
      ok: false,
      reason: "invalid-json",
      details: (err as Error).message,
    });
    return;
  }
  const outcome = await applyCssProperty(body as ApplyCssPropertyInput, {
    workspaceRoot: ctx.options.workspaceRoot,
    dryRun: false,
  });
  if (outcome.ok) {
    writeJson(res, 200, {
      ok: true,
      diff: outcome.diff,
      selector: outcome.selector,
      previousValue: outcome.previousValue,
    });
    return;
  }
  writeJson(res, outcome.status, {
    ok: false,
    reason: outcome.reason,
    details: outcome.details,
  });
}

async function dispatchStyledProperty(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, {
      ok: false,
      reason: "invalid-json",
      details: (err as Error).message,
    });
    return;
  }
  const outcome = await applyStyledProperty(body as ApplyStyledPropertyInput, {
    workspaceRoot: ctx.options.workspaceRoot,
    dryRun: false,
  });
  if (outcome.ok) {
    writeJson(res, 200, {
      ok: true,
      diff: outcome.diff,
      componentName: outcome.componentName,
      previousValue: outcome.previousValue,
    });
    return;
  }
  writeJson(res, outcome.status, {
    ok: false,
    reason: outcome.reason,
    details: outcome.details,
  });
}

async function dispatchAssets(
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const IMAGE_EXTS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".webp",
    ".avif",
  ]);
  const publicDir = path.join(ctx.options.workspaceRoot, "public");

  async function walk(dir: string, rel: string): Promise<string[]> {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      const child = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const sub = await walk(child, childRel);
        out.push(...sub);
      } else if (
        e.isFile() &&
        IMAGE_EXTS.has(path.extname(e.name).toLowerCase())
      ) {
        // public/foo.png is referenced as "/foo.png" in src attributes.
        out.push(`/${childRel}`);
      }
    }
    return out;
  }

  try {
    const assets = await walk(publicDir, "");
    assets.sort();
    writeJson(res, 200, { ok: true, assets });
  } catch (err) {
    writeJson(res, 500, {
      ok: false,
      reason: "assets-list-failed",
      details: (err as Error).message,
    });
  }
}

async function dispatchSelection(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    writeJson(res, 400, {
      ok: false,
      reason: "invalid-json",
      details: (err as Error).message,
    });
    return;
  }
  if (!isValidSelection(body)) {
    writeJson(res, 400, {
      ok: false,
      reason: "invalid-input",
      details:
        "Body must be { file, line, col, oid, className, tagName, componentName?, instanceCount }",
    });
    return;
  }
  ctx.currentSelection.set(body);
  writeJson(res, 200, { ok: true });
}

function isValidSelection(x: unknown): x is Selection {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.file === "string" &&
    typeof o.line === "number" &&
    typeof o.col === "number" &&
    typeof o.oid === "string" &&
    typeof o.className === "string" &&
    typeof o.tagName === "string" &&
    (o.componentName === null || typeof o.componentName === "string") &&
    typeof o.instanceCount === "number"
  );
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    // Guard: refuse pathologically large bodies. JSX className mutations
    // are small payloads — anything over 1 MB is suspicious.
    if (chunks.reduce((n, c) => n + c.length, 0) > 1024 * 1024) {
      throw new Error("Request body exceeds 1 MB");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
