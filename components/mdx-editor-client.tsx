"use client";

import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  ListsToggle,
  MDXEditor,
  UndoRedo,
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  quotePlugin,
  thematicBreakPlugin,
  toolbarPlugin
} from "@mdxeditor/editor";

type MdxEditorClientProps = {
  markdown: string;
  onMarkdownChange: (markdown: string) => void;
};

export function MdxEditorClient({
  markdown,
  onMarkdownChange
}: MdxEditorClientProps) {
  return (
    <MDXEditor
      className="patchmark-mdx-editor"
      contentEditableClassName="patchmark-prose"
      markdown={markdown}
      onChange={onMarkdownChange}
      plugins={[
        headingsPlugin(),
        listsPlugin(),
        quotePlugin(),
        thematicBreakPlugin(),
        linkPlugin(),
        linkDialogPlugin(),
        markdownShortcutPlugin(),
        toolbarPlugin({
          toolbarContents: () => (
            <>
              <UndoRedo />
              <BlockTypeSelect />
              <BoldItalicUnderlineToggles />
              <ListsToggle />
              <CreateLink />
            </>
          )
        })
      ]}
    />
  );
}
