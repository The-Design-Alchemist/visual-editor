# Building a Figma-Grade Visual Design Overlay for Next.js with Deterministic AST Writes and Claude Code MCP Integration

---

## Revisions — 2026-05-18

This research is preserved as a reference survey, but the following claims have been **superseded** by a Codex adversarial review and two empirical spikes (Spike A + Spike B). For the authoritative current plan see `PROJECT_CONTEXT.md`; for spike results see `SPIKES.md`.

**Versions empirically verified on a fresh `create-next-app@latest` scaffold (2026-05-18):**
- Next.js 16.2.6 (Turbopack default)
- React 19.2.4, React DOM 19.2.4
- Tailwind CSS v4 (via `@tailwindcss/postcss`)
- `babel.config.js` is **automatically picked up by Turbopack** in Next 16 — confirmed in dev.log: `"Using external babel configuration from .../babel.config.js"`. Per Next 16 docs (Turbopack page, Version Changes table): *"v16.0.0 — Automatic support for Babel when a configuration file is found."* SWC still runs for Next's internal transforms.

**Superseded claims (see strikethroughs and notes inline):**
1. **"Use React's free `__source`/`__self` as DEFAULT" (Strategy 1 below).** Empirically and per official sources, React 19.2 removed `source`/`self` arguments from `jsxDEV`. The plugin source props are not emitted on the default 2026 stack. Strategy 3 (build-time `data-oid`) is now the recommended primary, not the deferred option.
2. **"Skip RSC for v1, work in Client Components only."** Adversarial review flagged that App Router pages routinely render server-component DOM the user will hover; without `data-oid` the overlay silently misses half the page. v0.1 now ships `data-oid` so RSC content is at least *mappable* and *hover-selectable*; editing RSC remains v0.2.
3. **"`react-moveable` is React-based but works fine inside a Preact island via `preact/compat`."** Spike B avoided the aliasing concern entirely by using **vanilla `moveable`** (the underlying library) inside a closed Shadow DOM with Preact rendering only the overlay UI. Confirmed working with zero React-renderer-hook conflicts.
4. **"Tailwind spacing scale is `0, 0.5, 1, ...` rem-based" (hardcoded `TW_SPACING_PX` table).** Tailwind v4 is now the scaffold default and exposes the scale through `@theme` / `--spacing`. The snap engine must read the resolved theme from the running app, not a baked-in table.
5. **"Token swap handles `cn()`/`clsx()`/`twMerge()` safely by walking string-literal arguments."** Adversarial review showed this is unsafe under `twMerge` precedence (`twMerge("p-4", selected && "p-8")` — swapping `p-4` does nothing when `selected` is true) and impossible to prove for `cva`. The v0.1 AST writer now **refuses** dynamic-className contexts with a clear reason, not "best-effort" swap.
6. **"Stable `fiberKey` keys the staged buffer."** Fibers are recreated every render. Staged changes are now keyed by `data-oid` (stable across HMR).
7. **"Local server at `localhost:7790` is straightforward."** Any local origin can POST to `:7790`. v0.1 binds to loopback only and requires an unguessable per-session token.
8. **"`get_selected_element` returns ... computed styles" as a single tool.** A `getComputedStyle` dump is fat. v0.1 splits summary vs detail to control token burn per Claude turn.

The original recommendations below remain useful as **library survey** (recast, moveable, MCP SDK, Floating UI all still good calls) and as **architectural shape** (Shadow DOM at z-index 2147483647, stdio MCP, four tools). Read the sections below with the revisions above in mind.

---

## TL;DR

- **Build it as an npm package, not a browser extension.** Ship a `dev`-only script you import in `app/layout.tsx`, ~~use React's built-in `__source` JSX prop (free, no plugin) plus a `bippy`-style Fiber walk as fallback for element→file mapping~~ **[REVISED 2026-05-18: stamp every JSX element at build time with a `data-oid` Babel plugin (verified on Next 16.2.6 + React 19.2.4 + Turbopack); `bippy`/Fiber walk as fallback for non-Babel setups]**, render the overlay in a Shadow DOM with ~~`react-moveable`~~ **vanilla `moveable`** driving the gestures, mutate code through `recast` + `@babel/parser` + `@babel/traverse`, and expose the whole pipeline to Claude Code through a local stdio MCP server registered via `claude mcp add`.
- **Scope the MVP brutally:** Tailwind-only className edits, Client Components only, single-package repo, four MCP tools (`get_selected_element`, `propose_change`, `apply_change`, `revert_change`). That is shippable in ~2 weeks of focused work and delivers the entire see→drag→preview→commit loop.
- **Reference architecture:** React Grab (Fiber walking + agent providers) + Onlook (build-time `data-oid` + AST mutation) + Stagewise (Shadow-DOM toolbar) + Lovable Visual Edits (client-side AST) collectively contain every pattern you need. Fork ideas from all four; don't try to be all of them at once.

---

## Key Findings

1. **NPM package wins decisively over a Chrome extension** for full-featured tooling because MV3 isolates the content script into a CSP-restricted "isolated world" with no native access to React's Fiber tree, no `eval`, and a clumsy bridge requirement for writing to disk. Every serious player in this space (react-grab, Stagewise, Onlook, Lovable) ships as a script you import, not as an extension. Browser extensions only make sense if you must work across codebases you don't own.
2. **Source mapping is solved by combining two cheap mechanisms.** React's `@babel/preset-react` in `runtime: "automatic"` *already* emits `__source` and `__self` on every JSX element in development — you get file/line/column on every fiber for free. Aiden Bai's `bippy` library exposes the Fiber tree by impersonating React DevTools via `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`. Use `__source` as the primary source-of-truth, fall back to walking the Fiber tree's `_debugSource` when needed. A custom Babel plugin that injects a stable `data-oid` (Onlook's approach) is only required if you want to map *Server Component* HTML back to source, since RSC output has no fiber to inspect.
3. **Turbopack is the default bundler in Next.js 16, but Babel still works.** Per the Next.js 16 blog (October 21, 2025): *"more than 50% of development sessions and 20% of production builds on Next.js 15.3+ are already running on Turbopack"* with *"2–5× faster production builds [and] Up to 10× faster Fast Refresh."* `.babelrc`/`babel.config.js` are still picked up by Turbopack's webpack-loader compatibility layer, and Babel runs alongside SWC at the cost of dev-mode performance. `experimental.swcPlugins` is still experimental and has known crashes under Turbopack (vercel/next.js #74611, #78156), so don't bet the MVP on it. The current latest is Next.js 16.2 (March 18, 2026), which adds ~400% faster `next dev` startup over 16.0.
4. **Drag/resize is a one-library decision: use `react-moveable`.** It already implements 8-point handles, snapping, rotation, group selection, and Figma-style guideline snap. `interact.js` is lower-level and you'd reinvent half of Moveable's snap engine.
5. **Deterministic AST writes are best done with `recast` + `@babel/parser` + `@babel/traverse`, not jscodeshift.** Recast preserves whitespace and quote style on the unchanged parts of the file; jscodeshift wraps recast but adds an opinionated collection API you don't need for single-attribute edits. For Tailwind className parsing, study `prettier-plugin-tailwindcss` — it already handles class literals, template literals, and `clsx`/`cn`/`cva` function calls.
6. **MCP integration is genuinely simple.** A stdio server using `@modelcontextprotocol/sdk` is ~100 lines of TypeScript. Register it with `claude mcp add visual-editor -- node ./mcp-server.js`. Keep the surface to ~4 tools so you don't burn Claude's context budget.

---

## Details

### 1. NPM Package vs Browser Extension — Definitive Recommendation

**Ship an npm package.** Two installation surfaces:

- A single `<Script>` tag in `app/layout.tsx` gated on `process.env.NODE_ENV === "development"` (exactly the react-grab pattern).
- An optional MCP server you start via `npx your-tool mcp` in a separate terminal (exactly the Onlook/react-grab pattern for the disk-writing piece).

**Why not an extension:**

- **Isolated-world CSP.** Chrome's documented CSP for MV3 content scripts is `script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' chrome-extension://…`, which blocks `eval`, blocks remote scripts, and forbids loading anything off `localhost:*` unless the extension is unpacked. You cannot, e.g., load the React DevTools hook from the page world without a `world: "MAIN"` content script and a postMessage bridge.
- **Fiber access requires a bridge.** From the isolated world, `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` and `__reactFiber$…` properties live in the page's main world and require a `world: "MAIN"` content script plus `window.postMessage` shuttling to your isolated logic. That's the same problem React DevTools has — and the reason React DevTools ships a "bridge" as well as a "frontend."
- **Disk writes require native messaging or a companion local server.** You're going to need a local Node process anyway (for the MCP server and AST mutation), so the extension's only "advantage" — zero install in the user's codebase — is eaten by the need for that companion server.
- **Chrome Web Store review latency** kills your iteration loop.

**How the precedents chose:**
- **react-grab** ships as `<script src="//unpkg.com/react-grab/dist/index.global.js">` — an npm package loaded by a script tag, with a companion local server on port 7567 (`@react-grab/mcp`) or port 4567 (`@react-grab/claude-code`) for agent integrations.
- **Stagewise** historically shipped `@stagewise/toolbar-next` as an npm import; the deprecated package's README now redirects users to the `npx stagewise@latest` CLI proxy on port 3100, and the org's strategic move is toward a full Electron-based developer browser. Either way: not an extension.
- **Onlook** runs the user's project inside a Web Container (CodeSandbox SDK + Bun runtime) and instruments at build time via `@onlook/babel-plugin-react`. The desktop app was previously an Electron browser; current direction is a web app — neither is a Chrome extension.

**Definitive choice:** An npm package consisting of (a) a client-side runtime loaded via `<Script>` in dev only, (b) a small CLI that boots a local Node server exposing both an HTTP endpoint (for the browser script) and an MCP stdio endpoint (for Claude Code).

### 2. Source Mapping — Element → File:Line:Column

There are three viable strategies; the **recommended approach is to combine #1 and #2 below**, and treat #3 as a future addition only if you need Server Component support.

**Strategy 1 — Use React's free `__source`/`__self` ~~(DEFAULT, RECOMMENDED)~~ (SUPERSEDED — see Revisions block at top).**

Since the automatic JSX runtime, `@babel/plugin-transform-react-jsx-development` already adds `__source` (file/line/column) and `__self` (the enclosing `this`) to every JSX element in dev builds. You don't have to install anything: Next.js's default React config does this in development mode. From the official Babel docs for `@babel/plugin-transform-react-jsx-self`: *"In: `<sometag />` → Out: `<sometag __self={this} />`"*, and `@babel/plugin-transform-react-jsx-source` adds `__source={{fileName, lineNumber, columnNumber}}`.

The catch: **React 19.2 removed the `source` and `self` arguments from `jsxDEV`** (per Babel issue #17571), and the Babel plugins were updated to stop emitting them. In React 19.2+, the source location now lives on the Fiber's `_debugSource` (set by React itself during reconciliation), not on `__source` props. So plan to read both: prefer Fiber `_debugSource`, fall back to `__source` prop for older runtimes.

**Strategy 2 — Walk the Fiber tree with `bippy` (RECOMMENDED supplement).**

Aiden Bai's `bippy` package (the engine inside react-grab and React Scan) registers itself on `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` and exposes `traverseFiber`, `onCommitFiberRoot`, `traverseRenderedFibers`. From the bippy README: *"by default, you cannot access react internals. bippy bypasses this by 'pretending' to be react devtools, giving you access to the fiber tree and other internals. works outside of react — no react code modification needed. utility functions that work across modern react (v17–19)."*

The pattern react-grab uses, paraphrased from its blog: *"Walks the React fiber tree upward from that element. Collects component display names and, in development, source locations with file path and line and column numbers."*

The DOM→Fiber map is the `__reactFiber$<hash>` property React adds to every host node. Pseudocode:

```ts
function getFiber(node: Element) {
  const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'))
  return key ? (node as any)[key] : null
}
function getSource(fiber: any) {
  return fiber?._debugSource ?? fiber?.memoizedProps?.__source
}
```

**Strategy 3 — Onlook-style build-time `data-oid` ~~(DEFER)~~ (RECOMMENDED PRIMARY for v0.1 — see Revisions block at top; verified working in Spike A on Next 16.2.6 + Turbopack with a ~30-line plugin).**

Onlook's `@onlook/babel-plugin-react` (npm: `@onlook/babel-plugin-react`, alias `@onlook/react`, version 2.1.1) injects a `data-oid` attribute on every JSXOpeningElement at build time. Per Onlook's architecture doc: *"we inject an attribute into the DOM elements at build-time that points back to the code like a sourcemap. The attribute gives us the location of the code block, and the component scope. We then find the code, parse it into an AST, inject the styles, then write it back."* The exact `data-oid` payload (hash vs nanoid vs `path:line:col` literal) isn't documented in the README; third-party descriptions (LogRocket, BrightCoding) confirm it functions as a stable per-element identifier maintained in Onlook's own index.

The killer reason to invest in this: **Server Components don't hydrate, so there is no Fiber to walk.** A build-time data attribute survives into the HTML the server emits and is the only practical way to map a hovered RSC element back to its source.

~~**For your MVP:** Server Component editing is hard (you also can't change them at runtime, so the visual edit loop has to be code-first there). Skip RSC for v1, work in Client Components only, and rely on `__source` + Fiber walk. Revisit `data-oid` in v2 when you tackle RSC.~~

**For your MVP [REVISED 2026-05-18]:** ship `data-oid` from day one. The combination of (a) React 19.2 removing `__source`/`__self` (now the default scaffold), (b) RSC content making up half of any App Router page, and (c) the silent-failure risk on the half the overlay can't see, makes runtime Fiber-walking insufficient as the primary path. *Editing* RSC content is still v0.2 (the runtime preview loop is the hard part); *mapping and hover-feedback* on RSC content is in v0.1 because `data-oid` gives it to us for free.

**Next.js / Turbopack compatibility note:** Turbopack is the default bundler in Next.js 16. Per the Next.js Turbopack docs: *"Turbopack is now the default bundler in Next.js."* and from the same page: *"babel-loader (Configured automatically if a Babel configuration file is found)."* So a `.babelrc` adding a custom plugin **still works** in Next 16 + Turbopack, with the caveat that it disables SWC's fast-path on those files. `experimental.swcPlugins` is still experimental and has known panics under Turbopack (vercel/next.js #78156, #74611), so don't choose the SWC-plugin path for the MVP.

### 3. Overlay Rendering — Figma-Grade Visual Layer

**Use a Shadow DOM root with `mode: "closed"` attached to a top-level fixed-position `<div>` with `z-index: 2147483647`.** This is the exact Stagewise pattern (per their DeepWiki architecture page): *"Creates a custom element `stagewise-companion-anchor` and attaches it to the document body. Sets highest possible z-index (2147483647) to ensure visibility. Blocks events to prevent interference with the host application."*

Shadow DOM gives you CSS isolation — the user's `* { box-sizing: border-box }` won't break your handle styles, and your Tailwind reset won't bleed into the app. Next.js itself uses Shadow DOM for its app-router announcer (see `app-router-announcer.tsx` in the Next source).

**Render the overlay in something other than React.** React Grab is built in Solid, explicitly *"Loading two separate React instances on the same page can cause conflicts, so the overlay UI avoids React entirely"* (per the article that documents react-grab's design). Two React copies on the same page can clash on the DevTools hook and on context. **Recommendation:** use Preact or Solid for the overlay UI; both are tiny and have no DevTools hook conflict.

**Box-model spacing indicators (Figma/Chrome DevTools style).**

Chrome DevTools exposes the box-model logic as part of the public DevTools Protocol — see the `Overlay.HighlightConfig` type at `chromedevtools.github.io/devtools-protocol/tot/Overlay/`. It includes `contentColor`, `paddingColor`, `borderColor`, `marginColor`, `showRulers`, `showExtensionLines`, etc. You can't call this directly from inside a page, but you can copy the rendering primitives.

For each hovered element:

```ts
const rect = el.getBoundingClientRect()
const cs = getComputedStyle(el)
const padding = { top: parseFloat(cs.paddingTop), /* … */ }
const margin = { top: parseFloat(cs.marginTop), /* … */ }
// Draw:
// 1. Solid 1px outline at rect (the content+padding+border box)
// 2. Inset semi-transparent green rectangles inside rect for padding
// 3. Outset semi-transparent orange rectangles outside rect for margin
// 4. Floating labels with px values (use Floating UI for placement)
```

For **flexbox/grid badges and gap indicators**, replicate Chrome's flex/grid editor by reading `display: flex|grid`, `gap`, `column-gap`, `row-gap` from computed style and painting dotted lines along the gap regions.

**Hit testing without breaking the app.** Overlay root gets `pointer-events: none`. Handles inside it get `pointer-events: auto`. When the user moves the mouse over the app you call `document.elementFromPoint(x, y)` inside a `requestAnimationFrame` loop (throttled) to determine the candidate target.

**Multi-select and distance measurement** (Figma's "hold Alt/Option to measure"):

- Maintain `selectedElements: Element[]` in state. Shift-click toggles membership.
- When exactly one element is selected and the user holds Alt while hovering, compute the rectangle of the hovered element and draw four signed-distance lines from the selected element's bounding rect to the hovered rect's edges, with labels. Use `Math.min/max` on the four `top/right/bottom/left` pairs to compute the gap.
- For alignment guides while dragging, on every drag frame walk the parent's children, compare each sibling's edge x/y coordinates to the dragged element's edges, and draw a magenta line for any pair that lies within a 4 px snap threshold.

**Keeping in sync with HMR.** Use `MutationObserver` on `document.body` for nodes added/removed/attribute-changed, and a `ResizeObserver` on every currently-selected element to redraw handles on layout changes. On HMR, React re-mounts the affected subtree; re-attach by walking from the body to find an element whose `__source` matches your saved selection.

### 4. Drag / Resize / Nudge — Non-Destructive Live Preview

**Use `react-moveable` (npm: `react-moveable`, 42,786 weekly downloads per npmtrends).** It already implements:

- 8-point + edge resize handles
- Snap to guidelines, sibling alignment, and explicit snap points
- Group selection
- Rotation, scale, warp (you'll ignore most of these for MVP)
- Keep-ratio, throttle, bound constraints
- Coordinate output as either CSS `transform` or width/height/top/left

From the official `react-moveable` README, the resize handler signature is:

```ts
<Moveable
  target={selectedEl}
  draggable resizable keepRatio={false}
  snappable
  snapThreshold={4}                // for Tailwind 4px scale
  elementGuidelines={Array.from(selectedEl.parentElement.children)}
  onDrag={({target, transform}) => target.style.transform = transform}
  onResize={({target, width, height}) => {
    target.style.width  = width  + 'px'
    target.style.height = height + 'px'
  }}
/>
```

**Why not `interact.js`:** lower-level, you'd reimplement the snap engine. Use it only if you need extreme custom gestures.

**Non-destructive live preview = a staged-changes buffer.**

```ts
type StagedChange = {
  fiberKey: string          // stable handle to the source location
  sourceFile: string
  sourceLine: number
  sourceCol: number
  before: { className?: string; style?: Record<string,string> }
  after:  { className?: string; style?: Record<string,string> }
  inlineStyle: Record<string,string>   // applied to live DOM
  proposedClassName?: string           // what we'll write to source
}
const staged = new Map<string, StagedChange>()   // command-pattern buffer
```

On drag end, you don't write to disk. You apply an inline `style="..."` to the DOM and store the proposed `className` for later commit. Undo = `staged.delete(key)` + remove inline style. Redo = re-apply.

**Snap to Tailwind scale.** ~~Tailwind's spacing scale is `0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, …` rem-based, where 1 = 4px. Build a constant: `const TW_SPACING_PX = [...]`.~~ **[REVISED 2026-05-18]** Tailwind v4 (now the scaffold default) configures the scale via `@theme` and CSS custom properties (`--spacing-1`, `--spacing-2`, ...) instead of a JS config. A hardcoded `TW_SPACING_PX` table will silently emit wrong values for any project that customized `--spacing` or uses non-default scales. The snap engine must read the **resolved** theme from the running app — either by querying CSS custom properties at runtime (`getComputedStyle(document.documentElement).getPropertyValue('--spacing-4')`) or by parsing the user's CSS/Tailwind config. Emit `p-{index}` only after confirming the index maps to the actually-resolved px value. If the user holds Alt to disable snap, emit `p-[23px]` (arbitrary value).

**Keyboard nudging.** Global `keydown` on selection: arrow = 1 px, Shift+arrow = 10 px. Apply to top/left for absolutely-positioned elements; apply to `margin-{side}` deltas for flow children; for flex/grid children, prefer changing `gap`/order rather than position.

**Detecting drag intent in flex/grid.** Read `display` of the parent. If `flex`/`inline-flex`:
- If the drag axis is the parent's main axis and the pointer crosses a sibling's midpoint, treat as *reorder* (change DOM order, write back as a JSX reorder).
- Otherwise, treat as *resize* (`flex-basis` or `width`/`height`).

For grid, snap to grid lines computed from the parent's `gridTemplateColumns/Rows`.

### 5. AST Mutation — Deterministic Code Writes

**Library choice: `recast` + `@babel/parser` + `@babel/traverse`, NOT jscodeshift.** Recast's whole purpose is preserving formatting on unchanged tokens. From the egghead.io guide on combining them: the parse is done with `parse(code, { parser: require('recast/parsers/babel') })`, then transformed via `transformFromAstSync` with `cloneInputAst: false` (critical — recast stores formatting metadata on the AST nodes; cloning loses it), then re-printed with `print(ast).code`. Jscodeshift is a thin wrapper over the same stack — overkill for single-attribute mutations and pulls in extra opinionated APIs.

**The flow for "user dragged `p-4` → `p-6` on `Button.tsx:42:14`":**

```ts
// 1. Read the file
const code = await fs.readFile(file, 'utf8')
// 2. Parse, keeping recast's whitespace tokens
const ast = recast.parse(code, {
  parser: { parse: (src) => parser.parse(src, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
    tokens: true,                       // recast needs this
  }) }
})
// 3. Walk to the right JSXOpeningElement
traverse(ast, {
  JSXOpeningElement(path) {
    const loc = path.node.loc
    if (loc.start.line !== line) return
    if (loc.start.column !== col) return
    // 4. Mutate the className attribute
    const attr = path.node.attributes.find(a =>
      a.type === 'JSXAttribute' && a.name.name === 'className')
    rewriteClassName(attr, before, after)
    path.stop()
  }
})
// 5. Print
const out = recast.print(ast).code
await fs.writeFile(file, out)
```

**className parsing — the hard part.** A `className` can be:

- `"p-4 text-sm"` — a plain string literal
- `` {`p-4 ${condition && 'text-sm'}`} `` — a template literal
- `{cn("p-4", condition && "text-sm")}` — a function call (cn, clsx, classnames, twMerge, cva)
- `{cond ? "p-4" : "p-6"}` — a conditional

Study `prettier-plugin-tailwindcss` — it solves exactly this and is now an exported sorter you can call directly: `import { createSorter } from 'prettier-plugin-tailwindcss/sorter'`. It already understands `tailwindFunctions: ["clsx", "cn", "classNames", "tw", "cva"]` and tagged template literals.

The pragma you want is: **rewrite only string-literal arguments and string-literal positions within template literals.** Anything dynamic (`condition && '...'`) is left alone unless the value being replaced is unambiguously in a static segment.

```ts
function rewriteClassName(attr, before: string, after: string) {
  const v = attr.value
  if (v.type === 'StringLiteral') {
    v.value = swapTokens(v.value, before, after)
  } else if (v.type === 'JSXExpressionContainer') {
    const e = v.expression
    if (e.type === 'StringLiteral')      e.value = swapTokens(e.value, before, after)
    else if (e.type === 'TemplateLiteral') swapInTemplate(e, before, after)
    else if (e.type === 'CallExpression') swapInCall(e, before, after)
    else throw new Error('unsupported className expression')
  }
}
function swapTokens(s: string, before: string, after: string): string {
  return s.split(/(\s+)/).map(t => t === before ? after : t).join('')
}
```

For **arbitrary values** (`p-[23px]`): snap-to-scale by default, escape to arbitrary value only if the user holds Alt. Detect arbitrary syntax with `/^[a-z-]+-\[[^\]]+\]$/`.

**MVP scope: Tailwind only.** CSS Modules require editing a separate `.module.css` file; vanilla CSS needs selector resolution; styled-components needs string-template-literal AST surgery inside `` styled.button`…` ``. These are all doable but each is a whole sub-project. Ship Tailwind-only and put a clear warning when the user selects an element styled by another system.

**File watching feedback loop.** Next.js Fast Refresh will pick up your write within ~50 ms. Two defenses against re-processing your own write:

1. Maintain a `recentWrites: Set<string>` in your server keyed by absolute file path; clear it on any change you observe via `chokidar` after a 300 ms quiet period. If a file change is in the set, ignore it for overlay re-sync purposes.
2. After writing, send a `{type:'applied', file, fiberKey}` over the WebSocket to the browser; the overlay re-reads computed styles from the now-refreshed DOM rather than from its staged buffer, and clears the staged change.

### 6. Claude Code Integration — Minimal MCP Server

**Stdio, not HTTP/SSE.** Claude Code's docs are explicit: *"Stdio servers are local processes."* Stdio gives you the simplest lifecycle (Claude spawns and owns the process) and the fewest moving parts. The Streamable HTTP transport is for cloud/remote MCP servers.

**Minimal server (`./mcp-server.ts`):**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'visual-editor', version: '0.1.0' })

server.registerTool('get_selected_element', {
  description: 'Returns the element currently selected in the browser overlay (file, line, col, component, className, computed styles).',
  inputSchema: z.object({}),
}, async () => {
  const sel = await fetch('http://localhost:7790/selection').then(r => r.json())
  return { content: [{ type: 'text', text: JSON.stringify(sel) }] }
})

server.registerTool('propose_change', {
  description: 'Generates a unified diff for a className change without writing to disk.',
  inputSchema: z.object({
    file: z.string(), line: z.number(), col: z.number(),
    before: z.string(), after: z.string(),
  }),
}, async (args) => {
  const diff = await fetch('http://localhost:7790/propose', {
    method: 'POST', body: JSON.stringify(args)
  }).then(r => r.text())
  return { content: [{ type: 'text', text: diff }] }
})

server.registerTool('apply_change', { /* same shape, hits /apply */ }, async (a) => /* … */)
server.registerTool('revert_change', { /* hits /revert */ }, async (a) => /* … */)

await server.connect(new StdioServerTransport())
```

**Register with Claude Code:**

```bash
claude mcp add visual-editor --transport stdio -- node /abs/path/mcp-server.js
# project-scoped (committed in .mcp.json):
claude mcp add visual-editor --scope project -- node ./mcp-server.js
```

Verify in-session with `/mcp`.

**Architecture note:** the MCP stdio process **doesn't itself do AST mutation**. It's a thin proxy that talks (over `http://localhost:7790`) to your dev server, which holds the live browser state (current selection, staged changes) and the AST mutation logic. This is exactly the React Grab pattern (per their `@react-grab/droid` docs ASCII diagram): `Browser → HTTP → Local Server → stdin → Agent CLI`, and `Agent ← SSE ← Server ← stdout ← Agent CLI`. Doing it this way means you can also serve the same tools to Cursor (`cursor mcp add`), VS Code, and anything else that speaks MCP, with zero code changes.

**Context budget hygiene.** Per Anthropic's MCP guidance, each tool's description is shipped to the model on every turn. Keep descriptions to one sentence, keep input schemas tight, and don't expose ten variants of the same tool. Four tools is the sweet spot.

**Optional `/visual-editor` slash command.** Drop a markdown file in `.claude/commands/visual-editor.md`:

```md
---
description: Apply the currently selected visual edit
---
Use the `visual-editor` MCP server. Call `get_selected_element`, show me the proposed diff via `propose_change`, then apply it via `apply_change` only after I confirm.
```

### 7. The Live-Preview / Commit Loop

```
[browser overlay]            [local server :7790]           [next.js dev :3000]
      |                              |                              |
   drag                              |                              |
      |                              |                              |
   apply inline style                |                              |
      |                              |                              |
   push to staged buffer (in-memory) |                              |
      |                              |                              |
   [user clicks Apply] -- POST /apply (file,line,col,before,after) ->
                                     |                              |
                                  read file, parse, mutate, recast.print, write
                                     |                              |
                                     |----- watcher fires --------> |
                                     |                              | HMR
                                     |                              |----> WebSocket to browser
                                                                            |
                                                                       overlay re-syncs:
                                                                       - clear staged buffer entry
                                                                       - re-attach selection
                                                                       - clear inline style
                                                                         (className now reflects on its own)
```

**Race conditions and how to handle them:**

- **User edits the file in their IDE while a drag is staged.** On `chokidar` change event for a file with staged changes: show a "file modified externally, discard or re-base?" toast. Default to discard — the user clearly thinks they're done with that.
- **HMR refresh mid-drag.** Cancel the drag, clear inline styles, retain the staged-buffer entry for next interaction, surface a "preview reloaded — your staged change is still pending" badge.
- **Conflict on apply.** Before writing, re-parse the file and verify the JSXOpeningElement at `(line, col)` still contains the `before` value. If not, return `409 Conflict` to the browser and let the user decide.

### 8. Reliability — Specific Concerns and Mitigations

- **Turbopack vs Webpack (Next.js 16+).** Turbopack is the default per the Next.js docs: *"Turbopack is now the default bundler in Next.js."* Per the Next.js 16 blog (Oct 21, 2025): *"more than 50% of development sessions and 20% of production builds on Next.js 15.3+ are already running on Turbopack"* with *"2–5× faster production builds [and] Up to 10× faster Fast Refresh."* Babel still works via the webpack-loader compatibility layer (*"babel-loader (Configured automatically if a Babel configuration file is found)"*) — so a `.babelrc` plugin will run, but Turbopack does **not** support webpack *plugins* (*"Turbopack does not support webpack plugins"*), only loaders. `experimental.swcPlugins` has open crash bugs under Turbopack (vercel/next.js #74611 and #78156, the latter labelled "Confirmed issue tracked by the Turbopack team"). **Mitigation:** for the MVP, rely on the built-in `__source` props (no plugin needed) and Fiber walking. If you later need a data attribute, ship it as a Babel plugin and accept the slight HMR slowdown.

- **React 19.2 broke `__source` props.** Per Babel issue #17571: *"jsxDEV no longer includes the last two parameters — source and self — as of the React 19.2 release."* The data is still available, just on the Fiber's `_debugSource` instead of as JSX props. Detection: probe both `fiber.memoizedProps.__source` and `fiber._debugSource`.

- **TSX vs JSX.** Pass `plugins: ['jsx', 'typescript']` (or `'flow'`) to `@babel/parser`. Detect from file extension.

- **Monorepos (Turborepo, Nx, pnpm workspaces).** The `__source.fileName` is the absolute path on the build machine. In monorepos it'll be e.g. `/Users/foo/repo/packages/ui/src/Button.tsx`; just resolve it as-is, no path translation needed. Make sure your MCP server is started at the repo root so its `fs.writeFile` calls don't hit a sandbox boundary.

- **HMR edge cases.** Next.js's error overlay is itself rendered into a Shadow DOM (`next-route-announcer`-style). Don't fight it — if the error overlay is up, hide your own overlay until it goes away. Listen for the DOM mutation that adds/removes Next's error portal.

- **Production builds.** Strip your overlay code with `process.env.NODE_ENV === 'development'` guards everywhere. React strips `_debugSource` in prod anyway, so the tool would silently fail to find sources — better to refuse to load at all.

### 9. Step-by-Step Implementation Plan

All version pins below are current as of May 2026; bump if newer is available when you start.

**Repository layout (monorepo, but you can flatten if you prefer):**

```
visual-editor/
├── packages/
│   ├── runtime/                  # browser-side, loaded via <Script>
│   │   ├── src/
│   │   │   ├── index.ts          # entry: init overlay
│   │   │   ├── fiber.ts          # bippy wrapper, getSource()
│   │   │   ├── overlay/
│   │   │   │   ├── root.ts       # Shadow DOM mount
│   │   │   │   ├── selection.ts  # hit testing
│   │   │   │   ├── spacing.tsx   # padding/margin/gap indicators (Preact)
│   │   │   │   ├── handles.tsx   # Moveable wrapper
│   │   │   │   └── guides.tsx    # alignment lines, distance measure
│   │   │   ├── tailwind.ts       # snap scale, className token swap
│   │   │   └── transport.ts      # WS to local server
│   │   └── package.json
│   ├── server/                   # local Node server
│   │   ├── src/
│   │   │   ├── http.ts           # express on :7790
│   │   │   ├── ws.ts             # ws for state push
│   │   │   ├── ast/
│   │   │   │   ├── parse.ts      # recast + babel parser
│   │   │   │   ├── className.ts  # token swap with cn()/clsx() support
│   │   │   │   └── write.ts      # safe write w/ conflict detection
│   │   │   ├── watcher.ts        # chokidar, debounce
│   │   │   └── cli.ts            # `visual-editor start`
│   │   └── package.json
│   └── mcp/                      # MCP stdio server
│       ├── src/server.ts
│       └── package.json
└── examples/
    └── next-16-tailwind/
```

**Dependencies (pin to these or newer minor):**

```jsonc
// packages/runtime
{ "bippy": "^0.5.39", "react-moveable": "^0.56", "preact": "^10.22",
  "@floating-ui/dom": "^1.6" }
// packages/server
{ "@babel/parser": "^7.27", "@babel/traverse": "^7.27", "@babel/types": "^7.27",
  "recast": "^0.23", "chokidar": "^4.0", "ws": "^8.18", "express": "^4.21",
  "prettier-plugin-tailwindcss": "^0.6" }
// packages/mcp
{ "@modelcontextprotocol/sdk": "^1.29.0", "zod": "^3.25" }
```

---

**Milestone 1 (Days 1–2): Source mapping + element selection.**

- `npx create-next-app@latest examples/next-16-tailwind --tailwind --app --typescript`. This will scaffold Next.js 16.2 by default. Confirm React 19, Turbopack default.
- Create `packages/runtime`. In `src/index.ts`, attach a `mousemove` listener on `document.body`, call `document.elementFromPoint(x, y)`, walk to the React fiber via `__reactFiber$…` key lookup, read `_debugSource` (fall back to `memoizedProps.__source`), render a fixed-position label showing `Button.tsx:42:14`.
- Wire in `bippy` (`import { traverseFiber } from 'bippy'`) so you can walk up to find the nearest component.
- In the example app, add `<Script src="/visual-editor-runtime.js" strategy="beforeInteractive" />` inside `if (process.env.NODE_ENV === 'development')`.
- **Pitfall:** React 19.2 has removed `__source`. Verify with `console.log(fiber._debugSource)` that you're actually getting locations; if not, downgrade the example to React 19.0 for now or use the build-time `data-oid` fallback.

**Milestone 2 (Days 3–4): Overlay UI.**

- Move overlay rendering into a Shadow DOM root attached to a `<visual-editor-anchor>` custom element appended to `document.body` with `z-index: 2147483647`. Mount Preact inside.
- Implement spacing indicators: read `getBoundingClientRect` and `getComputedStyle` on hover, draw outline + padding (inner, green) + margin (outer, orange) with px labels.
- Multi-select: shift-click toggles selection set. Distance measure: holding Alt while a single element is selected and hovering another renders four labelled lines.
- **Pitfall:** Don't use React for the overlay — if the host app uses React 19 and you use React too, the DevTools hook will receive two renderer registrations. Stagewise patches `@headlessui/react` for this reason. Use Preact or Solid.

**Milestone 3 (Days 5–7): Drag/resize gestures.**

- Drop `react-moveable` into the Preact tree (Moveable is React-based but works fine inside a Preact island via `preact/compat`, or vanilla via `new Moveable(...)` from the non-React build).
- Wire `onDrag` and `onResize` to apply inline `style`. On end, compute the proposed Tailwind className delta and push to the in-memory staged buffer (`Map<fiberKey, StagedChange>`).
- Implement Tailwind snap: build the `TW_SPACING_PX` table; on drag of a padding handle, snap the px delta to the nearest scale entry and emit `p-{i}`.
- Add keyboard nudge: 1 px arrow, 10 px shift+arrow. Cmd/Ctrl+Z undoes the last staged change.
- **Pitfall:** Moveable's `snappable: true` with `elementGuidelines: Array.from(parent.children)` gives you Figma-style sibling snap nearly for free. Configure `snapThreshold: 4` to match Tailwind's base unit.

**Milestone 4 (Days 8–10): AST mutation server.**

- Build `packages/server`. Express on `:7790`. Endpoints: `GET /selection`, `POST /stage`, `POST /apply`, `POST /revert`, `POST /propose` (returns a unified diff without writing).
- Implement `parse.ts` using `recast.parse` with the babel parser configured for JSX+TypeScript, `tokens: true`.
- Implement `className.ts`: locate the `JSXAttribute` for `className`, dispatch on its expression type, swap tokens. Handle `cn(...)`, `clsx(...)`, `classNames(...)`, `cva(...)` by walking call expression arguments and only touching `StringLiteral` ones.
- Implement `write.ts`: re-parse before writing, verify the `before` token is still present at the recorded `(line, col)`, then `recast.print` and write; otherwise return `409`.
- Wire chokidar; debounce 300 ms; suppress re-sync for files in `recentWrites`.
- **Pitfall:** `recast.print` requires `cloneInputAst: false` if you ever go through `@babel/core.transformFromAstSync`; otherwise whitespace is destroyed.

**Milestone 5 (Days 11–14): MCP integration.**

- Build `packages/mcp` with the four tools above.
- Test with MCP Inspector: `npx @modelcontextprotocol/inspector node ./packages/mcp/dist/server.js`.
- Register with Claude Code locally: `claude mcp add visual-editor -- node $(pwd)/packages/mcp/dist/server.js`. Verify `/mcp` shows it as connected.
- Add a slash command at `.claude/commands/visual-editor.md`.
- End-to-end demo: drag a button's padding in the browser, run `claude` in another terminal, ask "apply my pending visual edits and explain the diff." Verify Claude reads `get_selected_element`, proposes, applies.
- **Pitfall:** For stdio MCP servers, never `console.log` anywhere in the server process — it corrupts JSON-RPC framing on stdout. Use `console.error` for diagnostics (stderr is fine).

**Milestone 6 (Week 3+): Polish.**

- Alignment guides while dragging (compare edges to siblings within 4 px).
- Padding "inner edge" handles like Figma (drag the inside of the padding band to adjust just that side).
- Persistent undo history (file-backed in `.visual-editor/history.json`).
- Error states: file not found, JSX node not found at `(line, col)`, parse errors, conflict detection UI.
- Component label badge on hover showing the React display name (read from `fiber.type.displayName ?? fiber.type.name`).
- Toggle hotkey (Ctrl/Cmd+E) to enable/disable the entire overlay.

### 10. Libraries and Projects to Study / Fork

| Project | What to learn from it |
|---|---|
| **react-grab** (github.com/aidenybai/react-grab) | Fiber walking; clipboard format; agent providers (`@react-grab/claude-code`, `@react-grab/cursor`); the `<script>` tag install pattern. The blog post `react-grab.com/blog/agent` documents the local-server-as-bridge pattern. |
| **bippy** (github.com/aidenybai/bippy) | Safe `__REACT_DEVTOOLS_GLOBAL_HOOK__` patching; `traverseFiber`, `traverseRenderedFibers`; cross-React-version utilities. |
| **@onlook/babel-plugin-react** | Build-time `data-oid` injection for RSC support. The `docs.onlook.com/developers/architecture` doc explains the parse→mutate→write pipeline. |
| **Stagewise toolbar** (github.com/stagewise-io/stagewise) | Shadow-DOM overlay pattern at z-index 2147483647; framework adapters for Next, Vue, etc.; how to patch React libraries that fight the Shadow DOM. AGPL-3 — read but be careful about forking. |
| **React Scan** | `bippy` in production; on-screen performance overlays as a model for low-overhead visual annotations. |
| **Floating UI** (`@floating-ui/dom`) | Robust tooltip and handle positioning that avoids viewport overflow. |
| **react-moveable** (npm) | The single best drag/resize/snap library; 42,786 weekly downloads, mature. |
| **recast / @babel/parser / @babel/traverse** | The canonical format-preserving AST round-trip; the egghead.io "Codemods with Babel Plugins" guide is the best primer. |
| **prettier-plugin-tailwindcss** | The `createSorter` API and the documented matrix of `class`/`className`/`clsx()`/`cn()`/template literals — the same matrix you need to mutate. |
| **@modelcontextprotocol/sdk** (^1.29.0) | The TypeScript SDK; the `modelcontextprotocol.io/docs/develop/build-server` quickstart is concrete and short. |
| **Lovable's "Visual Edits" blog** (lovable.dev/blog/visual-editors) | Client-side AST manipulation strategy; the `toJSXTree` traversal pattern is directly applicable. |
| **LocatorJS** (locatorjs.com) | Alternative element→source mapper; useful as a fallback if your bippy approach hits React-version snags. |

### 11. MVP vs Deferred — Be Ruthless

**Ship in MVP (the see → drag → preview → commit loop) [REVISED 2026-05-18 to match `PROJECT_CONTEXT.md` §5]:**

1. **Build-time `data-oid` Babel plugin** — stamps every `JSXOpeningElement` (verified working in Spike A).
2. Element selection on hover (single + multi via shift-click) — Client *and* Server Component DOM.
3. Spacing indicators (padding/margin/gap) on hover.
4. Drag to move (free-position absolute elements; sibling-reorder for flex children).
5. Resize via 8-point handles, snapped to the *resolved* Tailwind theme (not a hardcoded table).
6. Keyboard nudge (1 px / 10 px).
7. Staged-changes buffer in memory with undo/redo, keyed by `data-oid` (not Fiber identity).
8. AST writes for Tailwind className edits — **only on static string literals** at the located JSXOpeningElement. Refuses dynamic contexts (`cn`/`clsx`/`twMerge`/`cva`/spread) with a clear reason.
9. **Instance-count confirmation** — when one source location renders N DOM nodes, surface "this edit affects N elements" before Apply.
10. **Authenticated local server** — loopback bind + unguessable per-session token + pinned origin.
11. The 4 MCP tools, registered with Claude Code via stdio, with summary-vs-detail payload split to keep token cost modest.
12. Tailwind only (no CSS Modules, styled-components, vanilla CSS).
13. Client-Component **editing**; Server-Component **mapping/hover** with edits disabled and a clear "v0.2" message.

**Defer to v0.2+ [REVISED 2026-05-18]:**

- Server Components **editing** support (the runtime preview loop is the hard part; mapping already works in v0.1 via `data-oid`).
- **Dynamic className editing** (mutation inside `cn`/`clsx`/`twMerge`/`cva` calls — currently refused at the writer).
- **Instance-specific edits** (changing only the second `<Card />` rendered from a `.map(...)` — v0.1 always edits the source).
- CSS Modules, styled-components, vanilla CSS write-back.
- Auto-layout detection / "convert div to flex" (Figma's killer feature).
- Component extraction / "make this a reusable `<Card>` component" (Onlook does this).
- Design tokens / variables panel.
- Multi-cursor team editing.
- Production-build source map fallback.
- Monorepo cross-package symbol awareness.
- Variant authoring (CVA / multi-state components).
- Image and asset management.
- Branching / checkpoint system (Onlook's local-Git approach).

### 12. Reference / Inspiration Projects to Read Before You Start

Spend a half-day reading source before you write a line:

1. **react-grab's source** (`packages/react-grab/src` in github.com/aidenybai/react-grab) — the cleanest minimal implementation of Fiber-walk + clipboard-context + script-tag install. MIT licensed.
2. **bippy's source** (github.com/aidenybai/bippy) — small, focused codebase, the entire React DevTools-hook trick documented in code.
3. **Stagewise's `toolbar/core`** (github.com/stagewise-io/stagewise) — Shadow DOM init pattern, framework adapters; AGPL-3 (note: licensing means you can read but if you fork, you must AGPL your tool too).
4. **Onlook's architecture wiki** (docs.onlook.com/developers/architecture and the wiki on github.com/onlook-dev/onlook) — the data-oid mechanism described in the architecture wiki entry: *"Onlook is technically a browser that points to your localhost running the app. It can manipulate the DOM like a Chrome Devtool, and all these changes are injected into the page through a CSS stylesheet or DOM manipulation. The changes are non-persistent until written to code. To translate the changes to code, we inject an attribute into the DOM elements at build-time that points back to the code like a sourcemap."*
5. **Lovable's Visual Edits engineering post** (lovable.dev/blog/visual-editors) — best writeup of client-side AST + optimistic preview; quotes their `toJSXTree` function verbatim.
6. **The 2026 DEV.to comparison** "AI Coding Tools That Actually See Your Browser" (dev.to/bluehotdog/ai-coding-tools-that-actually-see-your-browser-2026-2hoc) — surveys Frontman, Stagewise, Tidewave, Chrome DevTools MCP, Onlook with honest tradeoffs; useful for positioning.
7. **react-grab's "For Agents" blog** (react-grab.com/blog/agent) — the local-server-as-bridge pattern with the ASCII diagram you should mentally print and pin to your monitor.

There is **no public GitHub project that does exactly what you're describing** (Figma-grade visual editor + deterministic AST writes + MCP). The closest combinations are:

- **Onlook + Tailwind + Next.js** does AST writes but is moving toward a web app on CodeSandbox containers, not a local-dev tool.
- **react-grab + Claude Code provider** does the MCP/agent loop but only for *context*, not *gestures*.
- **Stagewise** does the overlay + agent integration but its drag is a comment/select primitive, not a Figma-grade transform.

You're combining the best ideas from each. That's the right move and there is no off-the-shelf fork that gets you there faster than building it deliberately on this stack.

---

## Recommendations

**Start in this exact order — do not reorder:**

1. **Day 1:** Stand up a Next.js 16.2 app with Tailwind. Add a single 50-line script that, on `mousemove`, prints the element under the cursor's source location via `__source` and Fiber `_debugSource`. If this doesn't work cleanly on your installed React version, install React 19.0 explicitly (not 19.2) and verify. Threshold: you can hover any element and see its file/line in the console.
2. **Day 2:** Add the Shadow-DOM overlay root and render a single outline rectangle around the hovered element. Threshold: rectangle stays glued to the element across HMR refreshes.
3. **Day 3–4:** Render padding/margin/gap indicators. Threshold: side-by-side comparison with Chrome DevTools' Elements panel highlights matches within a pixel.
4. **Day 5–7:** Wire `react-moveable` with Tailwind-snap. Threshold: drag a button's padding from `p-4` to `p-6` visually and see the inline style update, even though no file has been written.
5. **Day 8–10:** Build the AST mutation server. Threshold: hit `POST /apply` with curl, see the source file's `p-4` change to `p-6` with zero whitespace drift in `git diff`.
6. **Day 11–14:** MCP wrap + register. Threshold: in Claude Code, the command "show me the current visual edit and apply it" works end-to-end.

**Hard stop points where you should reconsider the design:**

- If Milestone 1 takes more than 2 days, your React version isn't giving you source locations. Switch to a build-time data attribute plugin (`@onlook/babel-plugin-react` or a 50-line custom one) before going further.
- If Milestone 4's AST round-trip produces any diff noise (changed quotes, reflowed lines), stop and find the bug in your `recast` setup — every downstream feature depends on this being clean.
- If Milestone 5's MCP server doesn't connect on first try, run `npx @modelcontextprotocol/inspector` against your server in isolation. Do not debug through Claude Code's UI.

**Don't do these things even if tempted:**

- Don't ship Server Component editing in v1.
- Don't try to support CSS Modules + Tailwind + styled-components in v1.
- Don't write a custom SWC plugin yet — `experimental.swcPlugins` has open Turbopack crash bugs (vercel/next.js #74611, #78156).
- Don't put the overlay in React — use Preact or Solid to avoid two React instances.
- Don't `console.log` from the MCP server's stdio process.

---

## Caveats

- **React 19.2 breakage:** Babel issue #17571 documents that `@babel/plugin-transform-react-jsx-development` was updated to stop emitting `__source` / `__self` arguments to align with React 19.2. The data is still on `fiber._debugSource`, but if you're pinned to a transitional Babel version you can see duplicate `__self` errors. Pin a known-good combination.
- **`@onlook/babel-plugin-react`'s exact `data-oid` encoding is not documented in primary source.** Third-party blogs describe it as a build-time stable id; I could not retrieve the plugin's source file to confirm whether it encodes `path:line:col` literally or a hash + side-table. If you adopt this path, plan to read the source after cloning the repo locally. The package is at version 2.1.1 and was last published in mid-2024, suggesting Onlook's main project may have moved toward doing AST instrumentation inside its own indexer rather than asking users to install this plugin.
- **`experimental.swcPlugins` is not stable under Turbopack** as of Next.js 16 (vercel/next.js #74611, #78156 still open and labelled as confirmed Turbopack team issues). Treat the SWC-plugin path as a future option, not a present one.
- **Stagewise is AGPL-3.** You can read its source freely, but if you fork code from it your derivative must also be AGPL-3, which most commercial closed-source projects will not want. `react-grab` (MIT) and `bippy` (MIT) are safer to fork.
- **`__reactFiber$…` keys are private React internals.** Both bippy's README and react-grab's own writeup explicitly warn: *"Because this uses private, undocumented APIs, it's fragile. A React update could change how fibers work or how DevTools connects."* Wrap every Fiber-walk call in try/catch and degrade gracefully to `__source` props when it fails.
- **Chrome DevTools' overlay rendering primitives are not directly callable from a page.** The CDP `Overlay` domain (`Overlay.HighlightConfig` etc.) is only accessible from a DevTools extension or a remote debugger client. You're replicating the *look*, not reusing the *engine*.
- **Subagent gap:** I could not directly read `@onlook/babel-plugin-react`'s source through web tooling (the GitHub raw fetch was blocked). Findings about `data-oid` format are based on Onlook's architecture doc and third-party writeups; the exact payload format should be verified by `git clone`ing the Onlook repo before you write a compatible plugin.
- **Specific port numbers** (7790 for the local server) are recommendations, not requirements; react-grab uses 7567 for `@react-grab/mcp` and 4567 for `@react-grab/claude-code` — pick a port you control and document it.
- **No off-the-shelf fork matches this exact spec.** This is a synthesis of patterns, not a reproduction of an existing project. Budget accordingly.