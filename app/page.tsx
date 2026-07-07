import { DocumentEditor } from "@/components/document-editor";

export default function Home() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Patchmark</h1>
          <p>Markdown-first document editor with reviewable AI patches.</p>
        </div>
      </header>

      <DocumentEditor />
    </main>
  );
}
