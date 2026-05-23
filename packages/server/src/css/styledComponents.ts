import * as recast from "recast";
import babelTsParser from "recast/parsers/babel-ts.js";
import postcss from "postcss";

/**
 * v0.2 B3a — styled-components write-back.
 *
 * Two layers (mirrors the CSS Modules pipeline from B2):
 *   1. Given a JSX file + (line, col) pointing at a `<Button>`-style element,
 *      detect whether `Button` is defined IN THE SAME FILE as a
 *      styled.tagname`…` tagged template. Return the variable name and
 *      the tagged-template's location.
 *   2. Mutate a CSS property inside the template's static text via postcss,
 *      preserving every other declaration verbatim. Refuses on:
 *        - any `${…}` interpolation present
 *        - styled().attrs(...) / .withConfig(...) chains
 *        - extension form `styled(BaseComponent)`
 *        - cross-file imports (component declared elsewhere)
 *
 * Out of scope (v0.3): interpolation-aware mutation, attrs/withConfig,
 * twin.macro / tailwind-styled-components / tw-shorthand.
 */

export type StyledRef = {
  /** Variable name, e.g. "Button". */
  componentName: string;
  /** HTML tag name from `styled.X`, e.g. "button". */
  htmlTag: string;
};

export type DetectStyledResult =
  | { ok: true; ref: StyledRef }
  | {
      ok: false;
      reason:
        | "no-jsx-at-location"
        | "not-a-styled-component"
        | "styled-with-interpolation"
        | "styled-extension-not-supported"
        | "styled-attrs-not-supported"
        | "cross-file-styled-not-supported"
        | "parse-error";
      details: string;
    };

export function detectStyledComponent(
  jsxSource: string,
  line: number,
  col: number,
): DetectStyledResult {
  let ast: ReturnType<typeof recast.parse>;
  try {
    ast = recast.parse(jsxSource, { parser: babelTsParser });
  } catch (err) {
    return {
      ok: false,
      reason: "parse-error",
      details: (err as Error).message,
    };
  }

  // Step 1: find the JSXOpeningElement at line:col and extract its tag name.
  const jsxFound: { tagName: string | null; visited: boolean } = {
    tagName: null,
    visited: false,
  };
  recast.visit(ast, {
    visitJSXOpeningElement(path) {
      const node = path.node;
      const loc = node.loc;
      if (!loc) {
        this.traverse(path);
        return undefined;
      }
      if (loc.start.line !== line || loc.start.column !== col) {
        this.traverse(path);
        return undefined;
      }
      jsxFound.visited = true;
      const name = node.name as { type: string; name?: string };
      if (name.type === "JSXIdentifier" && name.name) {
        jsxFound.tagName = name.name;
      }
      return false;
    },
  });

  if (!jsxFound.visited) {
    return {
      ok: false,
      reason: "no-jsx-at-location",
      details: `No JSXOpeningElement found at ${line}:${col}`,
    };
  }
  if (!jsxFound.tagName || /^[a-z]/.test(jsxFound.tagName)) {
    // Lowercase tag = native HTML element, not a styled component.
    return {
      ok: false,
      reason: "not-a-styled-component",
      details: `JSX tag is not a component identifier (got "${jsxFound.tagName ?? "<none>"}")`,
    };
  }

  // Step 2: walk top-level declarations looking for
  //   `const <tagName> = styled.<htmlTag>\`...\``
  // with NO interpolations and NO attrs/withConfig.
  type RefusalReason =
    | "no-jsx-at-location"
    | "not-a-styled-component"
    | "styled-with-interpolation"
    | "styled-extension-not-supported"
    | "styled-attrs-not-supported"
    | "cross-file-styled-not-supported"
    | "parse-error";

  let foundRef: StyledRef | null = null;
  let refusedReason: RefusalReason | null = null;
  let refusedDetails = "";

  type DeclLike = {
    type: string;
    declarations?: Array<{
      type: string;
      id?: { type: string; name?: string };
      init?: unknown;
    }>;
  };
  const program = (ast as { program: { body: DeclLike[] } }).program;
  for (const stmt of program.body) {
    if (stmt.type !== "VariableDeclaration") continue;
    for (const decl of stmt.declarations ?? []) {
      if (decl.type !== "VariableDeclarator") continue;
      if (decl.id?.type !== "Identifier") continue;
      if (decl.id.name !== jsxFound.tagName) continue;
      const init = decl.init as
        | {
            type: string;
            tag?: {
              type: string;
              object?: { type: string; name?: string };
              property?: { type: string; name?: string };
              computed?: boolean;
              callee?: unknown;
            };
            quasi?: {
              type: string;
              expressions?: unknown[];
            };
          }
        | undefined;
      if (!init) continue;
      if (init.type !== "TaggedTemplateExpression") {
        refusedReason = "not-a-styled-component";
        refusedDetails = `\`${jsxFound.tagName}\` is declared but isn't a tagged template`;
        continue;
      }
      const tag = init.tag;
      if (!tag) continue;
      // Accept ONLY `styled.tagname` — refuse extensions and attrs chains.
      if (
        tag.type === "MemberExpression" &&
        tag.computed === false &&
        tag.object?.type === "Identifier" &&
        tag.object.name === "styled" &&
        tag.property?.type === "Identifier"
      ) {
        // The quasi must have NO interpolations.
        if ((init.quasi?.expressions?.length ?? 0) > 0) {
          refusedReason = "styled-with-interpolation";
          refusedDetails = `\`${jsxFound.tagName}\` template has \${…} interpolations — v0.2 only mutates fully-static templates`;
          continue;
        }
        foundRef = {
          componentName: jsxFound.tagName,
          htmlTag: tag.property.name ?? "div",
        };
        break;
      }
      // Common refusal shapes:
      if (tag.type === "CallExpression") {
        const callee = tag as unknown as {
          callee?: { type: string; name?: string; property?: { name?: string } };
        };
        const c = callee.callee;
        if (c?.type === "Identifier" && c.name === "styled") {
          refusedReason = "styled-extension-not-supported";
          refusedDetails = `\`styled(...)\` extension form — v0.2 only handles \`styled.tag\``;
        } else if (c?.type === "MemberExpression" && c.property?.name === "attrs") {
          refusedReason = "styled-attrs-not-supported";
          refusedDetails = `\`.attrs(...)\` chain not supported in v0.2`;
        }
      }
    }
    if (foundRef) break;
  }

  if (foundRef) return { ok: true, ref: foundRef };
  if (refusedReason) {
    return {
      ok: false,
      reason: refusedReason,
      details: refusedDetails,
    };
  }
  return {
    ok: false,
    reason: "cross-file-styled-not-supported",
    details: `\`${jsxFound.tagName}\` isn't declared in this file. v0.2 only resolves same-file styled definitions.`,
  };
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

export type MutateStyledResult =
  | { ok: true; output: string; previousValue: string | null }
  | {
      ok: false;
      reason:
        | "component-not-found"
        | "styled-with-interpolation"
        | "css-parse-error"
        | "invalid-property"
        | "parse-error";
      details: string;
    };

/**
 * Find `const componentName = styled.X\`...\`` in `jsxSource`, parse the
 * template's static text as CSS, update or insert a property, write back
 * to the template. Returns the rewritten source.
 *
 * Refuses if the template has ANY interpolations (we can't safely reason
 * about which static segment owns a property when interpolations are
 * present — v0.3 work).
 */
export function mutateStyledProperty(
  jsxSource: string,
  componentName: string,
  property: string,
  value: string,
): MutateStyledResult {
  if (!/^[a-zA-Z-]+$/.test(property)) {
    return {
      ok: false,
      reason: "invalid-property",
      details: `Property name "${property}" must be alphabetic + hyphens only`,
    };
  }

  let ast: ReturnType<typeof recast.parse>;
  try {
    ast = recast.parse(jsxSource, { parser: babelTsParser });
  } catch (err) {
    return {
      ok: false,
      reason: "parse-error",
      details: (err as Error).message,
    };
  }

  type MutateRefusalReason =
    | "component-not-found"
    | "styled-with-interpolation"
    | "css-parse-error"
    | "invalid-property"
    | "parse-error";

  const out: {
    found: boolean;
    interpolated: boolean;
    previousValue: string | null;
    error: { reason: MutateRefusalReason; details: string } | null;
  } = {
    found: false,
    interpolated: false,
    previousValue: null,
    error: null,
  };

  type Quasi = {
    type: "TemplateElement";
    value: { cooked?: string; raw: string };
  };
  type TemplateLiteralNode = {
    type: "TemplateLiteral";
    quasis: Quasi[];
    expressions: unknown[];
  };

  recast.visit(ast, {
    visitVariableDeclarator(path) {
      const node = path.node as {
        id?: { type: string; name?: string };
        init?: {
          type: string;
          tag?: {
            type: string;
            object?: { type: string; name?: string };
            property?: { type: string; name?: string };
            computed?: boolean;
          };
          quasi?: TemplateLiteralNode;
        };
      };
      if (out.found || out.error) return false;
      if (node.id?.type !== "Identifier" || node.id.name !== componentName) {
        this.traverse(path);
        return undefined;
      }
      const init = node.init;
      if (!init || init.type !== "TaggedTemplateExpression") return false;
      const tag = init.tag;
      if (
        !tag ||
        tag.type !== "MemberExpression" ||
        tag.object?.type !== "Identifier" ||
        tag.object.name !== "styled"
      ) {
        return false;
      }
      const quasi = init.quasi;
      if (!quasi) return false;
      if ((quasi.expressions?.length ?? 0) > 0) {
        out.interpolated = true;
        out.error = {
          reason: "styled-with-interpolation",
          details: `\`${componentName}\` template has interpolations — v0.2 only mutates fully-static templates`,
        };
        return false;
      }
      const onlyQuasi = quasi.quasis[0];
      if (!onlyQuasi) return false;

      const css = onlyQuasi.value.cooked ?? onlyQuasi.value.raw ?? "";
      // postcss parses CSS without selectors — wrap in a synthetic rule so
      // we can use the same walkDecls machinery as B2's mutateCssProperty.
      const wrapped = `:root {${css}}`;
      let root: postcss.Root;
      try {
        root = postcss.parse(wrapped);
      } catch (err) {
        out.error = {
          reason: "css-parse-error",
          details: (err as Error).message,
        };
        return false;
      }
      const rule = root.first as postcss.Rule | undefined;
      if (!rule) {
        out.error = {
          reason: "css-parse-error",
          details: "Internal: synthetic wrap produced no rule",
        };
        return false;
      }

      let updated = false;
      rule.walkDecls(property, (decl) => {
        if (decl.parent !== rule) return; // skip nested at-rules
        if (!updated) {
          out.previousValue = decl.value;
          decl.value = value;
          updated = true;
        }
      });
      if (!updated) {
        rule.append({ prop: property, value });
      }

      // Re-extract the inside-of-rule text.
      const rebuilt = rule.toString();
      // postcss serializes as `:root {\n  …\n}` (or :root{ … }). Strip the
      // outer selector + braces, restore the inner declarations as our
      // new quasi value.
      const innerMatch = rebuilt.match(/^[^{]*\{([\s\S]*)\}\s*$/);
      const inner = innerMatch && innerMatch[1] !== undefined ? innerMatch[1] : rebuilt;
      onlyQuasi.value.cooked = inner;
      onlyQuasi.value.raw = inner;
      out.found = true;
      return false;
    },
  });

  if (out.error) {
    return { ok: false, ...out.error };
  }
  if (!out.found) {
    return {
      ok: false,
      reason: "component-not-found",
      details: `No \`const ${componentName} = styled.X\`…\`\` definition found`,
    };
  }
  return {
    ok: true,
    output: recast.print(ast).code,
    previousValue: out.previousValue,
  };
}
