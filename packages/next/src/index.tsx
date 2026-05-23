// Public surface of @aaqiljamal/visual-editor-next.
//
// For users:
//   import { VisualEditOverlay } from "@aaqiljamal/visual-editor-next";
//   export { GET, POST, DELETE } from "@aaqiljamal/visual-editor-next/route";
//
// One package = overlay + route handler + Babel plugin (transitive).
// The separate `visual-editor-server` CLI is still available via
// @aaqiljamal/visual-editor-server but isn't needed in this setup.

export { VisualEditOverlay } from "@aaqiljamal/visual-editor-runtime";
