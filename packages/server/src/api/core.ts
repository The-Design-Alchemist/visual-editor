/**
 * Transport-agnostic API core.
 *
 * Every transport (standalone Node server, Next.js Route Handler, Vite dev
 * middleware) parses the request, applies its own trust policy (bearer
 * token or same-origin), and hands `{ method, endpoint, body, query }` to
 * `handleApi`. One implementation of every endpoint; the transports stay
 * mechanical.
 */
import * as path from "node:path";
import { applyToFile, type ApplyInput } from "../fs/applyToFile.ts";
import { revertToFile, type RevertInput } from "../fs/revertToFile.ts";
import { applyCssProperty, type ApplyCssPropertyInput } from "../fs/applyCssProperty.ts";
import { applyStyledProperty, type ApplyStyledPropertyInput } from "../fs/applyStyledProperty.ts";
import { RecentApplies } from "../state/recentApplies.ts";
import { CurrentSelection } from "../state/selection.ts";
import { PinStore } from "./pins.ts";
import { EventHub } from "./events.ts";
import { describeElementFile } from "./describeElement.ts";
import type {
  AgentEvent,
  ElementContext,
  EnrichedSelection,
  SelectionInput,
  SourceRef,
} from "./types.ts";

export type ApiContext = {
  workspaceRoot: string;
  /** Label reported by GET /health, e.g. "next-route-handler". */
  mode: string;
  recentApplies: RecentApplies;
  currentSelection: CurrentSelection;
  pins: PinStore;
  events: EventHub;
  /** Resolves once persisted state (history, pins) is loaded. */
  ready: Promise<void>;
};

export type ApiContextOptions = {
  workspaceRoot: string;
  mode?: string;
  /** Load/persist history + pins under <root>/.visual-editor/. Default true. */
  persist?: boolean;
  recentApplies?: RecentApplies;
  currentSelection?: CurrentSelection;
  pins?: PinStore;
  events?: EventHub;
};

export function createApiContext(opts: ApiContextOptions): ApiContext {
  const recentApplies = opts.recentApplies ?? new RecentApplies();
  const pins = opts.pins ?? new PinStore();
  const stateDir = path.join(opts.workspaceRoot, ".visual-editor");
  const ready =
    opts.persist === false
      ? Promise.resolve()
      : Promise.all([
          // Only wire persistence when the caller didn't inject its own.
          opts.recentApplies ? Promise.resolve() : recentApplies.load(path.join(stateDir, "history.json")),
          opts.pins ? Promise.resolve() : pins.load(path.join(stateDir, "pins.json")),
        ]).then(() => undefined);
  return {
    workspaceRoot: opts.workspaceRoot,
    mode: opts.mode ?? "standalone",
    recentApplies,
    currentSelection: opts.currentSelection ?? new CurrentSelection(),
    pins,
    events: opts.events ?? new EventHub(),
    ready,
  };
}

export type ApiResult = { status: number; body: unknown };

const json = (status: number, body: unknown): ApiResult => ({ status, body });
const refuse = (status: number, reason: string, details: string): ApiResult =>
  json(status, { ok: false, reason, details });

export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif"]);

/** Endpoints that stream (handled by each transport, not by handleApi). */
export const STREAMING_ENDPOINTS = new Set(["/events"]);

export async function handleApi(
  ctx: ApiContext,
  method: string,
  endpoint: string,
  body: unknown,
  query: URLSearchParams = new URLSearchParams(),
): Promise<ApiResult> {
  await ctx.ready;
  const m = method.toUpperCase();

  if (m === "GET") {
    switch (endpoint) {
      case "/health":
        return json(200, { ok: true, mode: ctx.mode, workspaceRoot: ctx.workspaceRoot });
      case "/selection":
        return json(200, { ok: true, selection: ctx.currentSelection.get() });
      case "/context":
        return json(200, {
          ok: true,
          selection: ctx.currentSelection.get(),
          pins: ctx.pins.list(),
          recent: ctx.recentApplies.list().slice(-5),
          workspaceRoot: ctx.workspaceRoot,
        });
      case "/recent":
        return json(200, { ok: true, applies: ctx.recentApplies.list() });
      case "/pins":
        return json(200, { ok: true, pins: ctx.pins.list() });
      case "/assets":
        return listAssets(ctx);
      case "/describe": {
        const ref = refFromQuery(query);
        if (!ref) return refuse(400, "invalid-input", "Query needs file, line, col");
        const role = query.get("role") === "call" ? "call" : "host";
        return json(200, { ok: true, element: await describeElementFile(ctx.workspaceRoot, ref, role) });
      }
      case "/events-poll": {
        const after = Number(query.get("after") ?? 0);
        return json(200, { ok: true, events: ctx.events.since(Number.isFinite(after) ? after : 0), now: Date.now() });
      }
      default:
        return refuse(404, "not-found", `GET ${endpoint}`);
    }
  }

  if (m === "POST") {
    switch (endpoint) {
      case "/apply":
        return mutate(ctx, body as ApplyInput, false);
      case "/propose":
        return mutate(ctx, body as ApplyInput, true);
      case "/revert": {
        const outcome = await revertToFile(
          body as RevertInput,
          { workspaceRoot: ctx.workspaceRoot, dryRun: false },
          ctx.recentApplies,
        );
        return outcome.ok
          ? json(200, { ok: true, diff: outcome.diff })
          : refuse(outcome.status, outcome.reason, outcome.details);
      }
      case "/apply-css-prop": {
        const outcome = await applyCssProperty(body as ApplyCssPropertyInput, {
          workspaceRoot: ctx.workspaceRoot,
          dryRun: false,
        });
        return outcome.ok
          ? json(200, {
              ok: true,
              diff: outcome.diff,
              selector: outcome.selector,
              previousValue: outcome.previousValue,
            })
          : refuse(outcome.status, outcome.reason, outcome.details);
      }
      case "/apply-styled-prop": {
        const outcome = await applyStyledProperty(body as ApplyStyledPropertyInput, {
          workspaceRoot: ctx.workspaceRoot,
          dryRun: false,
        });
        return outcome.ok
          ? json(200, {
              ok: true,
              diff: outcome.diff,
              componentName: outcome.componentName,
              previousValue: outcome.previousValue,
            })
          : refuse(outcome.status, outcome.reason, outcome.details);
      }
      case "/selection": {
        if (!isValidSelectionInput(body)) {
          return refuse(
            400,
            "invalid-input",
            "Body must be { file, line, col, oid, className, tagName, componentName, instanceCount, …optional context }",
          );
        }
        const enriched = await enrichSelection(ctx, body);
        ctx.currentSelection.set(enriched);
        return json(200, { ok: true, selection: enriched });
      }
      case "/pins": {
        const b = (body ?? {}) as { note?: unknown; selection?: unknown };
        const note = typeof b.note === "string" ? b.note.trim() : "";
        let selection: EnrichedSelection | null = null;
        if (isValidSelectionInput(b.selection)) {
          selection = await enrichSelection(ctx, b.selection);
        } else {
          selection = ctx.currentSelection.get();
        }
        if (!selection) {
          return refuse(400, "no-selection", "Select an element before pinning it.");
        }
        const pin = ctx.pins.add({ ...selection, note: note || selection.note || null }, note);
        ctx.events.emit({ type: "pins-changed", at: Date.now() });
        return json(200, { ok: true, pin });
      }
      case "/pins/resolve": {
        const b = (body ?? {}) as { id?: unknown; resolution?: unknown };
        if (typeof b.id !== "string") return refuse(400, "invalid-input", "Body needs { id }");
        const pin = ctx.pins.resolve(b.id, typeof b.resolution === "string" ? b.resolution : undefined);
        if (!pin) return refuse(404, "pin-not-found", `No pin with id ${b.id}`);
        ctx.events.emit({ type: "pin-resolved", id: pin.id, resolution: pin.resolution, at: Date.now() });
        return json(200, { ok: true, pin });
      }
      case "/highlight": {
        const b = (body ?? {}) as Partial<SourceRef> & {
          label?: unknown;
          durationMs?: unknown;
          attribute?: unknown;
        };
        if (typeof b.file !== "string" || !Number.isInteger(b.line) || !Number.isInteger(b.col)) {
          return refuse(400, "invalid-input", "Body needs { file, line, col, label?, durationMs? }");
        }
        const ev: AgentEvent = {
          type: "highlight",
          ref: { file: b.file, line: b.line as number, col: b.col as number },
          attribute: b.attribute === "data-oid-call" ? "data-oid-call" : "data-oid",
          label: typeof b.label === "string" ? b.label.slice(0, 120) : undefined,
          durationMs:
            typeof b.durationMs === "number" && b.durationMs > 0 ? Math.min(b.durationMs, 60_000) : undefined,
          at: Date.now(),
        };
        ctx.events.emit(ev);
        return json(200, { ok: true, delivered: ctx.events.listenerCount > 0, listeners: ctx.events.listenerCount });
      }
      default:
        return refuse(404, "not-found", `POST ${endpoint}`);
    }
  }

  if (m === "DELETE") {
    switch (endpoint) {
      case "/selection":
        ctx.currentSelection.clear();
        return json(200, { ok: true });
      case "/pins": {
        const b = (body ?? {}) as { id?: unknown; onlyResolved?: unknown };
        if (typeof b.id === "string") {
          const removed = ctx.pins.remove(b.id);
          if (!removed) return refuse(404, "pin-not-found", `No pin with id ${b.id}`);
          ctx.events.emit({ type: "pins-changed", at: Date.now() });
          return json(200, { ok: true, removed: 1 });
        }
        const removed = ctx.pins.clear(b.onlyResolved === true);
        ctx.events.emit({ type: "pins-changed", at: Date.now() });
        return json(200, { ok: true, removed });
      }
      default:
        return refuse(404, "not-found", `DELETE ${endpoint}`);
    }
  }

  return refuse(404, "not-found", `${m} ${endpoint}`);
}

// ---------------------------------------------------------------------------

async function mutate(ctx: ApiContext, input: ApplyInput, dryRun: boolean): Promise<ApiResult> {
  const outcome = await applyToFile(input, { workspaceRoot: ctx.workspaceRoot, dryRun });
  if (!outcome.ok) return refuse(outcome.status, outcome.reason, outcome.details);
  if (!dryRun) {
    // Persist the actual previous value so undo can swap back even when
    // the client sent before=null (asset picker UX).
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
  return json(200, { ok: true, diff: outcome.diff });
}

async function enrichSelection(ctx: ApiContext, input: SelectionInput): Promise<EnrichedSelection> {
  const refs: ElementContext[] = [];
  refs.push(
    await describeElementFile(
      ctx.workspaceRoot,
      { file: input.file, line: input.line, col: input.col },
      input.oidAttribute === "data-oid-call" ? "call" : "host",
    ),
  );
  if (input.callSite) {
    refs.push(
      await describeElementFile(
        ctx.workspaceRoot,
        { file: input.callSite.file, line: input.callSite.line, col: input.callSite.col },
        "call",
      ),
    );
  }
  return { ...input, refs, selectedAt: Date.now() };
}

async function listAssets(ctx: ApiContext): Promise<ApiResult> {
  const fs = await import("node:fs/promises");
  const publicDir = path.join(ctx.workspaceRoot, "public");
  async function walkDir(dir: string, rel: string): Promise<string[]> {
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
      if (e.isDirectory()) out.push(...(await walkDir(child, childRel)));
      else if (e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) out.push(`/${childRel}`);
    }
    return out;
  }
  try {
    const assets = await walkDir(publicDir, "");
    assets.sort();
    return json(200, { ok: true, assets });
  } catch (err) {
    return refuse(500, "assets-list-failed", (err as Error).message);
  }
}

function refFromQuery(q: URLSearchParams): SourceRef | null {
  const file = q.get("file");
  const line = Number(q.get("line"));
  const col = Number(q.get("col"));
  if (!file || !Number.isInteger(line) || !Number.isInteger(col) || line < 1 || col < 0) return null;
  return { file, line, col };
}

export function isValidSelectionInput(x: unknown): x is SelectionInput {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  const core =
    typeof o.file === "string" &&
    typeof o.line === "number" &&
    typeof o.col === "number" &&
    typeof o.oid === "string" &&
    typeof o.className === "string" &&
    typeof o.tagName === "string" &&
    (o.componentName === null || o.componentName === undefined || typeof o.componentName === "string") &&
    typeof o.instanceCount === "number";
  if (!core) return false;
  if (o.callSite !== undefined && o.callSite !== null) {
    const c = o.callSite as Record<string, unknown>;
    if (
      !c ||
      typeof c !== "object" ||
      typeof c.file !== "string" ||
      typeof c.line !== "number" ||
      typeof c.col !== "number" ||
      typeof c.oid !== "string" ||
      typeof c.instanceCount !== "number"
    ) {
      return false;
    }
  }
  if (o.note !== undefined && o.note !== null && typeof o.note !== "string") return false;
  if (
    o.oidAttribute !== undefined &&
    o.oidAttribute !== "data-oid" &&
    o.oidAttribute !== "data-oid-call"
  ) {
    return false;
  }
  if (o.computed !== undefined && o.computed !== null) {
    if (typeof o.computed !== "object") return false;
    for (const v of Object.values(o.computed as Record<string, unknown>)) {
      if (typeof v !== "string") return false;
    }
  }
  if (o.ancestors !== undefined && o.ancestors !== null && !Array.isArray(o.ancestors)) return false;
  return true;
}

/** Shared by the browser-facing transports: reject cross-site writes. */
export function isTrustedBrowserRequest(headers: {
  get(name: string): string | null | undefined;
}): { ok: true } | { ok: false; details: string } {
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return { ok: false, details: `Sec-Fetch-Site is ${site}; only same-origin requests may write.` };
  }
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        return { ok: false, details: `Origin ${origin} does not match host ${host}.` };
      }
    } catch {
      return { ok: false, details: `Unparseable Origin header: ${origin}` };
    }
  }
  return { ok: true };
}

export function formatSse(ev: AgentEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}
