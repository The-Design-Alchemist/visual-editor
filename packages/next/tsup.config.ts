import { defineConfig } from "tsup";

const external = [
  "react",
  "next",
  "@aaqiljamal/visual-editor-runtime",
  "@aaqiljamal/visual-editor-runtime/mount",
  "@aaqiljamal/visual-editor-server",
  "@aaqiljamal/visual-editor-server/transform",
];

export default defineConfig([
  {
    // Re-exports the React overlay wrapper (Client Component).
    entry: ["src/index.tsx"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    banner: { js: '"use client";' },
    external,
  },
  {
    // Route Handler (server-side).
    entry: ["src/route.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    external,
  },
  {
    // next.config wrapper — next.config.js is CJS more often than not.
    entry: ["src/config.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    sourcemap: true,
    external,
    // createRequire(import.meta.url) needs a CJS-safe shim.
    shims: true,
  },
  {
    // instrumentation-client injection (browser).
    entry: ["src/client.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    external,
    platform: "browser",
  },
]);
