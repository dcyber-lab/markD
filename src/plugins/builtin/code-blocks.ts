import { EditorView } from "@codemirror/view";
import type { MarkdPlugin } from "../api";

// Fenced code blocks get a background; the ``` fences hide unless the cursor is in the block.

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

export const codeBlocks: MarkdPlugin = {
  id: "markd.code-blocks",
  name: "Code blocks",

  activate(app) {
    app.editor.addExtension(theme);

    app.render.node("FencedCode", (node, ctx) => {
      const first = ctx.state.doc.lineAt(node.from).from;
      const last = ctx.state.doc.lineAt(node.to).from;
      ctx.lineClass(node.from, node.to, (lineFrom) =>
        lineFrom === first ? "cm-lp-fence cm-lp-fence-first"
        : lineFrom === last ? "cm-lp-fence cm-lp-fence-last"
        : "cm-lp-fence",
      );
      // With the cursor anywhere inside the block, show the fences for the whole block.
      if (!ctx.isActive(node.from, node.to)) {
        for (const mark of [...node.node.getChildren("CodeMark"), ...node.node.getChildren("CodeInfo")]) {
          ctx.hide(mark.from, mark.to);
        }
      }
      return false;
    });
  },
};
