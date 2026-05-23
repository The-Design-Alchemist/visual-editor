import * as path from "node:path";

/**
 * Resolve a user-supplied relative path against a workspace root, refusing
 * any path that escapes the root (via `..`, absolute paths, or symlink
 * trickery the caller might pass in).
 *
 * Returns the absolute path on success, or `null` if the resolved path
 * would land outside the workspace. The server uses this on every file
 * I/O so a malicious or buggy client cannot write `/etc/passwd` by
 * passing `file: "../../../../etc/passwd"`.
 */
export function resolveWithinWorkspace(
  workspaceRoot: string,
  relativePath: string,
): string | null {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return null;
  }

  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, relativePath);

  // Containment check: candidate must equal root or start with root + sep.
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    return null;
  }
  return candidate;
}
