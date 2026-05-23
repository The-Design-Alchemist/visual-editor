// Public entry point for @aaqiljamal/visual-edit-server.
// Anything imported here is part of the package's stable API.
// Submodule deep-imports (e.g. ./src/fs/applyToFile.ts) are NOT supported.

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
export { createServer } from "./http/server.ts";
