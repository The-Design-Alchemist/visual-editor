// Public entry for `@aaqiljamal/visual-editor-server/transform`.
// Consumed by the Next.js loader, the Vite plugin, and the Babel plugin's
// parity test. Built to both ESM and CJS (bundler loaders are CommonJS).
export {
  stampJsx,
  findWorkspaceRoot,
  resolveWorkspaceRoot,
  toSourceId,
  isStampablePath,
  STAMPABLE_EXTENSIONS,
  WORKSPACE_MARKERS,
} from "./stamp.ts";
export type { StampOptions, StampResult } from "./stamp.ts";
