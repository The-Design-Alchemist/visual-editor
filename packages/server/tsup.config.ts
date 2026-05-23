import { defineConfig } from "tsup";

const externals = [
  "recast",
  "postcss",
  "@babel/parser",
  "@babel/types",
  "tailwind-merge",
  "diff",
];

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: { entry: ["src/index.ts"] },
  clean: true,
  sourcemap: true,
  external: externals,
});
