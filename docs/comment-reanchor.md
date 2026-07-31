# Human Comment Re-anchor

Re-anchoring changes where an existing comment points. It does not rewrite or
rebase linked patch proposals.

## Viewport-stable workspace

Starting Re-anchor opens a fixed workspace aligned with the comment rail on
desktop. The workspace remains visible while the document scrolls and does not
participate in Markdown document flow. On narrow viewports it becomes a
viewport-clamped bottom sheet.

The workspace shows:

- the owning project, document, and comment identity;
- the historical anchor excerpt;
- deterministic candidate locations, including confidence and reason;
- the current manual selection and anchor context;
- an explicit review step before persistence;
- a warning that linked stale patches remain unchanged.

Entering Re-anchor preserves the active document, editor mode, editor
generation, and current page scroll position. Candidate preview intentionally
scrolls to the candidate and provides a return action. Manual exploration and
cancellation remain at the user's current scroll position, then restore focus
to the owning comment card without scrolling it into view.

## Manual selection

The document is non-editable during re-anchor, but native text selection remains
enabled. Visual Mode uses an `aria-readonly` selection-only guard that blocks
before-input, paste, cut, drop, mutating shortcuts, toolbar actions, and any
Markdown change callback without toggling MDXEditor into its layout-changing
read-only render. Markdown Mode uses the source textarea's native read-only
state. Both modes store each draft in the active
project/document/comment-scoped session before focus moves to an action.

Normal `+ Add comment` selection actions are suppressed while re-anchor is
active. A valid selection must map to a non-empty current Markdown range in the
same document generation. Invalid, foreign, collapsed, or unmappable selections
cannot be confirmed and receive a visible explanation.

## Candidates and confirmation

Automatic candidates remain deterministic. Preview highlights and scrolls to a
candidate but never writes. Selecting a candidate or manual range opens an
explicit confirmation that compares the historical and proposed anchors.
`Choose different text` returns to the live selection workspace without a
write.

Confirmation uses the existing generation-ordered project save coordinator. It
validates:

- project ID;
- document ID;
- comment ID;
- editor/document generation;
- save generation;
- current Markdown hash and exact range contents.

The committed update preserves comment ID, thread, status, timestamps,
document ownership, Review Batch/import provenance, patch relationships, and
concise anchor history. It updates only the comment anchor and derived metadata.
It does not resolve the comment or change any linked patch.

If persistence fails, the prior anchor remains authoritative, the confirmation
and selected draft stay open, and an actionable error is announced. Retrying
uses the same explicit confirmation.

## Switching and accessibility

Switching documents during an active session requires confirmation. Cancelling
the prompt leaves the session untouched; confirming cancels the session before
the switch. Duplicate local comment IDs in other documents are irrelevant.

The workspace is keyboard operable, has descriptive labels and live selection
status, preserves visible focus, supports Escape, restores focus on cancellation,
and does not depend on hover or color. Reduced-motion preferences are respected.

## Measured production cause

The production failure had two independent causes:

1. The selection synchronizer introduced for the selected-text comment composer
   explicitly returned while re-anchor mode was active. Native Visual Mode
   selection remained connected and selectable, but no document-scoped
   selection draft reached the re-anchor session, so `Use selection as new
   anchor` stayed disabled.
2. The legacy re-anchor panel rendered before the editor inside normal document
   flow. At deep scroll positions it was thousands of pixels above the viewport,
   shifted layout, and could trigger browser scroll anchoring away from the
   user's working context.
3. MDXEditor's read-only render removed its table controls. In the real
   table-heavy Strategy document, entering re-anchor removed 247 controls and
   shortened the editor by 2,251 pixels, clamping the page away from the working
   position even after the panel was removed from document flow.

The fixed workspace removes the document-flow dependency, the Visual editor
keeps the same rendered tree under a mutation-blocking selection-only guard,
and the selection synchronizer routes valid selection state into the active
re-anchor session instead of the ordinary comment-creation affordance.
