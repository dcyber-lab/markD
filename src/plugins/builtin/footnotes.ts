import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { tags } from "@lezer/highlight";
import type { Element, MarkdownConfig } from "@lezer/markdown";
import { hasModKey } from "../../platform";
import type { MarkdPlugin } from "../api";
import { normalizeLabel } from "./references";

// Footnotes as on GitHub: `text[^note]` references `[^note]: The footnote.` elsewhere in the
// document. References show as superscript numbers, in order of first use, and definitions get
// the same number. ⌘/Ctrl + click jumps between a reference and its definition. A reference to
// a footnote that is not defined stays as written.

const DEFINITION = /^\[\^([^\]\s]+)\]:/;

const footnoteSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "FootnoteReference" },
    { name: "FootnoteDefinition", block: true },
    { name: "FootnoteMark", style: tags.processingInstruction },
    { name: "FootnoteLabel", style: tags.labelName },
  ],
  parseInline: [
    {
      name: "FootnoteReference",
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 94 /* ^ */) return -1;
        const match = /^\[\^([^\]\s]+)\]/.exec(cx.slice(pos, cx.end));
        if (!match) return -1;
        const end = pos + match[0].length;
        return cx.addElement(
          cx.elt("FootnoteReference", pos, end, [
            cx.elt("FootnoteMark", pos, pos + 2),
            cx.elt("FootnoteLabel", pos + 2, end - 1),
            cx.elt("FootnoteMark", end - 1, end),
          ]),
        );
      },
      before: "Link",
    },
  ],
  parseBlock: [
    {
      name: "FootnoteDefinition",
      parse(cx, line) {
        if (line.indent - line.baseIndent >= 4) return false;
        const match = DEFINITION.exec(line.text.slice(line.pos));
        if (!match) return false;
        const start = cx.lineStart + line.pos;
        const labelEnd = start + 2 + match[1].length;
        const children: Element[] = [
          cx.elt("FootnoteMark", start, start + 2),
          cx.elt("FootnoteLabel", start + 2, labelEnd),
          cx.elt("FootnoteMark", labelEnd, labelEnd + 2),
        ];
        const content = line.pos + match[0].length;
        children.push(...cx.parser.parseInline(line.text.slice(content), cx.lineStart + content));
        let end = cx.lineStart + line.text.length;
        // Indented lines that follow continue the footnote; a blank line ends it.
        while (cx.nextLine() && line.next !== -1 && line.indent - line.baseIndent >= 2) {
          children.push(...line.markers);
          children.push(...cx.parser.parseInline(line.text.slice(line.pos), cx.lineStart + line.pos));
          end = cx.lineStart + line.text.length;
        }
        cx.addElement(cx.elt("FootnoteDefinition", start, end, children));
        return true;
      },
      endLeaf: (_cx, line) => line.indent - line.baseIndent < 4 && DEFINITION.test(line.text.slice(line.pos)),
      before: "LinkReference",
    },
  ],
};

interface Footnotes {
  /** Footnote numbers by normalized label, for defined footnotes that are referenced. */
  numbers: Map<string, number>;
  /** Start of each footnote's definition. */
  definitions: Map<string, number>;
  /** Start of the first reference to each footnote. */
  references: Map<string, number>;
}

const cache = new WeakMap<Tree, Footnotes>();

function labelOf(state: EditorState, node: SyntaxNode): string {
  const label = node.getChild("FootnoteLabel");
  return label ? normalizeLabel(state.sliceDoc(label.from, label.to)) : "";
}

const SKIP = new Set(["FencedCode", "CodeBlock", "InlineCode", "HTMLBlock", "Table"]);

function footnotes(state: EditorState): Footnotes {
  const tree = syntaxTree(state);
  let notes = cache.get(tree);
  if (notes) return notes;
  const definitions = new Map<string, number>();
  const refs: [string, number][] = [];
  tree.iterate({
    enter(node) {
      if (node.name === "FootnoteDefinition") {
        const label = labelOf(state, node.node);
        if (!definitions.has(label)) definitions.set(label, node.from);
      } else if (node.name === "FootnoteReference") {
        refs.push([labelOf(state, node.node), node.from]);
        return false;
      } else if (SKIP.has(node.name)) {
        return false;
      }
    },
  });
  notes = { numbers: new Map(), definitions, references: new Map() };
  for (const [label, pos] of refs) {
    if (!definitions.has(label) || notes.numbers.has(label)) continue;
    notes.numbers.set(label, notes.numbers.size + 1);
    notes.references.set(label, pos);
  }
  cache.set(tree, notes);
  return notes;
}

function jump(view: EditorView, pos: number | undefined) {
  if (pos === undefined) return;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  view.focus();
}

/**
 * A footnote number standing in for `[^label]` or `[^label]:`. A click edits the source;
 * ⌘/Ctrl + click jumps to the other end of the footnote.
 */
class FootnoteWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly label: string,
    readonly kind: "reference" | "definition",
    readonly length: number,
  ) {
    super();
  }

  eq(other: FootnoteWidget) {
    return other.text === this.text && other.label === this.label && other.kind === this.kind && other.length === this.length;
  }

  toDOM(view: EditorView) {
    const el: HTMLElement = document.createElement(this.kind === "reference" ? "sup" : "span");
    el.className = `cm-lp-footnote-${this.kind}`;
    el.textContent = this.kind === "reference" ? this.text : `${this.text}.`;
    el.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const notes = footnotes(view.state);
      if (hasModKey(event)) {
        jump(view, (this.kind === "reference" ? notes.definitions : notes.references).get(this.label));
      } else {
        view.dispatch({ selection: { anchor: view.posAtDOM(el) + this.length } });
        view.focus();
      }
    });
    return el;
  }
}

const theme = EditorView.baseTheme({
  ".cm-lp-footnote-reference": {
    color: "var(--link)",
    fontSize: "0.75em",
    lineHeight: "0",
    padding: "0 1px",
    cursor: "pointer",
  },
  ".cm-line.cm-lp-footnote": { fontSize: "0.9em", color: "var(--muted)" },
  ".cm-lp-footnote-definition": { color: "var(--link)", marginRight: "6px", cursor: "pointer" },
});

export const footnotesPlugin: MarkdPlugin = {
  id: "markd.footnotes",
  name: "Footnotes",

  activate(app) {
    app.markdown.addSyntax(footnoteSyntax);
    app.editor.addExtension(theme);

    app.render.node("FootnoteReference", (node, ctx) => {
      if (ctx.isActive(node.from, node.to)) return false;
      const label = labelOf(ctx.state, node.node);
      const number = footnotes(ctx.state).numbers.get(label);
      if (number === undefined) return false;
      ctx.replace(node.from, node.to, new FootnoteWidget(String(number), label, "reference", node.to - node.from));
      return false;
    });

    app.render.node("FootnoteDefinition", (node, ctx) => {
      ctx.lineClass(node.from, node.to, "cm-lp-footnote");
      const first = ctx.state.doc.lineAt(node.from);
      if (ctx.isActive(first.from, first.to)) return;
      const label = labelOf(ctx.state, node.node);
      const marks = node.node.getChildren("FootnoteMark");
      if (marks.length < 2) return;
      // `[^label]: ` including the space after the colon.
      const end = ctx.state.sliceDoc(marks[1].to, marks[1].to + 1) === " " ? marks[1].to + 1 : marks[1].to;
      const number = footnotes(ctx.state).numbers.get(label);
      const text = number === undefined ? ctx.state.sliceDoc(marks[0].to, marks[1].from) : String(number);
      ctx.replace(node.from, end, new FootnoteWidget(text, label, "definition", end - node.from));
    });
  },
};
