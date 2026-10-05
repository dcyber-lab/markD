import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { headings } from "../../markdown-headings";
import type { MarkdPlugin } from "../api";

// Focus mode: everything but the block (or section) being read is dimmed. The focus follows the
// cursor while editing, and a reading line about a third down the window while scrolling.

type Unit = "off" | "block" | "section";
const UNITS: Unit[] = ["off", "block", "section"];
const UNIT_KEY = "markd.focus";
/** Where the reading line sits, as a fraction of the window height. */
const READING_LINE = 0.35;
/** Scrolling this soon after an edit or cursor move is the editor keeping the cursor in view. */
const SCROLL_GRACE_MS = 300;

let unit: Unit = readUnit();

function readUnit(): Unit {
  try {
    const saved = localStorage.getItem(UNIT_KEY) as Unit | null;
    return saved && UNITS.includes(saved) ? saved : "off";
  } catch {
    return "off";
  }
}

const unitChanged = StateEffect.define<null>();

/** The top-level block at `pos`; in a list, the top-level item. */
function blockAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const top = syntaxTree(state).topNode;
  const node = top.childAfter(pos) ?? top.childBefore(pos);
  if (!node) return null;
  if (node.name === "BulletList" || node.name === "OrderedList") {
    const item = node.childAfter(pos) ?? node.childBefore(pos);
    if (item) return { from: item.from, to: item.to };
  }
  return { from: node.from, to: node.to };
}

/** From the heading at or above `pos` to the next heading of any level. */
function sectionAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const list = headings(syntaxTree(state));
  let from = 0;
  let to = state.doc.length;
  for (const heading of list) {
    if (heading.from <= pos) from = heading.from;
    else {
      to = heading.from - 1;
      break;
    }
  }
  return { from, to: Math.max(from, to) };
}

const focusLine = Decoration.line({ class: "cm-focus-on" });

const focusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    range: { from: number; to: number } | null = null;
    anchor: number;
    lastCursorMove = 0;
    frame = 0;

    constructor(readonly view: EditorView) {
      this.anchor = view.state.selection.main.head;
      this.onScroll = this.onScroll.bind(this);
      view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      this.refresh();
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) {
        this.anchor = u.state.selection.main.head;
        this.lastCursorMove = Date.now();
      }
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        syntaxTree(u.state) !== syntaxTree(u.startState) ||
        u.transactions.some((tr) => tr.effects.some((e) => e.is(unitChanged)))
      ) {
        this.refresh();
      }
    }

    onScroll() {
      if (unit === "off" || Date.now() - this.lastCursorMove < SCROLL_GRACE_MS) return;
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        const rect = this.view.scrollDOM.getBoundingClientRect();
        const y = rect.top + rect.height * READING_LINE - this.view.documentTop;
        this.anchor = this.view.lineBlockAtHeight(y).from;
        this.view.dispatch({ effects: unitChanged.of(null) });
      });
    }

    refresh() {
      const { state } = this.view;
      if (unit === "off") {
        this.range = null;
        this.decorations = Decoration.none;
        return;
      }
      const range = unit === "section" ? sectionAt(state, this.anchor) : blockAt(state, this.anchor);
      this.range = range;
      const decos: Range<Decoration>[] = [];
      if (range) {
        for (const { from, to } of this.view.visibleRanges) {
          const start = Math.max(from, range.from);
          const end = Math.min(to, range.to);
          for (let pos = start; pos <= end; ) {
            const line = state.doc.lineAt(pos);
            decos.push(focusLine.range(line.from));
            pos = line.to + 1;
          }
        }
      }
      this.decorations = Decoration.set(decos);
      // Block widgets (tables, diagrams) replace whole lines, so line classes miss them.
      this.view.requestMeasure({
        read: () => null,
        write: () => {
          for (const el of this.view.contentDOM.children) {
            if (el.classList.contains("cm-line")) continue;
            let inside = false;
            if (this.range) {
              try {
                const pos = this.view.posAtDOM(el);
                inside = pos >= this.range.from && pos <= this.range.to;
              } catch {
                // Not a document element
              }
            }
            el.classList.toggle("cm-focus-on", inside);
          }
        },
      });
    }

    destroy() {
      cancelAnimationFrame(this.frame);
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    }
  },
  { decorations: (p) => p.decorations },
);

// A function of the view, so it is re-read on every update.
const focusClass = EditorView.editorAttributes.of(() => (unit === "off" ? null : { class: "cm-focus-mode" }));

const theme = EditorView.baseTheme({
  "&.cm-focus-mode .cm-content > *": { opacity: "0.28", transition: "opacity 0.2s" },
  "&.cm-focus-mode .cm-content > .cm-focus-on": { opacity: "1" },
});

export const focusMode: MarkdPlugin = {
  id: "markd.focus",
  name: "Focus mode",

  activate(app) {
    app.editor.addExtension([focusPlugin, focusClass, theme]);
    app.commands.add({
      id: "view.focus",
      title: "Cycle Focus Mode",
      key: "Mod-Shift-f",
      run() {
        unit = UNITS[(UNITS.indexOf(unit) + 1) % UNITS.length];
        try {
          localStorage.setItem(UNIT_KEY, unit);
        } catch {
          // Only this session
        }
        app.editor.view.dispatch({ effects: unitChanged.of(null) });
        app.workspace.setStatus(
          unit === "off" ? "Focus mode off" : `Focus mode: ${unit === "block" ? "paragraph" : "section"}`,
        );
      },
    });
  },
};
