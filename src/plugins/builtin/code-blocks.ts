import { EditorView } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import type { MarkdPlugin, RenderContext } from "../api";

// Code blocks get a background. The ``` fences of a fenced block, and the four-space indent of an
// indented one, hide unless the cursor is in the block.

const theme = EditorView.baseTheme({
  // Inset 16px on each side for the background while the text stays aligned with body text.
  ".cm-line.cm-lp-fence": {
    margin: "0 16px",
    padding: "0 16px",
    background: "var(--code-bg)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
  },
  ".cm-line.cm-lp-fence-first": {
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px",
  },
  ".cm-line.cm-lp-fence-last": {
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px",
  },
});

function blockLines(node: SyntaxNodeRef, ctx: RenderContext) {
  const first = ctx.state.doc.lineAt(node.from).from;
  const last = ctx.state.doc.lineAt(node.to).from;
  ctx.lineClass(node.from, node.to, (lineFrom) =>
    first === last ? "cm-lp-fence cm-lp-fence-first cm-lp-fence-last"
    : lineFrom === first ? "cm-lp-fence cm-lp-fence-first"
    : lineFrom === last ? "cm-lp-fence cm-lp-fence-last"
    : "cm-lp-fence",
  );
}

export const codeBlocks: MarkdPlugin = {
  id: "markd.code-blocks",
  name: "Code blocks",

  activate(app) {
    app.editor.addExtension(theme);

    app.render.node("FencedCode", (node, ctx) => {
      blockLines(node, ctx);
      // With the cursor anywhere inside the block, show the fences for the whole block.
      if (!ctx.isActive(node.from, node.to)) {
        for (const mark of [...node.node.getChildren("CodeMark"), ...node.node.getChildren("CodeInfo")]) {
          ctx.hide(mark.from, mark.to);
        }
      }
      return false;
    });

    app.render.node("CodeBlock", (node, ctx) => {
      blockLines(node, ctx);
      // In a list the indent also carries the list's own, so only top-level blocks drop it.
      if (node.node.parent?.name !== "Document" || ctx.isActive(node.from, node.to)) return false;
      const { doc } = ctx.state;
      for (let pos = doc.lineAt(node.from).from; pos <= node.to; ) {
        const line = doc.lineAt(pos);
        const indent = /^(?: {1,4}|\t)/.exec(line.text)?.[0].length ?? 0;
        if (indent) ctx.hide(line.from, line.from + indent);
        pos = line.to + 1;
      }
      return false;
    });
  },
};
