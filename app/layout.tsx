import type { Metadata } from "next";
import "@mdxeditor/editor/style.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Patchmark",
  description: "Markdown-first document editor with Visual Mode and Markdown Mode."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
