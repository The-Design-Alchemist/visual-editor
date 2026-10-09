import type { AgentEvent } from "./types.ts";

/**
 * Agent → browser channel. The MCP server (acting for Claude) emits
 * events like "highlight this element"; the overlay subscribes over SSE.
 * In-memory and best-effort: if nobody is listening, events are dropped.
 */
export class EventHub {
  private listeners = new Set<(ev: AgentEvent) => void>();
  private recent: AgentEvent[] = [];

  subscribe(fn: (ev: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(ev: AgentEvent): void {
    this.recent.push(ev);
    if (this.recent.length > 20) this.recent.shift();
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        /* a broken subscriber must not break the others */
      }
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Events since `after` (ms timestamp) — used by the polling fallback. */
  since(after: number): AgentEvent[] {
    return this.recent.filter((e) => e.at > after);
  }
}
