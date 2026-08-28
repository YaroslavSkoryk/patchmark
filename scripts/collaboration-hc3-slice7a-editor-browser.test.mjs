import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CdpClient,
  assertEditorIsReachable,
  createPage,
  evaluate,
  findChromeExecutable,
  waitForDevToolsUrl,
  waitForProcessExit
} from "./comment-rail-editor-browser-regression.test.mjs";

const editorUrl =
  process.env.PATCHMARK_MDX_LIFECYCLE_URL ??
  "http://127.0.0.1:3117/mdx-render-error-lifecycle-regression";
const fixtureBytes = readFileSync(
  new URL(
    "./fixtures/collaboration-hc3-slice7a-editor-corpus-v1.json",
    import.meta.url
  )
);
const fixture = JSON.parse(fixtureBytes);
const expectedFixtureSha256 =
  "4a9afec6f85d57bfe433a9166511ed8a96683c5b0c95252855c6832a8e278e2c";

assert.equal(
  createHash("sha256").update(fixtureBytes).digest("hex"),
  expectedFixtureSha256
);

await run();

async function run() {
  const chromePath = process.env.PATCHMARK_CHROME_PATH ?? findChromeExecutable();
  if (!chromePath) {
    throw new Error(
      "Chrome was not found. Set PATCHMARK_CHROME_PATH to run the Slice 7A editor corpus test."
    );
  }

  await assertEditorIsReachable(editorUrl);
  const userDataDir = mkdtempSync(join(tmpdir(), "patchmark-hc3-slice7a-editor-"));
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-features=Translate,MediaRouter",
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  const consoleErrors = [];
  const consoleWarnings = [];
  const exceptions = [];
  const caseEvidence = [];
  let client;

  try {
    const browserWsUrl = await waitForDevToolsUrl(chrome);
    const pageWsUrl = await createPage(browserWsUrl, "about:blank");
    client = await CdpClient.connect(pageWsUrl);
    client.on("Runtime.consoleAPICalled", (event) => {
      const message = event.args
        ?.map((argument) => argument.value ?? argument.description)
        .join(" ");
      if (event.type === "error") consoleErrors.push(message);
      if (event.type === "warning") consoleWarnings.push(message);
    });
    client.on("Runtime.exceptionThrown", (event) => {
      exceptions.push(
        event.exceptionDetails?.exception?.description ??
          event.exceptionDetails?.text ??
          "Unknown exception"
      );
    });
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    await client.call("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: 900,
      mobile: false,
      width: 1440
    });
    await client.call("Page.navigate", { url: editorUrl });
    await waitFor(
      client,
      "Slice 7A lifecycle fixture",
      `document.querySelector("[data-lifecycle-fixture-ready='true'] [data-corpus-receiver-ready='true']") !== null`
    );

    for (const testCase of fixture.markdown_cases) {
      const markdown = expandMarkdownCase(testCase);
      const startedAt = Date.now();
      await loadCorpusCase(client, testCase.id, markdown);
      const state = await waitForCorpusState(
        client,
        testCase.id,
        testCase.expected_visual_state
      );
      await delay(150);
      const settled = await readCorpusState(client);

      assert.equal(settled.caseId, testCase.id);
      assert.equal(
        settled.changeCount,
        0,
        `${testCase.id} must not change Markdown merely by opening in Visual Mode`
      );
      assert.equal(
        settled.source,
        markdown,
        `${testCase.id} must retain exact source authority on no-op open`
      );
      assert.equal(settled.prototypePolluted, false);
      assert.equal(settled.prototypeCompromised, false);
      assert.equal(settled.executionMarkerPresent, false);
      if (testCase.expected_visual_state === "fallback") {
        assert.equal(state.fallback, true);
        assert.equal(state.fallbackSource, markdown);
      } else {
        assert.equal(state.editor, true);
        assert.equal(state.fallback, false);
      }

      caseEvidence.push({
        duration_ms: Date.now() - startedAt,
        id: testCase.id,
        input_bytes: Buffer.byteLength(markdown),
        source_sha256: createHash("sha256").update(markdown).digest("hex"),
        visual_state: testCase.expected_visual_state
      });
    }

    const richCase = fixture.markdown_cases.find(
      (testCase) => testCase.id === "rich_supported_markdown"
    );
    await loadCorpusCase(client, richCase.id, richCase.markdown);
    await waitForCorpusState(client, richCase.id, "ready");
    const richStructure = await evaluate(client, {
      expression: `(() => {
        const editor = document.querySelector("[aria-label='Lifecycle Visual editor']");
        if (!editor) return null;
        return {
          blockquoteCount: editor.querySelectorAll("blockquote").length,
          codeBlockCount: editor.querySelectorAll(".patchmark-deferred-code-block, .cm-editor").length,
          headingLevels: [...editor.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((node) => node.tagName),
          imageCount: editor.querySelectorAll("img").length,
          linkCount: editor.querySelectorAll("a").length,
          listCount: editor.querySelectorAll("ol,ul").length,
          tableCount: editor.querySelectorAll("table").length
        };
      })()`
    });
    assert.deepEqual(richStructure.headingLevels, ["H1", "H2", "H3", "H4", "H5", "H6"]);
    assert.ok(richStructure.blockquoteCount >= 1);
    assert.ok(richStructure.codeBlockCount >= 1);
    assert.ok(richStructure.imageCount >= 1);
    assert.ok(richStructure.linkCount >= 1);
    assert.ok(richStructure.listCount >= 2);
    assert.ok(richStructure.tableCount >= 1);

    const deferredRunEvidence = await verifyDeferredCodeRunSemantics(client);

    const editMarker = " Slice 7A bounded edit.";
    await evaluate(client, {
      expression: `(() => {
        const editor = document.querySelector("[aria-label='Lifecycle Visual editor']");
        if (!editor) throw new Error("Lifecycle Visual editor missing.");
        editor.focus();
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        const editableTextNodes = [];
        let textNode = walker.nextNode();
        while (textNode) {
          if (
            textNode.textContent &&
            !textNode.parentElement?.closest("[contenteditable='false']")
          ) {
            editableTextNodes.push(textNode);
          }
          textNode = walker.nextNode();
        }
        const target = editableTextNodes.at(-1);
        if (!target) throw new Error("Lifecycle Visual editor text is unavailable.");
        const range = document.createRange();
        range.setStart(target, target.textContent.length);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      })()`,
      userGesture: true
    });
    await client.call("Input.insertText", { text: editMarker });
    const edited = await waitFor(
      client,
      "bounded Visual edit",
      `(() => {
        const authority = document.querySelector("[data-testid='lifecycle-source-authority']");
        const source = authority?.querySelector("textarea")?.value ?? "";
        return Number(authority?.dataset.changeCount ?? 0) > 0 && source.includes(${JSON.stringify(editMarker)})
          ? { changeCount: Number(authority.dataset.changeCount), source }
          : null;
      })()`
    );
    assert.ok(edited.changeCount >= 1);
    assert.match(edited.source, /Slice 7A bounded edit/);

    await loadCorpusCase(client, richCase.id, richCase.markdown);
    await waitForCorpusState(client, richCase.id, "ready");
    await delay(150);
    const reopened = await readCorpusState(client);
    assert.equal(reopened.changeCount, 0);
    assert.equal(reopened.source, richCase.markdown);

    assert.deepEqual(exceptions, []);
    assert.deepEqual(
      [...consoleErrors, ...consoleWarnings].filter((message) =>
        /state update.*unmounted|update on an unmounted|can't perform.*unmounted/i.test(
          message ?? ""
        )
      ),
      []
    );

    console.log(
      JSON.stringify(
        {
          bounded_visual_edit: {
            change_count: edited.changeCount,
            persisted_in_authoritative_source: true,
            reopen_restored_frozen_source: reopened.source === richCase.markdown
          },
          cases: caseEvidence,
          console_errors: consoleErrors,
          console_warnings: consoleWarnings,
          exceptions,
          fixture_sha256: expectedFixtureSha256,
          deferred_code_run: deferredRunEvidence,
          rich_structure: richStructure
        },
        null,
        2
      )
    );
    console.log("HC-3 Slice 7A editor corpus browser test passed.");
  } finally {
    await client?.close().catch(() => undefined);
    chrome.kill("SIGTERM");
    await waitForProcessExit(chrome, 3000);
    rmSync(userDataDir, { force: true, recursive: true });
  }
}

async function verifyDeferredCodeRunSemantics(client) {
  const codeBlocks = Array.from({ length: 8 }, (_, index) => {
    const language = ["json", "ts", "yaml", "text"][index % 4];
    const meta = index === 2 ? "title=relay-three" : "";
    const body =
      index === 7
        ? `const relayEight = ${JSON.stringify("long-body-".repeat(80))};`
        : `relay-${index + 1}: deterministic-${language}`;
    return `\`\`\`${language}${meta ? ` ${meta}` : ""}\n${body}\n\`\`\``;
  });
  const offscreenPrelude = Array.from(
    { length: 50 },
    (_, index) =>
      `Prelude ${index + 1}: deterministic content keeps every deferred code block outside the initial viewport.`
  ).join("\n\n");
  const markdown = `# Deferred run semantics\n\n${offscreenPrelude}\n\n${codeBlocks.join("\n\n")}\n`;
  await loadCorpusCase(client, "deferred-code-run", markdown);
  await waitForCorpusState(client, "deferred-code-run", "ready");
  const inert = await waitFor(
    client,
    "deferred code run",
    `(() => {
      const blocks = [...document.querySelectorAll(".patchmark-deferred-code-block")];
      if (!document.querySelector("[aria-label='Lifecycle Visual editor']")) return null;
      const target = blocks.at(-1)?.querySelector("code");
      if (!target) return {
        codeMirrorCount: document.querySelectorAll(".cm-editor").length,
        deferredCount: blocks.length,
        html: document.querySelector("[aria-label='Lifecycle Visual editor']")?.innerHTML.slice(-2000)
      };
      const browserFind = window.find("relay-4: deterministic-text");
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      let copied = "";
      const capture = () => { copied = selection.toString(); };
      document.addEventListener("copy", capture, { once: true });
      target.dispatchEvent(new ClipboardEvent("copy", { bubbles: true }));
      return {
        copied,
        browserFind,
        searchable: document.querySelector("[aria-label='Lifecycle Visual editor']")
          ?.textContent?.includes("relay-4: deterministic-text") ?? false,
        selected: selection.toString(),
        targetText: target.textContent
      };
    })()`
  );
  assert.equal(inert.deferredCount ?? 8, 8, JSON.stringify(inert));
  assert.equal(inert.codeMirrorCount ?? 0, 0, JSON.stringify(inert));
  assert.equal(inert.searchable, true);
  assert.equal(inert.browserFind, true);
  assert.equal(inert.selected, inert.targetText);
  assert.equal(inert.copied, inert.targetText);

  await evaluate(client, {
    expression: `document.querySelectorAll(".patchmark-deferred-code-block").item(7).click()`,
    userGesture: true
  });
  await waitFor(
    client,
    "activated deferred code run block",
    `document.querySelectorAll(".cm-editor").length === 1 &&
      [...document.querySelectorAll(".cm-content")].some((node) =>
        node.textContent?.includes("long-body-"))`
  );
  await evaluate(client, {
    expression: `(() => {
      const content = [...document.querySelectorAll(".cm-content")]
        .find((node) => node.textContent?.includes("long-body-"));
      if (!content) throw new Error("Activated CodeMirror content missing.");
      content.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(content);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()`,
    userGesture: true
  });
  const editMarker = "\n// persisted deferred activation edit";
  await client.call("Input.insertText", { text: editMarker });
  const edited = await waitFor(
    client,
    "deferred code edit authority",
    `(() => {
      const authority = document.querySelector("[data-testid='lifecycle-source-authority']");
      const source = authority?.querySelector("textarea")?.value ?? "";
      return source.includes(${JSON.stringify(editMarker.trim())})
        ? { changeCount: Number(authority.dataset.changeCount), source }
        : null;
    })()`
  );
  assert.equal((edited.source.match(/```/g) ?? []).length, 16);
  assert.match(edited.source, /```ts/);
  assert.match(edited.source, /```yaml title=relay-three/);
  assert.ok(edited.changeCount >= 1);

  await loadCorpusCase(client, "deferred-code-run-reopen", edited.source);
  await waitForCorpusState(client, "deferred-code-run-reopen", "ready");
  const reopened = await waitFor(
    client,
    "reopened deferred code run",
    `(() => {
      const authority = document.querySelector("[data-testid='lifecycle-source-authority']");
      const source = authority?.querySelector("textarea")?.value ?? "";
      const blocks = [...document.querySelectorAll(".patchmark-deferred-code-block")];
      return blocks.length === 8 && source.includes(${JSON.stringify(editMarker.trim())})
        ? { changeCount: Number(authority.dataset.changeCount), source }
        : null;
    })()`
  );
  assert.equal(reopened.source, edited.source);
  assert.equal(reopened.changeCount, 0);

  const collisionMarkdown =
    "# Literal internal-language fence\n\n```patchmark-internal-code-run-v1\nuser-authored-token\n```\n";
  await loadCorpusCase(client, "deferred-code-collision", collisionMarkdown);
  await waitForCorpusState(client, "deferred-code-collision", "ready");
  await delay(100);
  const collision = await readCorpusState(client);
  assert.equal(collision.source, collisionMarkdown);
  assert.equal(collision.changeCount, 0);
  assert.equal(
    await evaluate(client, {
      expression: `document.querySelector(".patchmark-deferred-code-block")?.textContent`
    }),
    "user-authored-token"
  );

  const shortRunMarkdown = `# Short run\n\n${codeBlocks.slice(0, 7).join("\n\n")}\n`;
  await loadCorpusCase(client, "deferred-code-short-run", shortRunMarkdown);
  await waitForCorpusState(client, "deferred-code-short-run", "ready");
  await delay(100);
  const shortRun = await readCorpusState(client);
  assert.equal(shortRun.source, shortRunMarkdown);
  assert.equal(shortRun.changeCount, 0);

  return {
    activated_widget_count: 1,
    block_count: 8,
    collision_safe: true,
    copy_and_selection_preserved: true,
    edit_persisted_after_reopen: true,
    languages: ["json", "ts", "yaml", "text"],
    short_run_unchanged: true
  };
}

async function loadCorpusCase(client, id, markdown) {
  await evaluate(client, {
    expression: `(() => {
      window.dispatchEvent(new CustomEvent("patchmark:load-mdx-corpus-case", {
        detail: ${JSON.stringify({ id, markdown })}
      }));
      return true;
    })()`
  });
}

async function waitForCorpusState(client, id, expectedVisualState) {
  try {
    return await waitFor(
      client,
      `${id} ${expectedVisualState} state`,
      `(() => {
        const authority = document.querySelector("[data-testid='lifecycle-source-authority']");
        if (authority?.dataset.corpusCaseId !== ${JSON.stringify(id)}) return null;
        const editor = Boolean(document.querySelector("[aria-label='Lifecycle Visual editor']"));
        const fallback = document.querySelector(".visual-editor-fallback textarea");
        const ready = ${JSON.stringify(expectedVisualState)} === "fallback" ? Boolean(fallback) : editor && !fallback;
        return ready ? {
          editor,
          fallback: Boolean(fallback),
          fallbackSource: fallback?.value ?? null
        } : null;
      })()`
    );
  } catch (error) {
    const diagnostic = await evaluate(client, {
      expression: `(() => ({
        body: document.body.innerText.slice(0, 1200),
        caseId: document.querySelector("[data-testid='lifecycle-source-authority']")?.dataset.corpusCaseId ?? null,
        editor: Boolean(document.querySelector("[aria-label='Lifecycle Visual editor']")),
        fallback: Boolean(document.querySelector(".visual-editor-fallback textarea")),
        visualError: document.querySelector(".visual-editor-error")?.textContent ?? null
      }))()`
    });
    throw new Error(`${error.message}\nDiagnostic: ${JSON.stringify(diagnostic, null, 2)}`);
  }
}

async function readCorpusState(client) {
  return await evaluate(client, {
    expression: `(() => {
      const authority = document.querySelector("[data-testid='lifecycle-source-authority']");
      return {
        caseId: authority?.dataset.corpusCaseId ?? null,
        changeCount: Number(authority?.dataset.changeCount ?? 0),
        executionMarkerPresent: Object.hasOwn(globalThis, "__patchmarkYamlExecuted"),
        prototypeCompromised: Object.prototype.compromised === true,
        prototypePolluted: Object.prototype.polluted === true,
        source: authority?.querySelector("textarea")?.value ?? null
      };
    })()`
  });
}

async function waitFor(client, label, expression) {
  let latest = null;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    latest = await evaluate(client, { expression });
    if (latest) return latest;
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${label}.\n${JSON.stringify(latest, null, 2)}`
  );
}

function expandMarkdownCase(testCase) {
  if (typeof testCase.markdown === "string") return testCase.markdown;
  const descriptor = testCase.descriptor;
  if (descriptor.encoding !== "repeated_markdown_sections") {
    throw new Error(`Unsupported test-only descriptor: ${descriptor.encoding}`);
  }
  return Array.from({ length: descriptor.count }, (_, index) =>
    descriptor.template.replaceAll("{{index}}", String(index + 1))
  ).join("");
}
