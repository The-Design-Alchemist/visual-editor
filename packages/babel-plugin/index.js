/**
 * Stamps every JSXOpeningElement with data-oid="relpath:line:col" at build time.
 *
 * Plugin options:
 *   - root: absolute path that data-oid paths should be relative to.
 *     Defaults to walking up from the file looking for a workspace marker
 *     (pnpm-workspace.yaml, turbo.json, lerna.json, nx.json, or .git).
 *     Falls back to `state.cwd` if no marker is found.
 *
 *     For monorepos, point this at the monorepo root so data-oid paths
 *     are stable across packages — `packages/ui/Card.tsx:12:4` rather
 *     than `Card.tsx:12:4`.
 *
 *     Example:
 *       plugins: [["./babel-plugin-data-oid.js", { root: "/abs/monorepo" }]]
 *
 *     Or omit the option entirely — the plugin will find the workspace
 *     root automatically.
 */
const fs = require("node:fs");
// Renamed to avoid shadowing Babel's `path` parameter inside the visitor.
const nodePath = require("node:path");

const WORKSPACE_MARKERS = [
  "pnpm-workspace.yaml",
  "turbo.json",
  "lerna.json",
  "nx.json",
  ".git",
];

function findWorkspaceRoot(startDir) {
  let dir = startDir;
  while (dir && dir !== nodePath.dirname(dir)) {
    for (const marker of WORKSPACE_MARKERS) {
      try {
        if (fs.existsSync(nodePath.join(dir, marker))) {
          return dir;
        }
      } catch {
        /* permission denied — keep walking */
      }
    }
    dir = nodePath.dirname(dir);
  }
  return null;
}

const rootCache = new Map(); // startDir → resolved root (avoid repeated fs walks)

module.exports = function dataOidPlugin({ types: t }, options) {
  const configuredRoot =
    options && typeof options.root === "string" ? options.root : null;

  return {
    name: "data-oid",
    visitor: {
      // B2b/B3b: pre-collect default imports from .module.css files AND
      // local styled.tagname definitions at the Program level so the
      // JSXOpeningElement visitor below can stamp the right data attrs
      // without re-scanning per element.
      Program(programPath, state) {
        const cssModuleImports = new Map();
        const styledDefs = new Map(); // componentName → htmlTag
        for (const node of programPath.node.body) {
          if (
            node.type === "ImportDeclaration" &&
            typeof node.source?.value === "string" &&
            node.source.value.endsWith(".module.css")
          ) {
            for (const spec of node.specifiers || []) {
              if (
                spec.type === "ImportDefaultSpecifier" &&
                spec.local?.name
              ) {
                cssModuleImports.set(spec.local.name, node.source.value);
              }
            }
          } else if (node.type === "VariableDeclaration") {
            for (const decl of node.declarations || []) {
              if (decl.type !== "VariableDeclarator") continue;
              if (decl.id?.type !== "Identifier") continue;
              const init = decl.init;
              if (!init || init.type !== "TaggedTemplateExpression") continue;
              const tag = init.tag;
              if (
                tag &&
                tag.type === "MemberExpression" &&
                tag.computed === false &&
                tag.object?.type === "Identifier" &&
                tag.object.name === "styled" &&
                tag.property?.type === "Identifier" &&
                // Only stamp for templates with NO interpolations (matches
                // the v0.2 server-side support surface).
                (init.quasi?.expressions?.length ?? 0) === 0
              ) {
                styledDefs.set(decl.id.name, tag.property.name);
              }
            }
          }
        }
        state.cssModuleImports = cssModuleImports;
        state.styledDefs = styledDefs;
      },
      JSXOpeningElement(path, state) {
        const node = path.node;
        if (!node.loc) return;

        const already = node.attributes.some(
          (a) =>
            a.type === "JSXAttribute" &&
            a.name &&
            a.name.type === "JSXIdentifier" &&
            a.name.name === "data-oid",
        );
        if (already) return;

        const filename = state.filename || "<unknown>";

        // Resolve the path-prefix to strip. Priority:
        //   1. Plugin option `root` (explicit, monorepo-friendly)
        //   2. Cached workspace root from a parent dir walk
        //   3. Walk up from this file's dir looking for workspace markers
        //   4. state.cwd as fallback (v0.1 behavior)
        let root = configuredRoot;
        if (!root) {
          const dir = nodePath.dirname(filename);
          if (rootCache.has(dir)) {
            root = rootCache.get(dir);
          } else {
            root = findWorkspaceRoot(dir);
            rootCache.set(dir, root);
          }
        }
        if (!root) root = state.cwd || "";

        const rel =
          root && filename.startsWith(root)
            ? filename.slice(root.length + 1)
            : filename;

        const oid = `${rel}:${node.loc.start.line}:${node.loc.start.column}`;

        node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier("data-oid"), t.stringLiteral(oid)),
        );

        // B3b: if this JSX element's tag matches a same-file styled
        // component definition (collected at Program level), stamp the
        // styled-component data attrs.
        const styledDefs = state.styledDefs;
        if (styledDefs && styledDefs.size > 0) {
          const elName = node.name;
          if (
            elName &&
            elName.type === "JSXIdentifier" &&
            styledDefs.has(elName.name)
          ) {
            node.attributes.push(
              t.jsxAttribute(
                t.jsxIdentifier("data-styled-name"),
                t.stringLiteral(elName.name),
              ),
              t.jsxAttribute(
                t.jsxIdentifier("data-styled-tag"),
                t.stringLiteral(styledDefs.get(elName.name)),
              ),
            );
          }
        }

        // B2b: if this element's className is `{identifier.property}` where
        // the identifier is a default import from a .module.css file, stamp
        // data-css-module-* so the overlay can detect it at runtime and
        // route to the CSS-property mutation path.
        const cssModuleImports = state.cssModuleImports;
        if (cssModuleImports && cssModuleImports.size > 0) {
          const classNameAttr = node.attributes.find(
            (a) =>
              a.type === "JSXAttribute" &&
              a.name &&
              a.name.type === "JSXIdentifier" &&
              a.name.name === "className",
          );
          if (
            classNameAttr &&
            classNameAttr.value &&
            classNameAttr.value.type === "JSXExpressionContainer"
          ) {
            const expr = classNameAttr.value.expression;
            if (
              expr &&
              expr.type === "MemberExpression" &&
              expr.computed === false &&
              expr.object &&
              expr.object.type === "Identifier" &&
              expr.property &&
              expr.property.type === "Identifier"
            ) {
              const importPath = cssModuleImports.get(expr.object.name);
              if (importPath) {
                node.attributes.push(
                  t.jsxAttribute(
                    t.jsxIdentifier("data-css-module-class"),
                    t.stringLiteral(expr.property.name),
                  ),
                  t.jsxAttribute(
                    t.jsxIdentifier("data-css-module-file"),
                    t.stringLiteral(importPath),
                  ),
                );
              }
            }
          }
        }
      },
    },
  };
};
