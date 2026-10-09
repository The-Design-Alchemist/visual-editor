---
description: Process the elements the user selected or pinned in the visual-editor browser overlay
---

The `visual-editor` MCP server connects you to the user's running dev server. The user points at
elements in their browser (hover/click/drag) and either edits them visually (deterministic token
swaps the overlay already applied), or leaves **pins** — selections with a note — for you to handle.
Your job is to act on those with precise, reviewable edits.

Tools:

- `get_selected_element` — the current selection + all pins + recent edits. Each selection carries
  `refs`: `host` (the element inside its component file) and, when the component spreads props,
  `call` (where it was used). Each ref says whether a class-token swap there is `editable`, lists
  the static `tokens`, names the enclosing component, and includes a source `snippet`.
- `propose_change` / `apply_change` — swap ONE class token (or a whole attribute like `src`) at a
  ref. Deterministic: refuses with a structured `reason` when it can't prove the result.
- `revert_change` — undo.
- `apply_css_property` / `apply_styled_property` — CSS Modules / styled-components write-back.
- `highlight_element` — flash an outline in the user's browser ("this one?").
- `resolve_pin` — mark a pin done (the overlay turns it green).

Flow:

1. Call `get_selected_element`.
2. If there are **open pins**, work through them oldest-first. For each pin:
   - Read the note and the refs. Decide which ref owns the change: the `call` site when its tokens
     include the thing to change (a `<Card className="p-4">` override beats the component's own
     `p-6`), otherwise the `host`.
   - Prefer the deterministic tools when the note maps to a token swap (`"tighter"` on a `gap-4`
     → `gap-3`, `"bigger text"` on `text-sm` → `text-base`). Use `propose_change` first, show the
     diff, then `apply_change`.
   - When the note needs more than a token swap (new element, layout change, color system change),
     edit the files directly with your normal tools — the ref's file:line:col tells you exactly where.
     Keep the change minimal and inside the snippet you were given.
   - Before a change you're unsure about, call `highlight_element` on the ref and ask the user to confirm.
   - After applying, call `resolve_pin` with a one-line resolution.
3. If there are no pins but there is a current selection, describe it in one line (component,
   file:line, className) and ask what the user wants changed — unless they already said so in the
   prompt or the selection's `note`.
4. If nothing is selected: tell the user to click an element (or pin one) in the browser.

Refusals are correct by design — surface the `reason` and `details` verbatim and suggest the
nearest editable location (usually the other ref) instead of working around them:

- `dynamic-uncertain-arg` / `dynamic-spread-arg` — `cn("p-4", someVar)` / `cn(...rest)`: a runtime
  arg could override the token.
- `dynamic-conflict` — tailwind-merge would drop the new token because a later arg wins.
- `unknown-merger`, `dynamic-template-literal`, `dynamic-conditional` — not statically analyzable.
- `no-classname-attribute` — the element has no className here (props are spread in): edit the call site.
- `token-not-found` (409) — the file changed since the user staged the edit; re-read and retry with the current token.
- `no-jsx-at-location` — stale location; ask the user to re-select.
- `path-outside-workspace` — a safety check, never work around it.

Never guess at a visual change the user didn't describe; the whole point of this tool is that the
user's pointer, not your interpretation, picks the element and the value.
