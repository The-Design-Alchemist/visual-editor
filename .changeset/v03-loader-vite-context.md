---
"@aaqiljamal/visual-editor-babel-plugin": minor
"@aaqiljamal/visual-editor-runtime": minor
"@aaqiljamal/visual-editor-server": minor
"@aaqiljamal/visual-editor-next": minor
"@aaqiljamal/visual-editor-mcp": minor
"@aaqiljamal/visual-editor-vite": minor
---

v0.3 — works without Babel, works on Vite, and gives your agent real context.

- **No more `babel.config.js`.** `withVisualEditor()` wraps `next.config` and stamps JSX through an
  SWC/Turbopack-compatible loader (text insertion via magic-string). Auto-mounts the overlay on
  Next ≥ 16.3 via `instrumentationClientInject`.
- **New `@aaqiljamal/visual-editor-vite`** plugin: transform + dev-server middleware + overlay injection.
- **Fixed:** the shipped v0.2 couldn't apply edits in projects that aren't at their git root — the
  Babel plugin and the Route Handler resolved different roots. One shared rule now.
- **Component call sites.** Host elements get `data-oid`, component usages get `data-oid-call`; the
  overlay edits whichever location owns the class token (shadcn/ui, Radix, `next/image` all work).
- **Context for agents.** `get_selected_element` returns refs with editability, enclosing component
  names, source snippets, computed styles, ancestors and the user's note; plus pins and recent edits.
  New tools `highlight_element` (agent → browser) and `resolve_pin`. Overlay gains notes, pins,
  *Copy context*, and an edit-mode toggle that suppresses app click handlers.
- **Security:** browser-facing transports refuse cross-site writes (`Sec-Fetch-Site` / Origin vs
  Host) and non-JSON bodies.
- One transport-agnostic API core (`handleApi`) behind the Node server, Route Handler and Vite middleware.
