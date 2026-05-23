import * as recast from "recast";
import babelTsParser from "recast/parsers/babel-ts.js";
import postcss from "postcss";

/**
 * v0.2 B2a — CSS Modules write-back.
 *
 * Two layers:
 *   1. Given a JSX file + (line, col) pointing at a JSXOpeningElement,
 *      detect whether its className is `{styles.foo}` and resolve the
 *      `.module.css` file + the class selector (`.foo`).
 *   2. Given a CSS file + a selector + a property + a value, parse with
 *      postcss, update or insert that declaration on the matching rule,
 *      and stringify back. Refuses on `composes:` chains because they
 *      reach into other rules and our change could leak.
 *
 * Out of scope (v0.3): tracking which JSX files import which CSS modules
 * (cross-file refactor), CSS variables, nested rules, media queries that
 * override the property.
 */

export type CssModuleRef = {
  /** The .module.css path the className resolved to. Absolute or relative? See `resolved`. */
  cssFile: string;
  /** The class selector inside that file, e.g. `.foo`. */
  selector: string;
};

export type DetectCssModuleResult =
  | { ok: true; ref: CssModuleRef }
  | {
      ok: false;
      reason:
        | "no-jsx-at-location"
        | "no-classname-attribute"
        | "not-a-css-module"
        | "dynamic-classname"
        | "unresolved-import"
        | "parse-error";
      details: string;
    };

/**
 * Detect whether the className at (line, col) in `jsxSource` uses a CSS
 * Modules pattern: `<div className={styles.foo}>` where `styles` is a
 * default import from a `.module.css` file. Returns the resolved CSS
 * file path (kept relative to the JSX file — the caller resolves to
 * absolute via the workspace root) and the class selector.
 */
export function detectCssModule(
  jsxSource: string,
  line: number,
  col: number,
): DetectCssModuleResult {
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

  // Step 1: find the JSXOpeningElement at line:col and inspect its className.
  let found: {
    objectName: string | null;
    propertyName: string | null;
    visited: boolean;
  } = { objectName: null, propertyName: null, visited: false };

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
      found.visited = true;
      const attrs = (node.attributes ?? []) as Array<{
        type: string;
        name?: { type: string; name?: string };
        value?: {
          type: string;
          expression?: {
            type: string;
            object?: { type: string; name?: string };
            property?: { type: string; name?: string };
            computed?: boolean;
          };
        };
      }>;
      const classNameAttr = attrs.find(
        (a) =>
          a.type === "JSXAttribute" &&
          a.name?.type === "JSXIdentifier" &&
          a.name?.name === "className",
      );
      if (!classNameAttr) return false;
      const v = classNameAttr.value;
      if (!v || v.type !== "JSXExpressionContainer") return false;
      const expr = v.expression;
      if (!expr) return false;
      // Accept ONLY `styles.foo` form. cn(styles.foo)/styles[k]/string is
      // handled elsewhere or refused.
      if (
        expr.type === "MemberExpression" &&
        expr.computed === false &&
        expr.object?.type === "Identifier" &&
        expr.property?.type === "Identifier"
      ) {
        found.objectName = expr.object.name ?? null;
        found.propertyName = expr.property.name ?? null;
      }
      return false;
    },
  });

  if (!found.visited) {
    return {
      ok: false,
      reason: "no-jsx-at-location",
      details: `No JSXOpeningElement found at ${line}:${col}`,
    };
  }
  if (!found.objectName) {
    return {
      ok: false,
      reason: "dynamic-classname",
      details:
        "className isn't a `{identifier.property}` member expression. B2 only handles direct `{styles.foo}` access.",
    };
  }

  // Step 2: find the default import for `objectName` and verify it points
  // to a .module.css file. Holder object so TS's CFA can narrow on `.value`.
  const importHolder: { value: string | null } = { value: null };
  recast.visit(ast, {
    visitImportDeclaration(path) {
      const node = path.node as {
        source: { value: string };
        specifiers: Array<{
          type: string;
          local?: { name?: string };
        }>;
      };
      const defaultSpec = node.specifiers.find(
        (s) =>
          s.type === "ImportDefaultSpecifier" &&
          s.local?.name === found.objectName,
      );
      if (defaultSpec) {
        importHolder.value = node.source.value;
        return false;
      }
      this.traverse(path);
      return undefined;
    },
  });

  if (!importHolder.value) {
    return {
      ok: false,
      reason: "unresolved-import",
      details: `No default import found for \`${found.objectName}\``,
    };
  }
  const importSource = importHolder.value;
  if (!importSource.endsWith(".module.css")) {
    return {
      ok: false,
      reason: "not-a-css-module",
      details: `Import \`${importSource}\` is not a .module.css file`,
    };
  }

  return {
    ok: true,
    ref: {
      cssFile: importSource,
      selector: `.${found.propertyName}`,
    },
  };
}

// ---------------------------------------------------------------------------
// CSS mutation (postcss)
// ---------------------------------------------------------------------------

export type MutateCssPropertyResult =
  | { ok: true; output: string; previousValue: string | null }
  | {
      ok: false;
      reason:
        | "css-parse-error"
        | "selector-not-found"
        | "composes-chain"
        | "invalid-property";
      details: string;
    };

/**
 * Update or insert a property declaration on the rule matching `selector`
 * in `cssSource`. Returns the rewritten CSS (and the previous value if
 * the property already existed, for undo bookkeeping).
 *
 * Refuses if the rule has a `composes:` declaration — composes chains
 * reach into other rules and a property change here could leak elsewhere.
 * That's the v0.3 work; for v0.2 we surface the refusal cleanly.
 */
export function mutateCssProperty(
  cssSource: string,
  selector: string,
  property: string,
  value: string,
): MutateCssPropertyResult {
  if (!/^[a-zA-Z-]+$/.test(property)) {
    return {
      ok: false,
      reason: "invalid-property",
      details: `Property name "${property}" must be alphabetic + hyphens only`,
    };
  }
  let root: postcss.Root;
  try {
    root = postcss.parse(cssSource);
  } catch (err) {
    return {
      ok: false,
      reason: "css-parse-error",
      details: (err as Error).message,
    };
  }

  let targetRule: postcss.Rule | null = null;
  root.walkRules((rule) => {
    if (rule.selector === selector) {
      targetRule = rule;
      return false; // stop walking
    }
  });

  if (!targetRule) {
    return {
      ok: false,
      reason: "selector-not-found",
      details: `No rule matching selector \`${selector}\` in CSS source`,
    };
  }

  // Refuse on composes chains.
  let hasComposes = false;
  (targetRule as postcss.Rule).walkDecls("composes", () => {
    hasComposes = true;
  });
  if (hasComposes) {
    return {
      ok: false,
      reason: "composes-chain",
      details: `Rule \`${selector}\` uses \`composes:\`. v0.2 refuses to mutate composes chains because the property change could leak through.`,
    };
  }

  // Find an existing declaration of `property` on this rule (not in nested
  // at-rules); if present, update its value, otherwise append.
  let previousValue: string | null = null;
  let updated = false;
  (targetRule as postcss.Rule).walkDecls(property, (decl) => {
    // Skip declarations nested inside at-rules (media queries etc).
    if (decl.parent !== targetRule) return;
    if (!updated) {
      previousValue = decl.value;
      decl.value = value;
      updated = true;
    }
  });

  if (!updated) {
    (targetRule as postcss.Rule).append({ prop: property, value });
  }

  return {
    ok: true,
    output: root.toString(),
    previousValue,
  };
}
