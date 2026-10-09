// Public entry point for @aaqiljamal/visual-editor-server.
// Anything imported here is part of the package's stable API.
// Submodule deep-imports (e.g. ./src/fs/applyToFile.ts) are NOT supported;
// the bundler-side stamper lives at "@aaqiljamal/visual-editor-server/transform".

export { applyToFile } from "./fs/applyToFile.ts";
export type { ApplyInput } from "./fs/applyToFile.ts";

export { revertToFile } from "./fs/revertToFile.ts";
export type { RevertInput } from "./fs/revertToFile.ts";

export { applyCssProperty } from "./fs/applyCssProperty.ts";
export type { ApplyCssPropertyInput } from "./fs/applyCssProperty.ts";

export { applyStyledProperty } from "./fs/applyStyledProperty.ts";
export type { ApplyStyledPropertyInput } from "./fs/applyStyledProperty.ts";

export { RecentApplies } from "./state/recentApplies.ts";
export { CurrentSelection } from "./state/selection.ts";
export type { Selection } from "./state/selection.ts";

export { SessionToken } from "./state/auth.ts";
export {
  createServer,
  createNodeHandler,
  createStandaloneContext,
} from "./http/server.ts";
export type { ServerOptions, NodeHandlerOptions, NodeHandler } from "./http/server.ts";

// API core — one implementation of every endpoint, used by the standalone
// server, the Next.js Route Handler and the Vite middleware.
export {
  createApiContext,
  handleApi,
  isTrustedBrowserRequest,
  isValidSelectionInput,
  formatSse,
} from "./api/core.ts";
export type { ApiContext, ApiContextOptions, ApiResult } from "./api/core.ts";
export { PinStore } from "./api/pins.ts";
export { EventHub } from "./api/events.ts";
export { describeElementInSource, describeElementFile } from "./api/describeElement.ts";
export type {
  SourceRef,
  ClassNameInfo,
  ElementContext,
  SelectionInput,
  EnrichedSelection,
  Pin,
  AgentEvent,
} from "./api/types.ts";
