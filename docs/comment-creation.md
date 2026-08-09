# Comment Creation

## Unified Selection Actions

Visual Mode and Markdown Mode use one document-scoped selection-actions model:

```text
selection or right-click or Alt+Shift+M
→ shared scope chooser
→ existing comment composer or reading-bookmark action
```

Selecting supported document text shows a compact `+ Comment` action.
Activating it opens `Comment on…` with these choices:

- **Selected text** anchors the comment to the captured range.
- **Current section** uses the containing canonical Markdown heading.
- **Whole document** creates a document anchor without a selected-text anchor.
- **Set reading bookmark** uses the existing document reading-bookmark
  persistence path.

Right-click is an alternative trigger for the same selection-actions chooser.
It does not expose a separate set of Patchmark capabilities.

The chooser previews the captured excerpt, structural context, and containing
section before a scope is chosen. Section and document comments do not treat
the preview excerpt as their authoritative anchor. If a containing section
cannot be determined, `Current section` is replaced by a muted explanation
rather than an enabled control.

## Permanent Document Comment

The Comments rail always includes `Comment on whole document` with an explicit
`Scope: Whole document` label. It requires no selection, opens the existing
document-comment composer, and remains bound to the active project and
document.

## Selection Identity and Context

Before focus moves into the chooser, Patchmark captures the selection draft
with:

- project and document identity;
- editor generation;
- current document fingerprint;
- selection fingerprint;
- selected-text range and anchor context;
- inferred containing section;
- preview excerpt and popover geometry.

Activation revalidates that identity and fingerprint. A stale draft closes
safely and announces that the text must be selected again. Switching documents
closes the chooser and cannot transfer its selection.

Visual selections preserve paragraph, heading, list-item, blockquote, link,
table-cell, and supported multi-block mapping. A table `td` or `th` takes
precedence over an inner paragraph, so `anchor_context.kind` remains
`table_cell`. Markdown selections use their exact source offsets and the same
scope labels.

Right-click without a valid selection never consumes an earlier range.
Patchmark shows selected text as unavailable while retaining safe section,
whole-document, and section-based bookmark actions for the clicked location.

## Positioning and Accessibility

The compact action and chooser render outside the editor containers using fixed,
viewport-clamped coordinates. They reuse the tested selection-affordance
placement logic, account for the sticky toolbar, flip around viewport edges,
and recompute or clamp on selection changes, scrolling, and resizing. The
chooser is responsive and does not shift document layout.

`Alt+Shift+M` opens the complete chooser for a keyboard-created selection.
Tab uses native button order; Up/Down, Home, and End move among available
actions. Enter or Space activates the focused action. Escape closes the chooser,
clears transient selection state, and restores focus to the active Visual or
Markdown editor. Unavailable actions are status text, not controls that appear
actionable.

## Re-anchor Isolation

During a human re-anchor session, document selection belongs exclusively to the
re-anchor workspace. The compact comment action, shared chooser, right-click
actions, bookmark action, and `Alt+Shift+M` comment shortcut are suppressed.
Cancelling re-anchor restores normal selection behavior; one draft is never
consumed by both workflows.

## Persistence and Cancellation

Opening or cancelling the compact action, chooser, or composer does not write
Markdown, comments, patches, bookmarks, project manifests, review batches,
Guided Review state, recovery state, or Version History. Comment persistence
still begins only at `Save Comment`. A bookmark write begins only when the user
activates `Set reading bookmark`.

All comment scopes continue through the existing composer, anchor creation, and
document-scoped save orchestration. The chooser introduces no second comment or
bookmark persistence model.

## Previous Inconsistency

The earlier implementation maintained two definitions:

1. ordinary selection and `Alt+Shift+M` opened a selected-text composer
   directly;
2. right-click rendered a separate menu containing section, document, and
   bookmark actions.

Those paths duplicated labels, availability checks, positioning, and selection
handoff. The shared captured-selection state and `SelectionActionsChooser` now
make one action definition authoritative for pointer, context-menu, and keyboard
invocation.
