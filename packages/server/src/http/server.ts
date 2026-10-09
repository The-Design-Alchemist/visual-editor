import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createApiContext,
  handleApi,
  isTrustedBrowserRequest,
  formatSse,
  type ApiContext,
} from "../api/core.ts";
import type { RecentApplies } from "../state/recentApplies.ts";
import type { CurrentSelection } from "../state/selection.ts";
import type { PinStore } from "../api/pins.ts";
import type { EventHub } from "../api/events.ts";
import { SessionToken, parseBearer } from "../state/auth.ts";

export type ServerOptions = {
  /** Absolute path inside which all writes are constrained. */
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
  pins?: PinStore;
  events?: EventHub;
  /** Persist history/pins under <root>/.visual-editor. Default: only when nothing was injected. */
  persist?: boolean;
};

export type NodeHandlerOptions = {
  ctx: ApiContext;
  /**
   * "token": bearer token required on everything but /health and /token —
   *   the standalone, cross-origin server.
   * "same-origin": trust same-origin browser requests (Sec-Fetch-Site /
   *   Origin vs Host) — dev-server middleware (Vite) where the overlay is
   *   served from the same origin.
   */
  auth: "token" | "same-origin";
  sessionToken?: SessionToken;
  allowedOrigins?: readonly string[];
  /** Mount prefix to strip from req.url (e.g. "/api/visual-editor"). */
  basePath?: string;
};

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const MAX_BODY = 1024 * 1024;

/**
 * Build (but do not start) the local HTTP server. Callers do `.listen(port)`.
 * Tests pass `port: 0` to get a random port; the CLI binds 7790.
 */
export function createServer(options: ServerOptions): http.Server {
  const sessionToken = options.sessionToken ?? new SessionToken();
  const ctx = createApiContext({
    workspaceRoot: options.workspaceRoot,
    mode: "standalone",
    recentApplies: options.recentApplies,
    currentSelection: options.currentSelection,
    pins: options.pins,
    events: options.events,
    persist: options.persist ?? false,
  });
  const handler = createNodeHandler({
    ctx,
    auth: "token",
    sessionToken,
    allowedOrigins: options.allowedOrigins,
  });
  return http.createServer((req, res) => {
    void handler(req, res).catch((err) => {
      if (!res.headersSent) {
        writeJson(res, 500, {
          ok: false,
          reason: "internal-error",
          details: (err as Error).message,
        });
      } else {
        res.end();
      }
    });
  });
}

/** Expose the API context of a server built by createServer (CLI uses it). */
export function createStandaloneContext(options: ServerOptions): ApiContext {
  return createApiContext({
    workspaceRoot: options.workspaceRoot,
    mode: "standalone",
    recentApplies: options.recentApplies,
    currentSelection: options.currentSelection,
    pins: options.pins,
    events: options.events,
    persist: options.persist ?? true,
  });
}

/**
 * Node-style request handler shared by the standalone server and the Vite
 * dev-server middleware. Handles trust policy, CORS (token mode), JSON
 * parsing, SSE for /events, and delegates everything else to handleApi.
 */
export function createNodeHandler(opts: NodeHandlerOptions): NodeHandler {
  const { ctx, auth } = opts;
  const allowed = opts.allowedOrigins ?? [];
  const basePath = opts.basePath?.replace(/\/+$/, "") ?? "";

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let endpoint = url.pathname;
    if (basePath && endpoint.startsWith(basePath)) endpoint = endpoint.slice(basePath.length) || "/";
    const method = (req.method ?? "GET").toUpperCase();

    if (auth === "token") {
      // CORS — the standalone server is cross-origin by design (the overlay
      // runs on whatever port the dev server chose).
      const origin = req.headers.origin;
      const originAllowed = allowed.length === 0 || (!!origin && allowed.includes(origin));
      if (allowed.length === 0) {
        res.setHeader("Access-Control-Allow-Origin", "*");
      } else if (originAllowed && origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (method === "GET" && endpoint === "/health") {
        const r = await handleApi(ctx, "GET", "/health", undefined);
        writeJson(res, r.status, r.body);
        return;
      }
      // Origin check applies to /token too — the bootstrap is the most
      // attacked endpoint.
      if (!originAllowed) {
        writeJson(res, 403, {
          ok: false,
          reason: "origin-not-allowed",
          details: `Origin ${origin ?? "(missing)"} is not in the allowlist`,
        });
        return;
      }
      const token = opts.sessionToken;
      if (method === "GET" && endpoint === "/token") {
        writeJson(res, 200, { token: token ? token.get() : null });
        return;
      }
      // Everything below requires the bearer token. EventSource can't set
      // headers, so /events may pass it as ?token=.
      const bearer =
        parseBearer(req.headers.authorization) ??
        (endpoint === "/events" ? url.searchParams.get("token") : null);
      if (!token || !token.matches(bearer)) {
        writeJson(res, 401, {
          ok: false,
          reason: "unauthorized",
          details: "Include `Authorization: Bearer <token>` (fetch the token from GET /token).",
        });
        return;
      }
    } else {
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (endpoint !== "/health") {
        const trust = isTrustedBrowserRequest({ get: (n) => req.headers[n] as string | undefined });
        if (!trust.ok) {
          writeJson(res, 403, { ok: false, reason: "cross-site-request", details: trust.details });
          return;
        }
      }
      if (method === "GET" && endpoint === "/token") {
        // Same-origin transport — no bearer token needed.
        writeJson(res, 200, { token: null });
        return;
      }
    }

    if (method === "GET" && endpoint === "/events") {
      startSse(ctx, req, res);
      return;
    }

    let body: unknown = undefined;
    if (method === "POST" || method === "DELETE") {
      const ct = String(req.headers["content-type"] ?? "");
      if (method === "POST" && !ct.toLowerCase().includes("application/json")) {
        writeJson(res, 415, {
          ok: false,
          reason: "unsupported-media-type",
          details: "POST bodies must be application/json.",
        });
        return;
      }
      try {
        body = await readJsonBody(req);
      } catch (err) {
        writeJson(res, 400, { ok: false, reason: "invalid-json", details: (err as Error).message });
        return;
      }
    }

    const result = await handleApi(ctx, method, endpoint, body, url.searchParams);
    writeJson(res, result.status, result.body);
  };
}

function startSse(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  const unsubscribe = ctx.events.subscribe((ev) => {
    res.write(formatSse(ev));
  });
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25_000);
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", close);
  res.on("close", close);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    total += chunk.length;
    // Guard: refuse pathologically large bodies. Mutations are small
    // payloads — anything over 1 MB is suspicious.
    if (total > MAX_BODY) throw new Error("Request body exceeds 1 MB");
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
