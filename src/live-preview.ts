import { syntaxTree } from "@codemirror/language";
import { type EditorState, Facet, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  type WidgetType,
} from "@codemirror/view";
import type { NodeRenderer, RenderContext } from "./plugins/api";

// Live rendering: the document is always raw markdown. On lines without the cursor, plugins hide
// markup or swap it for its rendered form (bullets, checkboxes, images, ...); moving the cursor
// onto a line reveals its source again. This file only walks the syntax tree and hands each node
// to the renderers registered for its name.

/** Directory of the current document, used to resolve relative image paths. */
export const baseDir = Facet.define<string | null, string | null>({
  combine: (values) => values[0] ?? null,
});

/** Node renderers by node name, as registered by plugins. */
export const nodeRenderers = Facet.define<ReadonlyMap<string, NodeRenderer[]>, ReadonlyMap<string, NodeRenderer[]>>({
  combine: (values) => values[0] ?? new Map(),
});

const hidden = Decoration.replace({});

function cached(make: (cls: string) => Decoration) {
  const cache = new Map<string, Decoration>();
  return (cls: string) => {
    let deco = cache.get(cls);
    if (!deco) cache.set(cls, (deco = make(cls)));
    return deco;
  };
}
const lineDeco = cached((cls) => Decoration.line({ class: cls }));
const markDeco = cached((cls) => Decoration.mark({ class: cls }));

/** Lines touched by the selection (or cursor) show their raw source. */
function isActive(state: EditorState, from: number, to: number): boolean {
  const start = state.doc.lineAt(from).from;
  const end = state.doc.lineAt(to).to;
  return state.selection.ranges.some((r) => r.from <= end && r.to >= start);
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const renderers = state.facet(nodeRenderers);
  const decos: Range<Decoration>[] = [];

  // Decorations from a ViewPlugin may not replace line breaks; multi-line ranges are left as source.
  const replace = (from: number, to: number, widget?: WidgetType) => {
    if (from >= to || state.doc.lineAt(from).number !== state.doc.lineAt(to).number) return;
    decos.push(widget ? Decoration.replace({ widget }).range(from, to) : hidden.range(from, to));
  };

  const ctx: RenderContext = {
    state,
    baseDir: state.facet(baseDir),
    isActive: (from, to) => isActive(state, from, to),
    hide: (from, to) => replace(from, to),
    replace,
    mark(from, to, cls) {
      if (from < to) decos.push(markDeco(cls).range(from, to));
    },
    lineClass(from, to, cls) {
      for (let pos = from; pos <= to; ) {
        const line = state.doc.lineAt(pos);
        decos.push(lineDeco(typeof cls === "string" ? cls : cls(line.from)).range(line.from));
        pos = line.to + 1;
      }
    },
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const list = renderers.get(node.name);
        if (!list) return;
        let descend = true;
        for (const render of list) if (render(node, ctx) === false) descend = false;
        return descend;
      },
    });
  }

  return Decoration.set(decos, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      const { startState, state } = update;
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(startState) !== syntaxTree(state) ||
        startState.facet(baseDir) !== state.facet(baseDir) ||
        startState.facet(nodeRenderers) !== state.facet(nodeRenderers)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
