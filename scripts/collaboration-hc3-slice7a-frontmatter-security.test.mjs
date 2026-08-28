import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import yaml from "js-yaml";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { frontmatter as frontmatterExtension } from "micromark-extension-frontmatter";

const fixturePath = new URL(
  "./fixtures/collaboration-hc3-slice7a-editor-corpus-v1.json",
  import.meta.url
);
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes);
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
const mdxPackage = lock.packages["node_modules/@mdxeditor/editor"];
const yamlPackage = lock.packages["node_modules/js-yaml"];
const expectedFixtureSha256 =
  "4a9afec6f85d57bfe433a9166511ed8a96683c5b0c95252855c6832a8e278e2c";

assert.equal(fixture.version, "patchmark-hc3-slice7a-editor-corpus-v1");
assert.equal(
  createHash("sha256").update(fixtureBytes).digest("hex"),
  expectedFixtureSha256,
  "the Slice 7A security/corpus fixture must remain byte-frozen"
);
assert.equal(mdxPackage.version, "4.2.2");
assert.equal(mdxPackage.dependencies["js-yaml"], "4.3.1");
assert.equal(yamlPackage.version, "4.3.1");

const prototypeBaseline = {
  compromised: Object.prototype.compromised,
  polluted: Object.prototype.polluted
};
const parseEvidence = [];

for (const testCase of fixture.frontmatter_security_cases) {
  const source = expandSecurityCase(testCase);
  assert.ok(
    Buffer.byteLength(source) <= 1024 * 1024,
    `${testCase.id} must stay within the one-MiB focused-test input budget`
  );

  const startedAt = performance.now();
  let parsed;
  let thrown = null;
  try {
    parsed = yaml.load(source);
  } catch (error) {
    thrown = error;
  }
  const durationMs = performance.now() - startedAt;

  assert.ok(
    durationMs < 2_500,
    `${testCase.id} exceeded the bounded 2.5-second parser budget (${durationMs.toFixed(2)} ms)`
  );
  if (testCase.expect === "reject") {
    assert.ok(thrown instanceof yaml.YAMLException, `${testCase.id} must reject safely`);
  } else {
    assert.equal(thrown, null, `${testCase.id} must parse without an exception`);
    if (testCase.expect === "undefined") {
      assert.equal(parsed, undefined);
    } else if (testCase.expect === "array") {
      assert.ok(Array.isArray(parsed), `${testCase.id} must produce an array`);
    } else {
      assert.equal(typeof parsed, "object", `${testCase.id} must produce inert data`);
      assert.notEqual(parsed, null);
    }
    assert.ok(
      Buffer.byteLength(JSON.stringify(parsed ?? null)) <= 8 * 1024 * 1024,
      `${testCase.id} must stay within the focused-test output budget`
    );
  }

  assert.equal(globalThis.__patchmarkYamlExecuted, undefined);
  assert.equal(Object.prototype.polluted, prototypeBaseline.polluted);
  assert.equal(Object.prototype.compromised, prototypeBaseline.compromised);
  parseEvidence.push({
    duration_ms: Number(durationMs.toFixed(2)),
    id: testCase.id,
    input_bytes: Buffer.byteLength(source),
    result: thrown ? "rejected" : testCase.expect
  });
}

const prototypeResult = yaml.load(
  fixture.frontmatter_security_cases.find(
    (testCase) => testCase.id === "prototype_like_keys"
  ).yaml
);
assert.equal(Object.hasOwn(prototypeResult, "__proto__"), true);
assert.deepEqual(prototypeResult.__proto__, { polluted: true });
assert.deepEqual(prototypeResult.constructor, {
  prototype: { compromised: true }
});
assert.equal({}.polluted, undefined);
assert.equal({}.compromised, undefined);

const ordinaryDocument = markdownTree(
  "---\ntitle: Patchmark\n---\n\n# Body\n"
);
assert.equal(ordinaryDocument.children[0].type, "yaml");
assert.equal(ordinaryDocument.children[0].value, "title: Patchmark");
assert.equal(ordinaryDocument.children[1].type, "heading");

const fencedDocument = markdownTree(
  "# Fence\n\n```yaml\n---\ntitle: not frontmatter\n---\n```\n"
);
assert.equal(
  fencedDocument.children.some((node) => node.type === "yaml"),
  false,
  "frontmatter-looking text in a fence must remain code"
);
assert.equal(fencedDocument.children[1].type, "code");
assert.match(fencedDocument.children[1].value, /title: not frontmatter/);

const ambiguousDocument = markdownTree(
  "---\ntitle: no closing delimiter\n----\n\n# Body\n"
);
assert.equal(
  ambiguousDocument.children.some((node) => node.type === "yaml"),
  false,
  "a four-dash body line must not close three-dash frontmatter"
);

const malformedDocument = markdownTree(
  "---\ntitle: [unterminated\n---\n\n# Body\n"
);
assert.equal(malformedDocument.children[0].type, "yaml");
assert.throws(
  () => yaml.load(malformedDocument.children[0].value),
  yaml.YAMLException,
  "malformed frontmatter must remain bounded source and reject when inspected"
);

const invalidUtf8 = Uint8Array.from([
  0x23, 0x20, 0x55, 0x54, 0x46, 0x2d, 0x38, 0x0a, 0x0a, 0xc3, 0x28, 0xa0
]);
assert.throws(
  () => new TextDecoder("utf-8", { fatal: true }).decode(invalidUtf8),
  TypeError,
  "a strict test boundary must reject invalid UTF-8"
);
const browserFileBoundaryValue = new TextDecoder("utf-8").decode(invalidUtf8);
assert.match(browserFileBoundaryValue, /�\(�/);
assert.equal(markdownTree(browserFileBoundaryValue).type, "root");
assert.equal(globalThis.__patchmarkYamlExecuted, undefined);

console.log(
  JSON.stringify(
    {
      fixture_sha256: expectedFixtureSha256,
      js_yaml: yamlPackage.version,
      markdown_boundaries: {
        closing_delimiter_ambiguity: "body",
        fenced_frontmatter_like_text: "code",
        invalid_utf8_strict_boundary: "rejected",
        malformed_yaml: "preserved_then_rejected"
      },
      mdxeditor: mdxPackage.version,
      parse_evidence: parseEvidence,
      prototype_mutation: false,
      unsafe_tag_execution: false
    },
    null,
    2
  )
);
console.log("HC-3 Slice 7A frontmatter security tests passed.");

function markdownTree(markdown) {
  return fromMarkdown(markdown, {
    extensions: [frontmatterExtension(["yaml"])],
    mdastExtensions: [frontmatterFromMarkdown(["yaml"])]
  });
}

function expandSecurityCase(testCase) {
  if (typeof testCase.yaml === "string") return testCase.yaml;

  const descriptor = testCase.descriptor;
  switch (descriptor.encoding) {
    case "nested_mapping": {
      const lines = ["root:"];
      for (let depth = 0; depth < descriptor.depth; depth += 1) {
        lines.push(`${"  ".repeat(depth + 1)}level_${depth}:`);
      }
      lines.push(`${"  ".repeat(descriptor.depth + 1)}leaf: ${descriptor.leaf}`);
      return `${lines.join("\n")}\n`;
    }
    case "repeated_scalar":
      return `payload: ${String.fromCharCode(descriptor.byte).repeat(descriptor.length)}\n`;
    case "repeated_alias_merge":
      return [
        "base: &base { visible: true, owner: local }",
        `document: { <<: [${Array.from({ length: descriptor.count }, () => "*base").join(", ")}], owner: author }`
      ].join("\n");
    case "merge_chain": {
      const lines = ["node_0: &node_0 { key_0: value_0 }"];
      for (let index = 1; index < descriptor.count; index += 1) {
        lines.push(
          `node_${index}: &node_${index} { <<: *node_${index - 1}, key_${index}: value_${index} }`
        );
      }
      return `${lines.join("\n")}\n`;
    }
    case "ordered_map":
      return `!!omap\n${Array.from(
        { length: descriptor.count },
        (_, index) => `- key_${index}: value_${index}`
      ).join("\n")}\n`;
    default:
      throw new Error(`Unsupported test-only descriptor: ${descriptor.encoding}`);
  }
}
