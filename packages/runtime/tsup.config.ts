import { defineConfig } from "tsup";

// Runtime is a Next.js Client Component. Preserve the "use client"
// directive at the top of the emitted file via banner; esbuild strips
// it otherwise.
export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  banner: { js: '"use client";' },
  external: ["react", "preact", "moveable"],
});
