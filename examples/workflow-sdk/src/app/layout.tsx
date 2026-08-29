import type { Metadata } from "next";
import "@wterm/react/css";
import "./globals.css";

export const metadata: Metadata = {
  description:
    "Run a durable Vercel Workflow migration from the real Migrate TUI in your browser",
  title: "Migrate SDK · Browser TUI demo",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
