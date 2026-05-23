// Public surface of @aaqiljamal/visual-edit-next.
//
// For users:
//   import { VisualEditOverlay } from "@aaqiljamal/visual-edit-next";
//   export { GET, POST, DELETE } from "@aaqiljamal/visual-edit-next/route";
//
// One package = overlay + route handler + Babel plugin (transitive).
// The separate `visual-edit-server` CLI is still available via
// @aaqiljamal/visual-edit-server but isn't needed in this setup.

export { VisualEditOverlay } from "@aaqiljamal/visual-edit-runtime";
