/**
 * Babel plugin: stamps every JSXOpeningElement so the visual-editor overlay
 * can map runtime DOM back to source.
 *
 *   - host elements   (`<div>`, `<svg:rect>`)   → data-oid="relpath:line:col"
 *   - component sites (`<Button>`, `<Foo.Bar>`) → data-oid-call="relpath:line:col"
 *
 * Splitting host vs call-site into two attribute names means a component
 * that spreads its props onto a DOM node (shadcn/ui, Radix, next/image, …)
 * ends up carrying BOTH the location inside the component and the location
 * where it was used — regardless of whether `{...props}` comes before or
 * after the stamped attribute. The overlay then edits whichever location
 * actually owns the class token.
 *
 * Also stamps the hints the overlay uses to route an element to the right
 * mutation pipeline: data-css-module-class/-file for `{styles.foo}` and
 * data-styled-name/-tag for same-file, fully-static `styled.tag\`…\`` defs.
 *
 * Prefer the loader path (`withVisualEditor()` in next.config, or the Vite
 * plugin) over this plugin for SWC/Turbopack projects: a Babel config opts
 * Next.js out of its native compiler. This plugin exists for pipelines that
 * already run Babel. Both produce byte-identical attribute values; the
 * server package's parity test enforces that.
 *
 * Options:
 *   - root: absolute path that ids should be relative to. Defaults to the
 *     nearest workspace marker (pnpm-workspace.yaml, turbo.json, lerna.json,
 *     nx.json, .git) above the Babel cwd, else the cwd itself — the same
 *     rule the write side (@aaqiljamal/visual-editor-server) uses, so ids
 *     always resolve.
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
  let dir = nodePath.resolve(startDir);
  for (;;) {
    for (const marker of WORKSPACE_MARKERS) {
      try {
        if (fs.existsSync(nodePath.join(dir, marker))) return dir;
      } catch {
        /* permission denied — keep walking */
      }
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const rootCache = new Map(); // cwd → resolved root

function resolveRoot(configuredRoot, state) {
  if (configuredRoot) return nodePath.resolve(configuredRoot);
  if (process.env.VISUAL_EDITOR_WORKSPACE_ROOT) {
    return nodePath.resolve(process.env.VISUAL_EDITOR_WORKSPACE_ROOT);
  }
  const cwd = nodePath.resolve(state.cwd || process.cwd());
  if (!rootCache.has(cwd)) rootCache.set(cwd, findWorkspaceRoot(cwd) || cwd);
  return rootCache.get(cwd);
}

function toSourceId(root, filename) {
  return nodePath
    .relative(root, nodePath.resolve(filename))
    .split(nodePath.sep)
    .join("/");
}

function hasAttr(node, attrName) {
  return node.attributes.some(
    (a) =>
      a.type === "JSXAttribute" &&
      a.name &&
      a.name.type === "JSXIdentifier" &&
      a.name.name === attrName,
  );
}

// `<Fragment>` / `<React.Fragment>` only accept `key` — stamping them makes
// React warn. Skip those (plain `<>` has no opening element to begin with).
function isFragmentName(name) {
  if (!name) return false;
  if (name.type === "JSXIdentifier") return name.name === "Fragment";
  if (name.type === "JSXMemberExpression") {
    return name.property && name.property.name === "Fragment";
  }
  return false;
}

function nameKind(name) {
  if (!name) return null;
  if (name.type === "JSXIdentifier") {
    return /^[a-z]/.test(name.name) ? "host" : "component";
  }
  if (name.type === "JSXMemberExpression") return "component";
  if (name.type === "JSXNamespacedName") return "host";
  return null;
}

module.exports = function dataOidPlugin({ types: t }, options) {
  const configuredRoot =
    options && typeof options.root === "string" ? options.root : null;

  return {
    name: "visual-editor-data-oid",
    visitor: {
      // Pre-collect default imports from .module.css files and same-file
      // static styled.tag definitions at the Program level so the
      // JSXOpeningElement visitor can stamp hints without re-scanning.
      Program(programPath, state) {
        const cssModuleImports = new Map();
        const styledDefs = new Map(); // componentName → htmlTag
        for (const stmt of programPath.node.body) {
          if (
            stmt.type === "ImportDeclaration" &&
            typeof stmt.source?.value === "string" &&
            stmt.source.value.endsWith(".module.css")
          ) {
            for (const spec of stmt.specifiers || []) {
              if (spec.type === "ImportDefaultSpecifier" && spec.local?.name) {
                cssModuleImports.set(spec.local.name, stmt.source.value);
              }
            }
            continue;
          }
          const decl =
            stmt.type === "VariableDeclaration"
              ? stmt
              : stmt.type === "ExportNamedDeclaration" &&
                  stmt.declaration?.type === "VariableDeclaration"
                ? stmt.declaration
                : null;
          if (!decl) continue;
          for (const d of decl.declarations || []) {
            if (d.type !== "VariableDeclarator") continue;
            if (d.id?.type !== "Identifier") continue;
            const init = d.init;
            if (!init || init.type !== "TaggedTemplateExpression") continue;
            const tag = init.tag;
            if (
              tag &&
              tag.type === "MemberExpression" &&
              tag.computed === false &&
              tag.object?.type === "Identifier" &&
              tag.object.name === "styled" &&
              tag.property?.type === "Identifier" &&
              // Only fully-static templates (matches the server's support).
              (init.quasi?.expressions?.length ?? 0) === 0
            ) {
              styledDefs.set(d.id.name, tag.property.name);
            }
          }
        }
        state.cssModuleImports = cssModuleImports;
        state.styledDefs = styledDefs;
        state.visualEditorRoot = resolveRoot(configuredRoot, state);
      },
      JSXOpeningElement(path, state) {
        const node = path.node;
        if (!node.loc) return;
        if (hasAttr(node, "data-oid") || hasAttr(node, "data-oid-call")) return;
        if (isFragmentName(node.name)) return;
        const kind = nameKind(node.name);
        if (!kind) return;

        const filename = state.filename || "<unknown>";
        const root = state.visualEditorRoot || resolveRoot(configuredRoot, state);
        const rel = state.filename ? toSourceId(root, filename) : filename;
        const oid = `${rel}:${node.loc.start.line}:${node.loc.start.column}`;

        node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier(kind === "host" ? "data-oid" : "data-oid-call"),
            t.stringLiteral(oid),
          ),
        );

        // styled-components hint: the JSX tag matches a same-file static
        // styled definition.
        const styledDefs = state.styledDefs;
        if (
          styledDefs &&
          styledDefs.size > 0 &&
          node.name.type === "JSXIdentifier" &&
          styledDefs.has(node.name.name)
        ) {
          node.attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier("data-styled-name"),
              t.stringLiteral(node.name.name),
            ),
            t.jsxAttribute(
              t.jsxIdentifier("data-styled-tag"),
              t.stringLiteral(styledDefs.get(node.name.name)),
            ),
          );
        }

        // CSS Modules hint: className is `{identifier.property}` where the
        // identifier is a default import from a .module.css file.
        const cssModuleImports = state.cssModuleImports;
        if (cssModuleImports && cssModuleImports.size > 0) {
          const classNameAttr = node.attributes.find(
            (a) =>
              a.type === "JSXAttribute" &&
              a.name &&
              a.name.type === "JSXIdentifier" &&
              a.name.name === "className",
          );
          const expr =
            classNameAttr &&
            classNameAttr.value &&
            classNameAttr.value.type === "JSXExpressionContainer"
              ? classNameAttr.value.expression
              : null;
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
      },
    },
  };
};
