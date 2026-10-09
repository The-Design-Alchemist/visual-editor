import { defineConfig } from "tsup";

export default defineConfig([
  {
    // React wrapper — a Next.js Client Component. Preserve the "use client"
    // directive at the top of the emitted file via banner; esbuild strips
    // it otherwise.
    entry: ["src/index.tsx"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    banner: { js: '"use client";' },
    external: ["react", "preact", "moveable", "./mount"],
  },
  {
    // Framework-free mount, consumed by the Next.js instrumentation-client
    // injection and the Vite plugin's injected script.
    entry: ["src/mount.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: true,
    external: ["preact", "moveable"],
  },
]);
