# Comment Creation

## Selected Text and Whole Documents

Selected-text and whole-document comments use the same comment persistence and
anchor orchestration, but they start from distinct actions:

- In Visual Mode, select valid document text and use the viewport-adjacent
  `Add comment` action. The composer previews the exact selected excerpt and
  preserves the captured anchor while focus moves into the comment textarea.
- Use the document context menu's `Add Comment to Document` action for a
  whole-document comment. It requires no text selection and creates a
  document-scoped anchor.

The selected-text path supports paragraphs, headings, list items, links, table
cells, and the multi-block selections already supported by Patchmark's anchor
mapping. A selection inside a Markdown table cell is classified against the
containing `td` or `th` before its inner paragraph so the persisted
`anchor_context.kind` remains `table_cell`.

## Positioning and Scrolling

The selection action is fixed against viewport coordinates and rendered outside
the MDXEditor popup and content-editable containers. Its position uses the
selection's directional client rectangle, flips beside or above the selection
when needed, and clamps to the visible editor and viewport margins. The sticky
MDXEditor toolbar contributes a top inset so an edge selection cannot place the
action behind the toolbar.

Selection geometry is recomputed on `selectionchange`, page or nested-container
scroll, and resize. Fragmented multi-line selection rectangles use the first or
last visible rectangle according to selection direction instead of being
treated as ambiguous. The comment form remains in the existing right comment
rail and scrolls into view before its textarea receives focus.

## Keyboard and Cancellation

Keyboard-created selections receive the same action. The action exposes the
accessible label `Add comment to selected text`; `Alt+Shift+M` opens it without
requiring a pointer. The composer moves focus to the labeled comment textarea.
`Escape` or `Cancel` closes it, clears the transient draft, and restores focus
to the visual editor.

Opening or cancelling a composer does not write Markdown, comments, patches,
bookmarks, review batches, project manifests, document stores, or recovery
state. Only `Save Comment` enters the existing comment persistence path.

## Production Regression Cause

The production regression had two measured causes:

1. Visual `mouseup` successfully extracted and stored the selected-text draft,
   including the exact browser range, but no UI rendered an action from that
   state. Comment creation was reachable only through the custom right-click
   menu, so a normal paragraph or table selection produced no button or
   composer in the DOM.
2. When the right-click path was used in a table, the nearest inner paragraph
   won the block lookup before the containing table cell. The selected text was
   valid, but its anchor context was labeled `paragraph`.

The current flow renders one viewport-clamped action from the existing visual
selection draft, sends that draft through the existing comment form and anchor
creation path, and gives table cells precedence during visual context
classification.
