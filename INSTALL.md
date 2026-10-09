# Installing visual-editor

Pick your framework. Everything here is **dev-only**: production builds are untouched and the
API 404s outside `next dev` / `vite`.

---

## Next.js (App Router)

### The short way

```bash
npm install --save-dev @aaqiljamal/visual-editor-next
npx visual-editor-init          # add --claude to also write .claude/commands/visual-editor.md
npm run dev
```

`visual-editor-init` does three things (all idempotent, `--dry-run` to preview):

1. writes `app/api/visual-editor/[...path]/route.ts`:
   ```ts
   export { GET, POST, DELETE } from "@aaqiljamal/visual-editor-next/route";
   ```
2. wraps your `next.config.{ts,js,mjs}` in `withVisualEditor()` (or prints the snippet if your
   config is unusual);
3. adds `/.visual-editor/` (undo history + pins) to `.gitignore`.

### What `withVisualEditor()` does

```ts
// next.config.ts
import { withVisualEditor } from "@aaqiljamal/visual-editor-next/config";
export default withVisualEditor({ /* your config */ });
```

Only during `next dev` it:

- registers a **loader** (Turbopack `rules` + webpack `enforce: "pre"`) that inserts
  `data-oid` / `data-oid-call` attributes into your JSX **as text** before SWC compiles it — your
  code is never reformatted, and SWC, Turbopack, `next/font` and React Compiler keep working.
  There is no `babel.config.js`;
- auto-mounts the overlay through `instrumentationClientInject` (**Next ≥ 16.3**);
- pins the workspace root so the Route Handler resolves the same paths the loader emitted.

Options: `withVisualEditor(config, { root, injectClient, globs })`. Set `VISUAL_EDITOR_DISABLE=1`
to turn it off for one run.

### Next 15.3 – 16.2 (no auto-mount)

Add the overlay to `app/layout.tsx` yourself:

```tsx
import { VisualEditOverlay } from "@aaqiljamal/visual-editor-next";
// inside <body>:
{process.env.NODE_ENV === "development" && <VisualEditOverlay />}
```

Everything else is the same. (The component is idempotent: keeping it on ≥ 16.3 doesn't double-mount.)

### Monorepos

Both the loader and the Route Handler derive the workspace root the same way: the nearest
`pnpm-workspace.yaml` / `turbo.json` / `lerna.json` / `nx.json` / `.git` above the project, else the
project directory. Ids are root-relative (`apps/web/app/page.tsx:12:4`) and writes are confined to
that root, so editing `packages/ui/Card.tsx` from `apps/web` works. To pin a different root:
`withVisualEditor(config, { root: __dirname })` or `VISUAL_EDITOR_WORKSPACE_ROOT=/abs/path`.

### Upgrading from v0.2

Delete the `babel.config.js` the old init wrote (if it exists only for visual-editor), remove the
`<VisualEditOverlay />` line on Next ≥ 16.3, run `npx visual-editor-init` again. Bump
`@aaqiljamal/visual-editor-mcp` too — the tool surface grew.

---

## Vite + React (also React Router v7, TanStack Start, Astro + React)

```bash
npm install --save-dev @aaqiljamal/visual-editor-vite
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualEditor } from "@aaqiljamal/visual-editor-vite";

export default defineConfig({
  plugins: [react(), visualEditor()],
});
```

The plugin runs `enforce: "pre"`, so it stamps `.tsx/.jsx/.js` before `@vitejs/plugin-react`
(Babel or oxc) compiles them; mounts the writer API at `/api/visual-editor` on the dev server
(same-origin, no token); and injects `<script type="module">` into `index.html` that mounts the
overlay. `vite build` is untouched. Options: `visualEditor({ root, basePath, injectOverlay })`.

Frameworks that own `index.html` (React Router framework mode, TanStack Start): the API and the
stamps still work; if the overlay doesn't appear, mount it from your root component:

```tsx
import { mountVisualEditor } from "@aaqiljamal/visual-editor-runtime/mount";
useEffect(() => (import.meta.env.DEV ? mountVisualEditor({ serverUrl: "/api/visual-editor" }) : undefined), []);
```

---

## Anything else (Babel pipelines, separate dev servers)

Stamp with the Babel plugin and run the standalone server:

```bash
npm install --save-dev @aaqiljamal/visual-editor-babel-plugin @aaqiljamal/visual-editor-runtime @aaqiljamal/visual-editor-server
```

```js
// babel config
plugins: [require.resolve("@aaqiljamal/visual-editor-babel-plugin")]
```

```bash
npx visual-editor-server --port 7790 --workspace "$(pwd)" --allow-origin http://localhost:3000
```

```tsx
import { mountVisualEditor } from "@aaqiljamal/visual-editor-runtime/mount";
mountVisualEditor({ serverUrl: "http://127.0.0.1:7790" });   // dev only
```

The standalone server is cross-origin, so it uses a per-session bearer token
(`.visual-editor/session.json`) and an origin allowlist.

---

## Agents

### Claude Code

```bash
npm install --save-dev @aaqiljamal/visual-editor-mcp
claude mcp add visual-editor \
  --env VISUAL_EDITOR_SERVER_URL="http://localhost:3000/api/visual-editor" \
  -- npx visual-editor-mcp
```

Vite: use `http://localhost:5173/api/visual-editor`. Standalone server: `http://127.0.0.1:7790`
plus `VISUAL_EDITOR_WORKSPACE_ROOT` so it can read the session token.

`/mcp` should list eight tools. `npx visual-editor-init --claude` writes `.claude/commands/visual-editor.md`;
then: pin elements in the browser → `/visual-editor`.

### Other agents

Any MCP client works with the same stdio command. Examples:

```jsonc
// Cursor: .cursor/mcp.json   ·   Codex: ~/.codex/config.toml ([mcp_servers.visual-editor])
{ "mcpServers": { "visual-editor": {
  "command": "npx", "args": ["visual-editor-mcp"],
  "env": { "VISUAL_EDITOR_SERVER_URL": "http://localhost:3000/api/visual-editor" } } } }
```

No MCP at all? Select an element, add a note, click **Copy context** and paste.

---

## Using the overlay

Toolbar (top-right): **edit on/off** · **edits** (history, per-row undo) · **pins** (with a count).

| Gesture | What it does |
|---|---|
| Hover | Outline + `<Component> tag file:line:col` + padding (green) / margin (orange) bands |
| Click | Select: handles, padding bars, selection panel (bottom-left) |
| Drag a side handle | Resize → snap to your Tailwind scale → pending panel |
| `]` / `[` · `}` / `{` · `Alt+]` / `Alt+[` | Padding · margin · gap, one step |
| `Alt+Arrow` | Width / height, one step |
| Drag a teal bar | One side's padding |
| `i` (on `<img>`) | Asset picker from `public/` |
| Type a note + `Enter` (or *Pin for agent*) | Pin the selection for your agent |
| *Copy context* | Clipboard block for any agent |
| Shift-click, then Alt-hover | Distance measurement |
| `Esc` | Deselect / discard pending |
| `Ctrl+Shift+E` | Toggle edit mode |

**Edit mode** (default on) suppresses the app's own click handlers so you can select a button
without triggering it. Turn it off to use the app normally; the setting persists per origin.

**Selection panel** shows every source location the element maps to — the host element inside its
component and, for components that spread props (shadcn/ui, Radix, `next/image`, your own), the
call site — with the static class tokens at each and whether a token swap there is provably safe.
Edits land where the token lives; the call site wins when both have it.

---

## Troubleshooting

**Overlay doesn't appear** — check `GET /api/visual-editor/health` returns `{"ok":true,…}`; on
Next < 16.3 mount `<VisualEditOverlay />`; on Vite make sure `visualEditor()` is in `plugins`.

**Hover badge says "no data-oid"** — the file wasn't stamped. Next: is `withVisualEditor()` wrapping
the config that's actually loaded? Vite: is the file under `node_modules` or outside the Vite root?
A `babel.config.js` from v0.2 is fine to delete.

**`file-not-found` on Apply with a stray path prefix** — loader and server disagree on the root.
Set `VISUAL_EDITOR_WORKSPACE_ROOT` (or the `root` option) on the config wrapper; both sides read it.

**`cross-site-request`** — a page on another origin tried to write. Expected.

**Hydration mismatch mentioning `<html className>`** — usually a browser extension adding classes
(e.g. Storylane); not caused by the overlay, which only adds its own element to `<body>`.

**Refusal you didn't expect** — read `details`; the selection panel shows which location *is*
editable. Refusals are the contract: no silent best-effort.

**Playwright / Cypress `networkidle` never settles** — once you've selected something (or pins
exist) the overlay keeps a server-sent-events stream open for agent events. Wait for `load` /
`domcontentloaded` instead, or run e2e with `VISUAL_EDITOR_DISABLE=1`.

## Uninstall

```bash
npm uninstall @aaqiljamal/visual-editor-next @aaqiljamal/visual-editor-mcp   # or -vite
rm -rf .visual-editor app/api/visual-editor
claude mcp remove visual-editor
```

Unwrap `next.config` (remove `withVisualEditor(...)`) or drop `visualEditor()` from `vite.config`.
