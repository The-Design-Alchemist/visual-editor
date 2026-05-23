import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SESSION_DIRNAME = ".visual-editor";
const SESSION_FILENAME = "session.json";

/**
 * Per-session token. Mounted on startup, kept in memory, and persisted to
 * `<workspace>/.visual-editor/session.json` so the MCP stdio server (a
 * sibling process spawned by Claude Code) can read it without us having to
 * pipe it through a separate transport.
 *
 * Threat model: a random page running on the same dev machine (e.g. an ad
 * iframe, a stale tab on another local port) could POST to the loopback
 * server and clobber files. Requiring an Authorization header that only
 * the overlay (and the MCP server, via the file) knows blocks that vector.
 *
 * Open trade-off in v0.1: GET /token returns the token without auth so
 * the overlay can bootstrap. A drive-by page could fetch it the same way.
 * Production hardening would either (a) inject the token into the page at
 * dev-build time, or (b) pin the Origin/Referer header. Both require
 * dev-server integration that's out of scope here.
 */
export class SessionToken {
  private token: string | null = null;
  private filePath: string | null = null;

  async load(workspaceRoot: string): Promise<string> {
    const dir = path.join(workspaceRoot, SESSION_DIRNAME);
    this.filePath = path.join(dir, SESSION_FILENAME);

    // Reuse the existing session if the file is there. Refreshing the token
    // on every restart would invalidate the MCP server's cached value.
    try {
      const existing = JSON.parse(
        await fs.readFile(this.filePath, "utf8"),
      ) as { token?: unknown };
      if (typeof existing.token === "string" && existing.token.length >= 16) {
        this.token = existing.token;
        return this.token;
      }
    } catch {
      /* file missing or unreadable — fall through to mint a new one */
    }

    await fs.mkdir(dir, { recursive: true });
    this.token = randomBytes(24).toString("hex");
    await fs.writeFile(
      this.filePath,
      JSON.stringify({ token: this.token, createdAt: Date.now() }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
    return this.token;
  }

  /** Construct the token in-process without touching disk. Used by tests. */
  setInMemory(token: string): void {
    this.token = token;
  }

  get(): string {
    if (!this.token) {
      throw new Error("SessionToken not loaded — call load() first");
    }
    return this.token;
  }

  /**
   * Constant-time compare against the bearer string the client sent. Returns
   * `true` when the lengths match AND every byte is equal. Plain `===` would
   * leak length information through timing.
   */
  matches(received: string | null): boolean {
    if (!this.token || !received) return false;
    if (received.length !== this.token.length) return false;
    let diff = 0;
    for (let i = 0; i < received.length; i++) {
      diff |= received.charCodeAt(i) ^ this.token.charCodeAt(i);
    }
    return diff === 0;
  }
}

export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : null;
}
