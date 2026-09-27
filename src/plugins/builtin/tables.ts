import type { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { openUrl } from "@tauri-apps/plugin-opener";
import { h } from "../../dom";
import { hasModKey } from "../../platform";
import type { MarkdPlugin } from "../api";

// Tables render as real tables in live mode. With the cursor in a table, or when a table cannot be
// rendered (e.g. one nested in a list), its source shows in a monospace font instead. Clicking a
// cell puts the cursor at the end of that cell's source.

type Align = "left" | "center" | "right" | null;

/** Inline content of a cell. It only ever reaches the DOM as text, so there is no HTML to inject. */
type Inline =
  | string
  | { tag: "strong" | "em" | "s" | "code"; children: Inline[] }
  | { tag: "link"; url: string; children: Inline[] };

interface Cell {
  content: Inline[];
  /** Where a click on the cell puts the cursor, relative to the start of the table. */
  offset: number;
}

interface Table {
  align: Align[];
  /** The header row first. Every row has one cell per column. */
  rows: Cell[][];
}

const FORMATS: Record<string, "strong" | "em" | "s"> = {
  StrongEmphasis: "strong",
  Emphasis: "em",
  Strikethrough: "s",
};

const MARKUP = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark", "LinkMark", "URL", "LinkTitle", "LinkLabel"]);

/**
 * The cells of a table line, as trimmed ranges within the line. Cells are split at unescaped
 * pipes ourselves because the parser leaves out empty cells; a leading or trailing pipe does not
 * start or end a cell.
 */
function splitCells(text: string): { from: number; to: number }[] {
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "|") pipes.push(i);
  }
  const bounds = [-1, ...pipes, text.length];
  const cells = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    let from = bounds[i] + 1;
    let to = bounds[i + 1];
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    cells.push({ from, to });
  }
  if (pipes.length > 0 && pipes[pipes.length - 1] === text.trimEnd().length - 1) cells.pop();
  if (pipes.length > 0 && pipes[0] === text.search(/\S/)) cells.shift();
  return cells;
}

/** Inline content of `from..to`, using the syntax nodes under `node` (a cell or a span in one). */
function inline(state: EditorState, node: SyntaxNode | null, from: number, to: number): Inline[] {
  const out: Inline[] = [];
  let pos = from;
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) continue;
    if (child.from > pos) out.push(state.sliceDoc(pos, child.from));
    out.push(...inlineNode(state, child));
    pos = child.to;
  }
  if (pos < to) out.push(state.sliceDoc(pos, to));
  return out;
}

function inlineNode(state: EditorState, node: SyntaxNode): Inline[] {
  const format = FORMATS[node.name];
  if (format) return [{ tag: format, children: inline(state, node, node.from, node.to) }];
  switch (node.name) {
    case "Escape":
      return [state.sliceDoc(node.from + 1, node.to)];
    case "InlineCode": {
      const marks = node.getChildren("CodeMark");
      const code = marks.length >= 2 ? state.sliceDoc(marks[0].to, marks[marks.length - 1].from) : "";
      // A pipe in inline code has to be escaped in a table, and renders without the backslash.
      return [{ tag: "code", children: [code.replace(/\\\|/g, "|")] }];
    }
    case "Link": {
      // [text](url "title") or [text][ref]: show the text.
      const marks = node.getChildren("LinkMark");
      if (marks.length < 2) break;
      const children = inline(state, node, marks[0].to, marks[1].from);
      const url = node.getChild("URL");
      return url ? [{ tag: "link", url: state.sliceDoc(url.from, url.to), children }] : children;
    }
    case "Autolink": {
      const url = node.getChild("URL");
      if (!url) break;
      const text = state.sliceDoc(url.from, url.to);
      return [{ tag: "link", url: text, children: [text] }];
    }
  }
  // Anything else (images, HTML, entities) stays as written.
  return MARKUP.has(node.name) ? [] : [state.sliceDoc(node.from, node.to)];
}

/** Read a Table node; null if its delimiter row does not describe its header, so it stays source. */
function parseTable(state: EditorState, node: SyntaxNode): Table | null {
  const { doc } = state;
  const first = doc.lineAt(node.from).number;
  const last = doc.lineAt(node.to).number;
  const start = doc.line(first).from;
  if (last === first) return null;

  const cellsOf = (n: number) => {
    const line = doc.line(n);
    return splitCells(line.text).map((c) => ({ from: line.from + c.from, to: line.from + c.to }));
  };
  const header = cellsOf(first);
  const delimiters = cellsOf(first + 1).map((c) => state.sliceDoc(c.from, c.to));
  if (header.length === 0 || delimiters.length !== header.length) return null;
  if (!delimiters.every((d) => /^:?-+:?$/.test(d))) return null;
  const align = delimiters.map((d): Align =>
    d.startsWith(":") ? (d.endsWith(":") ? "center" : "left") : d.endsWith(":") ? "right" : null,
  );

  // Row nodes by line number, for the inline syntax inside cells.
  const rowNodes = new Map<number, SyntaxNode>();
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableHeader" || child.name === "TableRow") rowNodes.set(doc.lineAt(child.from).number, child);
  }

  const rows: Cell[][] = [];
  for (let n = first; n <= last; n++) {
    if (n === first + 1) continue;
    const line = doc.line(n);
    const ranges = cellsOf(n);
    const cellNodes = rowNodes.get(n)?.getChildren("TableCell") ?? [];
    // Rows are cut or padded to the header's width, as GitHub does.
    rows.push(
      header.map((_, i) => {
        const range = ranges[i];
        if (!range) return { content: [], offset: line.to - start };
        const cell = cellNodes.find((c) => c.from >= range.from && c.to <= range.to) ?? null;
        return { content: inline(state, cell, range.from, range.to), offset: range.to - start };
      }),
    );
  }
  return { align, rows };
}

function inlineDOM(item: Inline): Node {
  if (typeof item === "string") return document.createTextNode(item);
  const children = item.children.map(inlineDOM);
  switch (item.tag) {
    case "code":
      return h("code", { class: "cm-lp-code" }, ...children);
    case "link": {
      const link = h("span", { class: "cm-lp-link" }, ...children);
      link.dataset.url = item.url;
      return link;
    }
    default:
      return h(item.tag, {}, ...children);
  }
}

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly table: Table,
  ) {
    super();
  }

  eq(other: TableWidget) {
    return other.source === this.source;
  }

  get estimatedHeight() {
    return this.table.rows.length * 34 + 8;
  }

  toDOM(view: EditorView) {
    const { align, rows } = this.table;
    const row = (cells: Cell[], tag: "th" | "td") =>
      h(
        "tr",
        {},
        ...cells.map((cell, i) => {
          const el = h(tag, {}, ...cell.content.map(inlineDOM));
          if (align[i]) el.style.textAlign = align[i];
          el.dataset.offset = String(cell.offset);
          return el;
        }),
      );
    const [header, ...body] = rows;
    const wrap = h(
      "div",
      { class: "cm-lp-table-widget" },
      h("table", {}, h("thead", {}, row(header, "th")), h("tbody", {}, ...body.map((r) => row(r, "td")))),
    );

    wrap.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const target = event.target as HTMLElement;
      const url = target.closest<HTMLElement>("[data-url]")?.dataset.url;
      if (url && hasModKey(event) && /^(https?|mailto):/i.test(url)) {
        void openUrl(url);
        return;
      }
      // Editing a cell: put the cursor in its source, which makes the table show as source.
      const cell = target.closest<HTMLElement>("[data-offset]");
      const offset = cell ? Number(cell.dataset.offset) : this.source.length;
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) + offset } });
      view.focus();
    });
    return wrap;
  }
}

const theme = EditorView.baseTheme({
  ".cm-line.cm-lp-table": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
  },
  // Same side padding as a line, so the table lines up with the text around it.
  ".cm-lp-table-widget": {
    padding: "4px 32px",
    overflowX: "auto",
    cursor: "text",
  },
  ".cm-lp-table-widget table": {
    borderCollapse: "collapse",
    lineHeight: "1.5",
  },
  ".cm-lp-table-widget th, .cm-lp-table-widget td": {
    border: "1px solid var(--border)",
    padding: "4px 12px",
    textAlign: "left",
    verticalAlign: "top",
  },
  ".cm-lp-table-widget th": {
    background: "var(--bg-subtle)",
    fontWeight: "600",
  },
});

export const tables: MarkdPlugin = {
  id: "markd.tables",
  name: "Tables",

  activate(app) {
    app.editor.addExtension(theme);
    app.render.node("Table", (node, ctx) => ctx.lineClass(node.from, node.to, "cm-lp-table"));
    app.render.block("Table", (node, state) => {
      const table = parseTable(state, node.node);
      if (!table) return null;
      const source = state.sliceDoc(state.doc.lineAt(node.from).from, state.doc.lineAt(node.to).to);
      return new TableWidget(source, table);
    });
  },
};
