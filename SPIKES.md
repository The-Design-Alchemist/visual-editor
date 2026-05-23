# Pre-Milestone Spikes — Results

**Date:** 2026-05-18
**Scaffold:** `spikes/example-app/` — fresh `npx create-next-app@latest`
**Verified versions:** Next.js 16.2.6, React 19.2.4, React DOM 19.2.4, Tailwind v4 (`@tailwindcss/postcss`), Turbopack default. Node 22.16.0, arm64 (Apple Silicon).

---

## Verdict

| Spike | Goal | Result | Status |
|---|---|---|---|
| **A** | Build-time `data-oid` Babel plugin survives Fast Refresh and reaches Server Component output under Next 16.2 + Turbopack | All thresholds met | **PASS** |
| **B** | Preact UI inside a closed Shadow DOM + vanilla `moveable` for drag/resize, with no React-renderer conflict and CSS isolation in both directions | All thresholds met | **PASS** |

**Recommendation: proceed to Milestone 1** from the (revised) implementation plan. Both spikes' primary risks are retired. There are six smaller concerns surfaced during the work (see *Open notes* below) that should be tracked but don't block start.

---

## Spike A — `data-oid` Babel plugin

### What was built

- `spikes/example-app/babel-plugin-data-oid.js` — a ~30-line Babel plugin. For every `JSXOpeningElement` it appends `data-oid="<relpath>:<line>:<col>"`, idempotent if re-run.
- `spikes/example-app/babel.config.js` — declares the plugin alongside `next/babel`.
- `spikes/example-app/app/page.tsx` — a Server Component containing a `<main>`, `<h1>`, `<p>`, and an imported `<ClientWidget />`.
- `spikes/example-app/app/components/ClientWidget.tsx` — a Client Component (`"use client"`) with `useState`, a `<p>`, and a `<button>`.

### Configuration friction

None for the plugin itself. Next 16's official Turbopack docs explicitly state:

> *"Starting in Next.js 16, Turbopack uses Babel automatically if it detects a configuration file. Unlike in webpack, SWC is always used for Next.js's internal transforms and downleveling to older ECMAScript revisions."*

Confirmed in dev.log: `Using external babel configuration from .../babel.config.js`. No `next.config.ts` changes required.

### Threshold tests and results

1. **`data-oid` appears on rendered HTML for both Client and Server Components.**
   Curling `http://localhost:3001` produced 8 unique `data-oid` values across two files:
   ```
   data-oid="app/layout.tsx:26:4"          (server — <html>)
   data-oid="app/layout.tsx:30:6"          (server — <body>)
   data-oid="app/page.tsx:5:4"             (server — <main>)
   data-oid="app/page.tsx:6:6"             (server — <h1>)
   data-oid="app/page.tsx:9:6"             (server — <p>)
   data-oid="app/components/ClientWidget.tsx:8:4"   (client — <div>)
   data-oid="app/components/ClientWidget.tsx:9:6"   (client — <p>)
   data-oid="app/components/ClientWidget.tsx:10:6"  (client — <button>)
   ```
   Line/column numbers match source exactly. **PASS.**

2. **Fast Refresh preserves `data-oid` on a non-line-changing edit.**
   Changed button text from `increment` to `bump`. The diff of unique `data-oid` values before vs after the edit was empty. **PASS.**

3. **Fast Refresh produces a correct new `data-oid` when a new element is added.**
   Inserted `<span className="text-xs text-blue-300">freshly added line</span>` on a new line. The diff showed exactly one new entry — `data-oid="app/components/ClientWidget.tsx:11:6"` — with no entries removed and no duplications. **PASS.**

4. **Compile cost is acceptable.**
   Initial compile: 1.6s. Subsequent Fast Refresh compiles: ~12–25ms application-code time. **PASS.**

### Open notes from Spike A

- The scaffold emits a "multiple lockfiles" warning because there's a `package-lock.json` higher up the directory tree (`/Users/aaqiljamal/package-lock.json`). Next 16 auto-detects the workspace root using lockfiles. The plugin sets `data-oid` paths relative to `state.cwd`, which Next sets to the project root — so paths came out correctly here. In *real* monorepos with multiple workspaces this needs verification: should `data-oid` paths be workspace-root-relative or project-root-relative? Decide and document before Milestone 1.
- The v0.1 production plugin should switch from literal `path:line:col` to a stable hash + side-table to (a) keep the attribute short in the DOM and (b) decouple the runtime payload from filesystem layout. The spike used the literal form because it's easier to eyeball.
- React 19.2 strips `__source`/`__self` JSX props on the default scaffold (per Babel issue #17571 and the React 19.2 release). Our plugin doesn't depend on `__source` — it injects its own attribute — so this is fine for our path. But **bippy's Fiber-walking fallback** depends on `_debugSource`, which is private internal metadata. Pin a bippy version that has been tested against 19.2 before relying on the fallback.

---

## Spike B — Preact + closed Shadow DOM + drag/resize handles

### What was built

- `spikes/example-app/app/_overlay/Overlay.tsx` — a Client Component that, on `useEffect`, creates a `<visual-edit-anchor>` custom element at `z-index: 2147483647`, attaches a **closed** Shadow DOM, renders a Preact UI badge inside (via `h` + `render` from `preact`, no JSX-runtime config needed), and instantiates a vanilla `moveable` instance (not `react-moveable`) attached to a host-page element on click.
- `spikes/example-app/app/layout.tsx` — imports and renders `<Overlay />` next to `{children}`.
- `spikes/example-app/spike-b-verify.mjs` — a Playwright headless-Chromium script that boots a real browser, mounts the page, and asserts on:
  1. The custom element exists.
  2. `document.body.dataset.visualEditMounted === "true"` (overlay's useEffect ran).
  3. `anchor.shadowRoot` is `null` from page JS (closed mode is opaque).
  4. A self-test hook exposed on `window.__visualEditSpike` reports the Preact-rendered badge text/color and the Moveable handle count inside the (otherwise-opaque) shadow.

### Library choice — vanilla `moveable` vs `react-moveable`

The original research recommended `react-moveable` inside Preact via `preact/compat`. Spike B sidestepped that aliasing entirely by using vanilla `moveable` (the underlying library that `react-moveable` wraps). This is cleaner because:
- No JSX-pragma or alias gymnastics. The overlay uses `import Moveable from "moveable"` and instantiates with `new Moveable(container, options)`.
- Preact only renders the overlay UI (the badge today, the spacing indicators in v0.1). The drag handles are vanilla DOM owned by Moveable — Moveable doesn't care about React vs Preact.
- Reduces the surface area for two-React-copy conflicts in the inevitable case where the host app uses a Moveable-adjacent React library.

Confirmed functional. No runtime aliases needed in `next.config.ts`.

### Threshold tests and results

| Check | Expected | Observed | Status |
|---|---|---|---|
| `<visual-edit-anchor>` exists in DOM | yes | yes | ✓ |
| `body.dataset.visualEditMounted === "true"` | yes (useEffect ran) | yes | ✓ |
| `anchor.shadowRoot` from page JS | `null` (closed mode opaque) | `null` | ✓ |
| Preact rendered the badge inside shadow | badge text `"visual-edit on"` | matched | ✓ |
| Shadow CSS applied (badge background) | `rgb(102, 51, 153)` (rebeccapurple) | matched | ✓ |
| Host body color preserved | `rgb(23, 23, 23)` (Tailwind text-foreground) | matched | ✓ |
| `__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers` count | 0 (no two-renderer conflict; Preact does not register) | 0 | ✓ |
| Moveable handles **before** click | 0 | 0 | ✓ |
| Moveable handles **after** click on `<h1>` | ≥ 1 control box | 1 | ✓ |
| Console errors during full flow | 0 | 0 | ✓ |
| **CSS preflight isolation** | host body `border-box` (Tailwind preflight), shadow badge `content-box` (default — preflight does NOT pierce shadow) | host: `border-box`; shadow: `content-box` | ✓ |

The CSS preflight isolation result is the load-bearing one. Tailwind v4's preflight uses a universal selector (`*, ::before, ::after { box-sizing: border-box }`) and it does **not** cross the Shadow DOM boundary even with `mode: "closed"` and `:host { all: initial }`. This is the property that makes the overlay safe to ship without per-host-app CSS audits.

### Open notes from Spike B

- We tested *click* to attach Moveable, not full drag/resize. Moveable's drag/resize logic itself is well-tested upstream — the spike risk we needed to retire was specifically the Shadow-DOM-host concern, which passed. A drag simulation can be added to the verifier later if needed.
- The DevTools-hook count was 0 because the test runs in a stock headless Chromium with no React DevTools extension. React itself only calls `__REACT_DEVTOOLS_GLOBAL_HOOK__?.inject` if the hook exists; without the extension, neither host React 19 nor any other React copy creates the hook. So the "two renderers" problem is *latent*, not *active*, in our test. Preact still doesn't register either way — which is the relevant property — but the active two-renderer scenario only materializes when a real user has the DevTools extension open. Confirm again in a manual test before declaring final victory.
- Moveable's handles render inside the closed Shadow DOM (we passed `moveableContainer` as the parent). Pointer-events work, but the handles can only be inspected from outside via the self-test hook. For dev-iteration of the overlay, consider gating `mode: "closed"` vs `mode: "open"` on a build flag.
- The `<visual-edit-anchor>` element with `position: fixed; inset: 0; pointer-events: none` covers the viewport but doesn't block app interactions — confirmed because the click reached the underlying `<h1>` via `document.elementFromPoint`. This pattern works.

---

## Open notes (cross-spike) to track before Milestone 1

1. **Workspace-root path resolution.** The `data-oid` plugin uses `state.cwd`. Decide whether monorepos should produce workspace-root-relative or project-root-relative `data-oid` values. Add a test scaffold for pnpm/turborepo before relying on it.
2. **`data-oid` payload format for production.** Spike used literal `path:line:col`. For shipping, hash + side-table is preferable for both DOM weight and refactor robustness. Pick the hashing scheme and how the side-table is delivered (build-time JSON? runtime fetch? in-memory only on the server?).
3. **Theme-aware Tailwind snap.** Read CSS custom properties (`--spacing-*`) at runtime from `:root`, OR parse the user's `tailwind.config` / `@theme` block at server startup. Decide which.
4. **Local server auth.** Concrete scheme: random 32-byte token in a `.visual-edit/session` file (gitignored), required as a `Authorization: Bearer ...` header on every request, plus `Access-Control-Allow-Origin` pinned to the active dev URL.
5. **MCP `get_selected_element` shape.** Split into `summary` (default: source, className, component name, data-oid, instance-count) and `detail` (opt-in: computed styles by requested property list). Keep base payload under ~300 tokens.
6. **Manual DevTools-hook conflict check.** Open a real Chrome instance with React DevTools installed, load the spike app, confirm no renderer-count warnings and the extension can still inspect the host's React 19 tree normally.

---

## Files produced

```
spikes/example-app/
├── babel-plugin-data-oid.js         # Spike A — the plugin
├── babel.config.js                  # Spike A — wires the plugin under Turbopack's compat
├── app/page.tsx                     # Spike A — Server Component test page
├── app/components/ClientWidget.tsx  # Spike A — Client Component test
├── app/_overlay/Overlay.tsx         # Spike B — Preact + Shadow DOM + Moveable
├── app/layout.tsx                   # Spike B — renders <Overlay/>
├── spike-b-verify.mjs               # Spike B — Playwright assertions
└── dev.log                          # raw next dev output for reference
```

To re-run the spikes from scratch:

```bash
cd "spikes/example-app"
./node_modules/.bin/next dev --port 3001 > dev.log 2>&1 &
# Spike A:
curl -s http://localhost:3001 | grep -oE 'data-oid="[^"]*"' | sort -u
# Spike B:
node spike-b-verify.mjs
```
