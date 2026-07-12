import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHATGPT_TERMINOLOGY_CLARIFICATION_PAYLOAD_RULES,
  CHATGPT_TERMINOLOGY_CLARIFICATION_PROMPT_RULES
} from "../lib/comments/chatgpt-prompt-rules.ts";
import { CHATGPT_ATOMIC_TABLE_PROMPT_RULES } from "../lib/patches/atomic-table-patches.ts";

const documentEditorSource = readFileSync("components/document-editor.tsx", "utf8");
const promptRules = CHATGPT_TERMINOLOGY_CLARIFICATION_PROMPT_RULES;
const payloadRules = CHATGPT_TERMINOLOGY_CLARIFICATION_PAYLOAD_RULES.join("\n");

{
  assert.match(promptRules, /Terminology clarification and consistency/);
  assert.match(promptRules, /asks what a term means/);
  assert.match(promptRules, /First explain the term in plain language/);
  assert.match(promptRules, /remain with an explanation or be replaced/);
}

{
  assert.match(promptRules, /complete supplied scope/);
  assert.match(promptRules, /other uses of the same term/);
  assert.match(promptRules, /action_context\.default_scope/);
  assert.match(promptRules, /display_target/);
  assert.match(promptRules, /containing_section/);
  assert.match(promptRules, /full_document_markdown/);
  assert.match(promptRules, /Do not claim to have checked content that Patchmark did not export/);
}

{
  assert.match(promptRules, /Do not blindly replace every matching substring/);
  assert.match(promptRules, /URLs/);
  assert.match(promptRules, /Markdown link destinations/);
  assert.match(promptRules, /source titles/);
  assert.match(promptRules, /code fences/);
  assert.match(promptRules, /quoted source language/);
  assert.match(promptRules, /proper names/);
  assert.match(promptRules, /singular and plural/);
  assert.match(promptRules, /Preserve grammar/);
}

{
  assert.match(promptRules, /Return separate small patch proposals/);
  assert.match(promptRules, /same originating `comment_id`/);
  assert.match(promptRules, /own exact `original_text` and `suggested_text`/);
  assert.match(promptRules, /Do not create `patch_group_id`/);
  assert.match(promptRules, /Do not replace the entire table/);
  assert.match(promptRules, /complete-table patch only for genuinely structural table changes/);
  assert.match(promptRules, /same short phrase appears more than once/);
  assert.match(promptRules, /smallest exact surrounding Markdown context/);
  assert.match(promptRules, /uniquely identify its intended occurrence/);
}

{
  assert.match(promptRules, /share of non-network customers/);
  assert.match(promptRules, /30-day repeat rate among non-network customers/);
  assert.match(promptRules, /share of customers outside the founder's personal network/);
  assert.match(
    promptRules,
    /30-day repeat rate among customers outside the founder's personal network/
  );
  assert.match(promptRules, /Return two exact, uniquely anchored, non-structural patch proposals/);
  assert.match(promptRules, /Do not rewrite the entire table/);
  assert.match(promptRules, /Do not leave the unclear term behind/);
}

{
  assert.match(promptRules, /Did the unclear term appear elsewhere/);
  assert.match(promptRules, /Were equivalent occurrences handled consistently/);
  assert.match(promptRules, /unchanged occurrence still recreate/);
  assert.match(promptRules, /If the old terminology intentionally remains/);
  assert.match(promptRules, /reply` or `risk`/);
}

{
  assert.match(promptRules, /metric or business term/);
  assert.match(promptRules, /what is counted or averaged/);
  assert.match(promptRules, /unit, such as customer, order, item, loaf, or production week/);
  assert.match(promptRules, /listed price or actual transaction values/);
  assert.match(promptRules, /retail, subscription, or wholesale/);
  assert.match(promptRules, /discounts/);
  assert.match(promptRules, /Do not invent unsupported accounting policies/);
  assert.match(promptRules, /Do not imply that channel price differences are deductions/);
  assert.match(promptRules, /actually received/);
  assert.match(promptRules, /VAT, delivery fees, payment-provider fees, refunds, taxes/);
  assert.match(promptRules, /average amount received per unit sold, after discounts/);
}

{
  assert.match(payloadRules, /action_context\.default_scope/);
  assert.match(payloadRules, /complete supplied/);
  assert.match(payloadRules, /Do not claim to have checked full-document terminology/);
  assert.match(payloadRules, /separate small exact patch proposals/);
  assert.match(payloadRules, /uniquely identify each intended occurrence/);
  assert.match(payloadRules, /URLs/);
  assert.match(payloadRules, /code fences/);
  assert.match(payloadRules, /source titles/);
  assert.match(payloadRules, /old terminology intentionally remains/);
  assert.match(payloadRules, /unit and transaction basis/);
  assert.match(payloadRules, /VAT, tax, fee, refund, or settlement treatment/);
}

{
  assert.match(
    documentEditorSource,
    /CHATGPT_TERMINOLOGY_CLARIFICATION_PROMPT_RULES/
  );
  assert.match(
    documentEditorSource,
    /CHATGPT_TERMINOLOGY_CLARIFICATION_PAYLOAD_RULES/
  );
  assert.match(documentEditorSource, /CHATGPT_ATOMIC_TABLE_PROMPT_RULES/);
  assert.match(documentEditorSource, /Each \\`patch_proposal\\` must have its own exact \\`original_text\\` and \\`suggested_text\\`/);
  assert.match(documentEditorSource, /Do not create or include \\`patch_group_id\\`/);
}

{
  assert.match(CHATGPT_ATOMIC_TABLE_PROMPT_RULES, /complete-table patch required/i);
  assert.match(
    CHATGPT_ATOMIC_TABLE_PROMPT_RULES,
    /Return exactly one `patch_proposal`/
  );
  assert.match(
    CHATGPT_ATOMIC_TABLE_PROMPT_RULES,
    /Never copy a Patchmark table marker/
  );
}

console.log("ChatGPT prompt rule tests passed.");
