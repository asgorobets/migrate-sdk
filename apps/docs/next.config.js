import { createMDX } from "fumadocs-mdx/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["typescript"],
  async redirects() {
    return [
      { source: "/docs/concepts", destination: "/docs/learn", permanent: true },
      {
        source: "/docs/sources-and-stores",
        destination: "/docs/learn/sources",
        permanent: true,
      },
      {
        source: "/docs/cli",
        destination: "/docs/operate/cli",
        permanent: true,
      },
    ];
  },
};

const withMDX = createMDX();
export default withMDX(nextConfig);
