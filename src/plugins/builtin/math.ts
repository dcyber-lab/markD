import type { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { tags } from "@lezer/highlight";
import type { Element, MarkdownConfig } from "@lezer/markdown";
import type { MarkdPlugin, PluginApp } from "../api";

// TeX math with KaTeX: `$inline$` and `$$ display $$` blocks. KaTeX loads on first use. A formula
// KaTeX cannot parse stays as source, with a wavy underline.
//
// An inline formula follows pandoc's rules, so prices do not turn into math: the opening `$` is
// not followed by a space, and the closing `$` is not preceded by a space or followed by a digit.
// It also cannot contain a `$`, so in `$5 and $10 ... $x$` only `$x$` is math.

const isSpace = (ch: number) => ch === 32 || ch === 9 || ch === 10 || ch === -1;

const mathSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath" },
    { name: "BlockMath", block: true },
    { name: "MathMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "InlineMath",
      parse(cx, next, pos) {
        if (next !== 36 /* $ */ || cx.char(pos + 1) === 36 || isSpace(cx.char(pos + 1))) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === 92 /* \ */) {
            i++;
          } else if (ch === 36) {
            const after = cx.char(i + 1);
            if (isSpace(cx.char(i - 1)) || (after >= 48 && after <= 57)) return -1;
            return cx.addElement(
              cx.elt("InlineMath", pos, i + 1, [cx.elt("MathMark", pos, pos + 1), cx.elt("MathMark", i, i + 1)]),
            );
          }
        }
        return -1;
      },
      after: "InlineCode",
    },
  ],
  parseBlock: [
    {
      name: "BlockMath",
      parse(cx, line) {
        if (line.indent - line.baseIndent >= 4 || !line.text.startsWith("$$", line.pos)) return false;
        const start = cx.lineStart + line.pos;
        const children: Element[] = [cx.elt("MathMark", start, start + 2)];
        // `$$ x $$` on one line.
        const rest = line.text.slice(line.pos + 2).trimEnd();
        if (rest.length > 2 && rest.endsWith("$$")) {
          const end = start + 2 + rest.length;
          children.push(cx.elt("MathMark", end - 2, end));
          cx.nextLine();
          cx.addElement(cx.elt("BlockMath", start, end, children));
          return true;
        }
        // Otherwise up to a line ending in `$$`, or the end of the document, like a code fence.
        let end = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          children.push(...line.markers);
          const text = line.text.trimEnd();
          end = cx.lineStart + text.length;
          if (text.endsWith("$$")) {
            children.push(cx.elt("MathMark", end - 2, end));
            cx.nextLine();
            break;
          }
          end = cx.lineStart + line.text.length;
        }
        cx.addElement(cx.elt("BlockMath", start, end, children));
        return true;
      },
      endLeaf: (_cx, line) => line.indent - line.baseIndent < 4 && line.text.startsWith("$$", line.pos),
      before: "LinkReference",
    },
  ],
};

type Katex = typeof import("katex").default;

let katex: Katex | null = null;
let loading = false;

function load(app: PluginApp) {
  if (loading) return;
  loading = true;
  Promise.all([import("katex"), import("katex/dist/katex.min.css")])
    .then(([module]) => {
      katex = module.default;
      app.render.refresh();
    })
    .catch((e) => app.workspace.setStatus(`Math rendering unavailable: ${e}`, "error"));
}

/** Rendered HTML, or the error message, by `display` flag and TeX source. */
const rendered = new Map<string, { html: string } | { error: string }>();

function render(k: Katex, tex: string, display: boolean): { html: string } | { error: string } {
  const key = `${display ? "D" : "I"}${tex}`;
  let result = rendered.get(key);
  if (!result) {
    try {
      // KaTeX escapes the source, and with `trust` off (the default) commands like \href and
      // \htmlClass are refused, so the HTML it returns is safe to insert.
      result = { html: k.renderToString(tex, { displayMode: display, throwOnError: true, strict: "ignore" }) };
    } catch (e) {
      result = { error: e instanceof Error ? e.message : String(e) };
    }
    if (rendered.size > 500) rendered.delete(rendered.keys().next().value!);
    rendered.set(key, result);
  }
  return result;
}

/** The TeX of a BlockMath node, between its `$$` marks. */
function blockTex(state: EditorState, node: SyntaxNode): { tex: string; to: number } {
  const marks = node.getChildren("MathMark");
  const to = marks.length >= 2 ? marks[marks.length - 1].from : node.to;
  return { tex: state.sliceDoc(node.from + 2, to), to };
}

/** A rendered formula. A click puts the cursor in its source; `offset` is where, from its start. */
class MathWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly display: boolean,
    readonly offset: number,
  ) {
    super();
  }

  eq(other: MathWidget) {
    return other.html === this.html && other.display === this.display && other.offset === this.offset;
  }

  toDOM(view: EditorView) {
    const el: HTMLElement = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-lp-math-block" : "cm-lp-math";
    el.innerHTML = this.html;
    el.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(el) + this.offset } });
      view.focus();
    });
    return el;
  }
}

const theme = EditorView.baseTheme({
  ".cm-lp-math": { cursor: "text" },
  ".cm-lp-math-block": { padding: "8px 32px", overflowX: "auto", cursor: "text" },
  ".cm-lp-math-block .katex-display": { margin: "0" },
  ".cm-lp-math-error": { textDecoration: "underline wavy var(--error)", textUnderlineOffset: "3px" },
  ".cm-line.cm-lp-math-source": { fontFamily: "var(--font-mono)", fontSize: "0.9em" },
});

export const math: MarkdPlugin = {
  id: "markd.math",
  name: "Math",

  activate(app) {
    app.markdown.addSyntax(mathSyntax);
    app.editor.addExtension(theme);

    app.render.node("InlineMath", (node, ctx) => {
      if (ctx.isActive(node.from, node.to)) return false;
      if (!katex) {
        load(app);
        return false;
      }
      const result = render(katex, ctx.state.sliceDoc(node.from + 1, node.to - 1), false);
      if ("html" in result) {
        ctx.replace(node.from, node.to, new MathWidget(result.html, false, node.to - node.from - 1));
      } else {
        ctx.mark(node.from, node.to, "cm-lp-math-error");
      }
      return false;
    });

    // The source of a display formula, shown while the cursor is in it or when it does not render.
    app.render.node("BlockMath", (node, ctx) => {
      const failed = katex && "error" in render(katex, blockTex(ctx.state, node.node).tex, true);
      ctx.lineClass(node.from, node.to, failed ? "cm-lp-math-source cm-lp-math-error" : "cm-lp-math-source");
      return false;
    });

    app.render.block("BlockMath", (node, state) => {
      if (!katex) {
        load(app);
        return null;
      }
      const { tex, to: texTo } = blockTex(state, node.node);
      const result = render(katex, tex, true);
      if (!("html" in result)) return null;
      // A click lands at the start of the formula's first line of TeX.
      const firstLine = state.doc.lineAt(node.from);
      const offset = firstLine.to < texTo ? firstLine.to + 1 - node.from : 2;
      return new MathWidget(result.html, true, offset);
    });
  },
};
