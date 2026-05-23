/**
 * Web Request handler for visual-edit, mounted as a Next.js catchall
 * Route Handler. Users add ONE file:
 *
 *   app/api/visual-edit/[...path]/route.ts
 *   ──────────────────────────────────────
 *   export { GET, POST, DELETE } from "@aaqiljamal/visual-edit-next/route";
 *
 * The AST mutation logic runs in-process with the user's Next dev server.
 * No separate port, no separate process, no CORS dance, no bearer token.
 *
 * In production we 404 every request: visual-edit is dev-only by design.
 */
import * as path from "node:path";
import {
  applyToFile,
  type ApplyInput,
  revertToFile,
  type RevertInput,
  applyCssProperty,
  type ApplyCssPropertyInput,
  applyStyledProperty,
  type ApplyStyledPropertyInput,
  RecentApplies,
  CurrentSelection,
  type Selection,
} from "@aaqiljamal/visual-edit-server";

// Module-level state. Survives across Route Handler invocations within
// the same Next dev server process. RecentApplies persists to disk, so
// HMR/full restarts don't lose history.
const recentApplies = new RecentApplies();
const currentSelection = new CurrentSelection();
let stateLoaded = false;

async function ensureStateLoaded(): Promise<string> {
  const workspaceRoot = process.cwd();
  if (!stateLoaded) {
    await recentApplies.load(
      path.join(workspaceRoot, ".visual-edit", "history.json"),
    );
    stateLoaded = true;
  }
  return workspaceRoot;
}

function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

function devOnlyOrJson(): Response | null {
  if (!isDev()) {
    return new Response("Not available in production", { status: 404 });
  }
  return null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function endpointFromPath(pathSegments: string[] | undefined): string {
  return "/" + (pathSegments ?? []).join("/");
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const dev = devOnlyOrJson();
  if (dev) return dev;
  const workspaceRoot = await ensureStateLoaded();
  const { path: parts } = await context.params;
  const endpoint = endpointFromPath(parts);

  if (endpoint === "/health") {
    return json(200, { ok: true, mode: "next-route-handler" });
  }
  if (endpoint === "/token") {
    // Route Handler is same-origin — no bearer token needed. We respond
    // 200 with null so the overlay's bootstrap doesn't log a 404.
    return json(200, { token: null });
  }
  if (endpoint === "/selection") {
    return json(200, { ok: true, selection: currentSelection.get() });
  }
  if (endpoint === "/recent") {
    return json(200, { ok: true, applies: recentApplies.list() });
  }
  if (endpoint === "/assets") {
    return await handleAssets(workspaceRoot);
  }
  return json(404, {
    ok: false,
    reason: "not-found",
    details: `GET ${endpoint}`,
  });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(
  req: Request,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const dev = devOnlyOrJson();
  if (dev) return dev;
  const workspaceRoot = await ensureStateLoaded();
  const { path: parts } = await context.params;
  const endpoint = endpointFromPath(parts);

  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return json(400, {
      ok: false,
      reason: "invalid-json",
      details: (err as Error).message,
    });
  }

  if (endpoint === "/apply") {
    return await handleMutation(body as ApplyInput, workspaceRoot, false);
  }
  if (endpoint === "/propose") {
    return await handleMutation(body as ApplyInput, workspaceRoot, true);
  }
  if (endpoint === "/revert") {
    const outcome = await revertToFile(
      body as RevertInput,
      { workspaceRoot, dryRun: false },
      recentApplies,
    );
    if (outcome.ok) return json(200, { ok: true, diff: outcome.diff });
    return json(outcome.status, {
      ok: false,
      reason: outcome.reason,
      details: outcome.details,
    });
  }
  if (endpoint === "/apply-css-prop") {
    const outcome = await applyCssProperty(body as ApplyCssPropertyInput, {
      workspaceRoot,
      dryRun: false,
    });
    if (outcome.ok) {
      return json(200, {
        ok: true,
        diff: outcome.diff,
        selector: outcome.selector,
        previousValue: outcome.previousValue,
      });
    }
    return json(outcome.status, {
      ok: false,
      reason: outcome.reason,
      details: outcome.details,
    });
  }
  if (endpoint === "/apply-styled-prop") {
    const outcome = await applyStyledProperty(
      body as ApplyStyledPropertyInput,
      { workspaceRoot, dryRun: false },
    );
    if (outcome.ok) {
      return json(200, {
        ok: true,
        diff: outcome.diff,
        componentName: outcome.componentName,
        previousValue: outcome.previousValue,
      });
    }
    return json(outcome.status, {
      ok: false,
      reason: outcome.reason,
      details: outcome.details,
    });
  }
  if (endpoint === "/selection") {
    if (!isValidSelection(body)) {
      return json(400, {
        ok: false,
        reason: "invalid-input",
        details:
          "Body must be { file, line, col, oid, className, tagName, componentName, instanceCount }",
      });
    }
    currentSelection.set(body);
    return json(200, { ok: true });
  }

  return json(404, {
    ok: false,
    reason: "not-found",
    details: `POST ${endpoint}`,
  });
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function DELETE(
  req: Request,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const dev = devOnlyOrJson();
  if (dev) return dev;
  await ensureStateLoaded();
  const { path: parts } = await context.params;
  const endpoint = endpointFromPath(parts);

  if (endpoint === "/selection") {
    currentSelection.clear();
    return json(200, { ok: true });
  }
  return json(404, {
    ok: false,
    reason: "not-found",
    details: `DELETE ${endpoint}`,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function handleMutation(
  input: ApplyInput,
  workspaceRoot: string,
  dryRun: boolean,
): Promise<Response> {
  const outcome = await applyToFile(input, { workspaceRoot, dryRun });
  if (outcome.ok) {
    if (!dryRun) {
      const beforeForBuffer =
        outcome.previousValue ?? input.before ?? "";
      recentApplies.push({
        file: input.file,
        line: input.line,
        col: input.col,
        before: beforeForBuffer,
        after: input.after,
        appliedAt: Date.now(),
      });
    }
    return json(200, { ok: true, diff: outcome.diff });
  }
  return json(outcome.status, {
    ok: false,
    reason: outcome.reason,
    details: outcome.details,
  });
}

async function handleAssets(workspaceRoot: string): Promise<Response> {
  const fs = await import("node:fs/promises");
  const IMAGE_EXTS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".webp",
    ".avif",
  ]);
  const publicDir = path.join(workspaceRoot, "public");

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
        out.push(`/${childRel}`);
      }
    }
    return out;
  }

  try {
    const assets = await walk(publicDir, "");
    assets.sort();
    return json(200, { ok: true, assets });
  } catch (err) {
    return json(500, {
      ok: false,
      reason: "assets-list-failed",
      details: (err as Error).message,
    });
  }
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
