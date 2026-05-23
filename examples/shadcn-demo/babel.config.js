module.exports = {
  presets: ["next/babel"],
  // Resolved via Node so pnpm/yarn-pnp users don't need a second
  // explicit install of the plugin alongside @aaqiljamal/visual-editor-next.
  //
  // `root: __dirname` is only needed because this demo lives inside the
  // visual-editor monorepo (a parent .git exists above us). Without it,
  // the plugin walks up and emits data-oid paths like
  // "examples/shadcn-demo/components/...". For a standalone Next.js project
  // (the normal case), drop the options object — auto-detection just works.
  plugins: [
    [
      require.resolve("@aaqiljamal/visual-editor-babel-plugin"),
      { root: __dirname },
    ],
  ],
};
