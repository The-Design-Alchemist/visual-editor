import type { EnrichedSelection } from "../api/types.ts";

/**
 * Single in-memory "what is the user currently looking at" record, set by
 * the overlay on element acquire (and enriched by the API core with
 * source-side facts) and read by the MCP `get_selected_element` tool.
 * Intentionally null when no selection is active — the MCP tool returns
 * "no selection" rather than stale state.
 */
export type Selection = EnrichedSelection;

export class CurrentSelection {
  private current: Selection | null = null;
  set(s: Selection | null): void {
    this.current = s;
  }
  get(): Selection | null {
    return this.current;
  }
  clear(): void {
    this.current = null;
  }
}
