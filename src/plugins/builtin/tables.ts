import { EditorView } from "@codemirror/view";
import type { MarkdPlugin } from "../api";

// Tables use a monospace font so columns line up, until they get a real table widget.

const theme = EditorView.baseTheme({
  ".cm-line.cm-lp-table": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
  },
});

export const tables: MarkdPlugin = {
  id: "markd.tables",
  name: "Tables",

  activate(app) {
    app.editor.addExtension(theme);
    app.render.node("Table", (node, ctx) => ctx.lineClass(node.from, node.to, "cm-lp-table"));
  },
};
