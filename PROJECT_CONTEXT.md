# Visual Edit for Next.js — Project Context

> A context document for code review (Codex, Claude, or human reviewers). This explains **why** we are building this tool, **what** workflow problem it solves, **what we're explicitly not building**, and the **principles** that should guide implementation decisions. Read this before reviewing architecture or code.

> **Revised 2026-05-18 after adversarial review.** Key changes: build-time `data-oid` moved into v0.1 (Principle 6 inverted); determinism preconditions tightened (Principle 1); a new Principle 11 covers the "one source location → N DOM instances" trap; RSC *mapping* is now in v0.1, RSC *editing* stays deferred; success criteria 7 and 8 added for refusal-with-clarity and instance visibility; new Pre-Milestone Spikes section gates the build behind two specific de-risking exercises.

---

## 1. The Problem

When building Next.js apps with AI coding agents (Claude Code, Cursor, etc.), there is a specific friction in the visual iteration loop:

**The developer sees the rendered app in their browser. They notice a visual issue — "this padding is too tight," "this button should be 8px to the right," "the gap between these cards is wrong" — but they cannot precisely communicate this to the AI agent.**

Today's workflow looks like:

1. Run `next dev`, see the page in the browser.
2. Spot a visual issue.
3. Open DevTools, inspect the element, mentally translate "this needs more padding" into a textual prompt.
4. Type into Claude Code: *"can you make the padding bigger on the login button?"*
5. Claude Code searches for "login button," guesses which file, guesses the right Tailwind class, applies a change.
6. Reload, check, find it picked the wrong button / wrong direction / wrong amount.
7. Repeat.

**Three failure modes recur:**

- **Ambiguity at selection.** "The login button" might match three elements. "This padding here" is unprintable into a prompt.
- **Ambiguity at intent.** "Make it bigger" — by how much? `p-4 → p-5`? `p-4 → p-8`? Should it be a Tailwind scale value or an arbitrary `p-[23px]`?
- **Ambiguity at execution.** The agent has to guess the file, the line, and what change is even being asked for. Each guess compounds.

The result is a back-and-forth that should take 5 seconds and instead takes 5 minutes — and frequently produces wrong commits that pollute git history.

---

## 2. The Insight

The problem is not Claude Code. Claude Code is excellent at *applying* a precisely-specified code change. The problem is that **natural-language prompts are a lossy medium for visual changes**.

A visual change has three deterministic facts:
- **Which element** (a specific node in a specific source file at a specific line/column)
- **Which property** (className, style, gap, padding-left, etc.)
- **Which exact value** (`p-4` → `p-6`, not "bigger")

If the developer can express these three facts *visually* — by hovering, clicking, dragging — and the tool can capture them losslessly, then Claude Code's job becomes mechanical: review the diff, run tests, commit. **There is no longer any room for the agent to guess wrong, because there is nothing left to guess.**

This reframes the goal:

> **Build a tool that converts visual gestures into structured, unambiguous code edits — and uses Claude Code as the reviewer/committer, not the interpreter.**

This is fundamentally different from how Stagewise, react-grab, or v0 work. Those tools pass *richer context* to a freeform-prompt-driven agent. We are eliminating the freeform prompt entirely for the cases where it doesn't earn its keep (spacing, sizing, alignment, color, typography).

---

## 3. Why Existing Tools Don't Solve This

We surveyed the space exhaustively (see research docs). The closest options:

- **Onlook** — closest match conceptually (visual canvas → AST writes), but it loads your project inside a CodeSandbox web container, not your real `next dev` process. The indirection breaks for projects with custom dev setups, env vars, monorepos, or anything beyond the happy path. It's also an entire IDE/canvas, not an overlay on your existing browser.
- **Cursor 2.2 Visual Editor** — exactly the right idea, but locked to Cursor's own agent and $20/month plan. Cannot use Claude Code as the executor.
- **Stagewise** — Shadow-DOM toolbar that emits prompts. The agent still does the interpretation work, so we're back to ambiguity at execution.
- **react-grab** — passes file:line:col context to agents, but is select-and-prompt, not select-and-manipulate. Closer to "smart copy" than "visual edit."
- **Builder.io Fusion / Locofy** — Figma-side tools. Not an overlay on your running localhost.

**The gap:** no tool combines (a) live overlay on your real `next dev` process, (b) Figma-grade visual manipulation, (c) deterministic AST writes, and (d) Claude Code as the agent. That's the slot this project fills.

---

## 4. Workflow Goal

The target loop, end to end:

```
[1] dev runs `next dev` as normal
[2] visual-edit auto-loads in dev mode (one <Script> in app/layout.tsx)
[3] dev hovers over a button → sees Figma-style spacing/padding/margin indicators
[4] dev drags a handle to nudge padding from p-4 to p-6
    → inline style applies LIVE in the browser
    → nothing is written to disk yet
[5] dev iterates: undo, redo, try p-5, try p-8, settle on p-6
[6] dev clicks "Apply" (or runs /visual-edit in Claude Code)
    → MCP server hands Claude Code:
      - exact file path
      - exact line:column
      - exact before value ("p-4")
      - exact after value ("p-6")
      - a unified diff
[7] Claude Code reviews the diff (Server Component check, lint, etc.)
    → commits the change
[8] Next.js Fast Refresh picks it up
    → overlay re-syncs, badge clears
```

**Key property:** between step 4 and step 7, the user is the one making visual decisions, and the data flowing to Claude Code is structured and exact. No prompts like "make it bigger" ever exist in the system.

---

## 5. What We Are Building (Scope)

**Shipped in MVP (v0.1):**

1. **Build-time `data-oid` Babel plugin** — stamps every `JSXOpeningElement` with a stable id at compile time. The primary element→source map. Runs under Next 16.2 + Turbopack via the webpack-loader compat layer.
2. **Element selection on hover** — visual outline with file/line/component badge. Works on both Client and Server Component DOM (both carry `data-oid`).
3. **Spacing/padding/margin/gap indicators** — Figma-style, on hover.
4. **Multi-select + distance measurement** — Alt-hover to measure between elements.
5. **Drag/resize gestures** — 8-point handles, snap to the user's *resolved* Tailwind scale (read from the running theme — not a hardcoded table — to handle v4 `@theme` and v3 `theme.spacing` overrides). Arbitrary-value escape hatch on Alt-hold.
6. **Keyboard nudge** — arrow = 1px, Shift+arrow = 10px.
7. **Staged changes buffer** — in-memory, undo/redo, fully non-destructive. Keyed by `data-oid`, not by Fiber identity.
8. **Deterministic AST writes** — recast + Babel parser/traverse for clean className mutations preserving formatting. **Refuses to write** when the className is dynamic (`cn`/`clsx`/`twMerge`/`cva` call, spread, or conditional) and explains why.
9. **Instance-count confirmation** — when the source location renders N DOM nodes, Apply shows "this edit affects N elements at `<source>`" before commit. (Principle 11.)
10. **Authenticated local server** — `:7790` bound to loopback only; every request carries an unguessable per-session token; allowed origins pinned to the active dev-server URL. Prevents drive-by writes from other local pages/tabs.
11. **MCP server with 4 tools** — `get_selected_element`, `propose_change`, `apply_change`, `revert_change`. Payloads split *summary* vs *detail* to keep token cost per turn modest (computed-style dumps are opt-in, not default).
12. **Tailwind className edits only** — no CSS Modules, no styled-components, no vanilla CSS yet.
13. **Editing on Client Components only.** RSC content is *hovered and mapped* (you see the outline and source), but the drag handles are disabled with a clear "Server Component — visual editing ships in v0.2" message. The runtime preview loop (HMR + inline style) only works cleanly for client subtrees in v0.1.

**Explicitly deferred to v0.2+:**

- **Server Component *editing*** (mapping already works in v0.1 via `data-oid`; the hard part is the runtime preview/Fast Refresh loop without client state).
- **Dynamic className editing** (mutating tokens inside `cn`/`clsx`/`twMerge`/`cva` — currently refused at the AST writer with a clear reason).
- **Instance-specific edits** (changing only the second `<Card />` without affecting the source — would require lifting the className to a per-instance prop or extracting a variant; v0.1 always edits the source).
- CSS Modules / styled-components / vanilla CSS write-back.
- Auto-layout detection ("convert this div to flex").
- Component extraction ("make this a reusable Card").
- Design tokens panel / theme editing.
- Multi-cursor / team collaboration.
- Production build support (overlay is dev-only by design).
- Monorepo cross-package symbol awareness.
- Image asset management.
- Visual git checkpoint system.

**Explicitly NOT building, ever:**

- A whole IDE (Onlook's path).
- A replacement for Figma (we are not a design tool).
- A replacement for Claude Code (we hand off to Claude Code for execution).
- A natural-language-to-design-change tool (the whole point is eliminating natural language).
- A production runtime (dev-only).

---

## 6. Architecture Principles

These are the load-bearing decisions. Any code change that violates one of these should be questioned in review.

### Principle 1: Determinism over intelligence

If a change can be expressed as a deterministic AST transformation, **it must not go through an LLM**. LLMs introduce variance; variance breaks the "zero mistakes" promise. The whole architecture is biased toward:

- Babel AST mutations for known-shape edits (className token swaps, attribute changes).
- recast for format-preserving round-trips.
- LLM (Claude Code) only as a reviewer/refactorer — never as the interpreter of the user's intent.

If you find yourself writing "ask the model to rewrite this," **stop and ask whether an AST transform would do.**

**Determinism preconditions.** Determinism is only achievable when the token being edited is (a) a static string literal at the located `JSXOpeningElement`, and (b) provably the *effective* class at runtime — not shadowed by later `twMerge`/`cva` precedence, not hidden inside a conditional, not arriving through a JSX spread (`<Button {...props} />`). If either precondition fails, the tool refuses to write and surfaces the exact reason. We never "best-effort" a dynamic edit. This is the load-bearing line that makes the "zero mistakes" promise honest — and it's what we'd lose first if we got lazy.

### Principle 2: Non-destructive previews

Nothing touches disk until the user explicitly commits. Inline styles, in-memory staged buffer, undo/redo. The user must always be able to discard freely. This is the property that makes the tool *feel* like Figma rather than like git.

### Principle 3: NPM package, not browser extension

We run as a `<Script>` import in `app/layout.tsx`, gated on `NODE_ENV === 'development'`. We do *not* ship a Chrome extension. Reasons:

- MV3 isolated-world CSP blocks Fiber access without a postMessage bridge.
- Disk writes require a companion local server anyway.
- Chrome Web Store review latency kills iteration.
- Every precedent (react-grab, Stagewise, Onlook) chose npm package or local app — no serious player ships as an extension.

### Principle 4: Shadow DOM for the overlay

CSS isolation is non-negotiable. The user's `* { box-sizing: border-box }` must not affect our handles. Our Tailwind reset must not bleed into the app. Shadow DOM with `mode: 'closed'` at `z-index: 2147483647`.

### Principle 5: Preact or Solid for overlay UI — not React

If the host app uses React 19 and we also use React, the DevTools hook receives two renderer registrations and things break. react-grab built its overlay in Solid for exactly this reason. We use Preact for the overlay; the host stays untouched.

### Principle 6: Source mapping via build-time stable IDs, with React internals as fallback

We originally planned to lean on React's `__source` JSX prop and Fiber `_debugSource` as the primary source-of-truth and defer build-time instrumentation to v0.2. Adversarial review surfaced two compounding problems we can't ignore: **React 19.2 removed `__source`/`__self`** from `jsxDEV` (`_debugSource` survives but is fragile private internal metadata that Fast Refresh boundaries can drop), and **Server Components — which compose half of any real App Router page — have no Fiber to walk at all**. Rather than silently miss large parts of the user's app on hover, we ship a build-time `data-oid` Babel plugin (Onlook-style: stamps every `JSXOpeningElement` with a stable id) as **v0.1 infrastructure**. `bippy` + `_debugSource` remain as a fallback path for setups where the plugin can't run (e.g., users on alternative bundlers), but they are not the source-of-truth. The staged-changes buffer keys by `data-oid`, not by fiber identity — fibers are recreated every render and would lose state across HMR.

### Principle 7: Stdio MCP, not HTTP

Claude Code's docs are explicit: stdio servers are local processes Claude spawns and owns. Simplest lifecycle, fewest moving parts. HTTP/SSE is for remote cloud MCP servers. Our use case is local-only.

### Principle 8: Four MCP tools, no more

Every tool description ships to Claude on every turn. The token budget compounds. Four well-scoped tools (`get_selected_element`, `propose_change`, `apply_change`, `revert_change`) covers the full surface. Resist the temptation to add helpers.

### Principle 9: Tailwind scale by default, arbitrary values as escape hatch

When the user drags padding to 23px, the default behavior is to snap to the nearest Tailwind scale value (`p-6` = 24px). Holding Alt during drag emits `p-[23px]`. We are not optimizing for pixel-perfect at the cost of design-system hygiene. The default produces clean code; the escape hatch exists for the cases that need it.

### Principle 10: Fail loud, degrade gracefully

If `_debugSource` is missing, if the Fiber walk crashes, if the AST parse fails — we surface this immediately in the overlay UI with a clear error. We don't silently "do our best." The contract with the user is that a successful gesture produces a correct edit. If we can't guarantee that, we say so and refuse to write.

### Principle 11: Source-edits-many is surfaced, never hidden

A single source location (`Card.tsx:42:14`) very often renders N DOM instances (`items.map(item => <Card />)`). Editing the `className` at that location changes the source — which means **all N rendered instances update**. The tool must show "this edit affects N elements at `Card.tsx:42`" before Apply and require explicit confirmation when N > 1. We never silently propagate a visual edit to siblings the user didn't see — that's the surprise that loses the user's trust on day one and produces commits they didn't intend. Instance-specific edits (changing only the second card) are out of v0.1 scope; the v0.1 contract is "you're editing the component source, here's the blast radius."

---

## 7. Reference Architecture (1-Page Summary)

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (next dev on localhost:3000)                           │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  User's Next.js app (untouched)                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  visual-edit runtime (loaded via <Script> in dev only)   │  │
│  │  ├── bippy: walk Fiber tree, read _debugSource           │  │
│  │  ├── Shadow DOM overlay (Preact)                          │  │
│  │  │   ├── selection.ts: hit testing                        │  │
│  │  │   ├── spacing.tsx: padding/margin/gap indicators       │  │
│  │  │   ├── handles.tsx: react-moveable wrapper              │  │
│  │  │   └── guides.tsx: alignment lines, distance measure    │  │
│  │  ├── tailwind.ts: snap-to-scale, token swap               │  │
│  │  └── transport.ts: WebSocket to local server              │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP + WebSocket
                             │ (localhost:7790)
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  Local server (Node, started by `visual-edit start`)            │
│  ├── http.ts: REST endpoints                                     │
│  ├── ws.ts: live state push                                      │
│  ├── ast/                                                        │
│  │   ├── parse.ts: recast + @babel/parser                        │
│  │   ├── className.ts: token swap with cn()/clsx() support       │
│  │   └── write.ts: safe write with conflict detection            │
│  ├── watcher.ts: chokidar, suppresses self-triggered HMR         │
│  └── selection state (in-memory)                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │ (same process, exposes MCP via stdio)
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  MCP stdio server                                                │
│  ├── get_selected_element()                                      │
│  ├── propose_change(file, line, col, before, after)              │
│  ├── apply_change(...)                                           │
│  └── revert_change(...)                                          │
└────────────────────────────┬────────────────────────────────────┘
                             │ stdio (spawned by Claude Code)
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  Claude Code (separate terminal)                                 │
│  → reads the diff, reviews, commits                              │
└──────────────────────────────────────────────────────────────────┘
```

---

## 8. Success Criteria

The MVP succeeds if:

1. **End-to-end loop works under 10 seconds.** Hover → drag → apply → see in code → committed by Claude Code. Total wall-clock under 10 seconds for a single-property change.
2. **Zero ambiguity in commits.** `git diff` after an apply shows exactly the className/style token that changed and nothing else — no whitespace drift, no reflow, no unintended touches.
3. **No prompts in the loop.** The user never types "make it bigger" or any natural-language description of a visual change. Their hands move from mouse → keyboard nudge → Apply button. Claude Code's role is review, not interpretation.
4. **Works on the user's real `next dev` process.** Not in a container, not in a fork, not in a special branch. The same `npm run dev` they were already running.
5. **Discards are free.** The user can drag, undo, try again, undo, try a different element — without any disk writes.
6. **Tailwind code stays clean.** Most edits produce scale values (`p-6`). Arbitrary values (`p-[23px]`) only appear when the user explicitly opts in with Alt-hold.
7. **Dynamic classNames are refused with clarity.** When the source token sits inside `cn`/`clsx`/`twMerge`/`cva` or a JSX spread, the tool refuses to write and tells the user exactly which expression form blocked it. No silent best-effort, no half-applied edit.
8. **Multi-instance edits are visible.** When the source location renders N DOM nodes, the user sees "this edit affects N elements" before confirming Apply.

---

## 9. Pre-Milestone Spikes

Before any product code is written, two spikes retire the highest-risk unknowns. Skip these and the rest of the plan is a guess.

### Spike A — Build-time `data-oid` against React 19.2 + Next 16.2 + Turbopack

Write (or vendor from Onlook) a Babel plugin that injects `data-oid="<stable-id>"` on every `JSXOpeningElement`. Verify, in a fresh `npx create-next-app@latest` with the default React/Next/Turbopack/Tailwind v4:

- The attribute survives into both Client Component DOM and Server Component HTML.
- Fast Refresh doesn't strip or duplicate the attribute on edits.
- The `.babelrc` activates under Turbopack's webpack-loader compat layer without a Webpack-vs-Turbopack mode flag.
- The id is stable across rebuilds for the same source location (so the staged buffer survives HMR).

**Threshold to proceed:** hover any element on any page (client or server) in the example app and read a stable `data-oid` from `document.elementFromPoint(...)`.

### Spike B — `react-moveable` inside a closed Shadow DOM in a Preact island

Mount a Preact app inside a `mode: 'closed'` Shadow DOM, render `react-moveable` (via `preact/compat`) attached to a real DOM node in the host page. Verify:

- 8-point drag/resize handles render and respond to pointer events.
- Snap guidelines work against the host page's elements (composed-path event capture isn't blocked by the shadow boundary).
- Host page CSS (e.g., a global `* { box-sizing: border-box }`) doesn't leak into Moveable's handles, and Moveable's styles don't leak into the host.
- Two React copies (host 19.2 + overlay via preact/compat) don't fight on the DevTools hook.

**Threshold to proceed:** drag an 8-point handle on a button in a real Next.js page and see the inline `transform` update at 60fps with no console errors. If Preact/compat is unstable here, fall back to Moveable's vanilla build before committing.

### Side spike — Token-cost smoke test on MCP payloads

Mock the four MCP tools with realistic payloads (a `get_selected_element` response with computed styles, file path, classNames, the data-oid). Measure tokens per turn for a 3-edit session. If the total exceeds ~2k tokens of pure tool I/O, split the tool surface into summary/detail variants before exposing it to Claude Code.

---

## 10. What This Document Is For

If you're reviewing code in this repo (whether you're Codex, Claude, a human, or another agent), read this doc first. Then ask:

- Does this change preserve **non-destructive previews**? (no premature writes)
- Does it preserve **determinism**? (no LLM in deterministic paths; refuses dynamic-className contexts)
- Does it respect Principle 11? (surfaces multi-instance blast radius — never silently mutates a source that renders many DOM nodes)
- Does it stay in scope? (no RSC *editing*, no dynamic-className mutation, no CSS Modules, no IDE features in v0.1)
- Does it respect the **architecture principles** above?
- Does it move us closer to the **success criteria**?

If a change pulls us toward "let the model figure it out," push back. That's the failure mode this whole project exists to eliminate.

---

## 11. Anti-Goals (Repeated for Emphasis)

We are **not**:

- A natural-language design assistant ("make this section more modern").
- A Figma replacement.
- An IDE.
- A production runtime.
- A code generator for new components.
- A test author.
- A deployment tool.

We are a **visual-gesture-to-deterministic-code-edit pipeline** for a developer who is already iterating on a Next.js app with Claude Code as their agent. Everything else is out of scope and stays out of scope.
