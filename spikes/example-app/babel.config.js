module.exports = {
  presets: ["next/babel"],
  // Resolved via Node so this works whether the plugin is hoisted (npm) or
  // nested (pnpm/yarn-pnp) in the host project's node_modules.
  plugins: [require.resolve("@aaqiljamal/visual-editor-babel-plugin")],
};
