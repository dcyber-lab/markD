import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hasModKey } from "../../platform";
import type { MarkdPlugin } from "../api";

// Headings, emphasis, inline code, links, blockquotes and horizontal rules.

const INLINE_CLASSES: Record<string, string> = {
  StrongEmphasis: "cm-lp-strong",
  Emphasis: "cm-lp-em",
  Strikethrough: "cm-lp-strike",
  InlineCode: "cm-lp-code",
  Link: "cm-lp-link",
};

const HEADINGS = [1, 2, 3, 4, 5, 6].map((n) => `ATXHeading${n}`);

function linkTarget(state: EditorState, pos: number): string | null {
  let node = syntaxTree(state).resolveInner(pos, 1);
  for (;;) {
    if (node.name === "URL") return state.sliceDoc(node.from, node.to);
    if (node.name === "Link" || node.name === "Autolink") {
      const url = node.getChild("URL");
      return url ? state.sliceDoc(url.from, url.to) : null;
    }
    if (!node.parent) return null;
    node = node.parent;
  }
}

/** ⌘/Ctrl + click on a link opens it in the system browser. */
const openLinkOnModClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!hasModKey(event)) return false;
    const pos = view.posAtCoords(event);
    const url = pos == null ? null : linkTarget(view.state, pos);
    if (!url || !/^(https?|mailto):/i.test(url)) return false;
    event.preventDefault();
    void openUrl(url);
    return true;
  },
});

const theme = EditorView.baseTheme({
  ".cm-line.cm-lp-h1": { fontSize: "1.8em", paddingTop: "0.3em" },
  ".cm-line.cm-lp-h2": { fontSize: "1.45em", paddingTop: "0.25em" },
  ".cm-line.cm-lp-h3": { fontSize: "1.2em", paddingTop: "0.2em" },
  ".cm-line.cm-lp-h4": { fontSize: "1.05em" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through" },
  ".cm-lp-link": { color: "var(--link)" },
  ".cm-lp-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    color: "var(--code)",
    background: "var(--code-bg)",
    borderRadius: "4px",
    padding: "1px 4px",
  },
  ".cm-line.cm-lp-quote": {
    marginLeft: "32px",
    paddingLeft: "16px",
    borderLeft: "3px solid var(--border)",
    color: "var(--muted)",
  },
  ".cm-line.cm-lp-hr": {
    background: "linear-gradient(var(--border), var(--border)) no-repeat center / calc(100% - 64px) 1px",
  },
});

export const basics: MarkdPlugin = {
  id: "markd.basics",
  name: "Basic formatting",

  activate(app) {
    app.editor.addExtension([theme, openLinkOnModClick]);

    for (const [name, cls] of Object.entries(INLINE_CLASSES)) {
      app.render.node(name, (node, ctx) => ctx.mark(node.from, node.to, cls));
    }

    app.render.node(HEADINGS, (node, ctx) => ctx.lineClass(node.from, node.from, `cm-lp-h${node.name.slice(-1)}`));

    app.render.node("HeaderMark", (node, ctx) => {
      if (ctx.isActive(node.from, node.to)) return;
      // Hide a leading `## ` with its trailing space, or an optional closing ` ##` with its leading space.
      const { state } = ctx;
      const line = state.doc.lineAt(node.from);
      if (node.to < line.to && state.sliceDoc(node.to, node.to + 1) === " ") {
        ctx.hide(node.from, node.to + 1);
      } else {
        const spaced = node.from > line.from && state.sliceDoc(node.from - 1, node.from) === " ";
        ctx.hide(spaced ? node.from - 1 : node.from, node.to);
      }
    });

    app.render.node(["EmphasisMark", "StrikethroughMark"], (node, ctx) => {
      if (!ctx.isActive(node.from, node.to)) ctx.hide(node.from, node.to);
    });

    app.render.node("CodeMark", (node, ctx) => {
      // Only inline code; fenced code blocks belong to the code block plugin.
      if (node.node.parent?.name === "InlineCode" && !ctx.isActive(node.from, node.to)) {
        ctx.hide(node.from, node.to);
      }
    });

    app.render.node("Link", (node, ctx) => {
      if (ctx.isActive(node.from, node.to)) return;
      // [text](url "title") or [text][ref]: keep only the text.
      const marks = node.node.getChildren("LinkMark");
      if (marks.length >= 2) {
        ctx.hide(node.from, marks[0].to);
        ctx.hide(marks[1].from, node.to);
      }
    });

    app.render.node("Autolink", (node, ctx) => {
      if (ctx.isActive(node.from, node.to)) return;
      for (const mark of node.node.getChildren("LinkMark")) ctx.hide(mark.from, mark.to);
    });

    app.render.node("Blockquote", (node, ctx) => ctx.lineClass(node.from, node.to, "cm-lp-quote"));

    app.render.node("QuoteMark", (node, ctx) => {
      if (ctx.isActive(node.from, node.to)) return;
      const end = ctx.state.sliceDoc(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
      ctx.hide(node.from, end);
    });

    app.render.node("HorizontalRule", (node, ctx) => {
      if (ctx.isActive(node.from, node.to)) return;
      ctx.lineClass(node.from, node.from, "cm-lp-hr");
      ctx.hide(node.from, node.to);
    });
  },
};
