import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHighlighter } from "shiki";
import { twoslasher } from "twoslash";
import ts from "typescript";
import { definitionSteps } from "../app/definition-steps.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const code = (
  await readFile(resolve(root, "content/authors.ts"), "utf8")
).trimEnd();
// The repository's TypeScript 6 shim keeps standard libraries in its compiler dependency.
const tsLibDirectory = dirname(
  createRequire(import.meta.resolve("typescript")).resolve("@typescript/old")
);
const typeResult = twoslasher(code, "ts", {
  vfsRoot: root,
  tsModule: ts,
  tsLibDirectory,
  compilerOptions: {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    paths: {
      "migrate-sdk": [resolve(root, "../../packages/migrate-sdk/src/index.ts")],
      "migrate-sdk/*": [
        resolve(root, "../../packages/migrate-sdk/src/*/index.ts"),
      ],
    },
  },
});
const highlighter = await createHighlighter({
  themes: ["github-light", "github-dark"],
  langs: ["typescript", "sql"],
});
const themes = { light: "github-light", dark: "github-dark" };
const tokens = highlighter
  .codeToTokens(code, { lang: "typescript", themes })
  .tokens.flat();
const sqlTokens = [];
const source = ts.createSourceFile(
  "authors.ts",
  code,
  ts.ScriptTarget.Latest,
  true
);
function highlightSql(node) {
  if (
    ts.isTaggedTemplateExpression(node) &&
    node.tag.getText(source).startsWith("sql")
  ) {
    const template = node.template;
    const chunks = ts.isNoSubstitutionTemplateLiteral(template)
      ? [template]
      : [template.head, ...template.templateSpans.map((span) => span.literal)];
    for (const chunk of chunks) {
      const start = chunk.getStart(source) + 1;
      const end =
        chunk.end -
        (chunk.kind === ts.SyntaxKind.TemplateHead ||
        chunk.kind === ts.SyntaxKind.TemplateMiddle
          ? 2
          : 1);
      const highlighted = highlighter
        .codeToTokens(code.slice(start, end), { lang: "sql", themes })
        .tokens.flat();
      sqlTokens.push(
        ...highlighted.map((token) => ({
          ...token,
          offset: token.offset + start,
        }))
      );
    }
  }
  ts.forEachChild(node, highlightSql);
}
highlightSql(source);
const hovers = typeResult.hovers.map((hover) => ({
  start: hover.start,
  end: hover.start + hover.length,
  text: hover.text,
  target: hover.target,
}));
const boundaries = new Set([0, code.length]);
for (const token of [...tokens, ...sqlTokens]) {
  boundaries.add(token.offset);
  boundaries.add(token.offset + token.content.length);
}
for (const hover of hovers) {
  boundaries.add(hover.start);
  boundaries.add(hover.end);
}
for (let offset = 0; offset < code.length; offset++) {
  if (code[offset] === "\n") {
    boundaries.add(offset);
    boundaries.add(offset + 1);
  }
}
const positions = [...boundaries].sort((a, b) => a - b);
const lines = [{ number: 1, tokens: [] }];
for (let index = 0; index < positions.length - 1; index++) {
  const start = positions[index],
    end = positions[index + 1];
  const content = code.slice(start, end);
  if (content === "\n") {
    lines.push({ number: lines.length + 1, tokens: [] });
    continue;
  }
  if (!content) {
    continue;
  }
  const color =
    sqlTokens.find(
      (token) =>
        token.offset <= start && token.offset + token.content.length >= end
    ) ??
    tokens.find(
      (token) =>
        token.offset <= start && token.offset + token.content.length >= end
    );
  const hover = hovers.find((item) => item.start <= start && item.end >= end);
  lines.at(-1).tokens.push({
    content,
    offset: start,
    light: color?.htmlStyle?.color ?? "#24292e",
    dark: color?.htmlStyle?.["--shiki-dark"] ?? "#e1e4e8",
    ...(hover ? { type: hover.text, symbol: hover.target } : {}),
  });
}
function lineAt(marker) {
  const offset = code.indexOf(marker);
  if (offset < 0) {
    throw new Error(`Missing example marker: ${marker}`);
  }
  return code.slice(0, offset).split("\n").length;
}
function range(from, until) {
  const start = lineAt(from);
  let end = until ? lineAt(until) - 1 : lines.length;
  while (end > start && !lines[end - 1].tokens.length) {
    end--;
  }
  return { start, end };
}
const steps = definitionSteps.map(
  ({ previewFrom, previewUntil, contextFrom, contextUntil, ...step }) => ({
    ...step,
    preview: range(previewFrom, previewUntil),
    context: range(contextFrom, contextUntil),
  })
);
const result = { filename: "authors.ts", code, lines, steps };
const output = resolve(root, "app/generated");
await mkdir(output, { recursive: true });
await writeFile(
  resolve(output, "migration-example.json"),
  `${JSON.stringify(result)}\n`
);
await writeFile(
  resolve(output, "migration-previews.json"),
  `${JSON.stringify(steps.map((step) => ({ ...step, lines: lines.slice(step.preview.start - 1, step.preview.end) })))}\n`
);
highlighter.dispose();
console.log(
  `Highlighted ${lines.length} lines; ${typeResult.hovers.length} inferred types; no TypeScript errors.`
);
