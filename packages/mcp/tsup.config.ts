import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  external: ["@modelcontextprotocol/sdk", "zod"],
});
