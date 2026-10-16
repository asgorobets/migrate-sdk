import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { frontmatter } from "fumadocs-core/content/md/frontmatter";
import { applyMdxPreset, remarkInclude } from "fumadocs-mdx/config";
import config from "../.source/source.config.mjs";

const require = createRequire(import.meta.resolve("fumadocs-mdx/config"));
const { createProcessor } = await import(
  pathToFileURL(require.resolve("@mdx-js/mdx")).href
);
const options = await applyMdxPreset(config.mdxOptions)("bundler");
const processor = createProcessor({
  development: true,
  ...options,
  remarkPlugins: [remarkInclude, ...options.remarkPlugins],
});

async function compile(page) {
  const path = resolve("content/docs", page);
  const dependencies = new Set();
  const result = await processor.process({
    path,
    value: frontmatter(await readFile(path, "utf8")).content,
    data: {
      _compiler: {
        addDependency(dependency) {
          dependencies.add(dependency);
        },
      },
    },
  });
  return { code: String(result.value), dependencies };
}

test("Getting Started keeps type hovers without oversized generated markup", async (context) => {
  const { code } = await compile("getting-started.mdx");
  assert.ok(code.includes("PopupTrigger"), "type hovers must remain available");
  assert.ok(
    !code.includes('from "react/jsx-dev-runtime"'),
    "MDX must not emit per-token JSX debug frames"
  );
  assert.ok(
    code.includes("firstName: string"),
    "inferred signatures must remain available"
  );
  context.diagnostic(`Generated MDX: ${Buffer.byteLength(code)} bytes`);
  assert.ok(
    Buffer.byteLength(code) < 1_500_000,
    `Generated Getting Started MDX is ${Buffer.byteLength(code)} bytes`
  );
});

test("hidden example imports invalidate the compiled MDX page", async () => {
  const { dependencies } = await compile("learn/retries.mdx");
  assert.ok(dependencies.has(resolve("content/examples/recovery-retries.ts")));
  assert.ok(
    dependencies.has(resolve("content/examples/recovery-api-errors.ts")),
    "the recursively included API helper must be a compiler dependency"
  );
});
