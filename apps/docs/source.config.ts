import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { transformerTwoslash } from "fumadocs-twoslash";
import { compactTypeHovers } from "./lib/compact-type-hovers";
import { remarkTwoslash } from "./lib/remark-twoslash";

const root = process.cwd();

export const docs = defineDocs({ dir: "content/docs" });

export default defineConfig({
  mdxOptions: {
    // Avoid per-token JSX debug frames repeatedly caching large source maps.
    development: false,
    remarkPlugins: [[remarkTwoslash, { root }]],
    rehypeCodeOptions: {
      themes: { light: "github-light", dark: "github-dark" },
      langs: ["js", "jsx", "ts", "tsx"],
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        transformerTwoslash({
          rendererRich: { jsdoc: false },
          twoslashOptions: {
            cwd: root,
            compilerOptions: {
              strict: true,
              noEmit: true,
              allowImportingTsExtensions: true,
              customConditions: ["source"],
              types: ["node"],
            },
          },
        }),
        compactTypeHovers,
      ],
    },
  },
});
