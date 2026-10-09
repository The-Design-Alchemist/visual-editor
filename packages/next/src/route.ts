/**
 * Web Request handler for visual-editor, mounted as a Next.js catchall
 * Route Handler. Users add ONE file (the init script writes it):
 *
 *   app/api/visual-editor/[...path]/route.ts
 *   ──────────────────────────────────────
 *   export { GET, POST, DELETE } from "@aaqiljamal/visual-editor-next/route";
 *
 * The AST mutation logic runs in-process with the user's Next dev server.
 * No separate port, no separate process, no CORS dance, no bearer token:
 * trust is "same origin as the dev server" (Sec-Fetch-Site / Origin vs
 * Host), which blocks drive-by cross-site writes from other tabs.
 *
 * In production we 404 every request: visual-editor is dev-only by design.
 */
import {
  createApiContext,
  handleApi,
  isTrustedBrowserRequest,
  formatSse,
  type ApiContext,
} from "@aaqiljamal/visual-editor-server";
import { resolveWorkspaceRoot } from "@aaqiljamal/visual-editor-server/transform";

// One context per dev-server process, kept on globalThis so a re-evaluated
// route module (HMR) reuses the same selection / pins / event hub.
const CONTEXT_KEY = Symbol.for("@aaqiljamal/visual-editor.api-context");

function getContext(): ApiContext {
  const g = globalThis as unknown as Record<symbol, ApiContext | undefined>;
  let ctx = g[CONTEXT_KEY];
  if (!ctx) {
    ctx = createApiContext({
      // Same rule the stamping loader / Babel plugin use (env > nearest
      // workspace marker > cwd), so every id the overlay sends resolves.
      workspaceRoot: resolveWorkspaceRoot(),
      mode: "next-route-handler",
      persist: true,
    });
    g[CONTEXT_KEY] = ctx;
  }
  return ctx;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type RouteContext = { params: Promise<{ path?: string[] }> };

async function handle(req: Request, context: RouteContext): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return new Response("Not available in production", { status: 404 });
  }
  const ctx = getContext();
  const { path: parts } = await context.params;
  const endpoint = "/" + (parts ?? []).join("/");
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  if (endpoint !== "/health") {
    const trust = isTrustedBrowserRequest(req.headers);
    if (!trust.ok) {
      return json(403, { ok: false, reason: "cross-site-request", details: trust.details });
    }
  }
  if (method === "GET" && endpoint === "/token") {
    // Same-origin Route Handler — no bearer token needed. 200 + null so the
    // overlay's bootstrap doesn't log a 404.
    return json(200, { token: null });
  }
  if (method === "GET" && endpoint === "/events") {
    return sse(ctx, req);
  }

  let body: unknown = undefined;
  if (method === "POST" || method === "DELETE") {
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    if (method === "POST" && !ct.includes("application/json")) {
      return json(415, {
        ok: false,
        reason: "unsupported-media-type",
        details: "POST bodies must be application/json.",
      });
    }
    const text = await req.text();
    if (text.length === 0) {
      body = {};
    } else {
      try {
        body = JSON.parse(text);
      } catch (err) {
        return json(400, { ok: false, reason: "invalid-json", details: (err as Error).message });
      }
    }
  }

  const result = await handleApi(ctx, method, endpoint, body, url.searchParams);
  return json(result.status, result.body);
}

function sse(ctx: ApiContext, req: Request): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          /* stream already closed */
        }
      };
      push(": connected\n\n");
      unsubscribe = ctx.events.subscribe((ev) => push(formatSse(ev)));
      heartbeat = setInterval(() => push(": ping\n\n"), 25_000);
      req.signal.addEventListener("abort", () => {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
