import { syntaxTree } from "@codemirror/language";
import { type EditorState, Facet, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  type WidgetType,
} from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hasModKey } from "./platform";
import { bullet, CheckboxWidget, ImageWidget, resolveImageSrc } from "./widgets";

// Live rendering: the document is always raw markdown. On lines without the cursor,
// markup is hidden or swapped for its rendered form (bullets, checkboxes, images, ...);
// moving the cursor onto a line reveals its source again.

/** Directory of the current document, used to resolve relative image paths. */
export const baseDir = Facet.define<string | null, string | null>({
  combine: (values) => values[0] ?? null,
});

const hidden = Decoration.replace({});

const inlineClass: Record<string, string> = {
  StrongEmphasis: "cm-lp-strong",
  Emphasis: "cm-lp-em",
  Strikethrough: "cm-lp-strike",
  InlineCode: "cm-lp-code",
  Link: "cm-lp-link",
};

const lineDecos = new Map<string, Decoration>();
const lineDeco = (cls: string) => {
  let deco = lineDecos.get(cls);
  if (!deco) lineDecos.set(cls, (deco = Decoration.line({ class: cls })));
  return deco;
};

/** Lines touched by the selection (or cursor) show their raw source. */
function isActive(state: EditorState, from: number, to: number): boolean {
  const start = state.doc.lineAt(from).from;
  const end = state.doc.lineAt(to).to;
  return state.selection.ranges.some((r) => r.from <= end && r.to >= start);
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const decos: Range<Decoration>[] = [];

  // Decorations from a ViewPlugin may not replace line breaks; multi-line ranges are left as source.
  const replace = (from: number, to: number, widget?: WidgetType) => {
    if (from >= to || state.doc.lineAt(from).number !== state.doc.lineAt(to).number) return;
    decos.push(widget ? Decoration.replace({ widget }).range(from, to) : hidden.range(from, to));
  };
  const markLines = (from: number, to: number, cls: (lineFrom: number, lineTo: number) => string) => {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      decos.push(lineDeco(cls(line.from, line.to)).range(line.from));
      pos = line.to + 1;
    }
  };
  const withSpace = (to: number) => (state.sliceDoc(to, to + 1) === " " ? to + 1 : to);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const cls = inlineClass[node.name];
        if (cls) decos.push(Decoration.mark({ class: cls }).range(node.from, node.to));

        const heading = /^ATXHeading([1-6])$/.exec(node.name);
        if (heading) markLines(node.from, node.from, () => `cm-lp-h${heading[1]}`);

        switch (node.name) {
          case "Blockquote":
            markLines(node.from, node.to, () => "cm-lp-quote");
            return;
          case "Table":
            markLines(node.from, node.to, () => "cm-lp-table");
            return;
          case "FencedCode": {
            const first = state.doc.lineAt(node.from).from;
            const last = state.doc.lineAt(node.to).from;
            markLines(node.from, node.to, (lineFrom) =>
              lineFrom === first ? "cm-lp-fence cm-lp-fence-first"
              : lineFrom === last ? "cm-lp-fence cm-lp-fence-last"
              : "cm-lp-fence",
            );
            // With the cursor anywhere inside the block, show the ``` fences for the whole block.
            if (!isActive(state, node.from, node.to)) {
              for (const mark of [...node.node.getChildren("CodeMark"), ...node.node.getChildren("CodeInfo")]) {
                replace(mark.from, mark.to);
              }
            }
            return false;
          }
        }

        if (isActive(state, node.from, node.to)) return;

        switch (node.name) {
          case "HeaderMark": {
            // Hide a leading `## ` with its trailing space, or an optional closing ` ##` with its leading space.
            const line = state.doc.lineAt(node.from);
            if (node.to < line.to && state.sliceDoc(node.to, node.to + 1) === " ") {
              replace(node.from, node.to + 1);
            } else {
              const spaced = node.from > line.from && state.sliceDoc(node.from - 1, node.from) === " ";
              replace(spaced ? node.from - 1 : node.from, node.to);
            }
            break;
          }
          case "EmphasisMark":
          case "StrikethroughMark":
            replace(node.from, node.to);
            break;
          case "CodeMark":
            if (node.node.parent?.name === "InlineCode") replace(node.from, node.to);
            break;
          case "QuoteMark":
            replace(node.from, withSpace(node.to));
            break;
          case "HorizontalRule":
            markLines(node.from, node.from, () => "cm-lp-hr");
            replace(node.from, node.to);
            break;
          case "ListMark": {
            const task = node.node.nextSibling;
            const marker = task?.name === "Task" ? task.firstChild : null;
            if (marker?.name === "TaskMarker") {
              const checked = state.sliceDoc(marker.from + 1, marker.to - 1).toLowerCase() === "x";
              replace(node.from, marker.to, new CheckboxWidget(checked));
              if (checked && task!.to > marker.to) {
                decos.push(Decoration.mark({ class: "cm-lp-task-done" }).range(marker.to, task!.to));
              }
            } else if (node.node.parent?.parent?.name === "BulletList") {
              replace(node.from, node.to, bullet);
            }
            break;
          }
          case "Link": {
            // [text](url "title") or [text][ref]: keep only the text.
            const marks = node.node.getChildren("LinkMark");
            if (marks.length >= 2) {
              replace(node.from, marks[0].to);
              replace(marks[1].from, node.to);
            }
            break;
          }
          case "Autolink":
            for (const mark of node.node.getChildren("LinkMark")) replace(mark.from, mark.to);
            break;
          case "Image": {
            const marks = node.node.getChildren("LinkMark");
            const url = node.node.getChild("URL");
            const alt = marks.length >= 2 ? state.sliceDoc(marks[0].to, marks[1].from) : "";
            const src = url ? resolveImageSrc(state.sliceDoc(url.from, url.to), state.facet(baseDir)) : null;
            replace(node.from, node.to, new ImageWidget(src, alt));
            return false;
          }
        }
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
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        update.startState.facet(baseDir) !== update.state.facet(baseDir)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

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
export const openLinkOnModClick = EditorView.domEventHandlers({
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
