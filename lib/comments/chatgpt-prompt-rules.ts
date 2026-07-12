export const CHATGPT_TERMINOLOGY_CLARIFICATION_PROMPT_RULES = `## Terminology clarification and consistency

When a comment asks what a term means:

- First explain the term in plain language.
- Decide whether the term should remain with an explanation or be replaced in the document.
- If you recommend replacement because the term is unclear, technical, ambiguous, or unsuitable for the audience, inspect the complete supplied scope for other uses of the same term.
- Apply the clearer terminology consistently throughout the comment's intended scope.
- Do not replace only the anchored occurrence while leaving equivalent unclear terminology elsewhere without explanation.
- If another occurrence should intentionally remain unchanged, explain why in \`reply\` or \`risk\`.
- Report the number or nature of affected occurrences when useful.
- Do not claim consistent replacement unless every relevant occurrence in the supplied scope has been addressed.

Use \`action_context.default_scope\` to determine the intended search boundary:

- \`display_target\` gives the initial selected-text target.
- \`containing_section\` is the normal consistency-check scope when supplied.
- \`full_document\` may be checked only when \`full_document_markdown\` is included or explicitly requested.
- Do not claim to have checked content that Patchmark did not export.

Be conservative when deciding what counts as the same term:

- Do not blindly replace every matching substring.
- Exclude occurrences in URLs, Markdown link destinations, source titles that must remain exact, code or code fences, identifiers, protocol fields, quoted source language that should remain verbatim, proper names, or different concepts that happen to use the same words.
- Handle singular and plural forms, possessives, capitalization, surrounding modifiers, sentence role, and hyphenated or non-hyphenated variants carefully.
- Preserve grammar in every replacement.
- If semantic equivalence is uncertain, ask a clarification question or change only clearly equivalent occurrences and disclose the limitation.

When several occurrences need replacement:

- Return separate small patch proposals when the changes are non-structural and independently safe.
- Link every proposal to the same originating \`comment_id\`.
- Give each proposal its own exact \`original_text\` and \`suggested_text\`.
- Do not create \`patch_group_id\`; Patchmark creates grouping metadata during import.
- Preserve surrounding punctuation and Markdown.
- Do not replace the entire table merely because terminology appears in several cells.
- Continue using one complete-table patch only for genuinely structural table changes.
- If the same short phrase appears more than once, do not use ambiguous \`original_text\` that matches several locations.
- Include the smallest exact surrounding Markdown context needed to make each \`original_text\` uniquely identify its intended occurrence within the supplied target scope.

Example repeated term:

Supplied context contains:

- \`share of non-network customers\`
- \`30-day repeat rate among non-network customers\`

Bad patching:

- Two patches that both use \`non-network customers\` as \`original_text\`.

Good patching:

- Patch 1 uses \`share of non-network customers\` and replaces it with \`share of customers outside the founder's personal network\`.
- Patch 2 uses \`30-day repeat rate among non-network customers\` and replaces it with \`30-day repeat rate among customers outside the founder's personal network\`.

Before returning a response that recommends replacing unclear terminology, check:

- Did the unclear term appear elsewhere in the supplied scope?
- Were equivalent occurrences handled consistently?
- Does any unchanged occurrence still recreate the user's original confusion?
- Does every patch use exact Markdown?
- Is every short \`original_text\` uniquely applicable?
- Were URLs, source titles, links, code fences, and quoted evidence preserved?
- Were grammatical differences handled correctly?
- Did the reply accurately describe the extent of the proposed change?

If the old terminology intentionally remains somewhere, mention that in \`reply\` or \`risk\`.

For comments asking what a metric or business term means, make the replacement operationally understandable instead of merely swapping jargon:

- Where the supplied context supports it, clarify what is counted or averaged.
- Clarify the unit, such as customer, order, item, loaf, or production week.
- Clarify whether the metric uses listed price or actual transaction values.
- Clarify relevant segmentation, such as retail, subscription, or wholesale.
- Clarify important adjustments, such as discounts.
- Clarify a time window only when one is already defined or clearly required.
- Do not invent unsupported accounting policies.
- Do not imply that channel price differences are deductions.
- Do not use "actually received" if it could be confused with payment settlement, cash timing, provider fees, or tax treatment unless you explain the intended meaning.
- Do not silently decide treatment of VAT, delivery fees, payment-provider fees, refunds, taxes, or settlement timing when the document does not define them.
- If those inclusions materially change the metric and cannot be inferred, ask a clarification question.
- Prefer concise wording appropriate for a table cell.

Metric-language example:

- Original: \`average realized selling price\`
- Clearer: \`average amount received per unit sold, after discounts, across retail, subscription, and wholesale orders\`
- This is preferable because it defines the unit and transaction basis without treating retail, subscription, and wholesale price differences as deductions or inventing VAT, tax, fee, refund, or settlement treatment.

Compact terminology example:

- Comment: \`What does non-network customers mean?\`
- Explain that it refers to customers outside the founder's existing personal relationships.
- State that the terminology appears more than once in the supplied section when both occurrences are present.
- Return two exact, uniquely anchored, non-structural patch proposals with the same \`comment_id\`.
- Use consistent plain language in both replacements.
- Do not rewrite the entire table.
- Do not leave the unclear term behind in another equivalent metric.`;

export const CHATGPT_TERMINOLOGY_CLARIFICATION_PAYLOAD_RULES = [
  "When a comment asks what a term means, explain it plainly and decide whether the document should keep the term with explanation or replace it.",
  "If replacing unclear terminology, check the complete supplied action_context.default_scope and handle equivalent occurrences consistently.",
  "Do not claim to have checked full-document terminology unless full_document_markdown was exported or explicitly requested.",
  "For non-structural terminology replacements, use separate small exact patch proposals linked to the same comment_id.",
  "If a short phrase appears more than once, include enough exact surrounding Markdown in original_text to uniquely identify each intended occurrence.",
  "Do not replace matching substrings inside URLs, Markdown link destinations, source titles, code fences, identifiers, protocol fields, quoted source language, proper names, or different concepts.",
  "If old terminology intentionally remains, explain why in reply or risk.",
  "For metric terminology, clarify the unit and transaction basis where supported; do not invent VAT, tax, fee, refund, or settlement treatment."
];
