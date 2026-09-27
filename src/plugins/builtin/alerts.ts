import { EditorView, WidgetType } from "@codemirror/view";
import type { MarkdPlugin } from "../api";

// GitHub alerts: a blockquote starting with `> [!NOTE]` (or TIP, IMPORTANT, WARNING, CAUTION) is
// colored by type, and the marker shows as a label. Text after the marker, as Obsidian allows,
// becomes the label instead. Other types stay plain blockquotes.

const LABELS: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

class LabelWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }

  eq(other: LabelWidget) {
    return other.label === this.label;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-lp-alert-label";
    span.textContent = this.label;
    return span;
  }
}

const theme = EditorView.baseTheme({
  ".cm-line.cm-lp-quote.cm-lp-alert": {
    color: "var(--fg)",
    borderLeftColor: "var(--alert)",
    backgroundColor: "color-mix(in srgb, var(--alert) 7%, transparent)",
  },
  ".cm-lp-alert-note": { "--alert": "var(--alert-note)" },
  ".cm-lp-alert-tip": { "--alert": "var(--alert-tip)" },
  ".cm-lp-alert-important": { "--alert": "var(--alert-important)" },
  ".cm-lp-alert-warning": { "--alert": "var(--alert-warning)" },
  ".cm-lp-alert-caution": { "--alert": "var(--alert-caution)" },
  // Also over the quote color that syntax highlighting gives the text inside.
  ".cm-lp-alert-label, .cm-lp-alert-label span": { color: "var(--alert)", fontWeight: "600" },
});

export const alerts: MarkdPlugin = {
  id: "markd.alerts",
  name: "Alerts",

  activate(app) {
    app.editor.addExtension(theme);

    app.render.node("Blockquote", (node, ctx) => {
      const line = ctx.state.doc.lineAt(node.from);
      const head = ctx.state.sliceDoc(node.from, line.to);
      const match = /^>[ \t]*(\[!(\w+)\][ \t]*)(.*)$/.exec(head);
      const type = match?.[2].toLowerCase();
      if (!match || !type || !(type in LABELS)) return;
      ctx.lineClass(node.from, node.to, `cm-lp-alert cm-lp-alert-${type}`);
      if (ctx.isActive(line.from, line.to)) return;
      const markerFrom = node.from + head.indexOf("[");
      const markerTo = markerFrom + match[1].length;
      if (match[3].trim()) {
        ctx.hide(markerFrom, markerTo);
        ctx.mark(markerTo, line.to, "cm-lp-alert-label");
      } else {
        ctx.replace(markerFrom, markerTo, new LabelWidget(LABELS[type]));
      }
    });
  },
};
