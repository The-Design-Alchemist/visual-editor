---
"@aaqiljamal/visual-editor-next": patch
---

Init script now writes `plugins: [require.resolve("@aaqiljamal/visual-editor-babel-plugin")]` instead of the bare string. This means a single `npm install @aaqiljamal/visual-editor-next` is enough — the babel plugin gets resolved via Node's module resolution, which works under npm hoisting *and* pnpm/yarn-pnp's nested layout. Previously, pnpm/yarn users needed a second explicit install of the babel plugin alongside the meta-package.

The other 4 packages (`runtime`, `server`, `babel-plugin`, `mcp`) version-bump alongside `next` via the linked array in `.changeset/config.json` — code is unchanged for them.
