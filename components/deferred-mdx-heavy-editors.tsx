"use client";

import {
  CodeMirrorEditor,
  TableNode,
  type CodeBlockEditorDescriptor,
  type CodeBlockEditorProps
} from "@mdxeditor/editor";
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
  incrementDocumentSwitchPerformanceCounter
} from "@/lib/performance/document-switch-performance";

const HEAVY_EDITOR_VIEWPORT_MARGIN = 600;
const DeferredHeavyEditorContext = createContext(false);

type PatchableTableNodePrototype = typeof TableNode.prototype & {
  __patchmarkOriginalDecorate?: TableNode["decorate"];
};

const tableNodePrototype = TableNode.prototype as PatchableTableNodePrototype;

if (!tableNodePrototype.__patchmarkOriginalDecorate) {
  const originalDecorate = tableNodePrototype.decorate;
  tableNodePrototype.__patchmarkOriginalDecorate = originalDecorate;
  tableNodePrototype.decorate = function decorateDeferredTable(
    parentEditor,
    config
  ) {
    return createElement(DeferredTableEditor, {
      editor: originalDecorate.call(this, parentEditor, config),
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
  const [active, setActive] = useState(!shouldDefer);
  const containerRef = useRef<HTMLDivElement>(null);
  const focusAfterActivationRef = useRef(false);
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
    focusEmitter.publish();
  }, [active, focusEmitter]);

  if (active) {
    return <CodeMirrorEditor {...props} />;
  }

  return (
    <div
      ref={containerRef}
      aria-label={`Code block${props.language ? `, ${props.language}` : ""}. Activate to edit.`}
      className="patchmark-deferred-code-block"
      contentEditable={false}
      data-mdx-deferred-code-block="true"
      onClick={() => activate(true)}
      onKeyDown={(event) => activateFromKeyboard(event, () => activate(true))}
      role="button"
      tabIndex={0}
    >
      <span className="patchmark-deferred-code-language">
        {props.language || "Plain text"}
      </span>
      <pre>
        <code>{props.code}</code>
      </pre>
    </div>
  );
}

function DeferredTableEditor({
  editor,
  tableNode
}: {
  editor: ReactNode;
  tableNode: TableNode;
}) {
  const shouldDefer = useContext(DeferredHeavyEditorContext);
  const [active, setActive] = useState(!shouldDefer);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingCellRef = useRef<[number, number] | null>(null);
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
    tableNode.select(pendingCell);
  }, [active, tableNode]);

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
    if (isNearViewport(bounds)) {
      activate();
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          if (hasSelectionWithin(element)) {
            return;
          }
          observer.disconnect();
          activate();
        }
      },
      { rootMargin: `${HEAVY_EDITOR_VIEWPORT_MARGIN}px 0px` }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    active,
    activate,
    containerRef,
    counterName,
    operationIdRef,
    shouldDefer
  ]);
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

function getTableCellCoordinates(target: EventTarget): [number, number] {
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
