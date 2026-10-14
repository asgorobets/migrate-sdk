import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Migrate SDK — Data migrations, defined in TypeScript",
  description:
    "Build repeatable data migrations between APIs, databases, files, and CMSes. Define your logic in TypeScript, save progress, and retry what failed.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={geistMono.variable}>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
