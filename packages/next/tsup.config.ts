import { defineConfig } from "tsup";

// Two entries:
//   - index.tsx → re-exports the overlay (Client Component, "use client")
//   - route.ts  → Next.js Route Handler (server-side, no directive)
export default defineConfig([
  {
    entry: ["src/index.tsx"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    banner: { js: '"use client";' },
    external: [
      "react",
      "next",
      "@aaqiljamal/visual-editor-runtime",
      "@aaqiljamal/visual-editor-server",
    ],
  },
  {
    entry: ["src/route.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    external: [
      "next",
      "@aaqiljamal/visual-editor-runtime",
      "@aaqiljamal/visual-editor-server",
    ],
  },
]);
