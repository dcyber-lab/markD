import { codeFolding, ensureSyntaxTree, foldEffect, foldedRanges, syntaxTree, unfoldEffect } from "@codemirror/language";
import { type EditorState, type Range, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { type Heading, headings, sectionAt, sectionBody } from "../../markdown-headings";
import type { MarkdPlugin } from "../api";

// Folding by section: a heading folds everything up to the next heading of the same or a higher
// level. A chevron left of each heading toggles its section, and commands fold the section at the
// cursor or collapse the whole document to a heading level. Folds last until the document changes.

/** How long commands spend parsing the rest of the document before working with what is parsed. */
const PARSE_MS = 200;

function isFolded(state: EditorState, body: { from: number; to: number }): boolean {
  let found = false;
  foldedRanges(state).between(body.from, body.from, (from, to) => {
    if (from === body.from && to === body.to) found = true;
  });
  return found;
}

/** Fold `bodies`, moving the cursor out of any of them so the fold is not undone at once. */
function fold(view: EditorView, bodies: { from: number; to: number }[], unfold: { from: number; to: number }[] = []) {
  const head = view.state.selection.main.head;
  const covering = bodies.find((b) => b.from < head && head < b.to);
  view.dispatch({
    effects: [...unfold.map((r) => unfoldEffect.of(r)), ...bodies.map((b) => foldEffect.of(b))],
    selection: covering ? { anchor: covering.from } : undefined,
  });
}

function toggleSection(view: EditorView, heading: Heading) {
  const body = sectionBody(view.state, heading);
  if (!body) return;
  if (isFolded(view.state, body)) view.dispatch({ effects: unfoldEffect.of(body) });
  else fold(view, [body]);
}

function allFolds(state: EditorState): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => void ranges.push({ from, to }));
  return ranges;
}

function fullTree(state: EditorState) {
  return ensureSyntaxTree(state, state.doc.length, PARSE_MS) ?? syntaxTree(state);
}

/** Fold every section at `level` or deeper, so only headings above that level show their text. */
function collapseTo(view: EditorView, level: number) {
  const { state } = view;
  const bodies: { from: number; to: number }[] = [];
  let foldedTo = -1;
  for (const heading of headings(fullTree(state))) {
    if (heading.level < level || heading.from < foldedTo) continue;
    const body = sectionBody(state, heading);
    if (!body) continue;
    bodies.push(body);
    foldedTo = body.to;
  }
  fold(view, bodies, allFolds(state));
}

class ChevronWidget extends WidgetType {
  constructor(readonly folded: boolean) {
    super();
  }
  eq(other: ChevronWidget) {
    return other.folded === this.folded;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-md-fold-toggle${this.folded ? " is-folded" : ""}`;
    el.title = this.folded ? "Unfold section" : "Fold section";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

const chevrons = [new ChevronWidget(false), new ChevronWidget(true)];

function buildChevrons(view: EditorView): DecorationSet {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const list = headings(syntaxTree(state));
  for (const { from, to } of view.visibleRanges) {
    for (const heading of list) {
      if (heading.from < from) continue;
      if (heading.from > to) break;
      const body = sectionBody(state, heading);
      if (!body) continue;
      const widget = chevrons[isFolded(state, body) ? 1 : 0];
      decos.push(Decoration.widget({ widget, side: -1 }).range(heading.from));
    }
  }
  return Decoration.set(decos);
}

const chevronPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildChevrons(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.state) !== syntaxTree(u.startState) ||
        foldedRanges(u.state) !== foldedRanges(u.startState)
      ) {
        this.decorations = buildChevrons(u.view);
      }
    }
  },
  {
    decorations: (p) => p.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const el = (event.target as Element).closest?.(".cm-md-fold-toggle");
        if (!el) return false;
        event.preventDefault();
        const pos = view.posAtDOM(el);
        const heading = headings(syntaxTree(view.state)).find((h) => h.from === pos);
        if (heading) toggleSection(view, heading);
        return true;
      },
    },
  },
);

const folding = codeFolding({
  preparePlaceholder: (state, range) => state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number,
  placeholderDOM(_view, onclick, lines: number) {
    const el = document.createElement("span");
    el.className = "cm-md-fold-placeholder";
    el.textContent = `${lines} line${lines === 1 ? "" : "s"}`;
    el.title = "Unfold";
    el.addEventListener("click", onclick);
    return el;
  },
});

const theme = EditorView.baseTheme({
  // Sits in the line's left padding, so it takes no room in the text.
  ".cm-md-fold-toggle": {
    display: "inline-block",
    width: "24px",
    marginLeft: "-24px",
    height: "1em",
    verticalAlign: "middle",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity 0.1s",
    background: "no-repeat center / 10px 10px",
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5l3 3 3-3' fill='none' stroke='%238a9099' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
  },
  ".cm-md-fold-toggle.is-folded": { transform: "rotate(-90deg)", opacity: "1" },
  ".cm-line:hover .cm-md-fold-toggle": { opacity: "1" },
  ".cm-md-fold-placeholder": {
    display: "inline-block",
    marginLeft: "10px",
    padding: "0 8px",
    borderRadius: "10px",
    background: "var(--code-bg)",
    color: "var(--muted)",
    fontFamily: "var(--font-text)",
    fontSize: "12px",
    fontWeight: "400",
    lineHeight: "1.7",
    verticalAlign: "middle",
    cursor: "pointer",
  },
  ".cm-md-fold-placeholder:hover": { color: "var(--fg)" },
});

export const sectionFolding: MarkdPlugin = {
  id: "markd.folding",
  name: "Section folding",

  activate(app) {
    const view = () => app.editor.view;
    app.editor.addExtension([folding, chevronPlugin, theme]);

    const atCursor = () => {
      const { state } = view();
      return sectionAt(headings(syntaxTree(state)), state.selection.main.head);
    };

    app.commands.add({
      id: "fold.section",
      title: "Fold Section",
      key: "Mod-Alt-[",
      run() {
        const heading = atCursor();
        const body = heading && sectionBody(view().state, heading);
        if (body) fold(view(), [body]);
      },
    });
    app.commands.add({
      id: "fold.unfold-section",
      title: "Unfold Section",
      key: "Mod-Alt-]",
      run() {
        const heading = atCursor();
        const body = heading && sectionBody(view().state, heading);
        if (body) view().dispatch({ effects: unfoldEffect.of(body) });
      },
    });
    for (let level = 1; level <= 6; level++) {
      app.commands.add({
        id: `fold.level-${level}`,
        title: `Collapse to Heading ${level}`,
        key: `Mod-Alt-${level}`,
        run: () => collapseTo(view(), level),
      });
    }
    app.commands.add({
      id: "fold.unfold-all",
      title: "Unfold All",
      key: "Mod-Alt-0",
      run() {
        const effects: StateEffect<unknown>[] = allFolds(view().state).map((r) => unfoldEffect.of(r));
        if (effects.length) view().dispatch({ effects });
      },
    });
  },
};
