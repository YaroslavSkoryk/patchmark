"use client";

import {
  $createCodeBlockNode,
  CodeBlockNode,
  CodeMirrorEditor,
  TableNode,
  addExportVisitor$,
  addImportVisitor$,
  addLexicalNode$,
  realmPlugin,
  useCodeBlockEditorContext,
  type CodeBlockEditorDescriptor,
  type CodeBlockEditorProps,
  type LexicalExportVisitor,
  type MdastImportVisitor
} from "@mdxeditor/editor";
import {
  $applyNodeReplacement,
  $createTextNode,
  ElementNode,
  type EditorConfig,
  type LexicalEditor,
  type NodeKey,
  type SerializedElementNode,
  type Spread
} from "lexical";
import type { Code as MdastCode } from "mdast";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PropsWithChildren,
  type ReactNode
} from "react";
import {
  getLatestDocumentSwitchPerformanceOperationId,
  incrementDocumentSwitchPerformanceCounter,
  recordDocumentSwitchPerformanceDuration
} from "@/lib/performance/document-switch-performance";

const HEAVY_EDITOR_VIEWPORT_MARGIN = 600;
const HEAVY_EDITOR_AUTO_ACTIVATION_DELAY_MS = 1_000;
const deferredViewportActivations = new Map<Element, () => void>();
const nativeDeferredCodeBlocks = new Map<
  HTMLElement,
  {
    activate: (focus: boolean) => void;
    editor: LexicalEditor;
    nodeKey: NodeKey;
  }
>();
const nativeDeferredTables = new Map<
  HTMLElement,
  {
    activate: (cell?: [number, number]) => void;
    editor: LexicalEditor;
    nodeKey: NodeKey;
  }
>();
const nativeDeferredActivationTimeouts = new Map<HTMLElement, number>();
const activatedNativeCodeBlocks = new WeakMap<LexicalEditor, Set<NodeKey>>();
const pendingNativeCodeBlockFocus = new WeakMap<LexicalEditor, Set<NodeKey>>();
const activatedNativeTables = new WeakMap<LexicalEditor, Set<NodeKey>>();
const pendingNativeTableCells = new WeakMap<
  LexicalEditor,
  Map<NodeKey, [number, number]>
>();
const nativeDeferredCodeBlockElements = new WeakMap<
  LexicalEditor,
  Map<NodeKey, HTMLElement>
>();
const pendingNativeDeferredCodeBlockElements = new WeakMap<
  LexicalEditor,
  Map<NodeKey, HTMLElement>
>();
const pendingNativeDeferredCodeBlockHosts = new Map<
  HTMLElement,
  {
    code: string;
    codeBlockNode: CodeBlockNode;
    editor: LexicalEditor;
    language: string;
    nodeKey: NodeKey;
  }
>();
let nativeDeferredCodeBlockFlushScheduled = false;
const pendingNativeSemanticCodeBlockElements = new WeakMap<
  LexicalEditor,
  Map<NodeKey, HTMLElement>
>();
const pendingNativeSemanticCodeBlockHosts = new Map<
  HTMLElement,
  {
    editor: LexicalEditor;
    node: PatchmarkDeferredCodeBlockNode;
    nodeKey: NodeKey;
  }
>();
let nativeSemanticCodeBlockFlushScheduled = false;
let deferredViewportObserver: IntersectionObserver | null = null;
let deferredBusyObserver: MutationObserver | null = null;
let deferredReadyTimeoutId: number | null = null;
let deferredReadyTimeoutTarget: HTMLElement | null = null;
let nativeDeferredEventDocument: Document | null = null;
const DeferredHeavyEditorContext = createContext(false);
const DEFERRED_CODE_RUN_LANGUAGE = "patchmark-internal-code-run-v1";
const MINIMUM_DEFERRED_CODE_RUN = 8;
const deferredCodeRuns = new Map<
  string,
  Array<{ code: string; language: string; meta: string }>
>();
const deferredMarkdownImports = new Map<
  string,
  { markdown: string; tokens: string[] }
>();
let deferredCodeRunCounter = 0;

type SerializedPatchmarkDeferredCodeBlockNode = Spread<
  {
    code: string;
    language: string;
    meta: string;
    type: "patchmark-deferred-code-block";
    version: 1;
  },
  SerializedElementNode
>;

type DeferredCodeBlock = { code: string; language: string; meta: string };

type SerializedPatchmarkDeferredCodeRunNode = Spread<
  {
    blocks: DeferredCodeBlock[];
    type: "patchmark-deferred-code-run";
    version: 1;
  },
  SerializedElementNode
>;


class PatchmarkDeferredCodeBlockNode extends ElementNode {
  __code: string;
  __language: string;
  __meta: string;

  static getType() {
    return "patchmark-deferred-code-block";
  }

  static clone(node: PatchmarkDeferredCodeBlockNode) {
    return new PatchmarkDeferredCodeBlockNode(
      node.__code,
      node.__language,
      node.__meta,
      node.__key
    );
  }

  static importJSON(serialized: SerializedPatchmarkDeferredCodeBlockNode) {
    return new PatchmarkDeferredCodeBlockNode(
      serialized.code,
      serialized.language,
      serialized.meta
    );
  }

  constructor(code: string, language: string, meta: string, key?: NodeKey) {
    super(key);
    this.__code = code;
    this.__language = language;
    this.__meta = meta;
  }

  createDOM(_config: EditorConfig, editor: LexicalEditor): HTMLElement {
    const element = document.createElement("code");
    element.className =
      "patchmark-deferred-code-block patchmark-deferred-semantic-code-block";
    element.contentEditable = "false";
    element.dataset.languageLabel = this.__language || "Plain text";
    element.dataset.mdxDeferredCodeBlock = "true";
    element.dataset.mdxDeferredCodeRenderer = "semantic";
    element.setAttribute(
      "aria-label",
      `Code block${this.__language ? `, ${this.__language}` : ""}. Activate to edit.`
    );
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    scheduleNativeSemanticCodeBlockRegistration(element, editor, this);
    return element;
  }

  updateDOM(): false {
    return false;
  }

  exportJSON(): SerializedPatchmarkDeferredCodeBlockNode {
    return {
      ...super.exportJSON(),
      code: this.__code,
      language: this.__language,
      meta: this.__meta,
      type: "patchmark-deferred-code-block",
      version: 1
    };
  }

  getCode() {
    return this.__code;
  }

  getLanguage() {
    return this.__language;
  }

  getMeta() {
    return this.__meta;
  }

  isInline() {
    return false;
  }
}

class PatchmarkDeferredCodeRunNode extends ElementNode {
  __blocks: DeferredCodeBlock[];

  static getType() {
    return "patchmark-deferred-code-run";
  }

  static clone(node: PatchmarkDeferredCodeRunNode) {
    return new PatchmarkDeferredCodeRunNode(node.__blocks, node.__key);
  }

  static importJSON(serialized: SerializedPatchmarkDeferredCodeRunNode) {
    return new PatchmarkDeferredCodeRunNode(serialized.blocks);
  }

  constructor(blocks: readonly DeferredCodeBlock[], key?: NodeKey) {
    super(key);
    this.__blocks = blocks.map((block) => ({ ...block }));
  }

  createDOM(_config: EditorConfig, editor: LexicalEditor): HTMLElement {
    const startedAt = performance.now();
    const element = document.createElement("div");
    element.className = "patchmark-deferred-code-run";
    element.contentEditable = "false";
    for (const block of this.__blocks) {
      const blockElement = document.createElement("div");
      renderNativeDeferredCodeBlock(
        blockElement,
        block.code,
        block.language
      );
      element.append(blockElement);
    }
    scheduleNativeDeferredCodeRunRegistration(element, editor, this);
    recordDocumentSwitchPerformanceDuration(
      getLatestDocumentSwitchPerformanceOperationId(),
      "inert_code_dom_creation",
      performance.now() - startedAt
    );
    return element;
  }

  updateDOM(): false {
    return false;
  }

  exportJSON(): SerializedPatchmarkDeferredCodeRunNode {
    return {
      ...super.exportJSON(),
      blocks: this.__blocks.map((block) => ({ ...block })),
      type: "patchmark-deferred-code-run",
      version: 1
    };
  }

  getBlocks(): DeferredCodeBlock[] {
    return this.__blocks.map((block) => ({ ...block }));
  }

  isInline() {
    return false;
  }
}

function $createPatchmarkDeferredCodeBlockNode(
  code: string,
  language: string,
  meta: string
) {
  const node = $applyNodeReplacement(
    new PatchmarkDeferredCodeBlockNode(code, language, meta)
  );
  node.append($createTextNode(code));
  return node;
}

function $createPatchmarkDeferredCodeRunNode(
  blocks: readonly DeferredCodeBlock[]
) {
  return $applyNodeReplacement(new PatchmarkDeferredCodeRunNode(blocks));
}

function $isPatchmarkDeferredCodeBlockNode(
  node: unknown
): node is PatchmarkDeferredCodeBlockNode {
  return node instanceof PatchmarkDeferredCodeBlockNode;
}

function $isPatchmarkDeferredCodeRunNode(
  node: unknown
): node is PatchmarkDeferredCodeRunNode {
  return node instanceof PatchmarkDeferredCodeRunNode;
}

const deferredSemanticCodeBlockImportVisitor: MdastImportVisitor<MdastCode> = {
  priority: 200,
  testNode: "code",
  visitNode({ actions, mdastNode }) {
    const startedAt = performance.now();
    const deferredRun =
      mdastNode.lang === DEFERRED_CODE_RUN_LANGUAGE
        ? deferredCodeRuns.get(mdastNode.value)
        : undefined;
    if (deferredRun) {
      actions.addAndStepInto(
        $createPatchmarkDeferredCodeRunNode(deferredRun)
      );
      incrementDocumentSwitchPerformanceCounter(
        getLatestDocumentSwitchPerformanceOperationId(),
        "deferred_code_runs_expanded"
      );
      recordDocumentSwitchPerformanceDuration(
        getLatestDocumentSwitchPerformanceOperationId(),
        "code_block_node_creation",
        performance.now() - startedAt
      );
      return;
    }
    actions.addAndStepInto(
      $createPatchmarkDeferredCodeBlockNode(
        mdastNode.value,
        mdastNode.lang ?? "",
        mdastNode.meta ?? ""
      )
    );
    recordDocumentSwitchPerformanceDuration(
      getLatestDocumentSwitchPerformanceOperationId(),
      "code_block_node_creation",
      performance.now() - startedAt
    );
  }
};

const deferredSemanticCodeRunExportVisitor: LexicalExportVisitor<
  PatchmarkDeferredCodeRunNode,
  MdastCode
> = {
  testLexicalNode: $isPatchmarkDeferredCodeRunNode,
  visitLexicalNode({ actions, lexicalNode, mdastParent }) {
    for (const block of lexicalNode.getBlocks()) {
      actions.appendToParent(mdastParent, {
        type: "code",
        value: block.code,
        lang: block.language,
        meta: block.meta
      });
    }
  }
};

const deferredSemanticCodeBlockExportVisitor: LexicalExportVisitor<
  PatchmarkDeferredCodeBlockNode,
  MdastCode
> = {
  testLexicalNode: $isPatchmarkDeferredCodeBlockNode,
  visitLexicalNode({ actions, lexicalNode }) {
    actions.addAndStepInto(
      "code",
      {
        value: lexicalNode.getCode(),
        lang: lexicalNode.getLanguage(),
        meta: lexicalNode.getMeta()
      },
      false
    );
  }
};

export const deferredSemanticCodeBlockPlugin = realmPlugin({
  init(realm) {
    realm.pub(addExportVisitor$, deferredSemanticCodeBlockExportVisitor);
    realm.pub(addExportVisitor$, deferredSemanticCodeRunExportVisitor);
    realm.pub(addImportVisitor$, deferredSemanticCodeBlockImportVisitor);
    realm.pub(addLexicalNode$, PatchmarkDeferredCodeBlockNode);
    realm.pub(addLexicalNode$, PatchmarkDeferredCodeRunNode);
  }
});

export function prepareMarkdownForDeferredCodeImport(markdown: string): string {
  const cached = deferredMarkdownImports.get(markdown);
  if (cached) {
    deferredMarkdownImports.delete(markdown);
    deferredMarkdownImports.set(markdown, cached);
    return cached.markdown;
  }
  const lines = markdown.split("\n");
  const output: string[] = [];
  const tokens: string[] = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const firstBlock = readSimpleFencedCodeBlock(lines, lineIndex);
    if (!firstBlock) {
      output.push(lines[lineIndex]);
      lineIndex += 1;
      continue;
    }

    const blocks = [firstBlock];
    let runEnd = firstBlock.end;
    while (lines[runEnd] === "") {
      const nextBlock = readSimpleFencedCodeBlock(lines, runEnd + 1);
      if (!nextBlock) {
        break;
      }
      blocks.push(nextBlock);
      runEnd = nextBlock.end;
    }
    if (blocks.length < MINIMUM_DEFERRED_CODE_RUN) {
      output.push(...lines.slice(lineIndex, firstBlock.end));
      lineIndex = firstBlock.end;
      continue;
    }

    const token = `patchmark-code-run-${Date.now()}-${deferredCodeRunCounter += 1}`;
    deferredCodeRuns.set(
      token,
      blocks.map((block) => ({
        code: block.code,
        language: block.language,
        meta: block.meta
      }))
    );
    tokens.push(token);
    output.push(`\`\`\`${DEFERRED_CODE_RUN_LANGUAGE}`, token, "\`\`\`");
    lineIndex = runEnd;
  }
  const preparedMarkdown = output.join("\n");
  deferredMarkdownImports.set(markdown, {
    markdown: preparedMarkdown,
    tokens
  });
  while (deferredMarkdownImports.size > 4) {
    const oldestMarkdown = deferredMarkdownImports.keys().next().value as string;
    const oldest = deferredMarkdownImports.get(oldestMarkdown);
    deferredMarkdownImports.delete(oldestMarkdown);
    for (const token of oldest?.tokens ?? []) {
      deferredCodeRuns.delete(token);
    }
  }
  return preparedMarkdown;
}

function readSimpleFencedCodeBlock(
  lines: readonly string[],
  start: number
): { code: string; end: number; language: string; meta: string } | null {
  const opening = /^```([A-Za-z0-9_+.-]*)(?:[ \t]+(.*))?$/.exec(
    lines[start] ?? ""
  );
  if (!opening) {
    return null;
  }
  let closing = start + 1;
  while (closing < lines.length && !/^```[ \t]*$/.test(lines[closing])) {
    closing += 1;
  }
  if (closing >= lines.length) {
    return null;
  }
  return {
    code: lines.slice(start + 1, closing).join("\n"),
    end: closing + 1,
    language: opening[1] ?? "",
    meta: opening[2] ?? ""
  };
}

type PatchableCodeBlockNodePrototype = typeof CodeBlockNode.prototype & {
  __patchmarkOriginalCreateDOM?: CodeBlockNode["createDOM"];
  __patchmarkOriginalDecorate?: CodeBlockNode["decorate"];
};

type PatchableTableNodePrototype = typeof TableNode.prototype & {
  __patchmarkOriginalCreateDOM?: TableNode["createDOM"];
  __patchmarkOriginalDecorate?: TableNode["decorate"];
};

const tableNodePrototype = TableNode.prototype as PatchableTableNodePrototype;
const codeBlockNodePrototype =
  CodeBlockNode.prototype as PatchableCodeBlockNodePrototype;

if (!codeBlockNodePrototype.__patchmarkOriginalDecorate) {
  const originalCreateDOM = codeBlockNodePrototype.createDOM;
  const originalDecorate = codeBlockNodePrototype.decorate;
  codeBlockNodePrototype.__patchmarkOriginalCreateDOM = originalCreateDOM;
  codeBlockNodePrototype.__patchmarkOriginalDecorate = originalDecorate;
  codeBlockNodePrototype.createDOM = function createDeferredCodeBlockDOM(
    config,
    editor
  ) {
    const element = originalCreateDOM.call(this, config, editor);
    const nodeKey = this.getKey();
    element.dataset.mdxCodeBlockHost = "true";
    if (isNativeCodeBlockActivated(editor, nodeKey)) {
      element.dataset.mdxCodeBlockState = "active";
      return element;
    }

    element.dataset.mdxCodeBlockState = "pending";
    scheduleNativeDeferredCodeBlockHost(element, editor, this);
    return element;
  };
  codeBlockNodePrototype.decorate = function decorateDeferredCodeBlock(editor) {
    if (!isNativeCodeBlockActivated(editor, this.getKey())) {
      return null as unknown as ReturnType<CodeBlockNode["decorate"]>;
    }
    return originalDecorate.call(this, editor);
  };
}

if (!tableNodePrototype.__patchmarkOriginalDecorate) {
  const originalCreateDOM = tableNodePrototype.createDOM;
  const originalDecorate = tableNodePrototype.decorate;
  tableNodePrototype.__patchmarkOriginalCreateDOM = originalCreateDOM;
  tableNodePrototype.__patchmarkOriginalDecorate = originalDecorate;
  tableNodePrototype.createDOM = function createDeferredTableDOM(
    this: TableNode,
    config: EditorConfig,
    editor: LexicalEditor
  ) {
    const startedAt = performance.now();
    const element = originalCreateDOM.call(this, config, editor);
    const nodeKey = this.getKey();
    element.dataset.mdxTableHost = "true";
    if (isNativeTableActivated(editor, nodeKey)) {
      element.dataset.mdxTableState = "active";
      return element;
    }
    element.dataset.mdxTableState = "inert";
    renderNativeDeferredTable(element, this);
    registerNativeDeferredTable(element, editor, this);
    recordDocumentSwitchPerformanceDuration(
      getLatestDocumentSwitchPerformanceOperationId(),
      "table_node_dom_creation",
      performance.now() - startedAt
    );
    return element;
  } as TableNode["createDOM"];
  tableNodePrototype.decorate = function decorateDeferredTable(
    parentEditor,
    config
  ) {
    if (!isNativeTableActivated(parentEditor, this.getKey())) {
      return null as unknown as ReturnType<TableNode["decorate"]>;
    }
    return createElement(DeferredTableEditor, {
      editor: originalDecorate.call(this, parentEditor, config),
      parentEditor,
      tableNode: this
    });
  };
}

export const deferredCodeBlockEditorDescriptor: CodeBlockEditorDescriptor = {
  Editor: DeferredCodeBlockEditor,
  match: () => true,
  priority: 100
};

export function DeferredMdxHeavyEditorProvider({
  children,
  enabled = true
}: PropsWithChildren<{ enabled?: boolean }>) {
  return (
    <DeferredHeavyEditorContext.Provider value={enabled}>
      {children}
    </DeferredHeavyEditorContext.Provider>
  );
}

function DeferredCodeBlockEditor(props: CodeBlockEditorProps) {
  const shouldDefer = useContext(DeferredHeavyEditorContext);
  const { parentEditor } = useCodeBlockEditorContext();
  const nativeActivation = isNativeCodeBlockActivated(
    parentEditor,
    props.nodeKey
  );
  const [active, setActive] = useState(
    !shouldDefer || nativeActivation
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const focusAfterActivationRef = useRef(
    pendingNativeCodeBlockFocus.get(parentEditor)?.has(props.nodeKey) === true
  );
  const operationIdRef = useRef<string | null>(null);
  const focusEmitter = props.focusEmitter as typeof props.focusEmitter & {
    publish: () => void;
  };
  const activate = useCallback((focus = false) => {
    focusAfterActivationRef.current ||= focus;
    setActive((current) => {
      if (!current) {
        incrementDocumentSwitchPerformanceCounter(
          operationIdRef.current,
          "deferred_code_blocks_activated"
        );
      }
      return true;
    });
  }, []);

  useDeferredViewportActivation({
    active,
    activate,
    containerRef,
    counterName: "deferred_code_blocks",
    operationIdRef,
    shouldDefer
  });

  useEffect(() => {
    if (!active) {
      focusEmitter.subscribe(() => activate(true));
    }
  }, [activate, active, focusEmitter]);

  useEffect(() => {
    if (!active || !focusAfterActivationRef.current) {
      return;
    }
    focusAfterActivationRef.current = false;
    pendingNativeCodeBlockFocus.get(parentEditor)?.delete(props.nodeKey);
    focusEmitter.publish();
  }, [active, focusEmitter, parentEditor, props.nodeKey]);

  if (active) {
    return <CodeMirrorEditor {...props} />;
  }

  return (
    <div
      ref={containerRef}
      aria-label={`Code block${props.language ? `, ${props.language}` : ""}. Activate to edit.`}
      className="patchmark-deferred-code-block"
      contentEditable={false}
      data-language-label={props.language || "Plain text"}
      data-mdx-deferred-code-block="true"
      onClick={() => activate(true)}
      onKeyDown={(event) => activateFromKeyboard(event, () => activate(true))}
      role="button"
      tabIndex={0}
    >
      <code>{props.code}</code>
    </div>
  );
}

function DeferredTableEditor({
  editor,
  parentEditor,
  tableNode
}: {
  editor: ReactNode;
  parentEditor: LexicalEditor;
  tableNode: TableNode;
}) {
  const shouldDefer = useContext(DeferredHeavyEditorContext);
  const nativeActivation = isNativeTableActivated(
    parentEditor,
    tableNode.getKey()
  );
  const [active, setActive] = useState(!shouldDefer || nativeActivation);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingCellRef = useRef<[number, number] | null>(
    pendingNativeTableCells.get(parentEditor)?.get(tableNode.getKey()) ?? null
  );
  const operationIdRef = useRef<string | null>(null);
  const focusEmitter = (
    tableNode as TableNode & {
      focusEmitter: {
        subscribe: (callback: (cell: [number, number]) => void) => void;
      };
    }
  ).focusEmitter;
  const activate = useCallback((cell?: [number, number]) => {
    if (cell) {
      pendingCellRef.current = cell;
    }
    setActive((current) => {
      if (!current) {
        incrementDocumentSwitchPerformanceCounter(
          operationIdRef.current,
          "deferred_tables_activated"
        );
      }
      return true;
    });
  }, []);

  useDeferredViewportActivation({
    active,
    activate,
    containerRef,
    counterName: "deferred_tables",
    operationIdRef,
    shouldDefer
  });

  useEffect(() => {
    if (!active) {
      focusEmitter.subscribe((cell) => activate(cell));
    }
  }, [activate, active, focusEmitter]);

  useEffect(() => {
    if (!active || !pendingCellRef.current) {
      return;
    }
    const pendingCell = pendingCellRef.current;
    pendingCellRef.current = null;
    pendingNativeTableCells.get(parentEditor)?.delete(tableNode.getKey());
    tableNode.select(pendingCell);
  }, [active, parentEditor, tableNode]);

  if (active) {
    return editor;
  }

  const table = tableNode.getMdastNode();
  return (
    <div
      ref={containerRef}
      aria-label="Markdown table. Activate to edit."
      className="patchmark-deferred-table"
      contentEditable={false}
      data-mdx-deferred-table="true"
      onBeforeInput={(event) => {
        event.preventDefault();
        activate(getTableCellCoordinates(event.target));
      }}
      onClick={(event) => activateTableFromClick(event, activate)}
      onKeyDown={(event) => activateFromKeyboard(event, () => activate([0, 0]))}
      role="button"
      tabIndex={0}
    >
      <table>
        <tbody>
          {table.children.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.children.map((cell, colIndex) => {
                const Cell = rowIndex === 0 ? "th" : "td";
                return (
                  <Cell
                    key={colIndex}
                    contentEditable
                    data-col-index={colIndex}
                    data-row-index={rowIndex}
                    suppressContentEditableWarning
                    style={{
                      textAlign: table.align?.[colIndex] ?? "left"
                    }}
                  >
                    {renderMdastPhrasing(cell.children)}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useDeferredViewportActivation({
  active,
  activate,
  containerRef,
  counterName,
  operationIdRef,
  shouldDefer
}: {
  active: boolean;
  activate: () => void;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  counterName: "deferred_code_blocks" | "deferred_tables";
  operationIdRef: MutableRefObject<string | null>;
  shouldDefer: boolean;
}) {
  useLayoutEffect(() => {
    if (!shouldDefer || active || !containerRef.current) {
      return;
    }
    operationIdRef.current = getLatestDocumentSwitchPerformanceOperationId();
    incrementDocumentSwitchPerformanceCounter(
      operationIdRef.current,
      counterName
    );
    const element = containerRef.current;
    const bounds = element.getBoundingClientRect();
    if (!isDocumentSwitchBusy(element) && isNearViewport(bounds)) {
      activate();
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    return observeDeferredViewportElement(element, activate);
  }, [
    active,
    activate,
    containerRef,
    counterName,
    operationIdRef,
    shouldDefer
  ]);
}

function observeDeferredViewportElement(
  element: HTMLElement,
  activate: () => void
): () => void {
  if (
    process.env.NODE_ENV !== "production" &&
    new URLSearchParams(window.location.search)
      .get("patchmarkSlice7aAblate")
      ?.split(",")
      .includes("secondary_activation")
  ) {
    return () => undefined;
  }
  deferredViewportActivations.set(element, activate);
  observeDocumentSwitchReadiness();
  deferredViewportObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const targetActivation = deferredViewportActivations.get(target);
        if (
          !entry.isIntersecting ||
          !targetActivation ||
          isDocumentSwitchBusy(target) ||
          hasSelectionWithin(target)
        ) {
          continue;
        }
        deferredViewportObserver?.unobserve(target);
        deferredViewportActivations.delete(target);
        targetActivation();
      }
      disconnectDeferredObserversIfIdle();
    },
    { rootMargin: `${HEAVY_EDITOR_VIEWPORT_MARGIN}px 0px` }
  );
  deferredViewportObserver.observe(element);

  return () => {
    deferredViewportActivations.delete(element);
    deferredViewportObserver?.unobserve(element);
    disconnectDeferredObserversIfIdle();
  };
}

function observeDocumentSwitchReadiness() {
  if (
    deferredBusyObserver ||
    typeof MutationObserver === "undefined" ||
    !document.body
  ) {
    return;
  }

  deferredBusyObserver = new MutationObserver((entries) => {
    sweepDisconnectedNativeDeferredCodeBlocks();
    for (const entry of entries) {
      const editorBody = entry.target;
      if (
        !(editorBody instanceof HTMLElement) ||
        !editorBody.classList.contains("editor-body") ||
        editorBody.getAttribute("aria-busy") === "true"
      ) {
        continue;
      }
      schedulePostReadyViewportActivation(editorBody);
    }
  });
  deferredBusyObserver.observe(document.body, {
    attributeFilter: ["aria-busy"],
    attributes: true,
    childList: true,
    subtree: true
  });
}

function schedulePostReadyViewportActivation(editorBody: HTMLElement) {
  deferredReadyTimeoutTarget = editorBody;
  if (deferredReadyTimeoutId !== null) {
    return;
  }

  deferredReadyTimeoutId = window.setTimeout(() => {
    deferredReadyTimeoutId = null;
    const target = deferredReadyTimeoutTarget;
    deferredReadyTimeoutTarget = null;
    if (target && target.getAttribute("aria-busy") !== "true") {
      activateNearViewportEditors(target);
    }
  }, 120);
}

function activateNearViewportEditors(editorBody: HTMLElement) {
  for (const [candidate, activation] of deferredViewportActivations) {
    const element = candidate as HTMLElement;
    if (
      !editorBody.contains(element) ||
      hasSelectionWithin(element) ||
      !isNearViewport(element.getBoundingClientRect())
    ) {
      continue;
    }
    deferredViewportObserver?.unobserve(element);
    deferredViewportActivations.delete(element);
    activation();
  }
  disconnectDeferredObserversIfIdle();
}

function disconnectDeferredObserversIfIdle() {
  if (deferredViewportActivations.size !== 0) {
    return;
  }
  deferredViewportObserver?.disconnect();
  deferredViewportObserver = null;
  deferredBusyObserver?.disconnect();
  deferredBusyObserver = null;
  if (deferredReadyTimeoutId !== null) {
    window.clearTimeout(deferredReadyTimeoutId);
    deferredReadyTimeoutId = null;
  }
  deferredReadyTimeoutTarget = null;
}

function renderNativeDeferredCodeBlock(
  element: HTMLElement,
  code: string,
  language: string
) {
  element.className = "patchmark-deferred-code-block";
  element.contentEditable = "false";
  element.dataset.mdxDeferredCodeBlock = "true";
  element.dataset.mdxDeferredCodeRenderer = "native";
  element.setAttribute(
    "aria-label",
    `Code block${language ? `, ${language}` : ""}. Activate to edit.`
  );
  element.setAttribute("role", "button");
  element.tabIndex = 0;

  const codeElement = document.createElement("code");
  codeElement.textContent = code;
  element.dataset.languageLabel = language || "Plain text";
  element.append(codeElement);
}

function scheduleNativeDeferredCodeRunRegistration(
  element: HTMLElement,
  editor: LexicalEditor,
  runNode: PatchmarkDeferredCodeRunNode
) {
  queueMicrotask(() => {
    if (!element.isConnected) {
      return;
    }
    const blocks = runNode.getBlocks();
    const blockElements = Array.from(
      element.querySelectorAll<HTMLElement>(
        ":scope > [data-mdx-deferred-code-renderer='native']"
      )
    );
    for (const [blockIndex, blockElement] of blockElements.entries()) {
      const activate = (focus: boolean) => {
        if (!nativeDeferredCodeBlocks.has(blockElement)) {
          return;
        }
        for (const sibling of blockElements) {
          unregisterNativeDeferredCodeBlock(sibling);
        }
        try {
          editor.update(() => {
            const currentNode = runNode.getLatest();
            const replacements = blocks.map((block) =>
              $createCodeBlockNode({
                code: block.code,
                language: block.language,
                meta: block.meta
              })
            );
            const firstReplacement = replacements[0];
            if (!firstReplacement) {
              currentNode.remove();
              return;
            }
            currentNode.replace(firstReplacement);
            let previous = firstReplacement;
            for (const replacement of replacements.slice(1)) {
              previous.insertAfter(replacement);
              previous = replacement;
            }
            const activated = replacements[blockIndex];
            if (activated) {
              const activatedKey = activated.getKey();
              getNativeCodeBlockSet(activatedNativeCodeBlocks, editor).add(
                activatedKey
              );
              if (focus) {
                getNativeCodeBlockSet(
                  pendingNativeCodeBlockFocus,
                  editor
                ).add(activatedKey);
              }
            }
          });
          incrementDocumentSwitchPerformanceCounter(
            getLatestDocumentSwitchPerformanceOperationId(),
            "native_semantic_code_runs_activated"
          );
        } catch {
          incrementDocumentSwitchPerformanceCounter(
            getLatestDocumentSwitchPerformanceOperationId(),
            "native_deferred_code_block_activations_cancelled"
          );
        }
      };
      nativeDeferredCodeBlocks.set(blockElement, {
        activate,
        editor,
        nodeKey: runNode.getKey()
      });
      const scheduleViewportActivation = () => {
        scheduleNativeDeferredCodeBlockActivation(
          blockElement,
          activate,
          scheduleViewportActivation
        );
      };
      observeDeferredViewportElement(blockElement, scheduleViewportActivation);
    }
    if (blockElements.length > 0) {
      installNativeDeferredEventDelegation();
    }
    incrementDocumentSwitchPerformanceCounter(
      getLatestDocumentSwitchPerformanceOperationId(),
      "native_semantic_code_runs"
    );
    incrementDocumentSwitchPerformanceCounter(
      getLatestDocumentSwitchPerformanceOperationId(),
      "native_semantic_code_blocks",
      blockElements.length
    );
  });
}

function scheduleNativeDeferredCodeBlockHost(
  element: HTMLElement,
  editor: LexicalEditor,
  codeBlockNode: CodeBlockNode
) {
  const nodeKey = codeBlockNode.getKey();
  const editorElements = getPendingNativeCodeBlockElementMap(editor);
  const previousElement = editorElements.get(nodeKey);
  if (previousElement && previousElement !== element) {
    pendingNativeDeferredCodeBlockHosts.delete(previousElement);
    incrementDocumentSwitchPerformanceCounter(
      getLatestDocumentSwitchPerformanceOperationId(),
      "native_deferred_code_block_hosts_reconciled"
    );
  }
  editorElements.set(nodeKey, element);
  pendingNativeDeferredCodeBlockHosts.set(element, {
    code: codeBlockNode.getCode(),
    codeBlockNode,
    editor,
    language: codeBlockNode.getLanguage(),
    nodeKey
  });
  if (nativeDeferredCodeBlockFlushScheduled) {
    return;
  }
  nativeDeferredCodeBlockFlushScheduled = true;
  queueMicrotask(flushNativeDeferredCodeBlockHosts);
}

function flushNativeDeferredCodeBlockHosts() {
  nativeDeferredCodeBlockFlushScheduled = false;
  const pendingHosts = [...pendingNativeDeferredCodeBlockHosts];
  pendingNativeDeferredCodeBlockHosts.clear();
  for (const [element, pending] of pendingHosts) {
    const editorElements = pendingNativeDeferredCodeBlockElements.get(
      pending.editor
    );
    if (editorElements?.get(pending.nodeKey) !== element) {
      continue;
    }
    editorElements.delete(pending.nodeKey);
    if (isNativeCodeBlockActivated(pending.editor, pending.nodeKey)) {
      continue;
    }
    element.dataset.mdxCodeBlockState = "inert";
    renderNativeDeferredCodeBlock(
      element,
      pending.code,
      pending.language
    );
    registerNativeDeferredCodeBlock(
      element,
      pending.editor,
      pending.codeBlockNode
    );
  }
}

function registerNativeDeferredCodeBlock(
  element: HTMLElement,
  editor: LexicalEditor,
  codeBlockNode: CodeBlockNode
): (focus: boolean) => void {
  const nodeKey = codeBlockNode.getKey();
  const editorElements = getNativeCodeBlockElementMap(editor);
  const previousElement = editorElements.get(nodeKey);
  if (previousElement && previousElement !== element) {
    unregisterNativeDeferredCodeBlock(previousElement);
    incrementDocumentSwitchPerformanceCounter(
      getLatestDocumentSwitchPerformanceOperationId(),
      "native_deferred_code_block_hosts_reconciled"
    );
  }
  editorElements.set(nodeKey, element);
  const activate = (focus: boolean) => {
    if (!nativeDeferredCodeBlocks.has(element)) {
      return;
    }
    unregisterNativeDeferredCodeBlock(element);
    getNativeCodeBlockSet(activatedNativeCodeBlocks, editor).add(nodeKey);
    if (focus) {
      getNativeCodeBlockSet(pendingNativeCodeBlockFocus, editor).add(nodeKey);
    }
    element.replaceChildren();
    element.className = "";
    delete element.dataset.mdxDeferredCodeBlock;
    delete element.dataset.mdxDeferredCodeRenderer;
    element.removeAttribute("aria-label");
    element.removeAttribute("role");
    element.removeAttribute("tabindex");
    element.dataset.mdxCodeBlockState = "activating";
    incrementDocumentSwitchPerformanceCounter(
      getLatestDocumentSwitchPerformanceOperationId(),
      "native_deferred_code_blocks_activated"
    );
    try {
      editor.update(() => {
        codeBlockNode.getLatest().getWritable();
      });
    } catch {
      activatedNativeCodeBlocks.get(editor)?.delete(nodeKey);
      pendingNativeCodeBlockFocus.get(editor)?.delete(nodeKey);
      incrementDocumentSwitchPerformanceCounter(
        getLatestDocumentSwitchPerformanceOperationId(),
        "native_deferred_code_block_activations_cancelled"
      );
    }
  };

  nativeDeferredCodeBlocks.set(element, { activate, editor, nodeKey });
  codeBlockNode.__focusEmitter.subscribe(() => activate(true));
  incrementDocumentSwitchPerformanceCounter(
    getLatestDocumentSwitchPerformanceOperationId(),
    "native_deferred_code_blocks"
  );
  const scheduleViewportActivation = () => {
    scheduleNativeDeferredCodeBlockActivation(
      element,
      activate,
      scheduleViewportActivation
    );
  };
  observeDeferredViewportElement(element, scheduleViewportActivation);
  installNativeDeferredEventDelegation();
  return activate;
}

function registerNativeSemanticCodeBlock(
  element: HTMLElement,
  editor: LexicalEditor,
  semanticNode: PatchmarkDeferredCodeBlockNode
) {
  const nodeKey = semanticNode.getKey();
  const activate = (focus: boolean) => {
    if (!nativeDeferredCodeBlocks.has(element)) {
      return;
    }
    unregisterNativeDeferredCodeBlock(element);
    try {
      editor.update(() => {
        const currentNode = semanticNode.getLatest();
        const replacement = $createCodeBlockNode({
          code: currentNode.getCode(),
          language: currentNode.getLanguage(),
          meta: currentNode.getMeta()
        });
        const replacementKey = replacement.getKey();
        getNativeCodeBlockSet(activatedNativeCodeBlocks, editor).add(
          replacementKey
        );
        if (focus) {
          getNativeCodeBlockSet(pendingNativeCodeBlockFocus, editor).add(
            replacementKey
          );
        }
        currentNode.replace(replacement);
      });
      incrementDocumentSwitchPerformanceCounter(
        getLatestDocumentSwitchPerformanceOperationId(),
        "native_semantic_code_blocks_activated"
      );
    } catch {
      incrementDocumentSwitchPerformanceCounter(
        getLatestDocumentSwitchPerformanceOperationId(),
        "native_deferred_code_block_activations_cancelled"
      );
    }
  };
  nativeDeferredCodeBlocks.set(element, { activate, editor, nodeKey });
  incrementDocumentSwitchPerformanceCounter(
    getLatestDocumentSwitchPerformanceOperationId(),
    "native_semantic_code_blocks"
  );
  const scheduleViewportActivation = () => {
    scheduleNativeDeferredCodeBlockActivation(
      element,
      activate,
      scheduleViewportActivation
    );
  };
  observeDeferredViewportElement(element, scheduleViewportActivation);
  installNativeDeferredEventDelegation();
}

function scheduleNativeSemanticCodeBlockRegistration(
  element: HTMLElement,
  editor: LexicalEditor,
  node: PatchmarkDeferredCodeBlockNode
) {
  const nodeKey = node.getKey();
  const editorElements = getPendingNativeSemanticCodeBlockElementMap(editor);
  const previousElement = editorElements.get(nodeKey);
  if (previousElement && previousElement !== element) {
    pendingNativeSemanticCodeBlockHosts.delete(previousElement);
  }
  editorElements.set(nodeKey, element);
  pendingNativeSemanticCodeBlockHosts.set(element, {
    editor,
    node,
    nodeKey
  });
  if (nativeSemanticCodeBlockFlushScheduled) {
    return;
  }
  nativeSemanticCodeBlockFlushScheduled = true;
  queueMicrotask(flushNativeSemanticCodeBlockRegistrations);
}

function flushNativeSemanticCodeBlockRegistrations() {
  nativeSemanticCodeBlockFlushScheduled = false;
  const pendingHosts = [...pendingNativeSemanticCodeBlockHosts];
  pendingNativeSemanticCodeBlockHosts.clear();
  for (const [element, pending] of pendingHosts) {
    const editorElements = pendingNativeSemanticCodeBlockElements.get(
      pending.editor
    );
    if (editorElements?.get(pending.nodeKey) !== element) {
      continue;
    }
    editorElements.delete(pending.nodeKey);
    registerNativeSemanticCodeBlock(element, pending.editor, pending.node);
  }
}

function unregisterNativeDeferredCodeBlock(element: HTMLElement) {
  const registration = nativeDeferredCodeBlocks.get(element);
  const activationTimeoutId = nativeDeferredActivationTimeouts.get(element);
  if (activationTimeoutId !== undefined) {
    window.clearTimeout(activationTimeoutId);
    nativeDeferredActivationTimeouts.delete(element);
    incrementDocumentSwitchPerformanceCounter(
      getLatestDocumentSwitchPerformanceOperationId(),
      "native_deferred_code_block_activations_cancelled"
    );
  }
  nativeDeferredCodeBlocks.delete(element);
  if (registration) {
    const editorElements = nativeDeferredCodeBlockElements.get(
      registration.editor
    );
    if (editorElements?.get(registration.nodeKey) === element) {
      editorElements.delete(registration.nodeKey);
    }
  }
  deferredViewportActivations.delete(element);
  deferredViewportObserver?.unobserve(element);
  if (
    nativeDeferredCodeBlocks.size === 0 &&
    nativeDeferredTables.size === 0
  ) {
    uninstallNativeDeferredEventDelegation();
  }
  disconnectDeferredObserversIfIdle();
}

function scheduleNativeDeferredCodeBlockActivation(
  element: HTMLElement,
  activate: (focus: boolean) => void,
  reobserve: () => void
) {
  if (nativeDeferredActivationTimeouts.has(element)) {
    return;
  }
  incrementDocumentSwitchPerformanceCounter(
    getLatestDocumentSwitchPerformanceOperationId(),
    "native_deferred_code_block_activations_pending"
  );
  nativeDeferredActivationTimeouts.set(
    element,
    window.setTimeout(() => {
      nativeDeferredActivationTimeouts.delete(element);
      if (!nativeDeferredCodeBlocks.has(element)) {
        return;
      }
      if (
        !element.isConnected ||
        isDocumentSwitchBusy(element) ||
        !isNearViewport(element.getBoundingClientRect())
      ) {
        if (element.isConnected) {
          observeDeferredViewportElement(element, reobserve);
        } else {
          unregisterNativeDeferredCodeBlock(element);
        }
        return;
      }
      activate(false);
    }, HEAVY_EDITOR_AUTO_ACTIVATION_DELAY_MS)
  );
}

function renderNativeDeferredTable(element: HTMLElement, tableNode: TableNode) {
  element.className = "patchmark-deferred-table";
  element.contentEditable = "false";
  element.dataset.mdxDeferredTable = "true";
  element.dataset.mdxDeferredTableRenderer = "native";
  element.setAttribute("aria-label", "Markdown table. Activate to edit.");
  element.setAttribute("role", "button");
  element.tabIndex = 0;

  const tableElement = document.createElement("table");
  const tableBody = document.createElement("tbody");
  const table = tableNode.getMdastNode();
  table.children.forEach((row, rowIndex) => {
    const rowElement = document.createElement("tr");
    row.children.forEach((cell, colIndex) => {
      const cellElement = document.createElement(rowIndex === 0 ? "th" : "td");
      cellElement.dataset.colIndex = String(colIndex);
      cellElement.dataset.rowIndex = String(rowIndex);
      cellElement.style.textAlign = table.align?.[colIndex] ?? "left";
      appendNativeMdastPhrasing(cellElement, cell.children);
      rowElement.append(cellElement);
    });
    tableBody.append(rowElement);
  });
  tableElement.append(tableBody);
  element.append(tableElement);
}

function registerNativeDeferredTable(
  element: HTMLElement,
  editor: LexicalEditor,
  tableNode: TableNode
) {
  const nodeKey = tableNode.getKey();
  const activate = (cell: [number, number] = [0, 0]) => {
    if (!nativeDeferredTables.has(element)) {
      return;
    }
    unregisterNativeDeferredTable(element);
    getNativeCodeBlockSet(activatedNativeTables, editor).add(nodeKey);
    getPendingNativeTableCellMap(editor).set(nodeKey, cell);
    element.replaceChildren();
    element.className = "";
    delete element.dataset.mdxDeferredTable;
    delete element.dataset.mdxDeferredTableRenderer;
    element.removeAttribute("aria-label");
    element.removeAttribute("role");
    element.removeAttribute("tabindex");
    element.dataset.mdxTableState = "activating";
    incrementDocumentSwitchPerformanceCounter(
      getLatestDocumentSwitchPerformanceOperationId(),
      "native_deferred_tables_activated"
    );
    try {
      editor.update(() => {
        tableNode.getLatest().getWritable();
      });
    } catch {
      activatedNativeTables.get(editor)?.delete(nodeKey);
      pendingNativeTableCells.get(editor)?.delete(nodeKey);
      incrementDocumentSwitchPerformanceCounter(
        getLatestDocumentSwitchPerformanceOperationId(),
        "native_deferred_table_activations_cancelled"
      );
    }
  };
  nativeDeferredTables.set(element, { activate, editor, nodeKey });
  (
    tableNode as TableNode & {
      focusEmitter: {
        subscribe: (callback: (cell: [number, number]) => void) => void;
      };
    }
  ).focusEmitter.subscribe((cell) => activate(cell));
  incrementDocumentSwitchPerformanceCounter(
    getLatestDocumentSwitchPerformanceOperationId(),
    "native_deferred_tables"
  );
  observeDeferredViewportElement(element, () => activate([0, 0]));
  installNativeDeferredEventDelegation();
}

function unregisterNativeDeferredTable(element: HTMLElement) {
  nativeDeferredTables.delete(element);
  deferredViewportActivations.delete(element);
  deferredViewportObserver?.unobserve(element);
  if (
    nativeDeferredTables.size === 0 &&
    nativeDeferredCodeBlocks.size === 0
  ) {
    uninstallNativeDeferredEventDelegation();
  }
  disconnectDeferredObserversIfIdle();
}

function isNativeTableActivated(
  editor: LexicalEditor,
  nodeKey: NodeKey
): boolean {
  return activatedNativeTables.get(editor)?.has(nodeKey) === true;
}

function getPendingNativeTableCellMap(
  editor: LexicalEditor
): Map<NodeKey, [number, number]> {
  let cells = pendingNativeTableCells.get(editor);
  if (!cells) {
    cells = new Map();
    pendingNativeTableCells.set(editor, cells);
  }
  return cells;
}

function installNativeDeferredEventDelegation() {
  if (nativeDeferredEventDocument === document) {
    return;
  }
  nativeDeferredEventDocument = document;
  document.addEventListener("click", activateNativeDeferredCodeBlockFromEvent, true);
  document.addEventListener(
    "focusin",
    activateNativeDeferredCodeBlockFromEvent,
    true
  );
  document.addEventListener(
    "keydown",
    activateNativeDeferredCodeBlockFromKeyboard,
    true
  );
}

function uninstallNativeDeferredEventDelegation() {
  if (!nativeDeferredEventDocument) {
    return;
  }
  nativeDeferredEventDocument.removeEventListener(
    "click",
    activateNativeDeferredCodeBlockFromEvent,
    true
  );
  nativeDeferredEventDocument.removeEventListener(
    "focusin",
    activateNativeDeferredCodeBlockFromEvent,
    true
  );
  nativeDeferredEventDocument.removeEventListener(
    "keydown",
    activateNativeDeferredCodeBlockFromKeyboard,
    true
  );
  nativeDeferredEventDocument = null;
}

function activateNativeDeferredCodeBlockFromEvent(event: Event) {
  const target = findNativeDeferredCodeBlockTarget(event.target);
  if (target) {
    nativeDeferredCodeBlocks.get(target)?.activate(true);
    return;
  }
  const table = findNativeDeferredTableTarget(event.target);
  if (table && !hasSelectionWithin(table)) {
    nativeDeferredTables
      .get(table)
      ?.activate(getTableCellCoordinates(event.target));
  }
}

function activateNativeDeferredCodeBlockFromKeyboard(event: globalThis.KeyboardEvent) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  const target = findNativeDeferredCodeBlockTarget(event.target);
  if (target) {
    event.preventDefault();
    nativeDeferredCodeBlocks.get(target)?.activate(true);
    return;
  }
  const table = findNativeDeferredTableTarget(event.target);
  if (table) {
    event.preventDefault();
    nativeDeferredTables.get(table)?.activate([0, 0]);
  }
}

function findNativeDeferredTableTarget(
  target: EventTarget | null
): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const candidate = target.closest<HTMLElement>(
    '[data-mdx-deferred-table-renderer="native"]'
  );
  return candidate && nativeDeferredTables.has(candidate) ? candidate : null;
}

function findNativeDeferredCodeBlockTarget(
  target: EventTarget | null
): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const candidate = target.closest<HTMLElement>(
    "[data-mdx-deferred-code-renderer]"
  );
  return candidate && nativeDeferredCodeBlocks.has(candidate)
    ? candidate
    : null;
}

function sweepDisconnectedNativeDeferredCodeBlocks() {
  for (const element of nativeDeferredCodeBlocks.keys()) {
    if (!element.isConnected) {
      unregisterNativeDeferredCodeBlock(element);
    }
  }
  for (const element of nativeDeferredTables.keys()) {
    if (!element.isConnected) {
      unregisterNativeDeferredTable(element);
    }
  }
}

function isNativeCodeBlockActivated(
  editor: LexicalEditor,
  nodeKey: NodeKey
): boolean {
  return activatedNativeCodeBlocks.get(editor)?.has(nodeKey) === true;
}

function getNativeCodeBlockSet(
  registry: WeakMap<LexicalEditor, Set<NodeKey>>,
  editor: LexicalEditor
): Set<NodeKey> {
  let values = registry.get(editor);
  if (!values) {
    values = new Set();
    registry.set(editor, values);
  }
  return values;
}

function getNativeCodeBlockElementMap(
  editor: LexicalEditor
): Map<NodeKey, HTMLElement> {
  let elements = nativeDeferredCodeBlockElements.get(editor);
  if (!elements) {
    elements = new Map();
    nativeDeferredCodeBlockElements.set(editor, elements);
  }
  return elements;
}

function getPendingNativeCodeBlockElementMap(
  editor: LexicalEditor
): Map<NodeKey, HTMLElement> {
  let elements = pendingNativeDeferredCodeBlockElements.get(editor);
  if (!elements) {
    elements = new Map();
    pendingNativeDeferredCodeBlockElements.set(editor, elements);
  }
  return elements;
}

function getPendingNativeSemanticCodeBlockElementMap(
  editor: LexicalEditor
): Map<NodeKey, HTMLElement> {
  let elements = pendingNativeSemanticCodeBlockElements.get(editor);
  if (!elements) {
    elements = new Map();
    pendingNativeSemanticCodeBlockElements.set(editor, elements);
  }
  return elements;
}

function hasSelectionWithin(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  const range = selection.getRangeAt(0);
  return (
    element.contains(range.startContainer) || element.contains(range.endContainer)
  );
}

function isDocumentSwitchBusy(element: HTMLElement): boolean {
  return element.closest(".editor-body")?.getAttribute("aria-busy") === "true";
}

function isNearViewport(bounds: DOMRect): boolean {
  return (
    bounds.bottom >= -HEAVY_EDITOR_VIEWPORT_MARGIN &&
    bounds.top <= window.innerHeight + HEAVY_EDITOR_VIEWPORT_MARGIN
  );
}

function activateFromKeyboard(
  event: KeyboardEvent<HTMLElement>,
  activate: () => void
) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  activate();
}

function activateTableFromClick(
  event: MouseEvent<HTMLDivElement>,
  activate: (cell?: [number, number]) => void
) {
  if (hasSelectionWithin(event.currentTarget)) {
    return;
  }
  activate(getTableCellCoordinates(event.target));
}

function getTableCellCoordinates(target: EventTarget | null): [number, number] {
  if (!(target instanceof Element)) {
    return [0, 0];
  }
  const cell = target.closest<HTMLElement>(
    "[data-col-index][data-row-index]"
  );
  return cell
    ? [Number(cell.dataset.colIndex), Number(cell.dataset.rowIndex)]
    : [0, 0];
}

type MdastPhrasingNode = {
  alt?: string;
  children?: MdastPhrasingNode[];
  title?: string | null;
  type: string;
  url?: string;
  value?: string;
};

function appendNativeMdastPhrasing(
  parent: HTMLElement,
  nodes: readonly unknown[]
) {
  for (const value of nodes) {
    const node = value as MdastPhrasingNode;
    if (node.type === "break") {
      parent.append(document.createElement("br"));
      continue;
    }
    if (node.type === "image") {
      parent.append(node.alt ?? node.title ?? "Image");
      continue;
    }
    const tagName =
      node.type === "strong"
        ? "strong"
        : node.type === "emphasis"
          ? "em"
          : node.type === "delete"
            ? "del"
            : node.type === "inlineCode"
              ? "code"
              : "span";
    const element = document.createElement(tagName);
    if (node.type === "link") {
      element.title = node.title ?? node.url ?? "";
    }
    if (node.children) {
      appendNativeMdastPhrasing(element, node.children);
    } else {
      element.textContent = node.value ?? "";
    }
    parent.append(element);
  }
}

function renderMdastPhrasing(nodes: readonly unknown[]): ReactNode[] {
  return nodes.map((value, index) => {
    const node = value as MdastPhrasingNode;
    const children = node.children
      ? renderMdastPhrasing(node.children)
      : node.value ?? "";
    switch (node.type) {
      case "strong":
        return <strong key={index}>{children}</strong>;
      case "emphasis":
        return <em key={index}>{children}</em>;
      case "delete":
        return <del key={index}>{children}</del>;
      case "inlineCode":
        return <code key={index}>{node.value ?? ""}</code>;
      case "break":
        return <br key={index} />;
      case "image":
        return node.alt ?? node.title ?? "Image";
      case "link":
        return (
          <span key={index} title={node.title ?? node.url}>
            {children}
          </span>
        );
      default:
        return <span key={index}>{children}</span>;
    }
  });
}
