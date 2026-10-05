import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import { headingText } from "../../markdown-headings";
import { hasModKey } from "../../platform";
import type { MarkdPlugin, PluginApp } from "../api";
import { linkDestination } from "./references";

// Headings, emphasis, highlights, sub/superscript, inline code, links, escapes and entities,
// blockquotes and horizontal rules. ⌘/Ctrl + click follows links: web links open in the browser,
// `#heading` scrolls to that heading, and relative links open Markdown files in the open folder.

const INLINE_CLASSES: Record<string, string> = {
  StrongEmphasis: "cm-lp-strong",
  Emphasis: "cm-lp-em",
  Strikethrough: "cm-lp-strike",
  Highlight: "cm-lp-highlight",
  Subscript: "cm-lp-sub",
  Superscript: "cm-lp-sup",
  InlineCode: "cm-lp-code",
  Link: "cm-lp-link",
};

const INLINE_MARKS = ["EmphasisMark", "StrikethroughMark", "HighlightMark", "SubscriptMark", "SuperscriptMark"];

const ATX_HEADINGS = [1, 2, 3, 4, 5, 6].map((n) => `ATXHeading${n}`);
const SETEXT_HEADINGS = ["SetextHeading1", "SetextHeading2"];

const PUNCTUATION = /[\p{P}\p{S}]/u;

/** Opening and closing `==` must share one delimiter type object for the parser to pair them. */
const HIGHLIGHT_DELIMITER = { resolve: "Highlight", mark: "HighlightMark" };

/** `==highlighted==`, delimited like GFM strikethrough. */
const highlightSyntax: MarkdownConfig = {
  defineNodes: [{ name: "Highlight" }, { name: "HighlightMark", style: tags.processingInstruction }],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /^\s?$/.test(before);
        const spaceAfter = /^\s?$/.test(after);
        const punctBefore = PUNCTUATION.test(before);
        const punctAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          HIGHLIGHT_DELIMITER,
          pos,
          pos + 2,
          !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
          !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
        );
      },
      after: "Emphasis",
    },
  ],
};

/** Plain text replacing a range, e.g. the character an entity stands for. */
class TextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: TextWidget) {
    return other.text === this.text;
  }

  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.text;
    return span;
  }
}

let entityDecoder: HTMLTextAreaElement | null = null;

/** The text an entity such as `&amp;` or `&#x2192;` stands for, or null if it is not one. */
function decodeEntity(entity: string): string | null {
  const numeric = /^&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));$/i.exec(entity);
  if (numeric) {
    const code = numeric[1] ? parseInt(numeric[1], 16) : parseInt(numeric[2], 10);
    return String.fromCodePoint(code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code);
  }
  if (!/^&[a-z][a-z0-9]{1,31};$/i.test(entity)) return null;
  // A textarea's content is only text, so this decodes named entities without creating elements.
  entityDecoder ??= document.createElement("textarea");
  entityDecoder.innerHTML = entity;
  const text = entityDecoder.value;
  return text === entity ? null : text;
}

/** GitHub-style anchor: lowercase, punctuation dropped, spaces to hyphens. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Position of the heading `#anchor` points to; repeated headings get `-1`, `-2`, ... as on GitHub. */
function findHeading(state: EditorState, anchor: string): number | null {
  const seen = new Map<string, number>();
  let found: number | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (found !== null) return false;
      if (!node.name.startsWith("ATXHeading") && !node.name.startsWith("SetextHeading")) return;
      const base = slug(headingText(state, node.from, node.to));
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      if ((count === 0 ? base : `${base}-${count}`) === anchor) found = node.from;
      return false;
    },
  });
  return found;
}

function linkTarget(state: EditorState, pos: number): string | null {
  let node = syntaxTree(state).resolveInner(pos, 1);
  for (;;) {
    if (node.name === "URL") return state.sliceDoc(node.from, node.to);
    if (node.name === "Link") return linkDestination(state, node);
    if (node.name === "Autolink") {
      const url = node.getChild("URL");
      return url ? state.sliceDoc(url.from, url.to) : null;
    }
    if (!node.parent) return null;
    node = node.parent;
  }
}

const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd|mdx|txt)$/i;

function scrollToHeading(app: PluginApp, anchor: string) {
  const view = app.editor.view;
  const pos = findHeading(view.state, anchor);
  if (pos === null) {
    app.workspace.setStatus(`No heading #${anchor} in this document`, "error");
    return;
  }
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 48 }) });
  view.focus();
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function followLink(app: PluginApp, url: string) {
  // GFM turns a bare `www.example.com` into a link without a scheme.
  if (/^www\./i.test(url)) url = `https://${url}`;
  if (/^(https?|mailto):/i.test(url)) {
    void openUrl(url);
    return;
  }
  if (url.startsWith("#")) {
    scrollToHeading(app, decode(url.slice(1)));
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    app.workspace.setStatus(`markd does not open ${url.split(":")[0]}: links`, "error");
    return;
  }
  const hash = url.indexOf("#");
  const path = decode(hash >= 0 ? url.slice(0, hash) : url);
  const anchor = hash >= 0 ? decode(url.slice(hash + 1)) : "";
  const doc = app.workspace.doc;
  if (!doc) {
    app.workspace.setStatus("Save the document first to follow relative links", "error");
    return;
  }
  if (!MARKDOWN_FILE.test(path)) {
    app.workspace.setStatus(`Only Markdown files open in markd: ${path}`, "error");
    return;
  }
  const target = path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) ? path : `${doc.dir}/${path}`;
  app.workspace.run(async () => {
    try {
      await app.workspace.open(target);
    } catch (e) {
      throw new Error(`Cannot open ${path}: ${e}`);
    }
    if (anchor) scrollToHeading(app, anchor);
  });
}

/** ⌘/Ctrl + click follows a link. */
const followLinkOnModClick = (app: PluginApp) =>
  EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!hasModKey(event)) return false;
      const pos = view.posAtCoords(event);
      const url = pos == null ? null : linkTarget(view.state, pos);
      if (!url) return false;
      event.preventDefault();
      followLink(app, url);
      return true;
    },
  });

const theme = EditorView.baseTheme({
  ".cm-line.cm-lp-h1": { fontSize: "1.8em", paddingTop: "0.3em" },
  ".cm-line.cm-lp-h2": { fontSize: "1.45em", paddingTop: "0.25em" },
  ".cm-line.cm-lp-h3": { fontSize: "1.2em", paddingTop: "0.2em" },
  ".cm-line.cm-lp-h4": { fontSize: "1.05em" },
  ".cm-line.cm-lp-h5": { fontSize: "0.92em" },
  ".cm-line.cm-lp-h6": { fontSize: "0.85em", color: "var(--muted)" },
  // The underline of a setext heading, collapsed while the heading renders.
  ".cm-line.cm-lp-setext-mark": { height: "0", overflow: "hidden" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through" },
  ".cm-lp-highlight": { background: "var(--highlight)", borderRadius: "2px", padding: "0 1px" },
  ".cm-lp-sub": { verticalAlign: "sub", fontSize: "0.75em" },
  ".cm-lp-sup": { verticalAlign: "super", fontSize: "0.75em" },
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
  // Nested quotes draw one more bar per level inside the padding.
  ".cm-line.cm-lp-quote.cm-lp-quote-2": {
    paddingLeft: "35px",
    background: "linear-gradient(var(--border), var(--border)) no-repeat 16px 0 / 3px 100%",
  },
  ".cm-line.cm-lp-quote.cm-lp-quote-3": {
    paddingLeft: "54px",
    background:
      "linear-gradient(var(--border), var(--border)) no-repeat 16px 0 / 3px 100%, " +
      "linear-gradient(var(--border), var(--border)) no-repeat 35px 0 / 3px 100%",
  },
  ".cm-line.cm-lp-hr": {
    background: "linear-gradient(var(--border), var(--border)) no-repeat center / calc(100% - 64px) 1px",
  },
});

export const basics: MarkdPlugin = {
  id: "markd.basics",
  name: "Basic formatting",

  activate(app) {
    app.markdown.addSyntax(highlightSyntax);
    app.editor.addExtension([theme, followLinkOnModClick(app)]);

    for (const [name, cls] of Object.entries(INLINE_CLASSES)) {
      if (name === "Link") continue;
      app.render.node(name, (node, ctx) => ctx.mark(node.from, node.to, cls));
    }

    app.render.node(ATX_HEADINGS, (node, ctx) => ctx.lineClass(node.from, node.from, `cm-lp-h${node.name.slice(-1)}`));

    app.render.node(SETEXT_HEADINGS, (node, ctx) => {
      const cls = `cm-lp-h${node.name.slice(-1)}`;
      const mark = node.node.getChild("HeaderMark");
      if (!mark) return;
      // The text may span several lines; the last line is the `===` / `---` underline.
      const underline = ctx.state.doc.lineAt(mark.from);
      ctx.lineClass(node.from, underline.from - 1, cls);
      if (!ctx.isActive(node.from, node.to)) {
        ctx.lineClass(underline.from, underline.from, "cm-lp-setext-mark");
        ctx.hide(underline.from, underline.to);
      }
    });

    app.render.node("HeaderMark", (node, ctx) => {
      if (node.node.parent?.name.startsWith("SetextHeading")) return;
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

    app.render.node(INLINE_MARKS, (node, ctx) => {
      if (!ctx.isActive(node.from, node.to)) ctx.hide(node.from, node.to);
    });

    app.render.node("CodeMark", (node, ctx) => {
      // Only inline code; fenced code blocks belong to the code block plugin.
      if (node.node.parent?.name === "InlineCode" && !ctx.isActive(node.from, node.to)) {
        ctx.hide(node.from, node.to);
      }
    });

    // `\*` shows as `*`, and the backslash of a backslash hard break is hidden.
    app.render.node("Escape", (node, ctx) => {
      if (!ctx.isActive(node.from, node.to)) ctx.hide(node.from, node.from + 1);
    });

    app.render.node("HardBreak", (node, ctx) => {
      if (ctx.state.sliceDoc(node.from, node.from + 1) === "\\" && !ctx.isActive(node.from, node.from + 1)) {
        ctx.hide(node.from, node.from + 1);
      }
    });

    app.render.node("Entity", (node, ctx) => {
      if (ctx.isActive(node.from, node.to)) return;
      const text = decodeEntity(ctx.state.sliceDoc(node.from, node.to));
      if (text) ctx.replace(node.from, node.to, new TextWidget(text));
    });

    app.render.node("Link", (node, ctx) => {
      // A reference to an undefined label is plain text in CommonMark, e.g. `[x]` or `[!NOTE]`.
      if (linkDestination(ctx.state, node.node) === null) return;
      ctx.mark(node.from, node.to, INLINE_CLASSES.Link);
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

    app.render.node("Blockquote", (node, ctx) => {
      let depth = 1;
      for (let parent = node.node.parent; parent; parent = parent.parent) if (parent.name === "Blockquote") depth++;
      ctx.lineClass(node.from, node.to, depth === 1 ? "cm-lp-quote" : `cm-lp-quote-${Math.min(depth, 3)}`);
    });

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
