# Installing visual-editor

Two flows. Use the first one unless you have a reason not to.

---

## 🟢 The recommended way — Next.js App Router

Mounts the AST writer as a Route Handler inside your own dev server. No
separate process, no extra port, no CORS dance.

### 1. Install

```bash
npm install --save-dev @aaqiljamal/visual-editor-next
```

`@aaqiljamal/visual-editor-next` is a meta-package — it pulls in the overlay,
the AST mutator, and the Babel plugin transitively. The `init` script writes
a `babel.config.js` that uses `require.resolve()` to find the plugin, so it
works with any package manager (npm, pnpm, yarn).

### 2. Run the init script

```bash
npx visual-editor-init
```

It writes:

- `app/api/visual-editor/[...path]/route.ts` — the Route Handler (one-liner)
- `babel.config.js` — adds the data-oid plugin (warns if one already exists)
- `.gitignore` — adds `/.visual-editor/`

Pre-flight: refuses to run if there's no `app/` directory or no Next.js
dependency. Use `--dry-run` to preview changes; use `--force` to bypass
the App Router check.

### 3. Mount the overlay

Add two lines to `app/layout.tsx`:

```diff
+ import { VisualEditOverlay } from "@aaqiljamal/visual-editor-next";

  export default function RootLayout({ children }) {
    return (
      <html lang="en">
        <body>
          {children}
+         {process.env.NODE_ENV === "development" && <VisualEditOverlay />}
        </body>
      </html>
    );
  }
```

### 4. Run it

```bash
npm run dev
```

That's it. Open the page → click any element → editing works.

### 5. (Optional) Hook Claude Code in via MCP

```bash
npm install --save-dev @aaqiljamal/visual-editor-mcp

claude mcp add visual-editor \
  --env VISUAL_EDITOR_WORKSPACE_ROOT="$(pwd)" \
  --env VISUAL_EDITOR_SERVER_URL="http://localhost:3000/api/visual-editor" \
  -- npx visual-editor-mcp
```

In Claude Code, `/mcp` should list 6 tools. A slash-command driver lives at
`.claude/commands/visual-editor.md` in this repo — copy it into your project.

---

## 🟡 The standalone server — Vite, Remix, other frameworks (experimental)

> ⚠️ This flow is **not verified end-to-end** outside of Next.js. The Route
> Handler path above is the one we test in CI. Expect rough edges; file an
> issue if you hit one.

Use this when you're not on Next.js, you want to share one visual-editor
server across multiple dev servers, or you need bearer-token auth.

### Install

```bash
npm install --save-dev \
  @aaqiljamal/visual-editor-babel-plugin \
  @aaqiljamal/visual-editor-runtime \
  @aaqiljamal/visual-editor-server
```

Add to your app's root layout (path varies by framework):

```tsx
import { VisualEditOverlay } from "@aaqiljamal/visual-editor-runtime";

<VisualEditOverlay serverUrl="http://127.0.0.1:7790" />
```

### Run two terminals

```bash
# Terminal A
npx visual-editor-server \
  --port 7790 \
  --workspace "$(pwd)" \
  --allow-origin "http://localhost:3000"

# Terminal B
npm run dev
```

You'll also need the Babel plugin wired into your framework's build pipeline.
See `packages/babel-plugin/index.js` for the plugin shape.

---

## Using the overlay

Once everything's up, you'll see a small purple **"visual-editor on"**
badge top-right. Click any element to start.

| Gesture | What it does |
|---|---|
| Hover | Pink outline + source badge + box-model bands |
| Click | Selects: 8 drag handles + 4 inner padding handles + shortcuts hint |
| Drag a side handle | Resize → Tailwind-scale snap → pending panel |
| `]` / `[` | Padding up/down one step |
| `}` / `{` (Shift+]) | Margin up/down |
| `Alt+]` / `Alt+[` | Gap up/down |
| `Alt+ArrowKey` | Width / Height up/down |
| Click on `<img>` + `i` | Asset picker (lists everything in `public/`) |
| Click element using `cn()` | Mutation goes INSIDE the cn(...) — refuses on unsafe cases |
| Click element with `className={styles.x}` | CSS panel for the `.module.css` file |
| Click a styled-component | CSS panel for the tagged template |
| Shift-click another element | Set distance-measure anchor |
| Alt-hover after anchor | Distance label (Figma-style) |
| Click "visual-editor on" badge | Toggle history panel + per-row Undo |
| Apply | Writes to disk · Fast Refresh repaints |
| Undo | In the success banner, or in the history panel |
| Escape | Deselect, clear pending |

## What refusal looks like

Visual-edit never guesses. If a mutation isn't provably safe, you get a
structured refusal in the pending panel:

| Reason | What to do |
|---|---|
| `dynamic-uncertain-arg` | `cn("p-4", someVar)` — inline the static token or rewrite the className |
| `dynamic-conflict` | `cn("p-4", "p-8")` — tailwind-merge would drop your new token |
| `composes-chain` | The CSS rule uses `composes:` — edit the file directly |
| `styled-with-interpolation` | The styled template has `${…}` — only fully-static |
| `token-not-found` | The file changed externally — re-stage |
| `path-outside-workspace` | Trying to write outside the workspace root |

These are loud and structured, not "I tried my best."

## What's NOT supported

- Server Component **editing** (mapping works, editing is best-effort optimistic-patch)
- Dynamic className editing through non-static other args (refused)
- Instance-specific edits (Principle 11 surfaces blast radius instead)
- Cross-file styled-components
- CSS Modules with `composes:`
- Twin.macro / tw-shorthand
- Vanilla CSS imports

See `V02_PLAN.md` for v0.3+ roadmap.

## Uninstall

```bash
npm uninstall \
  @aaqiljamal/visual-editor-next \
  @aaqiljamal/visual-editor-babel-plugin \
  @aaqiljamal/visual-editor-mcp
rm babel.config.js
rm -rf .visual-editor/
rm -rf app/api/visual-editor/
claude mcp remove visual-editor
```

Plus remove the `<VisualEditOverlay />` line from your layout.

## Troubleshooting

**Overlay doesn't appear** — check `process.env.NODE_ENV === "development"`,
that `<VisualEditOverlay />` is mounted inside `<body>`, and that
`/api/visual-editor/health` returns `{"ok":true}`.

**`Module not found: '@aaqiljamal/visual-editor-runtime'`** — npm install
should have hoisted it transitively from `@aaqiljamal/visual-editor-next`.
If your package manager doesn't hoist, install it explicitly:
`npm install --save-dev @aaqiljamal/visual-editor-runtime`.

**Hydration mismatch with styled-components** — add a standard
styled-components SSR registry around `{children}` in your root layout.
The spike app has a copy at `spikes/example-app/app/lib/StyledRegistry.tsx`.

**Refusal you didn't expect** — read the `details` text in the panel.
Every refusal carries the exact reason; visual-editor's contract is
"loud refusal, never silent best-effort."
