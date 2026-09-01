import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  description:
    "Run and observe durable Migrate SDK operations through a browser client",
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
