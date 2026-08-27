import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  description:
    "A deployable Migrate Server using Vercel Workflow and PostgreSQL",
  title: "Migrate SDK · Workflow SDK example",
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
