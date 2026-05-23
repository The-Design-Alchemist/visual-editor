# Visual Edit — v0.2 Roadmap

> Companion to `PROJECT_CONTEXT.md` §5. This document lists every item we
> deferred from v0.1, sized realistically and ordered by tractability +
> principle compliance. Read this before starting v0.2 work.

> **Status:** v0.1 shipped 2026-05-18 (80/80 tests, end-to-end loop working through
> overlay → server → MCP). This document is the plan for what's next.

---

## Triage

| Tier | What it means |
|---|---|
| **A — Buildable now** | Small, well-scoped, no principle conflict. Targeted in the current session. |
| **B — Substantial but principled** | Real work (days–week each) but Principle-1-safe. v0.2 proper. |
| **C — Architecturally bigger** | Whole sub-projects. v0.2 stretch / v0.3. |
| **D — Principle-1 conflict** | Requires LLM interpretation in the deterministic path. Needs explicit re-scoping before we touch it. |
| **E — Already declined** | Out of v0.1/v0.2 by design (production runtime, multi-cursor). |

---

## Tier A — Implementing in this session

### A1. Persistent undo history
Recent applies survive server restart by writing to `<workspace>/.visual-edit/history.json` (last 50). Loaded on `SessionToken.load()`-adjacent startup path. **Effort:** ~30 min. **Risk:** none — same shape as the existing in-memory deque, plus disk I/O.

### A2. Origin pinning + token-bootstrap hardening
CLI accepts `--allow-origin http://localhost:3000` (repeatable). Server reads the `Origin` header on writes and refuses if not in the allowlist. `/token` is similarly gated. This closes the spike-era hole where any local page can fetch the token. **Effort:** ~45 min. **Risk:** low — but cross-port dev (e.g. `next dev --port 3002`) needs the new flag.

### A3. Alignment guides while dragging
`react-moveable` already supports `snappable` + `elementGuidelines`. Pass the target's parent's children as guidelines and the side handles snap to sibling edges with magenta lines, threshold 4px (Tailwind base). **Effort:** ~30 min. **Risk:** low — Moveable does the rendering.

### A4. Padding inner-edge handles (Figma-style)
Four small handles drawn INSIDE the padding band on selection. Dragging the inner-top handle changes only the top padding (`pt-*`). Snaps via existing engine. **Effort:** ~90 min. **Risk:** medium — custom drag handles inside Shadow DOM + correctly mapping to AST `pt-`/`pr-`/`pb-`/`pl-` tokens. The AST writer already handles every prefix; this is purely overlay work.

### A5. Server Component edit support
Mapping already works in v0.1 (the `data-oid` Babel plugin runs over RSC output too). What was missing: applying a className edit to RSC-rendered DOM didn't update the client until Fast Refresh. v0.2 approach: on Apply, optimistically swap the `className` token directly on the DOM element while the server writes the file. When Fast Refresh fires, the DOM gets repainted to its new ground-truth state. If Fast Refresh doesn't fire within a budget (e.g. mixed CC/RSC trees where the RSC subtree needs a route-segment refresh), show a "full reload to see final result" indicator. **Effort:** ~45 min. **Risk:** medium — the optimistic DOM patch is robust; the "did Fast Refresh repaint" detection is heuristic.

---

## Tier B — Substantial but principled (v0.2 proper)

> **Tier B batch 1 (this session):** B5, B7, B6, B8 in that order. Each is a small, discrete, well-defined feature. The big-domain items B2 (CSS Modules) and B3 (styled-components) are deferred to dedicated multi-day sessions — they each require a new file resolver + new AST pipeline + their own conflict-detection model. Doing them in pieces would leave a half-built foundation.


### B1. Dynamic className mutation with static safety analysis ✅ SHIPPED 2026-05-18
v0.1 refused any `cn`/`clsx`/`twMerge`/`cva`. v0.2 mutates inside known mergers (`cn`, `clsx`, `classnames`, `twMerge`, `twJoin`) when the safety analysis proves the mutation has effect.

Implementation: `mutateOnCallExpression` in `packages/server/src/ast/className.ts`. Algorithm:
1. Verify callee is a known merger; refuse with `unknown-merger` if not.
2. Find the StringLiteral arg containing `before`. Refuse with `token-not-found` if none.
3. For every other arg: refuse with `dynamic-uncertain-arg` if non-static, `dynamic-spread-arg` if spread.
4. Build the post-mutation concatenated className across all string args. Run through `tailwind-merge`. If `after`'s tokens don't all survive the merge, refuse with `dynamic-conflict`.
5. Otherwise mutate the StringLiteral via recast.

Tests added: 11 new tests covering happy path, multi-token args, non-first-arg targets, identifier args, spread args, unknown mergers, nested calls (`cva()()`), conflict refusal, partial-conflict-where-tailwind-keeps-both, compound-override `after` like `"p-4 pt-8"`. End-to-end verified through the overlay's keyboard nudge on a `cn()`-wrapped target in the spike app.

Out of scope (still v0.3+): `cva(base, variants)` — its second arg is a structured object, not analyzable by the v0.2 rules. The first arg by itself is mutatable in principle but requires updating `KNOWN_MERGERS` plus variant-conflict analysis.

### B2a. CSS Modules write-back — server pipeline + MCP ✅ SHIPPED 2026-05-18
Server-side AST pipeline + MCP tool. Three new modules in `packages/server`:
- `src/css/cssModule.ts` — `detectCssModule(jsxSource, line, col)` walks the JSX and the import declarations to resolve `<div className={styles.foo}>` to a `(cssFile, ".foo")` ref. `mutateCssProperty(cssSource, selector, property, value)` parses with `postcss`, finds the rule, updates or inserts the declaration, returns the rewritten CSS + the previous value (for undo bookkeeping).
- `src/fs/applyCssProperty.ts` — orchestrator: read JSX, detect, resolve CSS path against workspace, read CSS, mutate, write. Returns a unified diff. Workspace-containment + 403/404 status codes.
- `src/http/server.ts` — new `POST /apply-css-prop` endpoint with the same auth + Origin checks as the Tailwind path.
- `packages/mcp/src/server.ts` — new `apply_css_property` tool exposing the endpoint to Claude Code.

Refusals: `not-a-css-module` (import isn't `.module.css`), `dynamic-classname` (className isn't `{identifier.property}`), `unresolved-import` (no matching default import for the identifier), `selector-not-found`, `composes-chain` (would leak through to other rules), `invalid-property` (defensive against injection).

Tests: 17 unit + integration tests (`packages/server/test/cssModule.test.ts`) covering happy path, both update-existing and insert-new property cases, every refusal reason, @media subtree isolation, dryRun. Total server tests now 115/115.

### B2b. CSS Modules write-back — overlay UX ✅ SHIPPED 2026-05-18

Babel plugin extended (`Program` visitor pre-collects default imports from `.module.css` files; `JSXOpeningElement` visitor stamps `data-css-module-class="card"` + `data-css-module-file="./CssModuleCard.module.css"` on every element using `{styles.foo}`). Overlay's `acquire` checks for `data-css-module-class` on the selected element and opens a dedicated **CSS panel** (bottom-left) instead of the Tailwind pending UX. Panel shows the resolved selector + file, plus two text inputs (property, value) and an Apply button that POSTs to `/apply-css-prop`. Result line shows the previousValue → value transition. End-to-end verified: clicking the spike's `<CssModuleCard />` opens the panel, typing `border-radius` `1.5rem` and Apply mutates `0.5rem → 1.5rem` in the source CSS file with zero console errors.

### B3a. styled-components — server pipeline ✅ SHIPPED 2026-05-18
New `packages/server/src/css/styledComponents.ts` with `detectStyledComponent` (walks JSX → finds same-file `const X = styled.tagname\`…\`` definition) and `mutateStyledProperty` (parses static template text as CSS via postcss-wrapped synthetic rule, updates/inserts a declaration, rewrites the TemplateElement's raw+cooked value). New `applyStyledProperty` orchestrator. New `POST /apply-styled-prop` endpoint. New `apply_styled_property` MCP tool.

Refusals: `not-a-styled-component` (lowercase tag / no match), `styled-with-interpolation`, `styled-extension-not-supported` (`styled(Base)`), `styled-attrs-not-supported` (`.attrs(...)`), `cross-file-styled-not-supported`, `component-not-found`, `invalid-property`.

13 dedicated tests; server total 129/129 passing. End-to-end verified: `const Card = styled.div\`padding: 1rem; …\`` → mutate to `2.5rem` → diff cleanly applied, surrounding declarations preserved.

### B3b. styled-components — overlay UX ✅ SHIPPED 2026-05-18
Babel plugin's `Program` visitor now also pre-collects same-file styled definitions (componentName → htmlTag), and the per-element visitor stamps `data-styled-name="Card" data-styled-tag="div"` when the JSX tag matches a collected definition. Overlay's `showCssPanel` is now mode-aware: it dispatches to `/apply-css-prop` for CSS-Modules elements (`data-css-module-class` attribute) and `/apply-styled-prop` for styled-components (`data-styled-name`), with appropriate titles + meta ("Card = styled.div`…`"). End-to-end verified via Playwright.

Plus: standard styled-components SSR registry (`app/lib/StyledRegistry.tsx`) wired into root layout to eliminate hydration warnings.

### B4. Production source-map fallback for overlay
*Out of scope per Principle: dev-only.* Not on the v0.2 list.

### B5. Persistent staged-changes buffer (drafts) ✅ SHIPPED 2026-05-18
Overlay persists the pending change to `localStorage["visual-edit:draft-v1"]` on every showPending; clears on Apply success / Discard / hidePending. On mount, looks for an existing draft and re-resolves the element by data-oid. If the DOM still has the matching element, restore the pending panel; otherwise clear the stale draft. Verified: pending change `p-4 → p-5 (20px)` survives a full browser reload.

### B6. /history with diff replay ✅ SHIPPED 2026-05-18
History panel UI in the overlay. Click the "visual-edit on" badge to toggle. Panel pulls from `GET /recent`, renders newest-first with relative timestamps, file:line:col, before → after tokens, and a per-row Undo button that POSTs to `/revert {file, line, col}`. List refreshes after Undo. Verified with 31 historical entries; Undo decremented count to 30.

### B7. Cross-package symbol awareness in monorepos ✅ SHIPPED 2026-05-18 (first cut)
Babel plugin now accepts a `root` option, OR walks up the filesystem looking for workspace markers (`pnpm-workspace.yaml`, `turbo.json`, `lerna.json`, `nx.json`, `.git`) to auto-discover the monorepo root. Falls back to `state.cwd` if no marker is found. data-oid paths are emitted relative to that root, so a Next.js app under `apps/web` that imports from `packages/ui` produces `data-oid="packages/ui/Card.tsx:12:4"` — the server then resolves it against the same root via `resolveSafe`. Single-package projects (like our spike) still work because the example-app's own `.git` is the nearest marker. **Open:** a real pnpm/turborepo monorepo fixture would prove the cross-package write-back; the plumbing is in place but unverified outside the single-package case.

### B8. Image asset replacement ✅ SHIPPED 2026-05-18
New `mutateAttribute` AST function handles whole-value string-attribute swaps (src, href, alt, …). New `GET /assets` endpoint lists images under `<workspaceRoot>/public/` (png/jpg/jpeg/gif/svg/webp/avif), sorted, returned as paths like `/foo.png`. New `attribute` field on `/apply` routes to mutateAttribute when set to anything other than "className". Optional `before: null` skips the conflict check (asset picker UX — the server reports the actual previousValue back so the recent-applies buffer can still undo). Overlay: when an `<img>` is selected and the user presses `i`, an asset picker opens listing all images; click one → POST `/apply {attribute:"src", before:null, after:"/picked.svg"}` → source file updated + optimistic DOM patch. Verified end-to-end: `<img src="/next.svg" ...>` → press `i` → pick `/vercel.svg` → source becomes `<img src="/vercel.svg" ...>`.

---

## Tier C — Architecturally bigger

### C1. Design tokens panel (with theme write-back)
A side panel listing `--spacing-*`, `--color-*`, `--font-*` defined in the project's `globals.css` or `@theme` block. Click a token, edit value, AST-mutate the CSS file. Lots of UX surface — naming, conflict detection, preview-before-write. **Effort:** 1–2 weeks. **Principle compliance:** OK.

### C2. Variant authoring for CVA-style components
Edit a `cva({ variants: { size: { sm: "p-2", lg: "p-6" }}})` block visually. Could be a structured editor inside the overlay, not free-form. **Effort:** ~1 week. **Principle compliance:** OK — structured edits map cleanly to AST.

### C3. Visual git checkpoint system
Track every overlay-driven change as a separate git commit chain, with revert/branch/cherry-pick exposed in the overlay. Onlook ships this. **Effort:** ~2 weeks. **Principle compliance:** OK.

---

## Tier D — Principle-1 conflicts (need explicit decision before any work)

### D1. Auto-layout detection ("convert this div to flex")
Inferring "what flex/grid container would best replicate the current layout" is interpretive and pattern-matchy. To do it deterministically, we'd need a strict mapping from observed layout to a flex declaration. To do it well, we'd want an LLM. **Decision required:** does v0.2 accept an LLM-mediated suggestion that the AST writer still applies deterministically? If yes, this is a v0.2 stretch. If no, defer until we have a principled algorithm.

### D2. Component extraction ("make this a reusable Card")
Choosing the right component boundary, naming the component, identifying its props, picking the import path — all interpretive. Same gating decision as D1. **Recommendation:** these belong in a "LLM-assisted refactor" tool that lives ALONGSIDE visual-edit, not inside it. Keeping visual-edit deterministic preserves the trust model.

### D3. Instance-specific edits (changing only the second `<Card />`)
v0.1 always edits the source. v0.2 could "lift" the className to a prop and pass a different value at the call site of the second instance — but that's a structural refactor that changes the component's public API. Mechanically possible but semantically risky. **Decision required:** is the lifted prop's name user-chosen, or auto-generated? Either way the project's TS surface changes. Probably v0.3.

---

## Tier E — Already declined in the spec

- Multi-cursor / team collaboration
- Production runtime support (overlay is dev-only by design)
- A whole IDE (Onlook's path)
- Becoming a Figma replacement
- Becoming a generic code generator / test author / deployment tool

These stay out forever; no work planned.

---

## Recommended v0.2 milestone shape

If I were planning a real two-week v0.2 sprint after this session:

```
Week 1
  Day 1   A1 (persistent undo) + A2 (origin pinning + token hardening)        ← landed in session
  Day 2   A3 (alignment guides) + A4 (padding inner handles)                  ← landed in session
  Day 3   A5 (RSC edit support)                                               ← landed in session
  Day 4   B1 spec + write tests for the conflict cases  (NOT YET)
  Day 5   B1 implementation                                                    (NOT YET)

Week 2
  Day 6   B2 (CSS Modules) — scaffolding + happy path                          (NOT YET)
  Day 7   B2 — composes/conflict cases                                         (NOT YET)
  Day 8   B5 (persistent staged drafts) + B6 (history panel)                   (NOT YET)
  Day 9   B7 (monorepo) + B8 (image swaps)                                     (NOT YET)
  Day 10  Polish, dogfooding, demo build

Decisions held for explicit user choice before starting:
  D1 (auto-layout)  — needs LLM-vs-no-LLM call
  D2 (extraction)   — same
  D3 (per-instance) — needs API-change tolerance call
```

---

## What's actually shipping in this session

Tier A in full:

- ✅ A1. Persistent undo history
- ✅ A2. Origin pinning + token hardening
- ✅ A3. Alignment guides while dragging
- ✅ A4. Padding inner-edge handles
- ✅ A5. Server Component edit support

Everything in Tier B, C, D stays as plan only.

When you start v0.2 proper, this doc is the queue.
