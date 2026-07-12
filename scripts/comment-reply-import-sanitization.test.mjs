import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHATGPT_INTERNAL_CITATION_PROMPT_RULES,
  parsePatchmarkCommentReplyImport
} from "../lib/imports/patchmark-comment-reply-import.ts";

const contentReference = ":contentReference[oaicite:0]{index=0}";
const laterContentReference = ":contentReference[oaicite:12]{index=12}";
const privateUseCitation = "\uE200cite\uE202turn0search0\uE201";
const privateUseFileCitation = "\uE200filecite\uE202turn1view0\uE201";
const bracketedTurnCitation = "【turn1view0†source】";

function payload(overrides = {}) {
  return {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 1,
    summary: "Imported one focused response.",
    sources: [],
    replies: [
      {
        comment_id: "PM-COMMENT-0001",
        reply: "Reviewed the request.",
        reply_sources: [],
        suggested_user_action: "review"
      }
    ],
    patch_proposals: [
      {
        comment_id: "PM-COMMENT-0001",
        target_heading: "## Market View",
        original_text: "Original [linked source](https://example.com/original).",
        suggested_text: "Suggested [linked source](https://example.com/suggested).",
        suggested_text_sources: [
          {
            title: "Source",
            url: "https://example.com/report.pdf",
            supports: "Supports the suggested change."
          }
        ],
        reason: "Improves clarity.",
        reason_sources: [],
        risk: "Low risk.",
        risk_sources: []
      }
    ],
    open_questions: [
      {
        comment_id: "PM-COMMENT-0001",
        question: "Should this remain in scope?",
        question_sources: []
      }
    ],
    ...overrides
  };
}

function parse(input) {
  return parsePatchmarkCommentReplyImport(
    `\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``
  );
}

{
  assert.match(CHATGPT_INTERNAL_CITATION_PROMPT_RULES, /summary.*plain text/s);
  assert.match(CHATGPT_INTERNAL_CITATION_PROMPT_RULES, /:contentReference/);
  assert.match(CHATGPT_INTERNAL_CITATION_PROMPT_RULES, /oaicite/);
  assert.match(CHATGPT_INTERNAL_CITATION_PROMPT_RULES, /turn0search0/);
  assert.match(CHATGPT_INTERNAL_CITATION_PROMPT_RULES, /reply_sources/);
  assert.match(CHATGPT_INTERNAL_CITATION_PROMPT_RULES, /suggested_text_sources/);
  assert.match(CHATGPT_INTERNAL_CITATION_PROMPT_RULES, /question_sources/);
  assert.match(
    readFileSync("components/document-editor.tsx", "utf8"),
    /CHATGPT_INTERNAL_CITATION_PROMPT_RULES/
  );
}

{
  const result = parse(
    payload({
      summary: `Reviewed the focused request. ${contentReference}`
    })
  );

  assert.equal(result.summary, "Reviewed the focused request.");
}

{
  const result = parse(
    payload({
      summary: `Summary ${laterContentReference}`,
      replies: [
        {
          comment_id: "PM-COMMENT-0001",
          reply: `Reply ${contentReference} with artifact.`,
          reply_sources: [
            {
              title: `Title ${contentReference}`,
              url: "https://example.com/reply.pdf",
              supports: `Supports the reply ${privateUseCitation}.`
            }
          ],
          suggested_user_action: "review"
        }
      ],
      patch_proposals: [
        {
          comment_id: "PM-COMMENT-0001",
          original_text: `Original text ${bracketedTurnCitation}.`,
          suggested_text: `Suggested text ${privateUseFileCitation}.`,
          suggested_text_sources: [
            {
              title: "Patch source",
              url: "https://example.com/report.pdf",
              supports: `Supports patch ${laterContentReference}.`
            }
          ],
          reason: `Reason ${contentReference}.`,
          reason_sources: [],
          risk: `Risk ${privateUseCitation}.`,
          risk_sources: []
        }
      ],
      open_questions: [
        {
          comment_id: "PM-COMMENT-0001",
          question: `Question ${privateUseFileCitation}?`,
          question_sources: [
            {
              title: "Question source",
              url: "https://example.com/question.pdf",
              supports: `Supports question ${bracketedTurnCitation}.`
            }
          ]
        }
      ]
    })
  );

  assert.equal(result.summary, "Summary");
  assert.equal(result.replies[0].reply, "Reply with artifact.");
  assert.equal(result.replies[0].reply_sources?.[0].title, "Title");
  assert.equal(
    result.replies[0].reply_sources?.[0].supports,
    "Supports the reply."
  );
  assert.equal(result.patch_proposals[0].original_text, "Original text.");
  assert.equal(result.patch_proposals[0].suggested_text, "Suggested text.");
  assert.equal(
    result.patch_proposals[0].suggested_text_sources?.[0].supports,
    "Supports patch."
  );
  assert.equal(result.patch_proposals[0].reason, "Reason.");
  assert.equal(result.patch_proposals[0].risk, "Risk.");
  assert.equal(result.open_questions[0].question, "Question?");
  assert.equal(
    result.open_questions[0].question_sources?.[0].supports,
    "Supports question."
  );
}

{
  const result = parse(
    payload({
      replies: [
        {
          comment_id: "PM-COMMENT-0001",
          reply: `First ${privateUseCitation}; second ${privateUseFileCitation}.`,
          reply_sources: []
        }
      ]
    })
  );

  assert.equal(result.replies[0].reply, "First; second.");
}

{
  const result = parse(
    payload({
      summary: `Before  ${contentReference}  after , then done ${privateUseCitation}.`
    })
  );

  assert.equal(result.summary, "Before after, then done.");
}

{
  const result = parse(
    payload({
      patch_proposals: [
        {
          comment_id: "PM-COMMENT-0001",
          original_text:
            "Original [linked source](https://example.com/turn0search0/original).",
          suggested_text:
            "Suggested [linked source](https://example.com/turn1view0/suggested).",
          suggested_text_sources: [],
          reason: "Reason.",
          reason_sources: [],
          risk_sources: []
        }
      ]
    })
  );

  assert.equal(
    result.patch_proposals[0].original_text,
    "Original [linked source](https://example.com/turn0search0/original)."
  );
  assert.equal(
    result.patch_proposals[0].suggested_text,
    "Suggested [linked source](https://example.com/turn1view0/suggested)."
  );
}

{
  const result = parse(
    payload({
      patch_proposals: [
        {
          comment_id: "PM-COMMENT-0001",
          original_text: "Original text.",
          suggested_text: "Suggested text.",
          suggested_text_sources: [
            {
              title: "Source",
              url: "https://example.com/turn0search0/report.pdf",
              supports: "Supports the suggested text."
            }
          ],
          reason: "Reason.",
          reason_sources: [],
          risk_sources: []
        }
      ]
    })
  );

  assert.equal(
    result.patch_proposals[0].suggested_text_sources?.[0].url,
    "https://example.com/turn0search0/report.pdf"
  );
}

{
  const result = parse(
    payload({
      summary:
        "This citation explains why the content reference should remain as prose."
    })
  );

  assert.equal(
    result.summary,
    "This citation explains why the content reference should remain as prose."
  );
}

{
  assert.throws(
    () =>
      parse(
        payload({
          replies: [
            {
              comment_id: "PM-COMMENT-0001",
              reply: contentReference,
              reply_sources: []
            }
          ]
        })
      ),
    /Required field became empty/
  );
}

{
  const input = payload();
  const result = parse(input);

  assert.equal(result.summary, input.summary);
  assert.equal(result.replies[0].reply, input.replies[0].reply);
  assert.equal(
    result.patch_proposals[0].original_text,
    input.patch_proposals[0].original_text
  );
  assert.equal(
    result.patch_proposals[0].suggested_text,
    input.patch_proposals[0].suggested_text
  );
  assert.equal(result.patch_proposals[0].reason, input.patch_proposals[0].reason);
  assert.equal(result.open_questions[0].question, input.open_questions[0].question);
}

console.log("Comment reply import sanitization tests passed.");
