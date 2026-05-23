import * as fs from "node:fs/promises";

/**
 * Small in-memory deque of recently applied mutations, sized to keep the
 * footprint negligible. Used by the 4th MCP tool (`revert_change`) and
 * the overlay's "undo last apply" affordance.
 *
 * v0.2: persists to `<workspace>/.visual-editor/history.json` so the undo
 * stack survives server restarts. Persistence is fire-and-forget on every
 * mutation — `persistNow()` returns a Promise that tests can await for
 * deterministic checks.
 */
export type Apply = {
  file: string;
  line: number;
  col: number;
  before: string;
  after: string;
  appliedAt: number; // Date.now()
};

export class RecentApplies {
  private buffer: Apply[] = [];
  private filePath: string | null = null;

  constructor(private readonly maxSize = 50) {}

  /**
   * Wire up disk persistence. If the file exists, its contents become the
   * initial buffer. If it doesn't, we remember the path for future writes.
   */
  async load(filePath: string): Promise<void> {
    this.filePath = filePath;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as { applies?: Apply[] };
      if (Array.isArray(parsed.applies)) {
        // Take the last N to enforce the bound even if the file grew externally.
        this.buffer = parsed.applies
          .filter(isApply)
          .slice(-this.maxSize);
      }
    } catch {
      // File missing or unreadable — start empty. The path is set so the
      // next push will create the file.
    }
  }

  push(apply: Apply): void {
    this.buffer.push(apply);
    if (this.buffer.length > this.maxSize) this.buffer.shift();
    void this.persistNow();
  }

  /**
   * Find the most-recent entry matching `key`. If no key is provided, returns
   * the most-recent entry overall (single-step undo). Returns `null` when no
   * matching entry is in the buffer.
   */
  find(key?: { file: string; line: number; col: number }): Apply | null {
    if (this.buffer.length === 0) return null;
    if (!key) return this.buffer[this.buffer.length - 1] ?? null;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const a = this.buffer[i];
      if (
        a &&
        a.file === key.file &&
        a.line === key.line &&
        a.col === key.col
      ) {
        return a;
      }
    }
    return null;
  }

  remove(apply: Apply): void {
    const idx = this.buffer.lastIndexOf(apply);
    if (idx !== -1) this.buffer.splice(idx, 1);
    void this.persistNow();
  }

  list(): readonly Apply[] {
    return this.buffer;
  }

  clear(): void {
    this.buffer = [];
    void this.persistNow();
  }

  get size(): number {
    return this.buffer.length;
  }

  /**
   * Write the buffer to disk. No-op when no path has been configured.
   * Safe to `void`-call for fire-and-forget; tests can `await` it for
   * determinism.
   */
  async persistNow(): Promise<void> {
    if (!this.filePath) return;
    const json = JSON.stringify(
      { applies: this.buffer, savedAt: Date.now() },
      null,
      2,
    );
    try {
      await fs.writeFile(this.filePath, json, "utf8");
    } catch {
      // Disk full or perms — surface via dedicated health endpoint later.
      // For now, undo just won't survive a restart.
    }
  }
}

function isApply(x: unknown): x is Apply {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.file === "string" &&
    typeof o.line === "number" &&
    typeof o.col === "number" &&
    typeof o.before === "string" &&
    typeof o.after === "string" &&
    typeof o.appliedAt === "number"
  );
}
