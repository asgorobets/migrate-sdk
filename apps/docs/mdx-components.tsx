import { Popup, PopupContent, PopupTrigger } from "fumadocs-twoslash/ui";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    File,
    Files,
    Folder,
    Popup,
    PopupContent,
    PopupTrigger,
    ...components,
  };
}

export const useMDXComponents = getMDXComponents;
