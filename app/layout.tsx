import type { Metadata, Viewport } from "next";
import "@mdxeditor/editor/style.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Patchmark",
  description: "Markdown-first document editor with Visual Mode and Markdown Mode."
};

export const viewport: Viewport = {
  initialScale: 1,
  viewportFit: "cover",
  width: "device-width"
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
