import type { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import type { MarkdPlugin } from "../api";

// YAML front matter at the top of a document:
//
//   ---
//   image-storage: s3
//   ---
//
// Without this, Markdown reads the first `---` as a horizontal rule and the rest as a heading.

/** Lines that can appear inside front matter: `key: value`, indented, list items, comments, blank. */
const YAML_LINE = /^([\w-]+\s*:|\s|-\s|#|$)/;

const frontMatterSyntax: MarkdownConfig = {
  defineNodes: [{ name: "FrontMatter", block: true, style: tags.meta }],
  parseBlock: [
    {
      name: "FrontMatter",
      before: "HorizontalRule",
      parse(cx, line) {
        // Only `---` on the very first line, directly followed by a `key: value` line, so a
        // document that merely starts with a horizontal rule is left alone.
        if (cx.lineStart !== 0 || line.text.trimEnd() !== "---" || !/^[\w-]+\s*:/.test(cx.peekLine())) {
          return false;
        }
        const from = cx.lineStart;
        let to = from + line.text.length;
        while (cx.nextLine()) {
          if (line.text.trimEnd() === "---") {
            to = cx.lineStart + line.text.length;
            cx.nextLine();
            break;
          }
          // Not YAML: the front matter was never closed; leave this line to the Markdown parser.
          if (!YAML_LINE.test(line.text)) break;
          to = cx.lineStart + line.text.length;
        }
        cx.addElement(cx.elt("FrontMatter", from, to));
        return true;
      },
    },
  ],
};

/** The value of a simple `key: value` entry in the document's front matter, if present. */
export function frontMatterValue(doc: Text, key: string): string | null {
  const head = doc.sliceString(0, Math.min(doc.length, 8000));
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(head);
  if (!block) return null;
  for (const line of block[1].split(/\r?\n/)) {
    const entry = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (entry?.[1] === key) return entry[2].replace(/\s+#.*$/, "").replace(/^(["'])(.*)\1$/, "$2").trim() || null;
  }
  return null;
}

const theme = EditorView.baseTheme({
  ".cm-line.cm-lp-front-matter": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.85em",
    color: "var(--muted)",
  },
});

export const frontMatter: MarkdPlugin = {
  id: "markd.front-matter",
  name: "Front matter",

  activate(app) {
    app.markdown.addSyntax(frontMatterSyntax);
    app.editor.addExtension(theme);
    app.render.node("FrontMatter", (node, ctx) => {
      ctx.lineClass(node.from, node.to, "cm-lp-front-matter");
      return false;
    });
  },
};
