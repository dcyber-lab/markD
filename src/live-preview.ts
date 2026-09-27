import { syntaxTree } from "@codemirror/language";
import { type EditorState, Facet, Prec, type Range, StateField, type Transaction } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  type WidgetType,
} from "@codemirror/view";
import type { BlockRenderer, NodeRenderer, RenderContext } from "./plugins/api";

// Live rendering: the document is always raw markdown. On lines without the cursor, plugins hide
// markup or swap it for its rendered form (bullets, checkboxes, images, ...); moving the cursor
// onto a line reveals its source again. This file only walks the syntax tree and hands each node
// to the renderers registered for its name. Block renderers (tables) replace several lines with
// one widget; CodeMirror only allows that from a state field, so they get a pass of their own.

/** Directory of the current document, used to resolve relative image paths. */
export const baseDir = Facet.define<string | null, string | null>({
  combine: (values) => values[0] ?? null,
});

/** Node renderers by node name, as registered by plugins. */
export const nodeRenderers = Facet.define<ReadonlyMap<string, NodeRenderer[]>, ReadonlyMap<string, NodeRenderer[]>>({
  combine: (values) => values[0] ?? new Map(),
});

/** Block renderers by node name, as registered by plugins. */
export const blockRenderers = Facet.define<
  ReadonlyMap<string, BlockRenderer[]>,
  ReadonlyMap<string, BlockRenderer[]>
>({
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

const inlinePreview = ViewPlugin.fromClass(
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

interface Block {
  from: number;
  to: number;
  widget: WidgetType;
}

/**
 * Top-level blocks some renderer can draw, spanning whole lines, among the top-level nodes that
 * reach into `from..to`. Nodes a renderer declines keep their source. Also returns the extent of
 * all those nodes, which is the region these blocks replace.
 */
function findBlocks(state: EditorState, from = 0, to = state.doc.length) {
  const renderers = state.facet(blockRenderers);
  const blocks: Block[] = [];
  let spanFrom = from;
  let spanTo = to;
  if (renderers.size === 0) return { blocks, spanFrom, spanTo };
  for (let node = syntaxTree(state).topNode.childAfter(from); node && node.from <= to; node = node.nextSibling) {
    spanFrom = Math.min(spanFrom, node.from);
    spanTo = Math.max(spanTo, node.to);
    const list = renderers.get(node.name);
    if (!list) continue;
    const first = state.doc.lineAt(node.from);
    if (node.from !== first.from) continue;
    const last = state.doc.lineAt(node.to);
    for (const render of list) {
      const widget = render(node, state);
      if (widget) {
        blocks.push({ from: first.from, to: last.to, widget });
        break;
      }
    }
  }
  return { blocks, spanFrom, spanTo };
}

/**
 * Blocks after an edit. Rendering every block on every keystroke made typing slow in long
 * documents, so only the top-level nodes whose structure may have changed are rendered again; the
 * other blocks keep their widgets and move with the text.
 *
 * An edit can change the node before it (a `|---|` or `===` line turns the line above into a table
 * or heading) and any number of nodes after it (opening a code fence swallows everything below).
 * So the region starts one node before the edit and runs until a node matches the old tree again,
 * with the same type and the same (mapped) extent, the way incremental parsing resynchronizes.
 */
function updateBlocks(blocks: readonly Block[], tr: Transaction): Block[] {
  const oldTop = syntaxTree(tr.startState).topNode;
  const newTop = syntaxTree(tr.state).topNode;
  const back = tr.changes.invertedDesc;
  let lo = tr.state.doc.length;
  let hi = 0;
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    lo = Math.min(lo, fromB);
    hi = Math.max(hi, toB);
  });
  const atEdit = newTop.childBefore(lo);
  const from = (atEdit?.prevSibling ?? atEdit)?.from ?? 0;
  let to = hi;
  for (let node = newTop.childAfter(hi); node; node = node.nextSibling) {
    if (node.from > hi) {
      const oldFrom = back.mapPos(node.from, 1);
      const old = oldTop.childAfter(oldFrom);
      if (old && old.name === node.name && old.from === oldFrom && old.to === back.mapPos(node.to, -1)) break;
    }
    to = node.to;
  }
  const fresh = findBlocks(tr.state, from, to);
  const kept: Block[] = [];
  for (const block of blocks) {
    const bFrom = tr.changes.mapPos(block.from, 1);
    const bTo = tr.changes.mapPos(block.to, -1);
    if (bFrom <= bTo && (bTo < fresh.spanFrom || bFrom > fresh.spanTo)) kept.push({ from: bFrom, to: bTo, widget: block.widget });
  }
  return [...kept, ...fresh.blocks].sort((a, b) => a.from - b.from);
}

function blockDecorations(state: EditorState, blocks: readonly Block[]): DecorationSet {
  return Decoration.set(
    blocks
      .filter((b) => !isActive(state, b.from, b.to))
      .map((b) => Decoration.replace({ widget: b.widget, block: true }).range(b.from, b.to)),
  );
}

/**
 * Edits render the blocks around them again; new renderers, or a tree that grew without an edit
 * (background parsing), render all blocks. Moving the cursor only re-filters them.
 */
const blockPreview = StateField.define<{ blocks: Block[]; decorations: DecorationSet }>({
  create(state) {
    const { blocks } = findBlocks(state);
    return { blocks, decorations: blockDecorations(state, blocks) };
  },
  update(value, tr: Transaction) {
    const { startState, state } = tr;
    if (startState.facet(blockRenderers) !== state.facet(blockRenderers) || (!tr.docChanged && syntaxTree(startState) !== syntaxTree(state))) {
      const { blocks } = findBlocks(state);
      return { blocks, decorations: blockDecorations(state, blocks) };
    }
    if (tr.docChanged) {
      const blocks = updateBlocks(value.blocks, tr);
      return { blocks, decorations: blockDecorations(state, blocks) };
    }
    if (tr.selection) return { blocks: value.blocks, decorations: blockDecorations(state, value.blocks) };
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/**
 * Moving the cursor up or down would jump over a rendered block in one step, so it could never be
 * edited from the keyboard. Step into it instead: onto its last line going up, its first going down.
 */
function enterBlock(view: EditorView, forward: boolean): boolean {
  const { state } = view;
  if (state.selection.ranges.length > 1) return false;
  const range = state.selection.main;
  if (!range.empty) return false;
  const next = view.moveVertically(range, forward).head;
  const { blocks } = state.field(blockPreview);
  const block = forward
    ? blocks.find((b) => b.from > range.head && next >= b.from)
    : blocks.filter((b) => b.to < range.head && next <= b.to).pop();
  if (!block) return false;
  const column = range.head - state.doc.lineAt(range.head).from;
  const line = state.doc.lineAt(forward ? block.from : block.to);
  view.dispatch({ selection: { anchor: line.from + Math.min(column, line.length) }, scrollIntoView: true });
  return true;
}

/** Left from the start of the line below a rendered block gets stuck there; step to its end instead. */
function enterBlockByChar(view: EditorView, forward: boolean): boolean {
  const { state } = view;
  if (state.selection.ranges.length > 1 || !state.selection.main.empty) return false;
  const head = state.selection.main.head;
  const { blocks } = state.field(blockPreview);
  const block = forward ? blocks.find((b) => b.from === head + 1) : blocks.find((b) => b.to === head - 1);
  if (!block) return false;
  view.dispatch({ selection: { anchor: forward ? block.from : block.to }, scrollIntoView: true });
  return true;
}

const blockKeys = Prec.high(
  keymap.of([
    { key: "ArrowUp", run: (view) => enterBlock(view, false) },
    { key: "ArrowDown", run: (view) => enterBlock(view, true) },
    { key: "ArrowLeft", run: (view) => enterBlockByChar(view, false) },
    { key: "ArrowRight", run: (view) => enterBlockByChar(view, true) },
  ]),
);

export const livePreview = [inlinePreview, blockPreview, blockKeys];

/** Whether live rendering is on in `state` (its extensions are only present in live mode). */
export function isLive(state: EditorState): boolean {
  return state.field(blockPreview, false) !== undefined;
}
