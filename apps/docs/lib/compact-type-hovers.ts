import type { ShikiTransformer } from "shiki";
import { visit } from "unist-util-visit";

// Keep complete inferred signatures without emitting a highlighted tree for
// every identifier's popup. The visible example keeps its syntax highlighting.
export const compactTypeHovers: ShikiTransformer = {
  name: "docs:compact-type-hovers",
  code(code) {
    visit(code, "element", (node) => {
      if (node.tagName !== "PopupContent") {
        return;
      }
      let signature = "";
      visit(node, "text", (text) => {
        signature += text.value;
      });
      node.children = [
        {
          type: "element",
          tagName: "pre",
          properties: { className: ["twoslash"] },
          children: [
            {
              type: "element",
              tagName: "code",
              properties: {},
              children: [{ type: "text", value: signature }],
            },
          ],
        },
      ];
    });
  },
};
