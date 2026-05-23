---
description: Apply or review the visual edit the user has staged in the browser overlay
---

You have access to the `visual-editor` MCP server, which exposes five tools (v0.2):

- `get_selected_element` — returns what the user clicked on in the browser overlay (file, line, col, className, tag, component name, instance count). Returns `selection: null` if nothing is currently selected.
- `propose_change` — given `{file, line, col, before, after, attribute?}`, returns the unified diff WITHOUT writing. Default `attribute` is "className"; pass "src"/"href"/"alt"/etc. for other attributes.
- `apply_change` — same input shape; writes the change to disk. Conflict-checked (returns 409 with `token-not-found` if the file changed externally since the user staged the edit).
- `revert_change` — undo the most-recent apply, or pass `{file, line, col}` to undo a specific older one.
- `apply_css_property` — for elements styled via CSS Modules (`<div className={styles.foo}>`), set a CSS property on the `.foo` rule in the linked `.module.css` file. Args: `{file, line, col, property, value}`. Refuses on `composes:` chains.

Follow this flow:

1. Call `get_selected_element`. If `selection` is null, tell the user "Nothing is selected — click an element in the browser first." and stop.
2. Tell the user what was selected (component name + source location + the className they have). Ask which token they want to change (e.g., "you have `p-4` on this element — what should it become?"). If they already told you the answer in their prompt, skip the question.
3. Call `propose_change` with `{file, line, col, before: <old token>, after: <new token>}`. Print the unified diff back to the user.
4. Ask "Apply this?". On yes, call `apply_change` with the same arguments. On no, stop.
5. If the apply returns a refusal (e.g. `reason: "dynamic-call-expression"`), surface the structured reason verbatim — don't try to work around it. v0.1's writer only mutates static string literals; dynamic className contexts (`cn`/`clsx`/`twMerge`/`cva`/spread/template-literal/conditional) are refused by design (Principle 1).
6. If the apply succeeds, mention that the user can `/visual-editor undo` (or call `revert_change` directly) to undo.

If the user says "undo" or asks to revert, call `revert_change` with no arguments to undo the most-recent apply.

Refusal-reason cheat sheet:
- `dynamic-call-expression` — className wraps `cn(...)` / `clsx(...)` / `twMerge(...)` / `cva(...)`. Refusal is correct: those compose at runtime and we can't prove which token actually paints. Suggest the user inline the static token or change a sibling token instead.
- `dynamic-template-literal`, `dynamic-conditional` — same family; refusal is correct.
- `no-classname-attribute` — JSX uses `{...spread}` and has no local className. Refusal is correct.
- `token-not-found` — file changed externally between staging and apply. Suggest the user re-stage the change in the overlay.
- `no-jsx-at-location` — the line:col doesn't match a JSXOpeningElement. The data-oid is stale or the user copied the wrong location.
- `path-outside-workspace` — refuse silently; this is a server safety check, not a user error you can fix.

Do not try to "fix" refused changes. The whole project exists to refuse these instead of guessing.
