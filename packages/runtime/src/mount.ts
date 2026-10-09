import Moveable from "moveable";

// Spike B — verifies:
//   1. Preact renders into a closed Shadow DOM without leaking CSS either direction.
//   2. Vanilla `moveable` produces drag/resize handles attached to host-page elements.
//   3. No DevTools-hook conflict with the host's React 19 (Preact does not register).
//   4. Hover gives react-grab-style outline + source badge (data-oid + component name).
//   5. A self-test marker on `document.body` confirms the mount worked.

const ANCHOR_TAG = "visual-editor-anchor";

type FiberLike = {
  type?: unknown;
  return?: FiberLike | null;
};

// Names we treat as Next.js / React framework internals rather than the
// user's component. We don't want the hover badge to say "<SegmentViewNode>"
// when the user is pointing at a Server Component in their own page.tsx.
const FRAMEWORK_INTERNALS = new Set([
  "SegmentViewNode",
  "ClientPageRoot",
  "ClientSegmentRoot",
  "OutletBoundary",
  "AppRouter",
  "Router",
  "ServerInsertedHTMLProvider",
  "ServerInsertedMetadataProvider",
  "DevRootHTTPAccessFallbackBoundary",
  "HTTPAccessFallbackBoundary",
  "HTTPAccessFallbackErrorBoundary",
  "RenderFromTemplateContext",
  "LayoutRouter",
  "RedirectBoundary",
  "RedirectErrorBoundary",
  "NotFoundBoundary",
  "NotFoundErrorBoundary",
  "DevRootNotFoundBoundary",
  "ReactDevOverlay",
  "HotReload",
  "AppRouterAnnouncer",
  "Provider",
  "Overlay",
]);

function getComponentName(el: HTMLElement): string | null {
  const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (!fiberKey) return null;
  let fiber = (el as unknown as Record<string, FiberLike | undefined>)[
    fiberKey
  ];
  let depth = 0;
  while (fiber && depth < 30) {
    const t = fiber.type as
      | { displayName?: string; name?: string }
      | string
      | undefined;
    if (typeof t === "function") {
      const fn = t as unknown as { displayName?: string; name?: string };
      const name = fn.displayName || fn.name;
      if (name && name !== "_default" && !FRAMEWORK_INTERNALS.has(name)) {
        return name;
      }
    }
    fiber = fiber.return ?? undefined;
    depth++;
  }
  return null;
}

// Fallback: derive a label from a data-oid like "app/components/Card.tsx:12:4"
// → "Card". For Server Components there is no Fiber owner to walk, but the
// `data-oid` from our Babel plugin still tells us which file rendered this DOM.
function nameFromDataOid(oid: string | null): string | null {
  if (!oid) return null;
  const filePath = oid.split(":")[0];
  const base = filePath.split("/").pop();
  if (!base) return null;
  const stem = base.replace(/\.(tsx|ts|jsx|js)$/, "");
  // Capitalize the first letter so server-rendered routes like `page.tsx`
  // display as "Page" (matching React's PascalCase convention for components).
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

// ---------------------------------------------------------------------------
// Snap engine (inline; mirrors packages/server/src/snap/tailwind.ts).
// Duplicated here because the spike doesn't yet have a shared package for
// browser+server consumption. The server's snap.test.ts covers the same logic.
// ---------------------------------------------------------------------------

const DEFAULT_SCALE_STEPS = [
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24,
  28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96,
];

type SnapResult = {
  step: number | null;
  suffix: string;
  resolvedPx: number;
  snapped: boolean;
};

// Theme-aware scale cache: maps step N → resolved px, honoring any
// `--spacing-N` overrides the project added via `@theme`. Built lazily and
// invalidated whenever the project's `--spacing` base changes.
let resolvedScaleCache: { spacingPx: number; map: Map<number, number> } | null =
  null;

function getResolvedScale(spacingPx: number): Map<number, number> {
  if (resolvedScaleCache && resolvedScaleCache.spacingPx === spacingPx) {
    return resolvedScaleCache.map;
  }
  const map = new Map<number, number>();
  const cs = getComputedStyle(document.documentElement);
  for (const step of DEFAULT_SCALE_STEPS) {
    // Tailwind v4 by default sets only `--spacing` (the base); per-step
    // overrides like `--spacing-13: 3.25rem` are project-level customizations.
    // When present they win; otherwise we fall back to `step * --spacing`.
    const named = cs.getPropertyValue(`--spacing-${step}`).trim();
    let px: number;
    if (named) {
      const parsed = parseCssLengthToPx(named);
      px = parsed !== null ? parsed : step * spacingPx;
    } else {
      px = step * spacingPx;
    }
    map.set(step, px);
  }
  resolvedScaleCache = { spacingPx, map };
  return map;
}

function snapToTailwind(targetPx: number, spacingPx: number, tolerancePx = 1): SnapResult {
  if (!Number.isFinite(targetPx) || targetPx < 0) {
    return { step: null, suffix: `[0px]`, resolvedPx: 0, snapped: false };
  }
  const scale = getResolvedScale(spacingPx);
  let bestStep: number | null = null;
  let bestDiff = Infinity;
  let bestPx = 0;
  for (const [step, px] of scale) {
    const diff = Math.abs(px - targetPx);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestStep = step;
      bestPx = px;
    }
  }
  if (bestStep !== null && bestDiff <= tolerancePx) {
    return {
      step: bestStep,
      suffix: String(bestStep),
      resolvedPx: bestPx,
      snapped: true,
    };
  }
  const intPx = Math.round(targetPx);
  return { step: null, suffix: `[${intPx}px]`, resolvedPx: intPx, snapped: false };
}

function parseCssLengthToPx(value: string, rootFontPx = 16): number | null {
  const v = value.trim();
  if (v.endsWith("px")) {
    const n = parseFloat(v.slice(0, -2));
    return Number.isFinite(n) ? n : null;
  }
  if (v.endsWith("rem")) {
    const n = parseFloat(v.slice(0, -3));
    return Number.isFinite(n) ? n * rootFontPx : null;
  }
  if (v.endsWith("em")) {
    const n = parseFloat(v.slice(0, -2));
    return Number.isFinite(n) ? n * rootFontPx : null;
  }
  return null;
}

function pxFromClass(token: string, spacingPx: number): number | null {
  const open = token.indexOf("[");
  if (open !== -1 && token.endsWith("]")) {
    return parseCssLengthToPx(token.slice(open + 1, -1));
  }
  const lastDash = token.lastIndexOf("-");
  if (lastDash === -1) return null;
  const stepStr = token.slice(lastDash + 1);
  if (!/^-?\d+(?:\.\d+)?$/.test(stepStr)) return null;
  const step = parseFloat(stepStr);
  return Number.isFinite(step) ? step * spacingPx : null;
}

// Mirror of packages/server/src/snap/tailwind.ts:bumpStep. Uses the same
// theme-aware scale cache as snapToTailwind, so per-step --spacing-N
// overrides affect bump targets too.
function bumpStep(
  currentToken: string,
  direction: "up" | "down",
  spacingPx: number,
): string | null {
  const open = currentToken.indexOf("[");
  let lastDash: number;
  if (open !== -1 && currentToken.endsWith("]")) {
    lastDash = currentToken.lastIndexOf("-", open);
  } else {
    lastDash = currentToken.lastIndexOf("-");
  }
  if (lastDash <= 0) return null;
  const prefix = currentToken.slice(0, lastDash);

  const currentPx = pxFromClass(currentToken, spacingPx);
  if (currentPx === null) return null;

  const scale = Array.from(getResolvedScale(spacingPx).entries()); // [[step, px], ...]
  let currentIdx = -1;
  for (let i = 0; i < scale.length; i++) {
    if (Math.abs(scale[i]![1] - currentPx) < 0.001) {
      currentIdx = i;
      break;
    }
  }

  if (currentIdx === -1) {
    let nearestIdx = 0;
    let nearestDiff = Infinity;
    for (let i = 0; i < scale.length; i++) {
      const diff = Math.abs(scale[i]![1] - currentPx);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearestIdx = i;
      }
    }
    if (direction === "up" && scale[nearestIdx]![1] < currentPx) {
      currentIdx = nearestIdx;
    } else if (direction === "down" && scale[nearestIdx]![1] > currentPx) {
      currentIdx = nearestIdx;
    } else {
      return `${prefix}-${scale[nearestIdx]![0]}`;
    }
  }

  const newIdx = direction === "up" ? currentIdx + 1 : currentIdx - 1;
  if (newIdx < 0 || newIdx >= scale.length) return null;
  return `${prefix}-${scale[newIdx]![0]}`;
}

// Prefer the shorthand (`p-*`, `m-*`) when present; otherwise fall back to
// directional tokens (`px-*`, `pt-*`, …). The keyboard nudge bumps whichever
// is found first in this priority order.
const PADDING_PREFIXES = ["p", "px", "py", "pt", "pr", "pb", "pl"];
const MARGIN_PREFIXES = ["m", "mx", "my", "mt", "mr", "mb", "ml"];
const GAP_PREFIXES = ["gap", "gap-x", "gap-y"];
const WIDTH_PREFIXES = ["w"];
const HEIGHT_PREFIXES = ["h"];

// Mirror of the server-side swapToken used by mutateClassName. Used for the
// optimistic DOM patch on Apply so the user sees the new state before
// Fast Refresh fires (RSC content especially — the route segment refresh
// takes longer than a CC HMR step).
function swapClassToken(value: string, before: string, after: string): string {
  const parts = value.split(/(\s+)/);
  let found = false;
  return parts
    .map((p) => {
      if (!found && p === before) {
        found = true;
        return after;
      }
      return p;
    })
    .join("");
}

// Read the live page's Tailwind v4 `--spacing` from :root, fall back to 4px.
// This is the open-note from SPIKES.md note #3 — wired here so the snap
// honors any project that customized --spacing via `@theme`.
function getSpacingPx(): number {
  const rootStyle = getComputedStyle(document.documentElement);
  const rootFontPx = parseFloat(rootStyle.fontSize) || 16;
  const spacing = rootStyle.getPropertyValue("--spacing").trim();
  if (!spacing) return 4;
  if (spacing.endsWith("rem")) {
    const n = parseFloat(spacing);
    return Number.isFinite(n) ? n * rootFontPx : 4;
  }
  if (spacing.endsWith("px")) {
    const n = parseFloat(spacing);
    return Number.isFinite(n) ? n : 4;
  }
  return 4;
}

// Match Tailwind width tokens we'd snap: `w-32`, `w-2.5`, `w-[123px]`, etc.
// Excludes named tokens like `w-full`, `w-auto`, `w-screen`, `w-min`, `w-max`,
// `w-fit`, and viewport-relative names — those don't map to a numeric snap.
const WIDTH_TOKEN_RE = /^w-(\d+(?:\.\d+)?|\[[^\]]+\])$/;

/**
 * A decoded data-oid / data-oid-call: which attribute carried it (so
 * instance counting queries the right one) plus the source location.
 */
type SourceRef = {
  attribute: "data-oid" | "data-oid-call";
  oid: string;
  file: string;
  line: number;
  col: number;
};

function parseOid(
  oid: string | null,
  attribute: "data-oid" | "data-oid-call",
): SourceRef | null {
  if (!oid) return null;
  const parts = oid.split(":");
  if (parts.length < 3) return null;
  const file = parts.slice(0, parts.length - 2).join(":");
  const line = parseInt(parts[parts.length - 2]!, 10);
  const col = parseInt(parts[parts.length - 1]!, 10);
  if (!Number.isInteger(line) || !Number.isInteger(col)) return null;
  return { attribute, oid, file, line, col };
}

/**
 * Both locations a DOM node can map to:
 *   host — the `<div>` inside the component file that rendered it
 *   call — where the component was used (`<Card className="p-4">`), when
 *          the component spread its props onto the DOM node
 */
function getRefs(el: HTMLElement): { host: SourceRef | null; call: SourceRef | null } {
  return {
    host: parseOid(el.getAttribute("data-oid"), "data-oid"),
    call: parseOid(el.getAttribute("data-oid-call"), "data-oid-call"),
  };
}

/** Mirror of the server's ElementContext (packages/server/src/api/types.ts). */
type ElementContext = {
  ref: { file: string; line: number; col: number };
  role: "host" | "call";
  found: boolean;
  tag: string | null;
  componentName: string | null;
  className:
    | { kind: "static"; tokens: string[]; raw: string }
    | { kind: "merger"; callee: string; tokens: string[]; dynamicArgs: number; raw: string }
    | { kind: "template" | "conditional" | "dynamic"; raw: string }
    | { kind: "none"; spread: boolean }
    | null;
  attributes: string[];
  snippet: string;
  snippetTruncated: boolean;
  editable: boolean;
  reason?: string;
};

type EnrichedSelection = {
  oid: string;
  file: string;
  line: number;
  col: number;
  className: string;
  tagName: string;
  componentName: string | null;
  instanceCount: number;
  callSite?: { file: string; line: number; col: number; oid: string; instanceCount: number } | null;
  note?: string | null;
  refs: ElementContext[];
  selectedAt: number;
};

type PendingChange = {
  element: HTMLElement;
  /** Where the edit lands (host or call site). */
  ref: SourceRef;
  file: string;
  line: number;
  col: number;
  before: string;
  after: string;
};

// Default endpoint = the Next.js Route Handler mount point from
// @aaqiljamal/visual-editor-next. Pass a `serverUrl` prop to <VisualEditOverlay /> if
// you're using the standalone server CLI (e.g. "http://127.0.0.1:7790").
// Module-level let so the closure-bound helpers below (ensureSessionToken,
// authedFetch) see the resolved value — works for one overlay per page.
let SERVER_URL: string = "/api/visual-editor";
const DRAFT_STORAGE_KEY = "visual-editor:draft-v1";

// Persisted draft — the pending-but-not-yet-applied change. Survives page
// reloads via localStorage. The DOM element itself can't be persisted, so
// we store the data-oid and re-resolve the element on mount.
type PersistedDraft = {
  file: string;
  line: number;
  col: number;
  before: string;
  after: string;
  oid: string;
  attribute?: "data-oid" | "data-oid-call";
  resolvedPx: number;
  savedAt: number;
};

function saveDraft(d: Omit<PersistedDraft, "savedAt">): void {
  try {
    localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ ...d, savedAt: Date.now() }),
    );
  } catch {
    /* QuotaExceeded etc — drafts are best-effort */
  }
}

function loadDraft(): PersistedDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedDraft;
    if (
      typeof parsed.file === "string" &&
      typeof parsed.line === "number" &&
      typeof parsed.col === "number" &&
      typeof parsed.before === "string" &&
      typeof parsed.after === "string" &&
      typeof parsed.oid === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    /* same */
  }
}

// Fetched once on mount via GET /token. We use a memoized promise so any
// concurrent fetches that fire before the token resolves all queue on the
// same in-flight request rather than racing.
let sessionTokenPromise: Promise<string | null> | null = null;

function ensureSessionToken(): Promise<string | null> {
  if (sessionTokenPromise) return sessionTokenPromise;
  sessionTokenPromise = (async () => {
    try {
      const r = await fetch(`${SERVER_URL}/token`);
      if (!r.ok) return null;
      const body = (await r.json()) as { token?: string };
      return typeof body.token === "string" ? body.token : null;
    } catch {
      return null;
    }
  })();
  return sessionTokenPromise;
}

async function authedFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await ensureSessionToken();
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

export type VisualEditOverlayProps = {
  /**
   * Where the overlay sends mutation requests. Defaults to
   * "/api/visual-editor" — the path your Next.js Route Handler is mounted
   * at via @aaqiljamal/visual-editor-next. For the standalone server (used by
   * @aaqiljamal/visual-editor-server's CLI), pass "http://127.0.0.1:7790".
   */
  serverUrl?: string;
};

const MOUNT_FLAG = "__visualEditorMounted";

/**
 * Mount the overlay into the current document. Framework-free: works from
 * a Next.js `instrumentation-client` injection, a Vite-injected script, or
 * the React wrapper component. Returns a cleanup function.
 *
 * Idempotent per window — a second call while the first is mounted is a
 * no-op, so wiring both the auto-inject AND `<VisualEditOverlay />` doesn't
 * produce two overlays.
 */
export function mountVisualEditor(
  opts: VisualEditOverlayProps = {},
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const w = window as unknown as Record<string, unknown>;
  if (w[MOUNT_FLAG]) return () => {};
  w[MOUNT_FLAG] = true;
  if (opts.serverUrl) SERVER_URL = opts.serverUrl;
  {

    // Kick off the token fetch — every authed call awaits this promise so
    // concurrent fetches that fire on first acquire all queue cleanly.
    void ensureSessionToken();

    const anchor = document.createElement(ANCHOR_TAG);
    Object.assign(anchor.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
    });
    document.body.appendChild(anchor);
    const shadow = anchor.attachShadow({ mode: "closed" });

    // Server-enriched view of the current selection (source-side facts for
    // the host ref and the call-site ref). Null until the server answers,
    // or when it's unreachable — every consumer falls back to DOM facts.
    let currentSelection: EnrichedSelection | null = null;
    // Note typed for the agent about the current selection (cleared on
    // deselect). Sent with every selection POST so `get_selected_element`
    // sees it even before the user pins.
    let currentNote: string | null = null;
    // Hook the selection panel sets to re-render once the server answers.
    let onSelectionDescribed: ((el: HTMLElement) => void) | null = null;

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .badge {
        position: fixed; top: 12px; right: 12px;
        background: rebeccapurple; color: white;
        font: 12px/1.2 system-ui, sans-serif;
        padding: 6px 10px; border-radius: 6px;
        pointer-events: auto;
      }
      .hover-outline {
        position: fixed; display: none;
        pointer-events: none;
        box-sizing: border-box;
        border: 1.5px solid #ec4899;
        border-radius: 2px;
        background: rgba(236, 72, 153, 0.06);
        transition: none;
      }
      .hover-tag {
        position: fixed; display: none;
        pointer-events: none;
        background: #0f172a; color: white;
        font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
        padding: 4px 7px; border-radius: 3px;
        white-space: nowrap;
        box-shadow: 0 2px 6px rgba(0,0,0,0.2);
      }
      .hover-tag .comp { color: #fbbf24; margin-right: 6px; font-weight: 600; }
      .hover-tag .tag { color: #93c5fd; margin-right: 6px; }
      .hover-tag .src { color: #cbd5e1; }
      .moveable-container { pointer-events: auto; }
      .pending-panel {
        position: fixed; display: none;
        top: 56px; right: 12px;
        flex-direction: column; gap: 8px;
        background: #0f172a; color: white;
        font: 12px/1.3 system-ui, sans-serif;
        padding: 10px 12px; border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        pointer-events: auto;
        min-width: 240px;
      }
      .pending-header {
        font: 11px/1.2 ui-monospace, monospace;
        color: #94a3b8;
      }
      .pending-body {
        display: flex; align-items: center; gap: 8px;
        font: 12px/1.2 ui-monospace, monospace;
      }
      .pending-body .before { color: #f87171; background: rgba(248,113,113,0.1); padding: 2px 6px; border-radius: 3px; }
      .pending-body .arrow { color: #94a3b8; }
      .pending-body .after { color: #4ade80; background: rgba(74,222,128,0.1); padding: 2px 6px; border-radius: 3px; font-weight: 600; }
      .pending-body .resolved { color: #94a3b8; font-size: 11px; margin-left: auto; }
      .pending-instances {
        font: 11px/1.3 system-ui;
        color: #fbbf24;
        background: rgba(251, 191, 36, 0.1);
        padding: 6px 8px;
        border-radius: 4px;
        border-left: 3px solid #fbbf24;
      }
      .instance-outline {
        position: fixed;
        pointer-events: none;
        box-sizing: border-box;
        border: 1.5px dashed #fbbf24;
        border-radius: 2px;
        background: rgba(251, 191, 36, 0.05);
      }
      .indicator-pad {
        position: fixed; display: none;
        pointer-events: none;
        background: rgba(147, 196, 125, 0.45);
      }
      .indicator-margin {
        position: fixed; display: none;
        pointer-events: none;
        background: rgba(246, 178, 107, 0.40);
      }
      .anchor-outline {
        position: fixed; display: none;
        pointer-events: none;
        box-sizing: border-box;
        border: 1.5px solid #14b8a6;
        background: rgba(20, 184, 166, 0.06);
        border-radius: 2px;
      }
      .distance-label {
        position: fixed; display: none;
        pointer-events: none;
        background: #be185d; color: white;
        font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
        padding: 4px 7px; border-radius: 3px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.25);
        white-space: nowrap;
      }
      .distance-line {
        position: fixed; display: none;
        pointer-events: none;
        background: #ec4899;
      }
      /* Padding handles sit ON the inner edge of the padding band.
         Horizontal bars for top/bottom (you drag them vertically),
         vertical bars for left/right (you drag them horizontally).
         Subtle teal — the green padding indicator band is the
         "what's being adjusted" cue; the handle itself is just
         the grip. */
      .padding-handle {
        position: fixed; display: none;
        pointer-events: auto;
        background: #0d9488;
        border: 1px solid white;
        border-radius: 2px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.35);
        z-index: 2;
        touch-action: none;
        transition: background 100ms ease;
      }
      .padding-handle:hover { background: #0f766e; }
      .padding-handle-top, .padding-handle-bottom {
        width: 16px; height: 4px;
        margin-left: -8px; margin-top: -2px;
        cursor: ns-resize;
      }
      .padding-handle-left, .padding-handle-right {
        width: 4px; height: 16px;
        margin-left: -2px; margin-top: -8px;
        cursor: ew-resize;
      }
      .pending-actions { display: flex; gap: 6px; }
      .pending-actions button {
        font: 12px/1 system-ui; padding: 6px 10px; border-radius: 4px;
        border: none; cursor: pointer;
      }
      .btn-apply { background: #4ade80; color: #052e16; font-weight: 600; }
      .btn-apply:hover { background: #22c55e; }
      .btn-discard { background: #334155; color: white; }
      .btn-discard:hover { background: #475569; }
      .pending-result {
        font: 11px/1.3 system-ui;
        padding: 6px 8px; border-radius: 4px;
      }
      .pending-result.success { background: rgba(74,222,128,0.15); color: #4ade80; }
      .pending-result.error { background: rgba(248,113,113,0.15); color: #f87171; }
      .btn-undo { background: #1e293b; color: white; border: 1px solid #334155; }
      .btn-undo:hover { background: #334155; border-color: #475569; }
      /* Shortcuts hint badge — shown when a target is selected so the user
         immediately knows what's editable on this specific element. */
      .shortcuts-hint {
        position: fixed; display: none;
        bottom: 12px; left: 12px;
        background: #0f172a; color: white;
        font: 11px/1.4 system-ui, sans-serif;
        padding: 8px 12px; border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        max-width: 320px;
        pointer-events: auto;
      }
      .shortcuts-hint .hint-title {
        font-weight: 600; color: #fbbf24;
        margin-bottom: 4px;
        font-size: 11px;
      }
      .shortcuts-hint kbd {
        display: inline-block;
        background: #1e293b;
        color: #e2e8f0;
        padding: 1px 5px;
        border-radius: 3px;
        font: 10px/1 ui-monospace, monospace;
        border: 1px solid #334155;
        margin: 0 1px;
      }
      .shortcuts-hint .disabled { color: #64748b; }
      .shortcuts-hint .available { color: #cbd5e1; }
      .badge { cursor: pointer; user-select: none; }
      /* B6: history panel showing recent applies. Slides in from the
         right when the user clicks the "visual-editor on" badge. */
      .history-panel {
        position: fixed; display: none;
        top: 52px; right: 12px;
        width: 320px;
        max-height: calc(100vh - 80px);
        background: #0f172a; color: white;
        font: 12px/1.3 system-ui, sans-serif;
        padding: 10px 12px;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        pointer-events: auto;
        flex-direction: column;
        gap: 6px;
        overflow: hidden;
      }
      .history-title {
        display: flex; align-items: center; justify-content: space-between;
        font-weight: 600; color: #fbbf24;
        font-size: 11px;
        padding-bottom: 4px;
        border-bottom: 1px solid #1e293b;
      }
      .history-list { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; max-height: calc(100vh - 140px); }
      .history-row {
        display: grid;
        grid-template-columns: 1fr auto;
        align-items: center;
        gap: 4px;
        padding: 6px 8px;
        background: #1e293b;
        border-radius: 4px;
      }
      .history-row:hover { background: #243044; }
      .history-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .history-source {
        font: 10px/1.2 ui-monospace, monospace;
        color: #94a3b8;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .history-tokens {
        font: 11px/1.2 ui-monospace, monospace;
      }
      .history-tokens .before { color: #f87171; background: rgba(248,113,113,0.1); padding: 1px 4px; border-radius: 2px; }
      .history-tokens .arrow { color: #64748b; margin: 0 4px; }
      .history-tokens .after { color: #4ade80; background: rgba(74,222,128,0.1); padding: 1px 4px; border-radius: 2px; font-weight: 600; }
      .history-time {
        font: 10px/1.2 system-ui;
        color: #64748b;
        margin-top: 2px;
      }
      .btn-undo-row {
        background: transparent;
        border: 1px solid #334155;
        color: #cbd5e1;
        font: 11px/1 system-ui;
        padding: 4px 8px;
        border-radius: 3px;
        cursor: pointer;
      }
      .btn-undo-row:hover { background: #334155; }
      .history-empty {
        color: #64748b;
        text-align: center;
        font-size: 11px;
        padding: 16px 8px;
      }
      /* B8: asset picker panel — opens on 'i' when an img is selected. */
      .asset-picker {
        position: fixed; display: none;
        top: 12px; right: 12px;
        width: 320px;
        max-height: calc(100vh - 80px);
        background: #0f172a; color: white;
        font: 12px/1.3 system-ui, sans-serif;
        padding: 10px 12px;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        pointer-events: auto;
        flex-direction: column;
        gap: 6px;
        overflow: hidden;
        z-index: 3;
      }
      .asset-picker-title {
        display: flex; align-items: center; justify-content: space-between;
        font-weight: 600; color: #fbbf24;
        font-size: 11px;
        padding-bottom: 4px;
        border-bottom: 1px solid #1e293b;
      }
      .asset-picker-list {
        display: flex; flex-direction: column; gap: 2px;
        overflow-y: auto; max-height: calc(100vh - 160px);
      }
      .asset-row {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 8px;
        background: #1e293b;
        border-radius: 4px;
        cursor: pointer;
        font: 11px/1.2 ui-monospace, monospace;
      }
      .asset-row:hover { background: #334155; }
      .asset-row.current { border: 1px solid #4ade80; }
      .asset-row .current-badge { color: #4ade80; font-size: 9px; font-family: system-ui; }
      .asset-empty {
        color: #64748b; text-align: center; padding: 16px; font-size: 11px;
      }
      /* B2b: CSS Module mutation panel — opens automatically when the
         selected element has a data-css-module-class attribute (stamped
         by the Babel plugin). Distinct from the Tailwind pending panel
         because the input is a CSS property + value, not a class token. */
      .css-panel {
        position: fixed; display: none;
        top: 56px; left: 12px;
        width: 320px;
        background: #0f172a; color: white;
        font: 12px/1.3 system-ui, sans-serif;
        padding: 10px 12px;
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        pointer-events: auto;
        flex-direction: column;
        gap: 8px;
        z-index: 3;
      }
      .css-panel-title {
        font-weight: 600; color: #f472b6;
        font-size: 11px;
        padding-bottom: 4px;
        border-bottom: 1px solid #1e293b;
      }
      .css-panel-meta {
        font: 10px/1.3 ui-monospace, monospace;
        color: #94a3b8;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .css-input-row {
        display: flex; gap: 6px;
      }
      .css-input-row .label {
        color: #94a3b8; font-size: 10px;
        display: flex; align-items: center;
        min-width: 56px;
      }
      .css-input-row input {
        flex: 1;
        background: #1e293b;
        color: white;
        border: 1px solid #334155;
        border-radius: 3px;
        padding: 4px 6px;
        font: 11px/1.2 ui-monospace, monospace;
      }
      .css-input-row input:focus { outline: none; border-color: #60a5fa; }
      .css-panel-actions { display: flex; gap: 6px; }
      .css-panel-actions button {
        font: 12px/1 system-ui; padding: 6px 10px; border-radius: 4px;
        border: none; cursor: pointer;
      }
      .btn-css-apply { background: #4ade80; color: #052e16; font-weight: 600; }
      .btn-css-apply:hover { background: #22c55e; }
      .btn-css-close { background: #334155; color: white; }
      .btn-css-close:hover { background: #475569; }
      .css-panel-result {
        font: 11px/1.3 system-ui;
        padding: 6px 8px; border-radius: 4px;
        word-break: break-word;
      }
      .css-panel-result.success { background: rgba(74,222,128,0.15); color: #4ade80; }
      .css-panel-result.error { background: rgba(248,113,113,0.15); color: #f87171; }
      /* Toolbar (top-right): edit-mode toggle, recent edits, pins. */
      .toolbar {
        position: fixed; top: 12px; right: 12px;
        display: flex; gap: 4px; align-items: center;
        pointer-events: auto;
        font: 12px/1.2 system-ui, sans-serif;
      }
      .toolbar button {
        background: #1e293b; color: #e2e8f0;
        border: 1px solid #334155; border-radius: 6px;
        padding: 6px 9px; cursor: pointer;
        font: 11px/1.2 system-ui, sans-serif;
        display: inline-flex; align-items: center; gap: 4px;
      }
      .toolbar button:hover { background: #334155; }
      .toolbar .tb-mode { background: rebeccapurple; border-color: rebeccapurple; color: white; font-weight: 600; }
      .toolbar .tb-mode:hover { background: #7c3aed; }
      .toolbar .tb-mode.off { background: #334155; border-color: #475569; color: #cbd5e1; font-weight: 500; }
      .toolbar .count {
        display: inline-block; min-width: 14px; padding: 1px 4px;
        border-radius: 8px; background: #fbbf24; color: #1c1917;
        font: 700 10px/1.2 system-ui; text-align: center;
      }
      .toolbar .count:empty { display: none; }
      /* Selection panel (bottom-left): where the edit lands, what's
         editable, the note for the agent, and the shortcut cheat sheet. */
      .sel-panel {
        position: fixed; display: none;
        bottom: 12px; left: 12px;
        width: 360px; max-height: calc(100vh - 80px); overflow-y: auto;
        background: #0f172a; color: white;
        font: 11px/1.4 system-ui, sans-serif;
        padding: 10px 12px; border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        pointer-events: auto;
        flex-direction: column; gap: 6px;
      }
      .sel-head { font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cbd5e1; word-break: break-all; }
      .sel-head .comp { color: #fbbf24; font-weight: 600; }
      .sel-head .tag { color: #93c5fd; }
      .sel-ref { font: 10px/1.35 ui-monospace, monospace; color: #94a3b8; word-break: break-all; }
      .sel-ref .role { color: #e2e8f0; }
      .sel-ref .ok { color: #4ade80; }
      .sel-ref .no { color: #f87171; }
      .sel-ref .tokens { color: #cbd5e1; }
      .sel-shortcuts { border-top: 1px solid #1e293b; padding-top: 6px; }
      .sel-shortcuts .hint-title { font-weight: 600; color: #fbbf24; margin-bottom: 4px; }
      .sel-shortcuts kbd {
        display: inline-block; background: #1e293b; color: #e2e8f0;
        padding: 1px 5px; border-radius: 3px;
        font: 10px/1 ui-monospace, monospace; border: 1px solid #334155; margin: 0 1px;
      }
      .sel-shortcuts .disabled { color: #64748b; }
      .sel-shortcuts .available { color: #cbd5e1; }
      .sel-note { display: flex; gap: 4px; }
      .sel-note input {
        flex: 1; background: #1e293b; color: white;
        border: 1px solid #334155; border-radius: 4px;
        padding: 5px 7px; font: 11px/1.2 system-ui, sans-serif;
      }
      .sel-note input:focus { outline: none; border-color: #60a5fa; }
      .sel-actions { display: flex; gap: 4px; }
      .sel-actions button {
        font: 11px/1 system-ui; padding: 6px 9px; border-radius: 4px;
        border: 1px solid transparent; cursor: pointer;
      }
      .btn-pin { background: #fbbf24; color: #1c1917; font-weight: 600; }
      .btn-pin:hover { background: #f59e0b; }
      .btn-copy { background: #1e293b; color: #e2e8f0; border-color: #334155 !important; }
      .btn-copy:hover { background: #334155; }
      /* Pins: numbered markers on the page + a list panel. */
      .pin-marker {
        position: fixed; width: 20px; height: 20px; margin: -10px 0 0 -10px;
        border-radius: 50%; background: #fbbf24; color: #1c1917;
        font: 700 11px/20px system-ui, sans-serif; text-align: center;
        box-shadow: 0 1px 4px rgba(0,0,0,0.45);
        pointer-events: auto; cursor: pointer; z-index: 2;
        border: 2px solid white;
      }
      .pin-marker.resolved { background: #4ade80; }
      .pins-panel {
        position: fixed; display: none;
        top: 52px; right: 12px; width: 340px;
        max-height: calc(100vh - 80px);
        background: #0f172a; color: white;
        font: 12px/1.3 system-ui, sans-serif;
        padding: 10px 12px; border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        pointer-events: auto; flex-direction: column; gap: 6px; overflow: hidden;
      }
      .pins-list { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; max-height: calc(100vh - 180px); }
      .pin-row {
        display: grid; grid-template-columns: 22px 1fr auto; gap: 6px; align-items: start;
        padding: 6px 8px; background: #1e293b; border-radius: 4px;
      }
      .pin-row .idx { font-weight: 700; color: #fbbf24; }
      .pin-row.resolved .idx { color: #4ade80; }
      .pin-row .note { color: #e2e8f0; word-break: break-word; }
      .pin-row .src { font: 10px/1.3 ui-monospace, monospace; color: #94a3b8; word-break: break-all; }
      .pin-row .res { font: 10px/1.3 system-ui; color: #4ade80; }
      .pins-footer { display: flex; gap: 4px; justify-content: flex-end; }
      .pins-footer button, .pin-row button {
        background: transparent; border: 1px solid #334155; color: #cbd5e1;
        font: 10px/1 system-ui; padding: 4px 7px; border-radius: 3px; cursor: pointer;
      }
      .pins-footer button:hover, .pin-row button:hover { background: #334155; }
      /* Agent → browser: "is this the one you mean?" */
      .agent-highlight {
        position: fixed; pointer-events: none; box-sizing: border-box;
        border: 2px solid #a78bfa; border-radius: 3px;
        background: rgba(167, 139, 250, 0.14);
        animation: ve-pulse 1s ease-in-out infinite;
      }
      .agent-label {
        position: fixed; pointer-events: none;
        background: #5b21b6; color: white;
        font: 11px/1.2 system-ui, sans-serif;
        padding: 4px 7px; border-radius: 3px; white-space: nowrap;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      }
      @keyframes ve-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
    `;
    shadow.appendChild(style);

    const ui = document.createElement("div");
    shadow.appendChild(ui);
    const toolbar = document.createElement("div");
    // `.badge` kept for the test helpers / screenshots scripts.
    toolbar.className = "toolbar badge";
    const mkToolbarButton = (cls: string, label: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = label;
      toolbar.appendChild(b);
      return b;
    };
    const modeBtn = mkToolbarButton("tb-mode", "edit on");
    const historyBtn = mkToolbarButton("tb-history", "edits");
    const pinsBtn = mkToolbarButton("tb-pins", "pins");
    const pinCountEl = document.createElement("span");
    pinCountEl.className = "count";
    pinsBtn.appendChild(pinCountEl);
    ui.appendChild(toolbar);

    // B6: history panel — populated lazily on first open from GET /recent.
    const historyPanel = document.createElement("div");
    historyPanel.className = "history-panel";
    shadow.appendChild(historyPanel);

    type RecentApply = {
      file: string;
      line: number;
      col: number;
      before: string;
      after: string;
      appliedAt: number;
    };

    const relativeTime = (ms: number): string => {
      const diff = Date.now() - ms;
      if (diff < 5_000) return "just now";
      if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
      if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
      if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
      return `${Math.round(diff / 86_400_000)}d ago`;
    };

    const renderHistory = async (): Promise<void> => {
      let applies: RecentApply[] = [];
      try {
        const res = await authedFetch(`${SERVER_URL}/recent`, { method: "GET" });
        if (res.ok) {
          const body = (await res.json()) as {
            ok: boolean;
            applies?: RecentApply[];
          };
          applies = body.applies ?? [];
        }
      } catch {
        /* server unreachable — show empty */
      }
      historyPanel.innerHTML = "";

      const title = document.createElement("div");
      title.className = "history-title";
      title.innerHTML = `<span>Recent edits</span><span>${applies.length}</span>`;
      historyPanel.appendChild(title);

      if (applies.length === 0) {
        const empty = document.createElement("div");
        empty.className = "history-empty";
        empty.textContent =
          "No edits yet. Drag a handle, press a shortcut, or click an element to start.";
        historyPanel.appendChild(empty);
        return;
      }

      const list = document.createElement("div");
      list.className = "history-list";
      // Newest first.
      const sorted = [...applies].sort((a, b) => b.appliedAt - a.appliedAt);
      for (const a of sorted) {
        const row = document.createElement("div");
        row.className = "history-row";
        const main = document.createElement("div");
        main.className = "history-row-main";
        const src = document.createElement("div");
        src.className = "history-source";
        src.textContent = `${a.file}:${a.line}:${a.col}`;
        const tokens = document.createElement("div");
        tokens.className = "history-tokens";
        for (const [cls, text] of [
          ["before", a.before],
          ["arrow", "→"],
          ["after", a.after],
        ] as const) {
          const sp = document.createElement("span");
          sp.className = cls;
          sp.textContent = text;
          tokens.appendChild(sp);
        }
        const time = document.createElement("div");
        time.className = "history-time";
        time.textContent = relativeTime(a.appliedAt);
        main.appendChild(src);
        main.appendChild(tokens);
        main.appendChild(time);
        const undo = document.createElement("button");
        undo.className = "btn-undo-row";
        undo.textContent = "Undo";
        undo.dataset.file = a.file;
        undo.dataset.line = String(a.line);
        undo.dataset.col = String(a.col);
        row.appendChild(main);
        row.appendChild(undo);
        list.appendChild(row);
      }
      historyPanel.appendChild(list);
    };

    // B8: asset picker panel
    const assetPicker = document.createElement("div");
    assetPicker.className = "asset-picker";
    shadow.appendChild(assetPicker);

    // B2b: CSS Module mutation panel
    const cssPanel = document.createElement("div");
    cssPanel.className = "css-panel";
    shadow.appendChild(cssPanel);

    let cssPanelTarget: HTMLElement | null = null;

    const hideCssPanel = () => {
      cssPanel.style.display = "none";
      cssPanelTarget = null;
    };

    // B3b: the panel is reused for two endpoints with the same shape:
    //   - CSS Modules (B2b) → POST /apply-css-prop
    //   - styled-components (B3b) → POST /apply-styled-prop
    // The selected element's data attributes tell us which to use.
    type CssPanelMode = "css-module" | "styled-component";

    const showCssPanel = (el: HTMLElement) => {
      const isCssModule = el.hasAttribute("data-css-module-class");
      const isStyled = el.hasAttribute("data-styled-name");
      if (!isCssModule && !isStyled) return;
      const mode: CssPanelMode = isCssModule ? "css-module" : "styled-component";
      const endpoint =
        mode === "css-module" ? "/apply-css-prop" : "/apply-styled-prop";

      const cssClass = el.getAttribute("data-css-module-class");
      const cssFile = el.getAttribute("data-css-module-file");
      const styledName = el.getAttribute("data-styled-name");
      const styledTag = el.getAttribute("data-styled-tag");

      // CSS Modules: the `{styles.x}` sits on the host element. styled:
      // the `<Card>` JSX is the call site (data-styled-* rides with
      // data-oid-call).
      const refs = refsFor(el);
      const ref = mode === "css-module" ? (refs.host ?? refs.call) : (refs.call ?? refs.host);
      if (!ref) return;
      const jsxFile = ref.file;
      const line = ref.line;
      const col = ref.col;

      cssPanelTarget = el;
      cssPanel.innerHTML = "";

      const title = document.createElement("div");
      title.className = "css-panel-title";
      title.textContent =
        mode === "css-module" ? "CSS Module" : "styled-components";
      cssPanel.appendChild(title);

      const meta = document.createElement("div");
      meta.className = "css-panel-meta";
      meta.textContent =
        mode === "css-module"
          ? `.${cssClass} in ${cssFile}`
          : `${styledName} = styled.${styledTag}\`…\``;
      cssPanel.appendChild(meta);

      const mkRow = (
        label: string,
        placeholder: string,
        cls: string,
      ): HTMLInputElement => {
        const row = document.createElement("div");
        row.className = "css-input-row";
        const lab = document.createElement("span");
        lab.className = "label";
        lab.textContent = label;
        const input = document.createElement("input");
        input.type = "text";
        input.className = cls;
        input.placeholder = placeholder;
        input.autocomplete = "off";
        input.spellcheck = false;
        row.appendChild(lab);
        row.appendChild(input);
        cssPanel.appendChild(row);
        return input;
      };
      const propInput = mkRow("property", "padding", "css-prop-input");
      const valInput = mkRow("value", "1.5rem", "css-val-input");

      const actions = document.createElement("div");
      actions.className = "css-panel-actions";
      const applyBtn = document.createElement("button");
      applyBtn.className = "btn-css-apply";
      applyBtn.textContent = "Apply";
      const closeBtn = document.createElement("button");
      closeBtn.className = "btn-css-close";
      closeBtn.textContent = "Close";
      actions.appendChild(applyBtn);
      actions.appendChild(closeBtn);
      cssPanel.appendChild(actions);

      const showResultLine = (text: string, kind: "success" | "error") => {
        const existing = cssPanel.querySelector(".css-panel-result");
        existing?.remove();
        const r = document.createElement("div");
        r.className = `css-panel-result ${kind}`;
        r.textContent = text;
        cssPanel.appendChild(r);
      };

      applyBtn.addEventListener("click", async () => {
        const property = propInput.value.trim();
        const value = valInput.value.trim();
        if (!property || !value) {
          showResultLine("Both property and value are required.", "error");
          return;
        }
        try {
          const res = await authedFetch(`${SERVER_URL}${endpoint}`, {
            method: "POST",
            body: JSON.stringify({
              file: jsxFile,
              line,
              col,
              property,
              value,
            }),
          });
          const body = (await res.json()) as
            | {
                ok: true;
                selector?: string;
                componentName?: string;
                previousValue: string | null;
              }
            | { ok: false; reason: string; details: string };
          if (res.ok && body.ok) {
            const target =
              "selector" in body && body.selector
                ? body.selector
                : "componentName" in body && body.componentName
                  ? body.componentName
                  : "(target)";
            const prev = body.previousValue
              ? `${property}: ${body.previousValue} → ${value}`
              : `${property}: ${value} (inserted)`;
            showResultLine(`Applied to ${target} — ${prev}`, "success");
            propInput.value = "";
            valInput.value = "";
            propInput.focus();
          } else if (!body.ok) {
            showResultLine(`Refused (${body.reason}): ${body.details}`, "error");
          }
        } catch (err) {
          showResultLine(`Network error: ${(err as Error).message}`, "error");
        }
      });

      closeBtn.addEventListener("click", () => {
        hideCssPanel();
      });

      cssPanel.style.display = "flex";
      // Focus the property input so the user can immediately type.
      window.setTimeout(() => propInput.focus(), 0);
    };

    const renderAssetPicker = async (imgEl: HTMLElement): Promise<void> => {
      let assets: string[] = [];
      try {
        const res = await authedFetch(`${SERVER_URL}/assets`, { method: "GET" });
        if (res.ok) {
          const body = (await res.json()) as {
            ok: boolean;
            assets?: string[];
          };
          assets = body.assets ?? [];
        }
      } catch {
        /* server unreachable */
      }
      // The src on the rendered DOM may not match source (e.g. next/image
      // optimization), so we display it as informational only.
      const currentSrc = (imgEl as HTMLImageElement).getAttribute("src") ?? "";

      assetPicker.innerHTML = "";
      const title = document.createElement("div");
      title.className = "asset-picker-title";
      title.innerHTML = `<span>Replace image</span><span>${assets.length} available</span>`;
      assetPicker.appendChild(title);

      if (assets.length === 0) {
        const empty = document.createElement("div");
        empty.className = "asset-empty";
        empty.textContent =
          "No images found under public/. Put a .png/.jpg/.svg/.webp/.avif/.gif there.";
        assetPicker.appendChild(empty);
        assetPicker.style.display = "flex";
        return;
      }

      const list = document.createElement("div");
      list.className = "asset-picker-list";
      for (const a of assets) {
        const row = document.createElement("div");
        row.className = "asset-row" + (a === currentSrc ? " current" : "");
        row.dataset.asset = a;
        const name = document.createElement("span");
        name.textContent = a;
        row.appendChild(name);
        if (a === currentSrc) {
          const cur = document.createElement("span");
          cur.className = "current-badge";
          cur.textContent = "current";
          row.appendChild(cur);
        }
        list.appendChild(row);
      }
      assetPicker.appendChild(list);
      assetPicker.style.display = "flex";
    };

    const hideAssetPicker = () => {
      assetPicker.style.display = "none";
    };

    assetPicker.addEventListener("click", async (e) => {
      const row = (e.target as HTMLElement | null)?.closest(
        ".asset-row",
      ) as HTMLElement | null;
      if (!row || !lastSelected) return;
      const picked = row.dataset.asset;
      if (!picked) return;

      // A literal <img> owns its src on the host ref; a component like
      // next/image only leaves a call-site ref on the DOM node.
      const refs = refsFor(lastSelected);
      const ref = refs.host ?? refs.call;
      if (!ref) return;
      const file = ref.file;
      const line = ref.line;
      const col = ref.col;

      try {
        const res = await authedFetch(`${SERVER_URL}/apply`, {
          method: "POST",
          body: JSON.stringify({
            file,
            line,
            col,
            attribute: "src",
            before: null,
            after: picked,
          }),
        });
        const body = (await res.json()) as
          | { ok: true; diff: string }
          | { ok: false; reason: string; details: string };
        if (res.ok && body.ok) {
          // Optimistic DOM swap.
          (lastSelected as HTMLImageElement).src = picked;
          hideAssetPicker();
          showResult(`Swapped image to ${picked}`, "success");
        } else if (!body.ok) {
          showResult(`Refused (${body.reason}): ${body.details}`, "error");
        }
      } catch (err) {
        showResult(
          `Network error: ${(err as Error).message}`,
          "error",
        );
      }
    });

    historyPanel.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement | null;
      if (!target || !target.classList.contains("btn-undo-row")) return;
      const file = target.dataset.file!;
      const line = Number(target.dataset.line);
      const col = Number(target.dataset.col);
      try {
        await authedFetch(`${SERVER_URL}/revert`, {
          method: "POST",
          body: JSON.stringify({ file, line, col }),
        });
        await renderHistory(); // refresh list
      } catch {
        /* surface this via showResult later if needed */
      }
    });

    // ---- Pins: annotated selections waiting for the agent -------------------
    type Pin = {
      id: string;
      status: "open" | "resolved";
      note: string;
      createdAt: number;
      resolution?: string;
      selection: {
        oid: string;
        file: string;
        line: number;
        col: number;
        tagName: string;
        componentName: string | null;
        callSite?: { oid: string; file: string; line: number; col: number } | null;
      };
    };
    let pins: Pin[] = [];
    const pinMarkers: HTMLElement[] = [];
    const pinsPanel = document.createElement("div");
    pinsPanel.className = "pins-panel";
    shadow.appendChild(pinsPanel);

    const pinElement = (pin: Pin): HTMLElement | null => {
      const host = queryInstances(pin.selection.oid, "data-oid")[0];
      if (host) return host;
      if (pin.selection.callSite) {
        return queryInstances(pin.selection.callSite.oid, "data-oid-call")[0] ?? null;
      }
      return null;
    };

    const positionPinMarkers = () => {
      for (const m of pinMarkers) {
        const pin = pins.find((p) => p.id === m.dataset.pin);
        const el = pin ? pinElement(pin) : null;
        if (!el) {
          m.style.display = "none";
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) {
          m.style.display = "none";
          continue;
        }
        m.style.display = "block";
        m.style.left = `${r.right - 4}px`;
        m.style.top = `${r.top + 4}px`;
      }
    };

    const renderPinMarkers = () => {
      for (const m of pinMarkers) m.remove();
      pinMarkers.length = 0;
      pins.forEach((pin, i) => {
        const m = document.createElement("div");
        m.className = "pin-marker" + (pin.status === "resolved" ? " resolved" : "");
        m.textContent = String(i + 1);
        m.title = pin.note || "(no note)";
        m.dataset.pin = pin.id;
        m.addEventListener("click", (e) => {
          e.stopPropagation();
          const el = pinElement(pin);
          if (el) acquire(el);
        });
        shadow.appendChild(m);
        pinMarkers.push(m);
      });
      positionPinMarkers();
      const open = pins.filter((p) => p.status === "open").length;
      pinCountEl.textContent = open > 0 ? String(open) : "";
    };

    const renderPinsPanel = () => {
      pinsPanel.innerHTML = "";
      const title = document.createElement("div");
      title.className = "history-title";
      const t1 = document.createElement("span");
      t1.textContent = "Pins for your agent";
      const t2 = document.createElement("span");
      t2.textContent = String(pins.length);
      title.append(t1, t2);
      pinsPanel.appendChild(title);
      if (pins.length === 0) {
        const empty = document.createElement("div");
        empty.className = "history-empty";
        empty.textContent =
          "No pins. Select an element, type a note, press Enter (or Pin). Then run /visual-editor in Claude Code.";
        pinsPanel.appendChild(empty);
        pinsPanel.style.display = "flex";
        return;
      }
      const list = document.createElement("div");
      list.className = "pins-list";
      pins.forEach((pin, i) => {
        const row = document.createElement("div");
        row.className = "pin-row" + (pin.status === "resolved" ? " resolved" : "");
        const idx = document.createElement("div");
        idx.className = "idx";
        idx.textContent = pin.status === "resolved" ? "✓" : String(i + 1);
        const main = document.createElement("div");
        const note = document.createElement("div");
        note.className = "note";
        note.textContent = pin.note || "(no note)";
        const src = document.createElement("div");
        src.className = "src";
        const s = pin.selection;
        src.textContent = `<${s.tagName}> ${s.componentName ? `in ${s.componentName} · ` : ""}${s.file}:${s.line}`;
        main.append(note, src);
        if (pin.resolution) {
          const res = document.createElement("div");
          res.className = "res";
          res.textContent = pin.resolution;
          main.appendChild(res);
        }
        const rm = document.createElement("button");
        rm.type = "button";
        rm.textContent = "Remove";
        rm.addEventListener("click", async (e) => {
          e.stopPropagation();
          await authedFetch(`${SERVER_URL}/pins`, {
            method: "DELETE",
            body: JSON.stringify({ id: pin.id }),
          }).catch(() => {});
          await refreshPins();
        });
        row.append(idx, main, rm);
        row.addEventListener("click", () => {
          const el = pinElement(pin);
          if (el) {
            el.scrollIntoView({ block: "center", behavior: "smooth" });
            acquire(el);
          }
        });
        list.appendChild(row);
      });
      pinsPanel.appendChild(list);
      const footer = document.createElement("div");
      footer.className = "pins-footer";
      const clearResolved = document.createElement("button");
      clearResolved.type = "button";
      clearResolved.textContent = "Clear resolved";
      clearResolved.addEventListener("click", async () => {
        await authedFetch(`${SERVER_URL}/pins`, {
          method: "DELETE",
          body: JSON.stringify({ onlyResolved: true }),
        }).catch(() => {});
        await refreshPins();
      });
      const clearAll = document.createElement("button");
      clearAll.type = "button";
      clearAll.textContent = "Clear all";
      clearAll.addEventListener("click", async () => {
        await authedFetch(`${SERVER_URL}/pins`, {
          method: "DELETE",
          body: JSON.stringify({}),
        }).catch(() => {});
        await refreshPins();
      });
      footer.append(clearResolved, clearAll);
      pinsPanel.appendChild(footer);
      pinsPanel.style.display = "flex";
    };

    const refreshPins = async (): Promise<void> => {
      try {
        const res = await authedFetch(`${SERVER_URL}/pins`, { method: "GET" });
        if (res.ok) {
          const body = (await res.json()) as { ok: boolean; pins?: Pin[] };
          pins = body.pins ?? [];
        }
      } catch {
        /* server unreachable — keep what we have */
      }
      renderPinMarkers();
      if (pinsPanel.style.display === "flex") renderPinsPanel();
      // Pins mean an agent may act on this page — listen for its events.
      if (pins.length > 0) ensureAgentEvents();
    };

    // ---- Toolbar handlers ---------------------------------------------------
    historyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      pinsPanel.style.display = "none";
      const isOpen = historyPanel.style.display === "flex";
      if (isOpen) {
        historyPanel.style.display = "none";
      } else {
        await renderHistory();
        historyPanel.style.display = "flex";
      }
    });
    pinsBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      historyPanel.style.display = "none";
      const isOpen = pinsPanel.style.display === "flex";
      if (isOpen) {
        pinsPanel.style.display = "none";
      } else {
        await refreshPins();
        renderPinsPanel();
      }
    });

    const hoverOutline = document.createElement("div");
    hoverOutline.className = "hover-outline";
    shadow.appendChild(hoverOutline);

    const hoverTag = document.createElement("div");
    hoverTag.className = "hover-tag";
    shadow.appendChild(hoverTag);

    // Eight box-model indicator bands (Chrome DevTools style).
    const makeIndicator = (cls: "indicator-pad" | "indicator-margin") => {
      const d = document.createElement("div");
      d.className = cls;
      shadow.appendChild(d);
      return d;
    };
    const indicators = {
      padTop: makeIndicator("indicator-pad"),
      padRight: makeIndicator("indicator-pad"),
      padBottom: makeIndicator("indicator-pad"),
      padLeft: makeIndicator("indicator-pad"),
      marTop: makeIndicator("indicator-margin"),
      marRight: makeIndicator("indicator-margin"),
      marBottom: makeIndicator("indicator-margin"),
      marLeft: makeIndicator("indicator-margin"),
    };

    const setBand = (
      el: HTMLElement,
      visible: boolean,
      left: number,
      top: number,
      width: number,
      height: number,
    ) => {
      if (!visible || width <= 0 || height <= 0) {
        el.style.display = "none";
        return;
      }
      el.style.display = "block";
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
    };

    const clearIndicators = () => {
      for (const el of Object.values(indicators)) el.style.display = "none";
    };

    const updateIndicators = (el: HTMLElement, rect: DOMRect) => {
      const cs = getComputedStyle(el);
      const p = {
        t: parseFloat(cs.paddingTop) || 0,
        r: parseFloat(cs.paddingRight) || 0,
        b: parseFloat(cs.paddingBottom) || 0,
        l: parseFloat(cs.paddingLeft) || 0,
      };
      const m = {
        t: parseFloat(cs.marginTop) || 0,
        r: parseFloat(cs.marginRight) || 0,
        b: parseFloat(cs.marginBottom) || 0,
        l: parseFloat(cs.marginLeft) || 0,
      };
      // Padding (inside, between border and content)
      setBand(indicators.padTop, p.t > 0, rect.left, rect.top, rect.width, p.t);
      setBand(
        indicators.padBottom,
        p.b > 0,
        rect.left,
        rect.bottom - p.b,
        rect.width,
        p.b,
      );
      setBand(
        indicators.padLeft,
        p.l > 0,
        rect.left,
        rect.top + p.t,
        p.l,
        rect.height - p.t - p.b,
      );
      setBand(
        indicators.padRight,
        p.r > 0,
        rect.right - p.r,
        rect.top + p.t,
        p.r,
        rect.height - p.t - p.b,
      );
      // Margin (outside the element). Top/bottom span the full extended
      // width including side margins; left/right span only the element
      // height — avoids double-painted corners.
      setBand(
        indicators.marTop,
        m.t > 0,
        rect.left - m.l,
        rect.top - m.t,
        rect.width + m.l + m.r,
        m.t,
      );
      setBand(
        indicators.marBottom,
        m.b > 0,
        rect.left - m.l,
        rect.bottom,
        rect.width + m.l + m.r,
        m.b,
      );
      setBand(indicators.marLeft, m.l > 0, rect.left - m.l, rect.top, m.l, rect.height);
      setBand(indicators.marRight, m.r > 0, rect.right, rect.top, m.r, rect.height);
    };

    // Alt-hover distance measurement: show the anchor outline + a
    // labelled gap distance between the Moveable target (or last shift-
    // clicked element) and the currently hovered element.
    const anchorOutline = document.createElement("div");
    anchorOutline.className = "anchor-outline";
    shadow.appendChild(anchorOutline);
    const distanceLabel = document.createElement("div");
    distanceLabel.className = "distance-label";
    shadow.appendChild(distanceLabel);
    const distanceLineH = document.createElement("div");
    distanceLineH.className = "distance-line";
    shadow.appendChild(distanceLineH);
    const distanceLineV = document.createElement("div");
    distanceLineV.className = "distance-line";
    shadow.appendChild(distanceLineV);

    const measureSet: HTMLElement[] = [];

    const moveableContainer = document.createElement("div");
    moveableContainer.className = "moveable-container";
    shadow.appendChild(moveableContainer);

    // Bottom-left selection panel: where the edit will land (host vs call
    // site, editable or not), the note for the agent, pin/copy actions, and
    // the shortcut cheat sheet for THIS element's class tokens.
    const shortcutsHint = document.createElement("div");
    shortcutsHint.className = "sel-panel";
    shadow.appendChild(shortcutsHint);

    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.className = "sel-note-input";
    noteInput.placeholder = "Note for your agent… (Enter = pin)";
    noteInput.autocomplete = "off";
    noteInput.spellcheck = false;
    noteInput.addEventListener("input", () => {
      currentNote = noteInput.value.trim() || null;
    });
    noteInput.addEventListener("keydown", (e) => {
      // Keep the page-level shortcuts (] [ i esc) out of the text field.
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        void addPin();
      } else if (e.key === "Escape") {
        noteInput.blur();
      }
    });

    const describeClassName = (ctx: ElementContext): string => {
      const c = ctx.className;
      if (!c) return "";
      switch (c.kind) {
        case "static":
          return c.tokens.length ? c.tokens.join(" ") : "(empty className)";
        case "merger":
          return `${c.callee}(${c.tokens.join(" ")}${c.dynamicArgs ? ` +${c.dynamicArgs} dynamic` : ""})`;
        case "template":
          return "template literal";
        case "conditional":
          return "conditional";
        case "dynamic":
          return "dynamic expression";
        case "none":
          return c.spread ? "no className (props spread)" : "no className";
      }
    };

    /** Plain-text context block for any agent (clipboard / paste). */
    const buildAgentContext = (el: HTMLElement): string => {
      const refs = refsFor(el);
      const sel = currentSelection;
      const lines: string[] = [];
      const primary = refs.host ?? refs.call;
      const comp =
        sel?.refs.find((r) => r.role === "host")?.componentName ??
        sel?.componentName ??
        nameFromDataOid(primary?.oid ?? null);
      lines.push(
        `[visual-editor] <${el.tagName.toLowerCase()}>${comp ? ` in ${comp}` : ""}${primary ? ` — ${primary.file}:${primary.line}:${primary.col}` : ""}`,
      );
      if (refs.host && refs.call) {
        const callCtx = sel?.refs.find((r) => r.role === "call");
        lines.push(
          `used at: ${refs.call.file}:${refs.call.line}:${refs.call.col}${callCtx?.componentName ? ` (in ${callCtx.componentName})` : ""}`,
        );
      }
      if (sel) {
        for (const r of sel.refs) {
          if (!r.found) continue;
          lines.push(
            `className @ ${r.role === "call" ? "call site" : "host"}: ${describeClassName(r)}${r.editable ? "" : ` — not editable: ${r.reason ?? ""}`}`,
          );
        }
      } else {
        lines.push(`className (DOM): ${el.className}`);
      }
      const rect = el.getBoundingClientRect();
      const computed = collectComputed(el);
      const facts = [
        `${Math.round(rect.width)}×${Math.round(rect.height)}px`,
        ...["padding", "margin", "gap", "font-size", "display"]
          .filter((k) => computed[k])
          .map((k) => `${k} ${computed[k]}`),
      ];
      const count = primary ? queryInstances(primary.oid, primary.attribute).length : 1;
      lines.push(`renders ${count} instance${count === 1 ? "" : "s"} · ${facts.join(" · ")}`);
      lines.push(`page: ${location.pathname}${location.search}`);
      if (currentNote) lines.push(`note: ${currentNote}`);
      return lines.join("\n");
    };

    const copyContext = async () => {
      if (!lastSelected) return;
      const text = buildAgentContext(lastSelected);
      try {
        await navigator.clipboard.writeText(text);
        showResult("Copied context for your agent — paste it into Claude Code / Cursor / Codex.", "success");
      } catch {
        showResult("Clipboard blocked by the browser. Context is in the console.", "error");
        console.log(text);
      }
    };

    const addPin = async () => {
      if (!lastSelected) return;
      const payload = buildSelectionPayload(lastSelected, currentNote);
      if (!payload) return;
      try {
        const res = await authedFetch(`${SERVER_URL}/pins`, {
          method: "POST",
          body: JSON.stringify({ note: currentNote ?? "", selection: payload }),
        });
        const body = (await res.json()) as { ok: boolean; pin?: Pin; reason?: string; details?: string };
        if (res.ok && body.ok) {
          noteInput.value = "";
          currentNote = null;
          await refreshPins();
          showResult(
            `Pinned (#${pins.length}). Run /visual-editor in Claude Code to process pins.`,
            "success",
          );
        } else {
          showResult(`Could not pin (${body.reason}): ${body.details}`, "error");
        }
      } catch (err) {
        showResult(`Network error: ${(err as Error).message}`, "error");
      }
    };

    const updateShortcutsHint = (el: HTMLElement) => {
      const tokens = tokensFor(el);
      const hasPrefix = (prefixes: readonly string[]) =>
        tokens.some((t) =>
          prefixes.some(
            (p) =>
              t.startsWith(p + "-") &&
              NUMERIC_SUFFIX_RE.test(t.slice(p.length + 1)),
          ),
        );
      const hasW = hasPrefix(["w"]);
      const hasH = hasPrefix(["h"]);
      const hasPad = hasPrefix(["p", "px", "py", "pt", "pr", "pb", "pl"]);
      const hasMar = hasPrefix(["m", "mx", "my", "mt", "mr", "mb", "ml"]);
      const hasGap = hasPrefix(["gap", "gap-x", "gap-y"]);
      const isImg = el.tagName.toLowerCase() === "img";
      const refs = refsFor(el);
      const sel = currentSelection;
      const primary = refs.host ?? refs.call;

      shortcutsHint.innerHTML = "";

      // Header: <Component> tag · file:line:col
      const head = document.createElement("div");
      head.className = "sel-head";
      const comp =
        sel?.refs.find((r) => r.role === "host")?.componentName ??
        nameFromDataOid(primary?.oid ?? null);
      const compSpan = document.createElement("span");
      compSpan.className = "comp";
      compSpan.textContent = comp ? `<${comp}> ` : "";
      const tagSpan = document.createElement("span");
      tagSpan.className = "tag";
      tagSpan.textContent = el.tagName.toLowerCase();
      head.append(compSpan, tagSpan);
      shortcutsHint.appendChild(head);

      // One line per source ref: where an edit would land + editability.
      const refLine = (
        label: string,
        ref: SourceRef,
        ctx: ElementContext | undefined,
      ) => {
        const d = document.createElement("div");
        d.className = "sel-ref";
        const role = document.createElement("span");
        role.className = "role";
        role.textContent = `${label} `;
        d.appendChild(role);
        const where = document.createElement("span");
        where.textContent = `${ref.file}:${ref.line}:${ref.col}`;
        d.appendChild(where);
        if (ctx && ctx.found) {
          const status = document.createElement("span");
          status.className = ctx.editable ? "ok" : "no";
          status.textContent = ctx.editable ? " · editable" : " · refused";
          status.title = ctx.reason ?? "";
          d.appendChild(status);
          const tk = document.createElement("div");
          tk.className = "tokens";
          tk.textContent = describeClassName(ctx);
          d.appendChild(tk);
        } else if (ctx && !ctx.found) {
          const status = document.createElement("span");
          status.className = "no";
          status.textContent = ` · ${ctx.reason ?? "not found"}`;
          d.appendChild(status);
        } else if (!sel) {
          const status = document.createElement("span");
          status.textContent = " · describing…";
          d.appendChild(status);
        }
        shortcutsHint.appendChild(d);
      };
      if (refs.call) refLine("call site", refs.call, sel?.refs.find((r) => r.role === "call"));
      if (refs.host) refLine(refs.call ? "component" : "source", refs.host, sel?.refs.find((r) => r.role === "host"));
      if (!refs.host && !refs.call) {
        const d = document.createElement("div");
        d.className = "sel-ref no";
        d.textContent = "No data-oid on this element — is the visual-editor loader active for this file?";
        shortcutsHint.appendChild(d);
      }

      // Note + actions for the agent.
      const noteRow = document.createElement("div");
      noteRow.className = "sel-note";
      noteRow.appendChild(noteInput);
      shortcutsHint.appendChild(noteRow);
      const actions = document.createElement("div");
      actions.className = "sel-actions";
      const pinBtn = document.createElement("button");
      pinBtn.type = "button";
      pinBtn.className = "btn-pin";
      pinBtn.textContent = "Pin for agent";
      pinBtn.addEventListener("click", () => void addPin());
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn-copy";
      copyBtn.textContent = "Copy context";
      copyBtn.addEventListener("click", () => void copyContext());
      actions.append(pinBtn, copyBtn);
      shortcutsHint.appendChild(actions);

      // Shortcut cheat sheet (static markup only — nothing user-derived).
      const line = (label: string, keys: string, enabled: boolean): string =>
        `<div class="${enabled ? "available" : "disabled"}">${keys} → ${label}${enabled ? "" : " (no class on this element)"}</div>`;
      const sc = document.createElement("div");
      sc.className = "sel-shortcuts";
      sc.innerHTML =
        `<div class="hint-title">Editable via:</div>` +
        line("resize width / height", "drag side handles", hasW || hasH) +
        line("padding (per side)", "drag teal bars · <kbd>]</kbd> <kbd>[</kbd>", hasPad) +
        line("margin", "<kbd>}</kbd> <kbd>{</kbd> (shift+])", hasMar) +
        line("gap (flex/grid)", "<kbd>alt+]</kbd> <kbd>alt+[</kbd>", hasGap) +
        line("width / height nudge", "<kbd>alt+→</kbd> <kbd>alt+↓</kbd>", hasW || hasH) +
        line("replace image asset", "<kbd>i</kbd>", isImg) +
        `<div class="disabled" style="margin-top:4px;">deselect: <kbd>esc</kbd> · alt-hover for distance · shift-click to set anchor · <kbd>ctrl+shift+e</kbd> toggles edit mode</div>`;
      shortcutsHint.appendChild(sc);
      shortcutsHint.style.display = "flex";
    };
    onSelectionDescribed = (el) => {
      if (lastSelected === el) updateShortcutsHint(el);
    };

    const hideShortcutsHint = () => {
      shortcutsHint.style.display = "none";
    };

    // Figma-style padding handles: 4 circles at the inner edges of the
    // padding band on the selected element. Dragging changes only that
    // side's padding; release snaps to scale and proposes a change.
    type PaddingSide = "top" | "right" | "bottom" | "left";
    const paddingHandles: Record<PaddingSide, HTMLElement> = {
      top: document.createElement("div"),
      right: document.createElement("div"),
      bottom: document.createElement("div"),
      left: document.createElement("div"),
    };
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const h = paddingHandles[side];
      h.className = `padding-handle padding-handle-${side}`;
      shadow.appendChild(h);
    }

    const hidePaddingHandles = () => {
      for (const side of ["top", "right", "bottom", "left"] as const) {
        paddingHandles[side].style.display = "none";
      }
    };

    const positionPaddingHandles = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const pt = parseFloat(cs.paddingTop) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      const pb = parseFloat(cs.paddingBottom) || 0;
      const pl = parseFloat(cs.paddingLeft) || 0;
      const hasAnyPadding = pt > 0 || pr > 0 || pb > 0 || pl > 0;
      if (!hasAnyPadding) {
        hidePaddingHandles();
        return;
      }
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const showAt = (h: HTMLElement, x: number, y: number) => {
        h.style.display = "block";
        h.style.left = `${x}px`;
        h.style.top = `${y}px`;
      };
      // Inner edge of each padding band.
      if (pt > 0) showAt(paddingHandles.top, cx, rect.top + pt);
      else paddingHandles.top.style.display = "none";
      if (pb > 0) showAt(paddingHandles.bottom, cx, rect.bottom - pb);
      else paddingHandles.bottom.style.display = "none";
      if (pl > 0) showAt(paddingHandles.left, rect.left + pl, cy);
      else paddingHandles.left.style.display = "none";
      if (pr > 0) showAt(paddingHandles.right, rect.right - pr, cy);
      else paddingHandles.right.style.display = "none";
    };

    const cssSideKey = (side: PaddingSide) =>
      ({
        top: "paddingTop",
        right: "paddingRight",
        bottom: "paddingBottom",
        left: "paddingLeft",
      })[side] as "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft";

    const setupPaddingDrag = (handle: HTMLElement, side: PaddingSide) => {
      handle.addEventListener("pointerdown", (ev) => {
        if (!lastSelected) return;
        ev.preventDefault();
        ev.stopPropagation();
        const target = lastSelected;
        const cssKey = cssSideKey(side);
        const startX = ev.clientX;
        const startY = ev.clientY;
        const startPad =
          parseFloat(getComputedStyle(target)[cssKey] as string) || 0;
        handle.setPointerCapture(ev.pointerId);

        const onMove = (mv: PointerEvent) => {
          let delta = 0;
          if (side === "top") delta = mv.clientY - startY;
          else if (side === "bottom") delta = -(mv.clientY - startY);
          else if (side === "left") delta = mv.clientX - startX;
          else if (side === "right") delta = -(mv.clientX - startX);
          const next = Math.max(0, startPad + delta);
          target.style[cssKey] = `${next}px`;
          positionPaddingHandles(target);
        };
        const onUp = (mv: PointerEvent) => {
          handle.releasePointerCapture(mv.pointerId);
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          const finalPx =
            parseFloat(getComputedStyle(target)[cssKey] as string) || 0;
          proposePaddingSideChange(target, side, finalPx);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      });
    };
    for (const side of ["top", "right", "bottom", "left"] as const) {
      setupPaddingDrag(paddingHandles[side], side);
    }

    const SIDE_PREFIX: Record<PaddingSide, string> = {
      top: "pt",
      right: "pr",
      bottom: "pb",
      left: "pl",
    };
    const AXIS_PREFIX: Record<PaddingSide, "px" | "py"> = {
      top: "py",
      bottom: "py",
      left: "px",
      right: "px",
    };

    // Padding handle drag → snap → propose.
    // Priority for which token to mutate:
    //   1. side-specific (`pt-*`) — bump directly
    //   2. axis (`py-*`) or shorthand (`p-*`) — append override (`p-4` → `p-4 pt-5`)
    const proposePaddingSideChange = (
      target: HTMLElement,
      side: PaddingSide,
      newPx: number,
    ) => {
      const sidePrefix = SIDE_PREFIX[side];
      const axisPrefix = AXIS_PREFIX[side];
      const tokens = tokensFor(target);
      const numericSuffix = NUMERIC_SUFFIX_RE;

      const sideToken = tokens.find(
        (t) =>
          t.startsWith(sidePrefix + "-") &&
          numericSuffix.test(t.slice(sidePrefix.length + 1)),
      );

      const spacingPx = getSpacingPx();
      const snap = snapToTailwind(newPx, spacingPx);

      if (sideToken) {
        const newToken = `${sidePrefix}-${snap.suffix}`;
        if (newToken === sideToken) {
          clearInlineSizing(target);
          return;
        }
        proposeTokenChange(target, sideToken, newToken, snap.resolvedPx);
        return;
      }

      const axisToken = tokens.find(
        (t) =>
          t.startsWith(axisPrefix + "-") &&
          numericSuffix.test(t.slice(axisPrefix.length + 1)),
      );
      const shortToken = tokens.find(
        (t) =>
          t.startsWith("p-") && numericSuffix.test(t.slice("p-".length)),
      );
      const base = axisToken ?? shortToken;
      if (!base) {
        showResult(
          `This element has no padding class (no p-*, ${axisPrefix}-*, or ${sidePrefix}-*). Drag handles need an existing padding token to mutate.`,
          "error",
        );
        clearInlineSizing(target);
        return;
      }
      const overrideToken = `${sidePrefix}-${snap.suffix}`;
      // The writer's swapToken splits on whitespace. Swapping the base
      // token for "<base> <override>" appends the override while leaving
      // the base in place. twMerge resolves the conflict to <override>.
      proposeTokenChange(
        target,
        base,
        `${base} ${overrideToken}`,
        snap.resolvedPx,
      );
    };

    const pendingPanel = document.createElement("div");
    pendingPanel.className = "pending-panel";
    shadow.appendChild(pendingPanel);

    let moveable: Moveable | null = null;
    let lastSelected: HTMLElement | null = null;
    let hoverTarget: HTMLElement | null = null;
    let rafId = 0;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let lastResizeWidth: number | null = null;
    let pending: PendingChange | null = null;
    const instanceOutlines: HTMLElement[] = [];

    const refsFor = (el: HTMLElement) => getRefs(el);

    /**
     * Static class tokens per source ref, call site first: a `<Card
     * className="p-4">` call site overrides the component's own `p-6`
     * (cn(base, className) semantics), so it's the location whose token
     * actually paints. Falls back to the DOM className when the server
     * hasn't described this element.
     */
    const tokenSourcesFor = (
      el: HTMLElement,
    ): Array<{ ref: SourceRef; tokens: string[]; editable: boolean }> => {
      const refs = refsFor(el);
      const out: Array<{ ref: SourceRef; tokens: string[]; editable: boolean }> = [];
      const sel = currentSelection;
      const described =
        sel && refs.host && sel.oid === refs.host.oid
          ? sel.refs
          : sel && refs.call && !refs.host && sel.callSite?.oid === refs.call.oid
            ? sel.refs
            : null;
      if (described) {
        for (const ctx of described) {
          const ref = ctx.role === "call" ? refs.call : refs.host;
          if (!ref || !ctx.found) continue;
          const tokens =
            ctx.className && (ctx.className.kind === "static" || ctx.className.kind === "merger")
              ? ctx.className.tokens
              : [];
          out.push({ ref, tokens, editable: ctx.editable });
        }
        // Call site first.
        out.sort((a, b) => (a.ref.attribute === b.ref.attribute ? 0 : a.ref.attribute === "data-oid-call" ? -1 : 1));
      }
      if (out.length === 0) {
        const ref = refs.host ?? refs.call;
        if (ref) {
          out.push({
            ref,
            tokens: el.className.split(/\s+/).filter(Boolean),
            editable: true,
          });
        }
      }
      return out;
    };

    /** Union of all static tokens that could describe this element. */
    const tokensFor = (el: HTMLElement): string[] => {
      const seen = new Set<string>();
      for (const src of tokenSourcesFor(el)) for (const t of src.tokens) seen.add(t);
      if (seen.size === 0) for (const t of el.className.split(/\s+/)) if (t) seen.add(t);
      return [...seen];
    };

    /** The ref that owns `token` (call site wins), else the primary ref. */
    const pickRefForToken = (el: HTMLElement, token: string): SourceRef | null => {
      const sources = tokenSourcesFor(el);
      for (const src of sources) if (src.tokens.includes(token)) return src.ref;
      const refs = refsFor(el);
      return sources[0]?.ref ?? refs.host ?? refs.call;
    };

    const NUMERIC_SUFFIX_RE = /^(-?\d+(?:\.\d+)?|\[[^\]]+\])$/;

    /** First token matching one of `prefixes`, with the ref that owns it. */
    const findEditableToken = (
      el: HTMLElement,
      prefixes: readonly string[],
    ): { token: string; ref: SourceRef } | null => {
      for (const src of tokenSourcesFor(el)) {
        for (const p of prefixes) {
          for (const t of src.tokens) {
            if (t.startsWith(p + "-") && NUMERIC_SUFFIX_RE.test(t.slice(p.length + 1))) {
              return { token: t, ref: src.ref };
            }
          }
        }
      }
      return null;
    };

    // Principle 11: when one source location (data-oid) renders N DOM nodes,
    // mutating its className updates all N. We surface this blast radius by
    // (a) counting matching elements, (b) outlining the *other* instances
    // with a dashed amber border so the user sees what they're about to
    // touch, and (c) showing the count in the pending panel.
    const queryInstances = (
      oid: string,
      attribute: "data-oid" | "data-oid-call" = "data-oid",
    ): HTMLElement[] => {
      // CSS attribute selectors need double quotes escaped; the data-oid
      // value contains `:` which is selector-safe inside quotes.
      const escaped = oid.replace(/"/g, '\\"');
      const nodes = document.querySelectorAll(`[${attribute}="${escaped}"]`);
      const out: HTMLElement[] = [];
      nodes.forEach((n) => {
        if (n instanceof HTMLElement) out.push(n);
      });
      return out;
    };

    const clearInstanceOutlines = () => {
      for (const node of instanceOutlines) node.remove();
      instanceOutlines.length = 0;
    };

    const drawInstanceOutlines = (instances: HTMLElement[], selected: HTMLElement) => {
      clearInstanceOutlines();
      for (const el of instances) {
        if (el === selected) continue; // Moveable already shows the selected one
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const outline = document.createElement("div");
        outline.className = "instance-outline";
        outline.style.left = `${rect.left}px`;
        outline.style.top = `${rect.top}px`;
        outline.style.width = `${rect.width}px`;
        outline.style.height = `${rect.height}px`;
        shadow.appendChild(outline);
        instanceOutlines.push(outline);
      }
    };

    const showPending = (change: PendingChange, resolvedPx: number) => {
      pending = change;
      pendingPanel.innerHTML = "";
      hidePaddingHandles();

      const oid = change.ref.oid;

      // B5: persist the draft so a page reload doesn't blow it away. The
      // change.element reference can't be serialized — we save the
      // data-oid and re-resolve on next mount.
      saveDraft({
        file: change.file,
        line: change.line,
        col: change.col,
        before: change.before,
        after: change.after,
        oid,
        attribute: change.ref.attribute,
        resolvedPx,
      });

      const instances = queryInstances(oid, change.ref.attribute);
      const instanceCount = instances.length;

      const header = document.createElement("div");
      header.className = "pending-header";
      header.textContent =
        `${change.file}:${change.line}:${change.col}` +
        (change.ref.attribute === "data-oid-call" ? "  (call site)" : "");

      const body = document.createElement("div");
      body.className = "pending-body";
      const mkSpan = (cls: string, text: string) => {
        const sp = document.createElement("span");
        sp.className = cls;
        sp.textContent = text;
        return sp;
      };
      body.appendChild(mkSpan("before", change.before));
      body.appendChild(mkSpan("arrow", "→"));
      body.appendChild(mkSpan("after", change.after));
      body.appendChild(mkSpan("resolved", `${Math.round(resolvedPx)}px`));

      pendingPanel.appendChild(header);
      pendingPanel.appendChild(body);

      // If the server already told us this location can't take a token
      // swap, say so up front (Apply still goes to the server — it's the
      // authority — but the user shouldn't be surprised by the refusal).
      const described = currentSelection?.refs.find(
        (r) =>
          r.ref.file === change.ref.file &&
          r.ref.line === change.ref.line &&
          r.ref.col === change.ref.col,
      );
      if (described && described.found && !described.editable) {
        const warnEl = document.createElement("div");
        warnEl.className = "pending-instances";
        warnEl.textContent = `Heads-up: ${described.reason ?? "this location isn't editable"} Apply will be refused; edit the source by hand or via your agent.`;
        pendingPanel.appendChild(warnEl);
      }

      // Principle 11: surface blast radius before commit.
      if (instanceCount > 1) {
        const banner = document.createElement("div");
        banner.className = "pending-instances";
        banner.textContent = `Edits ${instanceCount} elements rendered from this source location.`;
        pendingPanel.appendChild(banner);
        drawInstanceOutlines(instances, change.element);
      } else {
        clearInstanceOutlines();
      }

      const actions = document.createElement("div");
      actions.className = "pending-actions";
      const apply = document.createElement("button");
      apply.className = "btn-apply";
      apply.textContent = instanceCount > 1 ? `Apply to ${instanceCount}` : "Apply";
      const discard = document.createElement("button");
      discard.className = "btn-discard";
      discard.textContent = "Discard";
      actions.appendChild(apply);
      actions.appendChild(discard);
      pendingPanel.appendChild(actions);
      pendingPanel.style.display = "flex";
    };

    const clearInlineSizing = (el: HTMLElement) => {
      el.style.width = "";
      el.style.height = "";
      el.style.transform = "";
      // Padding inline styles are set by the padding-handle drag — clear
      // them too so the new className paints when Fast Refresh fires.
      el.style.paddingTop = "";
      el.style.paddingRight = "";
      el.style.paddingBottom = "";
      el.style.paddingLeft = "";
    };

    const hidePending = () => {
      pending = null;
      pendingPanel.style.display = "none";
      clearInstanceOutlines();
      clearDraft();
    };

    let resultDismissTimer: number | null = null;
    let lastApplied: PendingChange | null = null;

    const showResult = (message: string, kind: "success" | "error") => {
      pendingPanel.innerHTML = "";
      const r = document.createElement("div");
      r.className = `pending-result ${kind}`;
      r.textContent = message;
      pendingPanel.appendChild(r);
      pendingPanel.style.display = "flex";
      if (resultDismissTimer !== null) window.clearTimeout(resultDismissTimer);
      resultDismissTimer = window.setTimeout(() => {
        if (!pending) pendingPanel.style.display = "none";
      }, 3500);
    };

    // After a successful Apply, show "Applied: X → Y · Undo" with a button
    // that calls /revert. Auto-dismiss after 6s.
    const showSuccessWithUndo = (change: PendingChange) => {
      lastApplied = change;
      pendingPanel.innerHTML = "";

      const r = document.createElement("div");
      r.className = "pending-result success";
      r.textContent = `Applied: ${change.before} → ${change.after}`;
      pendingPanel.appendChild(r);

      const actions = document.createElement("div");
      actions.className = "pending-actions";
      const undo = document.createElement("button");
      undo.className = "btn-undo";
      undo.textContent = "Undo";
      const dismiss = document.createElement("button");
      dismiss.className = "btn-discard";
      dismiss.textContent = "Dismiss";
      actions.appendChild(undo);
      actions.appendChild(dismiss);
      pendingPanel.appendChild(actions);
      pendingPanel.style.display = "flex";

      if (resultDismissTimer !== null) window.clearTimeout(resultDismissTimer);
      resultDismissTimer = window.setTimeout(() => {
        if (!pending) pendingPanel.style.display = "none";
        lastApplied = null;
      }, 6000);
    };

    pendingPanel.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement | null;
      if (!target || !pending) return;
      const change = pending;
      if (target.classList.contains("btn-apply")) {
        try {
          const res = await authedFetch(`${SERVER_URL}/apply`, {
            method: "POST",
            body: JSON.stringify({
              file: change.file,
              line: change.line,
              col: change.col,
              before: change.before,
              after: change.after,
            }),
          });
          const body = (await res.json()) as
            | { ok: true; diff: string }
            | { ok: false; reason: string; details: string };
          if (res.ok && body.ok) {
            // Optimistic DOM patch: swap the className on every instance
            // sharing this data-oid so the user sees the new state
            // immediately. For Client Components Fast Refresh quickly
            // catches up; for Server Components the route segment refresh
            // takes longer, and without this patch the user would see a
            // stale view for ~200ms. After patch, clear inline sizing so
            // the new class can paint cleanly.
            const targets = queryInstances(change.ref.oid, change.ref.attribute);
            for (const target of targets.length ? targets : [change.element]) {
              target.className = swapClassToken(
                target.className,
                change.before,
                change.after,
              );
              clearInlineSizing(target);
            }
            // The class swap changes the box; keep Moveable's control box
            // glued to the new geometry.
            moveable?.updateRect();
            if (currentSelection && lastSelected === change.element) {
              void pushSelectionToServer(change.element);
            }
            pending = null;
            clearInstanceOutlines();
            clearDraft();
            // The optimistic DOM patch above already paints the new state.
            // For RSC content (route segment refresh path) Fast Refresh
            // catches up within a few hundred ms; the className swap on
            // every matching DOM node keeps the view stable until then.
            showSuccessWithUndo(change);
            // Re-place the padding handles using the now-updated computed
            // styles (the className change may have grown or shrunk the
            // padding band).
            if (lastSelected) positionPaddingHandles(lastSelected);
          } else if (!body.ok) {
            showResult(`Refused (${body.reason}): ${body.details}`, "error");
          }
        } catch (err) {
          showResult(
            `Network error: ${(err as Error).message}. Is the dev server (or visual-editor-server) running?`,
            "error",
          );
        }
      } else if (target.classList.contains("btn-discard")) {
        // Discard while a pending change exists; otherwise just dismiss
        // the result panel (e.g., after a successful Apply).
        if (pending) {
          clearInlineSizing(pending.element);
          hidePending();
        } else {
          pendingPanel.style.display = "none";
          lastApplied = null;
        }
        if (lastSelected) positionPaddingHandles(lastSelected);
      } else if (target.classList.contains("btn-undo") && lastApplied) {
        const change = lastApplied;
        try {
          const res = await authedFetch(`${SERVER_URL}/revert`, {
            method: "POST",
            body: JSON.stringify({
              file: change.file,
              line: change.line,
              col: change.col,
            }),
          });
          const body = (await res.json()) as
            | { ok: true; diff: string }
            | { ok: false; reason: string; details: string };
          if (res.ok && body.ok) {
            lastApplied = null;
            showResult(`Reverted: ${change.after} → ${change.before}`, "success");
          } else if (!body.ok) {
            showResult(
              `Could not undo (${body.reason}): ${body.details}`,
              "error",
            );
          }
        } catch (err) {
          showResult(
            `Network error during undo: ${(err as Error).message}`,
            "error",
          );
        }
      }
    });

    const isOverlayEl = (el: Element | null): boolean => {
      if (!el) return true;
      if (el.tagName.toLowerCase() === ANCHOR_TAG) return true;
      if (el.closest(ANCHOR_TAG)) return true;
      // Don't try to select Next.js's dev-tools UI.
      if (el.closest("[data-nextjs-dev-tools-button]")) return true;
      if (el.closest("nextjs-portal")) return true;
      return false;
    };

    const clearDistanceOverlay = () => {
      anchorOutline.style.display = "none";
      distanceLabel.style.display = "none";
      distanceLineH.style.display = "none";
      distanceLineV.style.display = "none";
    };

    const showDistanceBetween = (anchor: HTMLElement, hovered: HTMLElement) => {
      if (anchor === hovered) {
        clearDistanceOverlay();
        return;
      }
      const a = anchor.getBoundingClientRect();
      const b = hovered.getBoundingClientRect();

      anchorOutline.style.display = "block";
      anchorOutline.style.left = `${a.left}px`;
      anchorOutline.style.top = `${a.top}px`;
      anchorOutline.style.width = `${a.width}px`;
      anchorOutline.style.height = `${a.height}px`;

      // Horizontal and vertical gaps between bounding boxes.
      // dx positive → hovered is to the right of the anchor; negative → overlap;
      // 0 means edges touch. Mirror for dy.
      let dx = 0;
      if (b.left >= a.right) dx = b.left - a.right;
      else if (b.right <= a.left) dx = b.right - a.left; // negative
      let dy = 0;
      if (b.top >= a.bottom) dy = b.top - a.bottom;
      else if (b.bottom <= a.top) dy = b.bottom - a.top; // negative

      // Position the label at the midpoint of the rectangle joining the
      // two centers. Easy and unambiguous.
      const ax = (a.left + a.right) / 2;
      const ay = (a.top + a.bottom) / 2;
      const bx = (b.left + b.right) / 2;
      const by = (b.top + b.bottom) / 2;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      distanceLabel.textContent = `↔ ${Math.round(Math.abs(dx))}px · ↕ ${Math.round(Math.abs(dy))}px`;
      distanceLabel.style.display = "block";
      distanceLabel.style.left = `${mx + 8}px`;
      distanceLabel.style.top = `${my + 8}px`;

      // Draw horizontal line from anchor's nearest x-edge to hovered's nearest x-edge,
      // at the midpoint y of the smaller element. Same for vertical.
      const drawHLine = () => {
        const y = my;
        const x1 = Math.min(a.right, b.right) > Math.max(a.left, b.left)
          ? // overlap horizontally — skip line, dx is 0/negative
            null
          : ax < bx ? a.right : a.left;
        const x2 = x1 === null ? null : ax < bx ? b.left : b.right;
        if (x1 === null || x2 === null) {
          distanceLineH.style.display = "none";
          return;
        }
        distanceLineH.style.display = "block";
        distanceLineH.style.left = `${Math.min(x1, x2)}px`;
        distanceLineH.style.top = `${y}px`;
        distanceLineH.style.width = `${Math.abs(x2 - x1)}px`;
        distanceLineH.style.height = `1px`;
      };
      const drawVLine = () => {
        const x = mx;
        const y1 = Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)
          ? null
          : ay < by ? a.bottom : a.top;
        const y2 = y1 === null ? null : ay < by ? b.top : b.bottom;
        if (y1 === null || y2 === null) {
          distanceLineV.style.display = "none";
          return;
        }
        distanceLineV.style.display = "block";
        distanceLineV.style.left = `${x}px`;
        distanceLineV.style.top = `${Math.min(y1, y2)}px`;
        distanceLineV.style.width = `1px`;
        distanceLineV.style.height = `${Math.abs(y2 - y1)}px`;
      };
      drawHLine();
      drawVLine();
    };

    const clearHover = () => {
      hoverOutline.style.display = "none";
      hoverTag.style.display = "none";
      clearIndicators();
      clearDistanceOverlay();
      hoverTarget = null;
    };

    const updateHover = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        clearHover();
        return;
      }
      hoverOutline.style.display = "block";
      hoverOutline.style.left = `${rect.left}px`;
      hoverOutline.style.top = `${rect.top}px`;
      hoverOutline.style.width = `${rect.width}px`;
      hoverOutline.style.height = `${rect.height}px`;
      updateIndicators(el, rect);

      const oid = el.getAttribute("data-oid") ?? el.getAttribute("data-oid-call");
      // The data-oid path is the authoritative "where did this DOM come from"
      // because the Babel plugin stamps it at compile time, before SSR/CSR.
      // Fiber walking only adds value if it finds a user-component name *not*
      // already implied by the filename (e.g., element rendered inside a child
      // of the file's default export). For the spike, the filename label is
      // strictly better than walking into Next/React internals.
      const fiberName = getComponentName(el);
      const fileName = nameFromDataOid(oid);
      const componentName =
        fileName ||
        (fiberName && !FRAMEWORK_INTERNALS.has(fiberName) ? fiberName : null);
      const tagName = el.tagName.toLowerCase();
      const oidLabel = oid
        ? el.hasAttribute("data-oid")
          ? oid
          : `${oid} (call site)`
        : "(no data-oid — not stamped)";

      hoverTag.innerHTML = "";
      if (componentName) {
        const c = document.createElement("span");
        c.className = "comp";
        c.textContent = `<${componentName}>`;
        hoverTag.appendChild(c);
      }
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = tagName;
      hoverTag.appendChild(t);
      const s = document.createElement("span");
      s.className = "src";
      s.textContent = oidLabel;
      hoverTag.appendChild(s);

      hoverTag.style.display = "block";
      // Position tag above element by default; flip below if near top.
      const tagH = 22;
      const above = rect.top - tagH - 4;
      const below = rect.bottom + 4;
      hoverTag.style.left = `${Math.max(4, rect.left)}px`;
      hoverTag.style.top = `${above < 0 ? below : above}px`;
    };

    const onMouseMove = (e: MouseEvent) => {
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      if (!editMode) return;

      // Alt+hover with an anchor (Moveable target or shift-clicked element):
      // show the gap distance instead of (or in addition to) the hover badge.
      const anchor =
        (moveable ? lastSelected : null) ?? measureSet[0] ?? null;
      if (e.altKey && anchor) {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          const target = document.elementFromPoint(lastMouseX, lastMouseY);
          if (!(target instanceof HTMLElement) || isOverlayEl(target)) {
            clearDistanceOverlay();
            return;
          }
          showDistanceBetween(anchor, target);
        });
        return;
      }
      clearDistanceOverlay();

      if (moveable) return; // selection mode — hover suspended
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const target = document.elementFromPoint(lastMouseX, lastMouseY);
        if (!(target instanceof HTMLElement) || isOverlayEl(target)) {
          clearHover();
          return;
        }
        if (target === hoverTarget) return;
        hoverTarget = target;
        updateHover(target);
      });
    };

    const onScrollOrResize = () => {
      if (pending) {
        const instances = queryInstances(pending.ref.oid, pending.ref.attribute);
        drawInstanceOutlines(instances, pending.element);
      }
      if (moveable && lastSelected) {
        positionPaddingHandles(lastSelected);
      }
      positionPinMarkers();
      positionAgentHighlights();
      if (moveable) return;
      const target = document.elementFromPoint(lastMouseX, lastMouseY);
      if (target instanceof HTMLElement && !isOverlayEl(target)) {
        hoverTarget = target;
        updateHover(target);
      } else {
        clearHover();
      }
    };

    const onMouseLeave = () => clearHover();

    // Curated computed styles — the facts an agent needs to reason about
    // spacing/sizing/typography without a full computed-style dump.
    const COMPUTED_KEYS = [
      "display",
      "position",
      "width",
      "height",
      "padding",
      "margin",
      "gap",
      "flex-direction",
      "align-items",
      "justify-content",
      "grid-template-columns",
      "font-size",
      "font-weight",
      "line-height",
      "color",
      "background-color",
      "border-radius",
      "border",
    ] as const;

    const collectComputed = (el: HTMLElement): Record<string, string> => {
      const cs = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const k of COMPUTED_KEYS) {
        const v = cs.getPropertyValue(k).trim();
        if (v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px") out[k] = v;
      }
      return out;
    };

    const collectAncestors = (el: HTMLElement) => {
      const out: Array<{ tag: string; oid: string | null; className: string }> = [];
      let cur = el.parentElement;
      while (cur && cur !== document.body && out.length < 6) {
        out.push({
          tag: cur.tagName.toLowerCase(),
          oid: cur.getAttribute("data-oid") ?? cur.getAttribute("data-oid-call"),
          className: typeof cur.className === "string" ? cur.className : "",
        });
        cur = cur.parentElement;
      }
      return out;
    };

    const buildSelectionPayload = (el: HTMLElement, note?: string | null) => {
      const refs = refsFor(el);
      const primary = refs.host ?? refs.call;
      if (!primary) return null;
      const fiberName = getComponentName(el);
      const fileName = nameFromDataOid(primary.oid);
      const componentName =
        fileName ||
        (fiberName && !FRAMEWORK_INTERNALS.has(fiberName) ? fiberName : null);
      const rect = el.getBoundingClientRect();
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      return {
        file: primary.file,
        line: primary.line,
        col: primary.col,
        oid: primary.oid,
        oidAttribute: primary.attribute,
        className: typeof el.className === "string" ? el.className : "",
        tagName: el.tagName.toLowerCase(),
        componentName,
        instanceCount: queryInstances(primary.oid, primary.attribute).length,
        callSite:
          refs.host && refs.call
            ? {
                file: refs.call.file,
                line: refs.call.line,
                col: refs.call.col,
                oid: refs.call.oid,
                instanceCount: queryInstances(refs.call.oid, "data-oid-call").length,
              }
            : null,
        note: note ?? currentNote ?? null,
        url: location.pathname + location.search,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        computed: collectComputed(el),
        ancestors: collectAncestors(el),
        text: text || null,
      };
    };

    const pushSelectionToServer = async (el: HTMLElement): Promise<void> => {
      const payload = buildSelectionPayload(el);
      if (!payload) return;
      // The overlay keeps working even if the server isn't running — MCP
      // clients just won't see selection updates in that case.
      try {
        const res = await authedFetch(`${SERVER_URL}/selection`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { ok: boolean; selection?: EnrichedSelection };
        if (body.ok && body.selection && lastSelected === el) {
          currentSelection = body.selection;
          onSelectionDescribed?.(el);
        }
      } catch {
        /* unreachable server */
      }
    };


    const clearSelectionOnServer = () => {
      currentSelection = null;
      currentNote = null;
      void authedFetch(`${SERVER_URL}/selection`, {
        method: "DELETE",
      }).catch(() => {});
    };

    const acquire = (el: HTMLElement) => {
      if (el === lastSelected) return;
      if (isOverlayEl(el)) return;
      // Switching targets discards any pending change on the previous one.
      if (pending) {
        clearInlineSizing(pending.element);
        hidePending();
      }
      lastSelected = el;
      lastResizeWidth = null;
      clearHover();
      ensureAgentEvents();
      void pushSelectionToServer(el);

      if (moveable) moveable.destroy();
      // Sibling elements act as alignment guidelines while dragging — when
      // the target's edge gets within 4 px of a sibling's edge, Moveable
      // snaps and draws a magenta line. The 4 px matches Tailwind's base
      // spacing unit, which keeps snap behavior aligned with the snap engine.
      const parent = el.parentElement;
      const elementGuidelines: HTMLElement[] = parent
        ? Array.from(parent.children).filter(
            (c): c is HTMLElement => c instanceof HTMLElement && c !== el,
          )
        : [];

      moveable = new Moveable(moveableContainer, {
        target: el,
        draggable: true,
        resizable: true,
        keepRatio: false,
        origin: false,
        snappable: true,
        snapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
        elementSnapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
        snapThreshold: 4,
        elementGuidelines,
      });
      moveable.on("drag", ({ target, transform }) => {
        const t = target as HTMLElement;
        t.style.transform = transform;
        positionPaddingHandles(t);
        updateIndicators(t, t.getBoundingClientRect());
      });
      moveable.on("resize", ({ target, width, height }) => {
        const t = target as HTMLElement;
        t.style.width = `${width}px`;
        t.style.height = `${height}px`;
        lastResizeWidth = width;
        positionPaddingHandles(t);
        updateIndicators(t, t.getBoundingClientRect());
      });
      positionPaddingHandles(el);
      // Show the green padding / orange margin bands during selection too,
      // not just on hover — they're the visual answer to "what are these
      // teal handles letting me grow?"
      updateIndicators(el, el.getBoundingClientRect());
      updateShortcutsHint(el);

      // B2b / B3b: if this element comes from a CSS Module OR a styled-
      // component, the Tailwind path can't help. The shared CSS panel
      // picks the right endpoint via the element's data attributes.
      if (
        el.hasAttribute("data-css-module-class") ||
        el.hasAttribute("data-styled-name")
      ) {
        showCssPanel(el);
      } else {
        hideCssPanel();
      }
      moveable.on("resizeEnd", ({ target }) => {
        const el = target as HTMLElement;
        if (lastResizeWidth === null) return;
        const newWidthPx = lastResizeWidth;
        lastResizeWidth = null;

        const tokens = tokensFor(el);
        const widthToken = tokens.find((t) => WIDTH_TOKEN_RE.test(t));
        if (!widthToken) {
          // Check what the element DOES have so we can suggest a useful path.
          const numericSuffix = /^(-?\d+(?:\.\d+)?|\[[^\]]+\])$/;
          const hasPad = tokens.some((t) =>
            ["p", "px", "py", "pt", "pr", "pb", "pl"].some(
              (p) =>
                t.startsWith(p + "-") &&
                numericSuffix.test(t.slice(p.length + 1)),
            ),
          );
          const suggestion = hasPad
            ? "Use the teal padding bars or press [ ] to adjust padding instead."
            : "No editable padding either — pick a different element.";
          showResult(`No w-* class on this element. ${suggestion}`, "error");
          return;
        }

        const spacingPx = getSpacingPx();
        const snap = snapToTailwind(newWidthPx, spacingPx);
        const newToken = `w-${snap.suffix}`;
        if (newToken === widthToken) {
          clearInlineSizing(el);
          return;
        }
        proposeTokenChange(el, widthToken, newToken, snap.resolvedPx);
      });
    };

    // Shared "given a before token + after token on an element, surface
    // the pending panel" helper. Both resizeEnd and the keyboard nudge
    // funnel through this so the data-oid parsing and error UX stay
    // consistent.
    const proposeTokenChange = (
      el: HTMLElement,
      before: string,
      after: string,
      resolvedPx: number,
      refOverride?: SourceRef | null,
    ) => {
      const ref = refOverride ?? pickRefForToken(el, before);
      if (!ref) {
        showResult(
          "Element has no data-oid. Is the visual-editor loader (withVisualEditor / Vite plugin / Babel plugin) active?",
          "error",
        );
        return;
      }
      showPending(
        {
          element: el,
          ref,
          file: ref.file,
          line: ref.line,
          col: ref.col,
          before,
          after,
        },
        resolvedPx,
      );
    };

    // Keyboard nudge for properties Moveable can't easily express by
    // dragging a corner — padding, margin, gap. Inspired by Photoshop /
    // Figma where `[` and `]` are step-down/-up.
    //   ]  → padding +1 step       (prefer `p-*`, fall back to side-specific)
    //   [  → padding −1 step
    //   }  → margin  +1 step
    //   {  → margin  −1 step
    //   Alt+]  → gap +1 step
    //   Alt+[  → gap −1 step
    const handleNudgeKey = (e: KeyboardEvent): boolean => {
      if (!lastSelected) return false;

      let prefixes: readonly string[] | null = null;
      let direction: "up" | "down" | null = null;

      // Different browsers and automation tools report Shift+] as either
      // e.key === "}" OR e.key === "]" with e.shiftKey true. Handle both.
      // Arrow keys with Alt → width/height nudges.
      if (e.altKey && e.key === "ArrowRight") {
        prefixes = WIDTH_PREFIXES;
        direction = "up";
      } else if (e.altKey && e.key === "ArrowLeft") {
        prefixes = WIDTH_PREFIXES;
        direction = "down";
      } else if (e.altKey && e.key === "ArrowDown") {
        prefixes = HEIGHT_PREFIXES;
        direction = "up";
      } else if (e.altKey && e.key === "ArrowUp") {
        prefixes = HEIGHT_PREFIXES;
        direction = "down";
      } else if (e.altKey && (e.key === "]" || e.key === "}")) {
        prefixes = GAP_PREFIXES;
        direction = "up";
      } else if (e.altKey && (e.key === "[" || e.key === "{")) {
        prefixes = GAP_PREFIXES;
        direction = "down";
      } else if (e.key === "}" || (e.key === "]" && e.shiftKey)) {
        prefixes = MARGIN_PREFIXES;
        direction = "up";
      } else if (e.key === "{" || (e.key === "[" && e.shiftKey)) {
        prefixes = MARGIN_PREFIXES;
        direction = "down";
      } else if (e.key === "]" && !e.shiftKey) {
        prefixes = PADDING_PREFIXES;
        direction = "up";
      } else if (e.key === "[" && !e.shiftKey) {
        prefixes = PADDING_PREFIXES;
        direction = "down";
      }

      if (!prefixes || !direction) return false;
      e.preventDefault();

      const el = lastSelected;
      const hit = findEditableToken(el, prefixes);
      const token = hit?.token ?? null;
      if (!token || !hit) {
        const family =
          prefixes === PADDING_PREFIXES
            ? "padding"
            : prefixes === MARGIN_PREFIXES
              ? "margin"
              : prefixes === GAP_PREFIXES
                ? "gap"
                : prefixes === WIDTH_PREFIXES
                  ? "width"
                  : prefixes === HEIGHT_PREFIXES
                    ? "height"
                    : `${prefixes[0]}-*`;
        showResult(
          `No ${family} class on this element to nudge. See the hint badge for what IS editable.`,
          "error",
        );
        return true;
      }

      const spacingPx = getSpacingPx();
      const newToken = bumpStep(token, direction, spacingPx);
      if (!newToken) {
        showResult(
          `${token} is already at the ${direction === "up" ? "max" : "min"} step. Try the arbitrary-value drag (release outside the snap window).`,
          "error",
        );
        return true;
      }

      const resolvedPx = pxFromClass(newToken, spacingPx) ?? 0;
      proposeTokenChange(el, token, newToken, resolvedPx, hit.ref);
      return true;
    };

    const onClick = (e: MouseEvent) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!(target instanceof HTMLElement)) return;
      if (isOverlayEl(target)) return;
      // Shift-click toggles membership in the measure set without
      // acquiring Moveable. The first member becomes the anchor for
      // Alt-hover distance lines.
      if (e.shiftKey) {
        const idx = measureSet.indexOf(target);
        if (idx === -1) measureSet.push(target);
        else measureSet.splice(idx, 1);
        return;
      }
      acquire(target);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt" || e.altKey === false) {
        clearDistanceOverlay();
      }
    };

    const deselectAll = () => {
      if (pending) {
        clearInlineSizing(pending.element);
        hidePending();
      }
      if (moveable) {
        moveable.destroy();
        moveable = null;
      }
      lastSelected = null;
      hidePaddingHandles();
      clearIndicators();
      hideShortcutsHint();
      hideAssetPicker();
      hideCssPanel();
      clearSelectionOnServer();
      noteInput.value = "";
    };

    const isTypingTarget = (): boolean => {
      const a = (shadow.activeElement ?? document.activeElement) as HTMLElement | null;
      if (!a) return false;
      const tag = a.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || a.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Shift+E toggles edit mode everywhere (also when the overlay is
      // passive, so there's always a way back in).
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "E" || e.key === "e")) {
        e.preventDefault();
        setEditMode(!editMode);
        return;
      }
      if (!editMode) return;
      if (isTypingTarget()) return;
      // B8: `i` opens the image asset picker for the currently selected
      // <img> element.
      if (
        (e.key === "i" || e.key === "I") &&
        !e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        lastSelected &&
        lastSelected.tagName.toLowerCase() === "img"
      ) {
        e.preventDefault();
        void renderAssetPicker(lastSelected);
        return;
      }
      if (e.key === "Escape") {
        deselectAll();
        return;
      }
      handleNudgeKey(e);
    };

    // ---- Edit mode -----------------------------------------------------------
    // "edit on": hover outlines, click selects (and the app's own click
    // handlers are suppressed so a <button> doesn't navigate while you're
    // trying to pick it). "edit off": the overlay is passive and the app
    // behaves normally. Persisted per origin.
    const MODE_KEY = "visual-editor:mode-v1";
    let editMode = (() => {
      try {
        return localStorage.getItem(MODE_KEY) !== "off";
      } catch {
        return true;
      }
    })();
    const setEditMode = (on: boolean) => {
      editMode = on;
      try {
        localStorage.setItem(MODE_KEY, on ? "on" : "off");
      } catch {
        /* private mode etc. */
      }
      modeBtn.textContent = on ? "edit on" : "edit off";
      modeBtn.classList.toggle("off", !on);
      modeBtn.title = on
        ? "Clicks select elements; the app's own click handlers are suppressed. Ctrl+Shift+E to toggle."
        : "Overlay is passive — the app behaves normally. Ctrl+Shift+E to toggle.";
      if (!on) {
        deselectAll();
        clearHover();
      }
    };
    modeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setEditMode(!editMode);
    });
    setEditMode(editMode);

    // In edit mode we own pointer input on the page. Capture phase on
    // `document` runs before React's root listeners, so stopPropagation()
    // keeps the app from reacting, and preventDefault() keeps links/forms
    // from navigating. Overlay UI (shadow host) is always left alone.
    const POINTER_TYPES = ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "auxclick"] as const;
    const interceptPointer = (e: Event) => {
      if (!editMode) return;
      const t = e.target;
      if (!(t instanceof Element) || isOverlayEl(t)) return;
      // stopPropagation on every pointer event keeps the app's handlers
      // (React onClick, Radix onPointerDown, …) from firing. preventDefault
      // only on the click family: cancelling pointerdown would also cancel
      // the browser's own click synthesis in some engines, and we rely on
      // that click to select.
      e.stopPropagation();
      if (e.type === "click" || e.type === "dblclick" || e.type === "auxclick") {
        e.preventDefault();
      }
      if (e.type === "click") onClick(e as MouseEvent);
    };

    // ---- Agent → browser events (SSE) -------------------------------------------
    type AgentHighlight = { boxes: HTMLElement[]; label: HTMLElement; targets: HTMLElement[]; timer: number };
    const agentHighlights: AgentHighlight[] = [];
    const positionAgentHighlights = () => {
      for (const h of agentHighlights) {
        h.targets.forEach((el, i) => {
          const box = h.boxes[i];
          if (!box) return;
          const r = el.getBoundingClientRect();
          box.style.left = `${r.left}px`;
          box.style.top = `${r.top}px`;
          box.style.width = `${r.width}px`;
          box.style.height = `${r.height}px`;
          if (i === 0) {
            h.label.style.left = `${Math.max(4, r.left)}px`;
            h.label.style.top = `${r.top - 26 < 0 ? r.bottom + 4 : r.top - 26}px`;
          }
        });
      }
    };
    const showAgentHighlight = (ev: {
      ref: { file: string; line: number; col: number };
      attribute?: "data-oid" | "data-oid-call";
      label?: string;
      durationMs?: number;
    }) => {
      const oid = `${ev.ref.file}:${ev.ref.line}:${ev.ref.col}`;
      const attribute = ev.attribute ?? "data-oid";
      let targets = queryInstances(oid, attribute);
      if (targets.length === 0) {
        targets = queryInstances(oid, attribute === "data-oid" ? "data-oid-call" : "data-oid");
      }
      if (targets.length === 0) {
        showResult(`Agent pointed at ${oid}, but nothing on this page renders from it.`, "error");
        return;
      }
      const boxes = targets.map(() => {
        const b = document.createElement("div");
        b.className = "agent-highlight";
        shadow.appendChild(b);
        return b;
      });
      const label = document.createElement("div");
      label.className = "agent-label";
      label.textContent = `agent → ${ev.label ?? oid}${targets.length > 1 ? ` (×${targets.length})` : ""}`;
      shadow.appendChild(label);
      const entry: AgentHighlight = { boxes, label, targets, timer: 0 };
      agentHighlights.push(entry);
      targets[0]!.scrollIntoView({ block: "center", behavior: "smooth" });
      positionAgentHighlights();
      window.setTimeout(positionAgentHighlights, 350);
      entry.timer = window.setTimeout(() => {
        for (const b of boxes) b.remove();
        label.remove();
        const i = agentHighlights.indexOf(entry);
        if (i !== -1) agentHighlights.splice(i, 1);
      }, ev.durationMs ?? 4000);
    };

    let eventSource: EventSource | null = null;
    // Connected lazily (first selection, or when pins exist) rather than at
    // mount: a permanently open stream would keep the page from ever
    // reaching "networkidle" and break Playwright/Cypress waits in dev.
    const ensureAgentEvents = () => {
      if (eventSource) return;
      void connectAgentEvents();
    };
    const connectAgentEvents = async () => {
      if (typeof EventSource === "undefined" || eventSource) return;
      try {
        const token = await ensureSessionToken();
        const url = `${SERVER_URL}/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
        eventSource = new EventSource(url);
        eventSource.addEventListener("highlight", (e) => {
          try {
            showAgentHighlight(JSON.parse((e as MessageEvent).data));
          } catch {
            /* malformed */
          }
        });
        eventSource.addEventListener("pin-resolved", () => {
          void refreshPins();
          showResult("Your agent resolved a pin ✓", "success");
        });
        eventSource.addEventListener("pins-changed", () => {
          void refreshPins();
        });
        eventSource.addEventListener("message", (e) => {
          try {
            const data = JSON.parse((e as MessageEvent).data) as { text?: string };
            if (data.text) showResult(`agent: ${data.text}`, "success");
          } catch {
            /* ignore */
          }
        });
        // EventSource reconnects on its own; nothing to do on error.
      } catch {
        /* no server — the overlay still works for local edits */
      }
    };

    document.addEventListener("mousemove", onMouseMove, { passive: true });
    document.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);
    document.addEventListener("mouseleave", onMouseLeave);
    for (const type of POINTER_TYPES) document.addEventListener(type, interceptPointer, true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    anchor.setAttribute("data-mounted", "true");
    void refreshPins();

    // B5: restore any persisted draft from localStorage. We re-resolve the
    // element by data-oid (the only stable handle across page reloads).
    // If the element is gone (page changed, deployed, etc.), drop the draft.
    {
      const draft = loadDraft();
      if (draft) {
        const attribute = draft.attribute ?? "data-oid";
        const escaped = draft.oid.replace(/"/g, '\\"');
        const restored = document.querySelector(
          `[${attribute}="${escaped}"]`,
        ) as HTMLElement | null;
        if (restored) {
          showPending(
            {
              element: restored,
              ref: {
                attribute,
                oid: draft.oid,
                file: draft.file,
                line: draft.line,
                col: draft.col,
              },
              file: draft.file,
              line: draft.line,
              col: draft.col,
              before: draft.before,
              after: draft.after,
            },
            draft.resolvedPx,
          );
        } else {
          // Stale — DOM doesn't have the element anymore.
          clearDraft();
        }
      }
    }

    (window as unknown as { __visualEditorSpike?: object }).__visualEditorSpike = {
      moveableHandleCount: () =>
        moveableContainer.querySelectorAll(".moveable-control-box").length,
      badgeText: () =>
        (shadow.querySelector(".badge") as HTMLElement | null)?.textContent ??
        null,
      hostBodyColor: () => getComputedStyle(document.body).color,
      badgeColor: () => {
        const b = shadow.querySelector(".badge") as HTMLElement | null;
        return b ? getComputedStyle(b).backgroundColor : null;
      },
      badgeBoxSizing: () => {
        const b = shadow.querySelector(".badge") as HTMLElement | null;
        return b ? getComputedStyle(b).boxSizing : null;
      },
      hostBodyBoxSizing: () => getComputedStyle(document.body).boxSizing,
      hoverTagVisible: () =>
        (shadow.querySelector(".hover-tag") as HTMLElement | null)?.style
          .display === "block",
      hoverTagText: () =>
        (shadow.querySelector(".hover-tag") as HTMLElement | null)
          ?.textContent ?? null,
      pendingPanelVisible: () =>
        (shadow.querySelector(".pending-panel") as HTMLElement | null)?.style
          .display === "flex",
      pendingPanelText: () =>
        (shadow.querySelector(".pending-panel") as HTMLElement | null)
          ?.textContent ?? null,
      // Programmatic Apply trigger — clicks the .btn-apply button inside the
      // shadow so headless tests can drive the Apply flow without
      // navigating Moveable's pointer-events surface.
      clickApply: () => {
        const btn = shadow.querySelector(".btn-apply") as HTMLElement | null;
        if (!btn) return { error: "no-apply-button" };
        btn.click();
        return { clicked: true };
      },
      instanceOutlineCount: () =>
        shadow.querySelectorAll(".instance-outline").length,
      visiblePaddingIndicators: () =>
        Array.from(shadow.querySelectorAll(".indicator-pad")).filter(
          (e) => (e as HTMLElement).style.display !== "none",
        ).length,
      visibleMarginIndicators: () =>
        Array.from(shadow.querySelectorAll(".indicator-margin")).filter(
          (e) => (e as HTMLElement).style.display !== "none",
        ).length,
      distanceLabelText: () => {
        const el = shadow.querySelector(".distance-label") as HTMLElement | null;
        if (!el || el.style.display === "none") return null;
        return el.textContent;
      },
      measureSetSize: () => measureSet.length,
      visiblePaddingHandles: () =>
        Array.from(shadow.querySelectorAll(".padding-handle")).filter(
          (e) => (e as HTMLElement).style.display !== "none",
        ).length,
      paddingHandleRect: (side: "top" | "right" | "bottom" | "left") => {
        const h = shadow.querySelector(
          `.padding-handle-${side}`,
        ) as HTMLElement | null;
        if (!h || h.style.display === "none") return null;
        return {
          left: parseFloat(h.style.left),
          top: parseFloat(h.style.top),
        };
      },
      historyPanelVisible: () =>
        (shadow.querySelector(".history-panel") as HTMLElement | null)?.style
          .display === "flex",
      historyRowCount: () =>
        shadow.querySelectorAll(".history-row").length,
      historyRows: () =>
        Array.from(shadow.querySelectorAll(".history-row")).map((r) => ({
          source: (r.querySelector(".history-source") as HTMLElement | null)
            ?.textContent,
          tokens: (r.querySelector(".history-tokens") as HTMLElement | null)
            ?.textContent,
        })),
      // Open the history panel programmatically (Playwright can't reach
      // into closed shadow to click the toolbar directly).
      openHistory: () => {
        historyBtn.click();
      },
      openPins: () => {
        pinsBtn.click();
      },
      // Select an element programmatically (scripts / e2e can't reach the
      // page through the closed shadow root's pointer surface reliably).
      selectBySelector: (selector: string) => {
        const el = document.querySelector(selector);
        if (!(el instanceof HTMLElement)) return { error: "not-found" };
        acquire(el);
        return { selected: el.tagName.toLowerCase() };
      },
      editMode: () => editMode,
      setEditMode: (on: boolean) => setEditMode(on),
      selectionPanelText: () => shortcutsHint.textContent,
      setNote: (text: string) => {
        noteInput.value = text;
        currentNote = text.trim() || null;
      },
      pin: () => addPin(),
      pinCount: () => pins.length,
      pinMarkerCount: () =>
        pinMarkers.filter((m) => m.style.display !== "none").length,
      agentContext: () => (lastSelected ? buildAgentContext(lastSelected) : null),
      currentSelection: () => currentSelection,
      agentHighlightCount: () => agentHighlights.length,
      undoRowAt: (index: number) => {
        const rows = shadow.querySelectorAll(".btn-undo-row");
        const btn = rows[index] as HTMLElement | undefined;
        btn?.click();
      },
      assetPickerVisible: () =>
        (shadow.querySelector(".asset-picker") as HTMLElement | null)?.style
          .display === "flex",
      assetPickerOptions: () =>
        Array.from(shadow.querySelectorAll(".asset-row")).map(
          (r) => (r as HTMLElement).dataset.asset,
        ),
      pickAsset: (assetPath: string) => {
        const row = shadow.querySelector(
          `.asset-row[data-asset="${CSS.escape(assetPath)}"]`,
        ) as HTMLElement | null;
        if (!row) return { error: "asset-not-found" };
        row.click();
        return { picked: assetPath };
      },
      cssPanelVisible: () =>
        (shadow.querySelector(".css-panel") as HTMLElement | null)?.style
          .display === "flex",
      cssPanelMeta: () =>
        (shadow.querySelector(".css-panel-meta") as HTMLElement | null)
          ?.textContent ?? null,
      cssApply: (property: string, value: string) => {
        const propInput = shadow.querySelector(
          ".css-prop-input",
        ) as HTMLInputElement | null;
        const valInput = shadow.querySelector(
          ".css-val-input",
        ) as HTMLInputElement | null;
        const applyBtn = shadow.querySelector(
          ".btn-css-apply",
        ) as HTMLElement | null;
        if (!propInput || !valInput || !applyBtn) {
          return { error: "no-css-panel" };
        }
        propInput.value = property;
        valInput.value = value;
        applyBtn.click();
        return { clicked: true };
      },
      cssPanelResult: () =>
        (shadow.querySelector(".css-panel-result") as HTMLElement | null)
          ?.textContent ?? null,
      selectedTag: () => lastSelected?.tagName ?? null,
      selectedAttrs: () =>
        lastSelected
          ? {
              dataCssClass: lastSelected.getAttribute("data-css-module-class"),
              dataCssFile: lastSelected.getAttribute("data-css-module-file"),
              dataOid: lastSelected.getAttribute("data-oid"),
            }
          : null,
    };

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
      document.removeEventListener("mouseleave", onMouseLeave);
      for (const type of POINTER_TYPES) document.removeEventListener(type, interceptPointer, true);
      document.removeEventListener("keydown", onKeyDown);
      eventSource?.close();
      for (const m of pinMarkers) m.remove();
      for (const h of agentHighlights) {
        window.clearTimeout(h.timer);
        for (const b of h.boxes) b.remove();
        h.label.remove();
      }
      document.removeEventListener("keyup", onKeyUp);
      cancelAnimationFrame(rafId);
      if (resultDismissTimer !== null) window.clearTimeout(resultDismissTimer);
      moveable?.destroy();
      hidePaddingHandles();
      hideShortcutsHint();
      clearInstanceOutlines();
      anchor.remove();
      delete w[MOUNT_FLAG];
    };
  }
}
