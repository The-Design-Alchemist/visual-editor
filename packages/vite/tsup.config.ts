import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  shims: true,
  external: [
    "vite",
    "@aaqiljamal/visual-editor-server",
    "@aaqiljamal/visual-editor-server/transform",
    "@aaqiljamal/visual-editor-runtime",
    "@aaqiljamal/visual-editor-runtime/mount",
  ],
});
