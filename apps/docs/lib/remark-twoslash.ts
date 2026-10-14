import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Root } from "mdast";
import ts from "typescript";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

const sourcePattern = /\bsource="([^"]+)"/;
const twoslashPattern = /\btwoslash\b/;
const resolutionOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
};

interface MdxCompiler {
  addDependency(path: string): void;
}

// Include real local dependencies as hidden virtual files, so imported values
// retain their inferred types without adding declarations to the visible sample.
export const remarkTwoslash: Plugin<[{ root: string }], Root> =
  ({ root }) =>
  (tree, file) => {
    const compiler = file.data._compiler as MdxCompiler | undefined;
    visit(tree, "code", (node) => {
      const source = sourcePattern.exec(node.meta ?? "")?.[1];
      if (!(source && twoslashPattern.test(node.meta ?? ""))) {
        return;
      }

      const entry = resolve(dirname(file.path), source);
      const files = new Map<string, string>();
      const collect = (path: string, code: string) => {
        if (files.has(path)) {
          return;
        }
        compiler?.addDependency(path);
        files.set(path, code);
        for (const imported of ts.preProcessFile(code).importedFiles) {
          if (!imported.fileName.startsWith(".")) {
            continue;
          }
          const dependency = ts.resolveModuleName(
            imported.fileName,
            path,
            resolutionOptions,
            ts.sys
          ).resolvedModule?.resolvedFileName;
          if (dependency) {
            collect(dependency, readFileSync(dependency, "utf8"));
          }
        }
      };
      collect(entry, node.value);

      const filename = (path: string) =>
        relative(root, path).replaceAll("\\", "/");
      const dependencies = [...files]
        .filter(([path]) => path !== entry)
        .map(([path, code]) => `// @filename: ${filename(path)}\n${code}`);
      node.value = [
        ...dependencies,
        `// @filename: ${filename(entry)}`,
        "// ---cut---",
        node.value,
      ].join("\n");
    });
  };
