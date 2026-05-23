/**
 * Single in-memory "what is the user currently looking at" record, set by
 * the overlay on element acquire and read by the MCP `get_selected_element`
 * tool. Intentionally null when no selection is active — the MCP tool
 * returns "no selection" rather than stale state.
 */
export type Selection = {
  /** Workspace-relative file path from the element's data-oid. */
  file: string;
  /** 1-based line number (Babel convention). */
  line: number;
  /** 0-based column (Babel convention). */
  col: number;
  /** The full data-oid string for traceability. */
  oid: string;
  /** Whole className string (overlay should split if it wants tokens). */
  className: string;
  /** DOM tag name like "div", "button". */
  tagName: string;
  /** Best-guess component name (file basename or Fiber name). */
  componentName: string | null;
  /** How many DOM elements share this data-oid right now (Principle 11). */
  instanceCount: number;
};

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
