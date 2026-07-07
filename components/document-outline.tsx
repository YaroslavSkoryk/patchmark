import type { MarkdownHeading } from "@/lib/markdown/parse-headings";

type DocumentOutlineProps = {
  headings: MarkdownHeading[];
};

export function DocumentOutline({ headings }: DocumentOutlineProps) {
  return (
    <aside className="outline-panel" aria-label="Document Outline">
      <h2>Document Outline</h2>

      {headings.length === 0 ? (
        <p className="outline-empty">No headings yet.</p>
      ) : (
        <ol className="outline-list">
          {headings.map((heading) => (
            <li
              className="outline-item"
              key={`${heading.line}-${heading.level}-${heading.text}`}
              style={{ paddingLeft: `${(heading.level - 1) * 14}px` }}
            >
              <div className="outline-entry">
                <span className="outline-line">L{heading.line}</span>
                <span className="outline-text">{heading.text}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
