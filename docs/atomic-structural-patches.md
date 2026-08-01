# Atomic structural patches

Patchmark validates structural Markdown changes before importing replies or patch proposals. The validator prevents partial table rewrites from leaving sibling patches stale while still allowing a proposal to reorganize a complete section.

> One patch proposal may atomically replace a region containing several Markdown tables. A structural change is considered split only when multiple proposals independently modify an overlapping or interdependent structural region.

## Proposal and block boundaries

A patch proposal is the externally reviewable unit identified by its `patch_key`, `comment_id`, `target_heading`, `original_text`, and `suggested_text`. Markdown tables, headings, paragraphs, and lists inside those fields are structural blocks owned by that proposal; they are not additional proposals.

One proposal may replace one table with another, replace two adjacent tables with three tables, reorder tables, add headings between tables, or replace a complete section containing several structures. Table-block count may change and does not determine proposal count.

## Complete-region validation

For an atomic structural rewrite, Patchmark requires the original region to resolve through the normal canonical target pipeline. Every affected source table must be fully contained in the resolved region, and every replacement table must have a header, delimiter row, and consistent cell counts. Target-heading and exported-snapshot validation still ensure the region belongs to the declared section and the exact Review Batch base document.

A proposal that changes table structure while starting or ending inside a table is rejected as `incomplete_structural_region`. A malformed replacement table is rejected as `malformed_structural_markdown`; it is not described as a split proposal.

## Genuine split conflicts

Patchmark groups proposals by the source table ranges they touch. A group is rejected as `split_structural_change_across_proposals` when at least one proposal structurally changes a grouped table and more than one proposal independently touches that same source structure. This covers split header/body changes, separate row changes that alter cell distribution, and a complete-table replacement paired with a row-level patch.

Independent proposals for unrelated tables in different sections remain valid. Patch dependencies and canonical target simulation continue to validate ordering, stale targets, and explicit prerequisites after structural validation.

## Errors and repair prompts

A genuine multi-proposal conflict asks for one atomic patch covering the complete affected table or structural region and includes patch keys and a shared target heading when available. Internal one-proposal split invariants use `single_proposal_split_invariant`, preserve the pasted response and zero-write state, and do not ask ChatGPT to repair an already atomic response.

All structural failures occur before import persistence. Failed imports add no reply, patch, import artifact, response analysis, or Review Batch transition. Successful imports still create pending patches only; Patchmark never accepts a patch automatically.

## Real regression

The permanent protocol-v2 fixture `scripts/fixtures/atomic-multi-table-import-response.json` preserves the reported response as a 29,696-byte payload with SHA-256 `8e4c545f081443489f86551c30ff43f293f20f20ebc4f424adb0b7c4ad4b284d`. It contains one proposal with no dependencies, two complete source table blocks, and three complete replacement table blocks.
