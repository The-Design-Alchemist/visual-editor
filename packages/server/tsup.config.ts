import { defineConfig } from "tsup";

const externals = [
  "recast",
  "postcss",
  "@babel/parser",
  "@babel/types",
  "tailwind-merge",
  "diff",
  "magic-string",
];

export default defineConfig([
  {
    entry: ["src/index.ts", "src/cli.ts"],
    format: ["esm"],
    dts: { entry: ["src/index.ts"] },
    clean: true,
    sourcemap: true,
    external: externals,
  },
  {
    // The stamper is consumed by bundler loaders, which are CommonJS in
    // Turbopack/webpack land — so it ships in both module formats.
    entry: { transform: "src/transform/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: false,
    sourcemap: true,
    external: externals,
  },
]);
