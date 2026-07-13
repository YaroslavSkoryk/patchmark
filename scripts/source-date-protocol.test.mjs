import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHATGPT_IMPORT_REPAIR_PROMPT,
  CHATGPT_INTERNAL_CITATION_PROMPT_RULES,
  parsePatchmarkCommentReplyImport
} from "../lib/imports/patchmark-comment-reply-import.ts";
import {
  SOURCE_DATE_REFERENCE_ERROR,
  SOURCE_DATE_UNAVAILABLE_REFERENCE_ERROR,
  SOURCE_OBSERVATION_REFERENCE_ERROR,
  auditVisibleReferenceDateAnnotations
} from "../lib/imports/source-date-validation.ts";

function sourceReference(overrides = {}) {
  return {
    title: "Source report",
    url: "https://example.com/report",
    published_at: "2026-03-31",
    updated_at: null,
    observed_at: "2026-07-13",
    supports: "Supports the suggested change.",
    ...overrides
  };
}

function patchProposal(overrides = {}) {
  return {
    comment_id: "PM-COMMENT-0001",
    original_text: "Original text.",
    suggested_text: "Suggested text.",
    suggested_text_sources: [],
    reason: "Improves the document.",
    reason_sources: [],
    risk: "Low risk.",
    risk_sources: [],
    ...overrides
  };
}

function reply(overrides = {}) {
  return {
    comment_id: "PM-COMMENT-0001",
    reply: "Reviewed the request.",
    reply_sources: [],
    suggested_user_action: "review",
    ...overrides
  };
}

function payload(overrides = {}) {
  return {
    protocol: "patchmark.comment_reply_import",
    protocol_version: 1,
    summary: "Imported response.",
    sources: [],
    replies: [],
    patch_proposals: [patchProposal()],
    open_questions: [],
    ...overrides
  };
}

function parsePayload(input) {
  return parsePatchmarkCommentReplyImport(
    `\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``
  );
}

function linkedPatch({
  annotation,
  label = "Market report",
  source = sourceReference(),
  textPrefix = "Use",
  url = source.url
}) {
  return patchProposal({
    suggested_text: `${textPrefix} [${label}](${url}) ${annotation}.`,
    suggested_text_sources: [source]
  });
}

function withoutKey(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

{
  const documentEditorSource = readFileSync(
    "components/document-editor.tsx",
    "utf8"
  );

  assert.match(documentEditorSource, /Source date rules:/);
  assert.match(
    documentEditorSource,
    /Every source object must include \\`published_at\\` and \\`observed_at\\`/
  );
  assert.match(documentEditorSource, /publication date unavailable/);
  assert.match(documentEditorSource, /copyright years, footers, URL paths/);
  assert.match(documentEditorSource, /Good live-price \\`suggested_text\\`/);
  assert.match(documentEditorSource, /observed_at.*\$\{observedAt\}/s);
  assert.match(CHATGPT_IMPORT_REPAIR_PROMPT, /published_at/);
  assert.match(CHATGPT_IMPORT_REPAIR_PROMPT, /observed_at/);
  assert.match(CHATGPT_IMPORT_REPAIR_PROMPT, /publication date unavailable/);
  assert.match(CHATGPT_INTERNAL_CITATION_PROMPT_RULES, /:contentReference/);
  assert.match(CHATGPT_INTERNAL_CITATION_PROMPT_RULES, /oaicite/);
}

{
  const result = parsePayload(
    payload({
      patch_proposals: [
        linkedPatch({
          annotation: "— published 31 March 2026",
          source: sourceReference({
            title: "Dated report",
            url: "https://example.com/dated-report",
            published_at: "2026-03-31"
          })
        })
      ]
    })
  );

  assert.equal(
    result.patch_proposals[0].suggested_text_sources?.[0].published_at,
    "2026-03-31"
  );
}

{
  assert.doesNotThrow(() =>
    parsePayload(
      payload({
        patch_proposals: [
          linkedPatch({
            annotation: "— published 2026",
            source: sourceReference({
              url: "https://example.com/year-report",
              published_at: "2026"
            })
          })
        ]
      })
    )
  );

  assert.doesNotThrow(() =>
    parsePayload(
      payload({
        patch_proposals: [
          linkedPatch({
            annotation: "— published March 2026",
            source: sourceReference({
              url: "https://example.com/month-report",
              published_at: "2026-03"
            })
          })
        ]
      })
    )
  );
}

{
  const result = parsePayload(
    payload({
      patch_proposals: [
        linkedPatch({
          annotation: "— published 12 January 2025; updated 3 June 2026",
          source: sourceReference({
            url: "https://example.com/updated-report",
            published_at: "2025-01-12",
            updated_at: "2026-06-03"
          })
        })
      ]
    })
  );

  assert.equal(
    result.patch_proposals[0].suggested_text_sources?.[0].updated_at,
    "2026-06-03"
  );
}

{
  const result = parsePayload(
    payload({
      patch_proposals: [
        linkedPatch({
          annotation: "— publication date unavailable; prices observed 13 July 2026",
          label: "Conkey's Bakery live menu",
          source: sourceReference({
            title: "Conkey's Bakery live menu",
            url: "https://example.com/live-menu",
            published_at: null,
            supports: "Shows live menu prices visible on the observation date."
          }),
          textPrefix: "Prices remain visible on"
        })
      ]
    })
  );

  assert.equal(
    result.patch_proposals[0].suggested_text_sources?.[0].published_at,
    null
  );
}

{
  assert.doesNotThrow(() =>
    parsePayload(
      payload({
        patch_proposals: [
          linkedPatch({
            annotation: "— published 5 May 2025; price checked 13 July 2026",
            label: "Holey pricing post",
            source: sourceReference({
              title: "Holey pricing post",
              url: "https://example.com/social-post",
              published_at: "2025-05-05",
              supports: "Shows a potentially current price."
            })
          })
        ]
      })
    )
  );
}

{
  assert.throws(
    () =>
      parsePayload(
        payload({
          patch_proposals: [
            linkedPatch({
              annotation: "— published 31 March 2026",
              source: withoutKey(
                sourceReference({ url: "https://example.com/missing-published" }),
                "published_at"
              )
            })
          ]
        })
      ),
    /missing published_at/
  );

  assert.throws(
    () =>
      parsePayload(
        payload({
          patch_proposals: [
            linkedPatch({
              annotation: "— published 31 March 2026",
              source: withoutKey(
                sourceReference({ url: "https://example.com/missing-observed" }),
                "observed_at"
              )
            })
          ]
        })
      ),
    /missing observed_at/
  );
}

{
  assert.throws(
    () =>
      parsePayload(
        payload({
          patch_proposals: [
            linkedPatch({
              annotation: "— published 31 March 2026",
              source: sourceReference({
                url: "https://example.com/bad-date",
                published_at: "2026/03/31"
              })
            })
          ]
        })
      ),
    /Invalid source date/
  );

  assert.throws(
    () =>
      parsePayload(
        payload({
          patch_proposals: [
            linkedPatch({
              annotation: "— published 31 March 2026",
              source: sourceReference({
                url: "https://example.com/partial-observed",
                observed_at: "2026-07"
              })
            })
          ]
        })
      ),
    /observed_at/
  );
}

{
  assert.throws(
    () =>
      parsePayload(
        payload({
          patch_proposals: [
            linkedPatch({
              annotation: "— published 14 July 2026",
              source: sourceReference({
                url: "https://example.com/future-published",
                published_at: "2026-07-14"
              })
            })
          ]
        })
      ),
    /published_at cannot be after observed_at/
  );

  assert.throws(
    () =>
      parsePayload(
        payload({
          patch_proposals: [
            linkedPatch({
              annotation: "— published 31 March 2026; updated 1 January 2026",
              source: sourceReference({
                url: "https://example.com/bad-update-order",
                published_at: "2026-03-31",
                updated_at: "2026-01-01"
              })
            })
          ]
        })
      ),
    /updated_at cannot be before published_at/
  );

  assert.throws(
    () =>
      parsePayload(
        payload({
          patch_proposals: [
            linkedPatch({
              annotation: "— published 31 March 2026; updated 1 August 2026",
              source: sourceReference({
                url: "https://example.com/future-updated",
                updated_at: "2026-08-01"
              })
            })
          ]
        })
      ),
    /updated_at cannot be after observed_at/
  );
}

{
  assert.throws(
    () =>
      parsePayload(
        payload({
          patch_proposals: [
            linkedPatch({
              annotation: "— published 13 July 2026",
              label: "Example live menu",
              source: sourceReference({
                title: "Example live menu",
                url: "https://example.com/menu",
                published_at: "2026-07-13",
                supports: "Shows live menu prices visible on the observation date."
              })
            })
          ]
        })
      ),
    /Do not use observed_at as published_at/
  );
}

{
  assert.throws(
    () =>
      parsePayload(
        payload({
          replies: [
            reply({
              reply_sources: [
                sourceReference({
                  url: "https://example.com/repeated",
                  published_at: "2026-03-31"
                })
              ]
            })
          ],
          patch_proposals: [
            linkedPatch({
              annotation: "— published 1 April 2026",
              source: sourceReference({
                url: "https://example.com/repeated",
                published_at: "2026-04-01"
              })
            })
          ]
        })
      ),
    /conflicting date metadata/
  );

  assert.doesNotThrow(() =>
    parsePayload(
      payload({
        replies: [
          reply({
            reply_sources: [
              sourceReference({
                url: "https://example.com/repeated-consistent"
              })
            ]
          })
        ],
        patch_proposals: [
          linkedPatch({
            annotation: "— published 31 March 2026",
            source: sourceReference({
              url: "https://example.com/repeated-consistent"
            })
          })
        ]
      })
    )
  );
}

{
  assert.throws(
    () =>
      parsePayload(
        payload({
          patch_proposals: [
            linkedPatch({
              annotation: "",
              source: sourceReference({
                url: "https://example.com/no-visible-date"
              })
            })
          ]
        })
      ),
    new RegExp(SOURCE_DATE_REFERENCE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );

  assert.throws(
    () =>
      parsePayload(
        payload({
          patch_proposals: [
            linkedPatch({
              annotation: "— publication date unavailable",
              label: "Live menu",
              source: sourceReference({
                title: "Live menu",
                url: "https://example.com/no-observation",
                published_at: null,
                supports: "Shows live menu prices."
              })
            })
          ]
        })
      ),
    new RegExp(
      SOURCE_DATE_UNAVAILABLE_REFERENCE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
  );

  assert.throws(
    () =>
      parsePayload(
        payload({
          patch_proposals: [
            linkedPatch({
              annotation: "— published 5 May 2025",
              label: "Pricing post",
              source: sourceReference({
                title: "Pricing post",
                url: "https://example.com/missing-price-check",
                published_at: "2025-05-05",
                supports: "Shows a potentially current price."
              })
            })
          ]
        })
      ),
    new RegExp(
      SOURCE_OBSERVATION_REFERENCE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
  );
}

{
  assert.doesNotThrow(() =>
    parsePayload(
      payload({
        patch_proposals: [
          patchProposal({
            original_text:
              "Original [legacy source](https://example.com/legacy).",
            suggested_text:
              "Revised wording keeps [legacy source](https://example.com/legacy).",
            suggested_text_sources: []
          })
        ]
      })
    )
  );
}

{
  const result = parsePayload(
    payload({
      patch_proposals: [
        linkedPatch({
          annotation: "— published 31 March 2026",
          source: sourceReference({
            url: "https://example.com/source?turn=turn0search0&ref=2026-03-31"
          })
        })
      ]
    })
  );

  assert.equal(
    result.patch_proposals[0].suggested_text,
    "Use [Market report](https://example.com/source?turn=turn0search0&ref=2026-03-31) — published 31 March 2026."
  );
  assert.equal(
    result.patch_proposals[0].suggested_text_sources?.[0].url,
    "https://example.com/source?turn=turn0search0&ref=2026-03-31"
  );
}

{
  const result = parsePayload(
    payload({
      summary:
        "This citation and content reference wording should remain ordinary prose."
    })
  );

  assert.equal(
    result.summary,
    "This citation and content reference wording should remain ordinary prose."
  );
}

{
  const originalTable = [
    "| Signal | Source |",
    "| --- | --- |",
    "| Legacy | [Legacy](https://example.com/legacy) |"
  ].join("\n");
  const suggestedTable = [
    "| Signal | Source |",
    "| --- | --- |",
    "| Legacy | [Legacy](https://example.com/legacy) |",
    "| Demand | [Market report](https://example.com/table-report) — published March 2026 |"
  ].join("\n");

  assert.doesNotThrow(() =>
    parsePayload(
      payload({
        patch_proposals: [
          patchProposal({
            original_text: originalTable,
            suggested_text: suggestedTable,
            suggested_text_sources: [
              sourceReference({
                url: "https://example.com/table-report",
                published_at: "2026-03"
              })
            ]
          })
        ]
      })
    )
  );
}

{
  assert.doesNotThrow(() => parsePayload(payload()));
}

{
  assert.deepEqual(
    auditVisibleReferenceDateAnnotations(
      "Legacy [Source](https://example.com/source)."
    ),
    [
      {
        label: "Source",
        reason: "missing_publication_date",
        url: "https://example.com/source"
      }
    ]
  );

  assert.deepEqual(
    auditVisibleReferenceDateAnnotations(
      "Prices use [Live menu](https://example.com/menu) — published 2026."
    ),
    [
      {
        label: "Live menu",
        reason: "missing_observation_date",
        url: "https://example.com/menu"
      }
    ]
  );
}

console.log("Source date protocol tests passed.");
