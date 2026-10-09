# vite-demo

Vite 8 + React 19 + Tailwind v4 with `@aaqiljamal/visual-editor-vite`. The `Card` component
spreads its props onto the DOM node, so every rendered card carries both `data-oid` (Card.tsx)
and `data-oid-call` (App.tsx) — select one and the overlay edits the call site's `p-4`, flagging
that all three cards share it.

```bash
npm install
npm run dev   # http://localhost:5173
```

The package.json points at the published `@aaqiljamal/visual-editor-vite` (^0.3.0). To run against the monorepo source: `npm install -D file:../../packages/vite file:../../packages/runtime file:../../packages/server`.
