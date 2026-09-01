import { resolve } from "node:path";
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const rawResourceQuery = /raw/;

const nextConfig: NextConfig = {
  outputFileTracingRoot: resolve(process.cwd(), "../.."),
  skipTrailingSlashRedirect: true,
  webpack: (config) => {
    config.module.rules.push({
      resourceQuery: rawResourceQuery,
      type: "asset/source",
    });
    return config;
  },
};

export default withWorkflow(nextConfig);
