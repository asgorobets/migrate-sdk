import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  description:
    "Run long migrations as durable Vercel Workflows and monitor their progress from any connected client",
  title: "Migrate SDK · Workflow demo",
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
