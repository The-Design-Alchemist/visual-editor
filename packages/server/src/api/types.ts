/**
 * Shared shapes for the API core. Everything the overlay sends, the MCP
 * reads, and the pins persist is described here.
 */

/** A JSXOpeningElement location — what a data-oid / data-oid-call decodes to. */
export type SourceRef = {
  /** Workspace-relative POSIX path. */
  file: string;
  /** 1-based line (Babel convention). */
  line: number;
  /** 0-based column (Babel convention). */
  col: number;
};

export type ClassNameInfo =
  | { kind: "static"; tokens: string[]; raw: string }
  | {
      kind: "merger";
      callee: string;
      /** Tokens from the static string arguments only. */
      tokens: string[];
      /** Count of non-string-literal arguments (what the writer refuses on). */
      dynamicArgs: number;
      raw: string;
    }
  | { kind: "template" | "conditional" | "dynamic"; raw: string }
  | { kind: "none"; spread: boolean };

/** What the writer can tell about one JSX element from its source alone. */
export type ElementContext = {
  ref: SourceRef;
  /** "host" = DOM tag inside a component file; "call" = where a component was used. */
  role: "host" | "call";
  found: boolean;
  /** `div`, `Button`, `Foo.Bar` — null when not found. */
  tag: string | null;
  /** Enclosing component function (or "default" for anonymous default exports). */
  componentName: string | null;
  className: ClassNameInfo | null;
  /** Attribute names on the element; spreads appear as "{...}". */
  attributes: string[];
  /** The element's source text (opening through closing tag), clipped. */
  snippet: string;
  snippetTruncated: boolean;
  /** True when a className token swap at this ref would be accepted by the writer. */
  editable: boolean;
  /** Why it isn't editable, in one sentence; absent when editable. */
  reason?: string;
};

/** What the overlay collects at selection time (DOM-side facts). */
export type SelectionInput = {
  file: string;
  line: number;
  col: number;
  oid: string;
  /** Which attribute `oid` came from. Defaults to data-oid; a DOM node that only carries a call-site id (foreign component such as next/link) sends data-oid-call. */
  oidAttribute?: "data-oid" | "data-oid-call";
  className: string;
  tagName: string;
  componentName: string | null;
  instanceCount: number;
  /** Component call site (data-oid-call) when the DOM node carries one. */
  callSite?: { file: string; line: number; col: number; oid: string; instanceCount: number } | null;
  /** Free-text note the user typed for their agent. */
  note?: string | null;
  /** Page pathname (+search) the selection happened on. */
  url?: string | null;
  rect?: { x: number; y: number; width: number; height: number } | null;
  /** Curated computed styles, e.g. { padding: "16px", gap: "8px" }. */
  computed?: Record<string, string> | null;
  /** Nearest ancestors, outermost last. */
  ancestors?: Array<{ tag: string; oid: string | null; className: string }> | null;
  /** First ~80 chars of textContent. */
  text?: string | null;
};

export type EnrichedSelection = SelectionInput & {
  /** Source-side facts for the host ref and (when present) the call-site ref. */
  refs: ElementContext[];
  selectedAt: number;
};

export type Pin = {
  id: string;
  createdAt: number;
  status: "open" | "resolved";
  note: string;
  selection: EnrichedSelection;
  resolvedAt?: number;
  /** What the agent did, in its own words. */
  resolution?: string;
};

export type AgentEvent =
  | {
      type: "highlight";
      ref: SourceRef;
      /** Which attribute to match in the DOM. Defaults to data-oid. */
      attribute?: "data-oid" | "data-oid-call";
      label?: string;
      durationMs?: number;
      at: number;
    }
  | { type: "pin-resolved"; id: string; resolution?: string; at: number }
  | { type: "pins-changed"; at: number }
  | { type: "message"; text: string; at: number };
