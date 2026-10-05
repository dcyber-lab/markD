import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { Tree } from "@lezer/common";

// Headings and the sections they start, shared by the outline, section folding and focus mode.
// Only top-level headings count: a heading inside a list or blockquote does not start a section.

export interface Heading {
  level: number;
  from: number;
  to: number;
  /** End of the section: the last block before the next heading of the same or a higher level. */
  end: number;
  /** Start of that next heading, or null if the section runs to the end of the document. */
  next: number | null;
}

export function headingLevel(name: string): number | null {
  const match = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
  return match ? +match[1] : null;
}

const cache = new WeakMap<Tree, Heading[]>();

/** Top-level headings in document order. Covers only the part of the document parsed so far. */
export function headings(tree: Tree): Heading[] {
  let list = cache.get(tree);
  if (list) return list;
  list = [];
  const open: Heading[] = [];
  let blockEnd = 0;
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const level = headingLevel(node.name);
    if (level !== null) {
      while (open.length && open[open.length - 1].level >= level) {
        const closed = open.pop()!;
        closed.end = blockEnd;
        closed.next = node.from;
      }
      const heading: Heading = { level, from: node.from, to: node.to, end: node.to, next: null };
      list.push(heading);
      open.push(heading);
    }
    blockEnd = node.to;
  }
  for (const heading of open) heading.end = blockEnd;
  cache.set(tree, list);
  return list;
}

/**
 * The foldable body of a section: from the end of the heading line to the line before the next
 * heading, so blank lines between sections fold too.
 */
export function sectionBody(state: EditorState, heading: Heading): { from: number; to: number } | null {
  const from = state.doc.lineAt(heading.to).to;
  if (heading.end <= from) return null;
  const to = heading.next === null ? heading.end : state.doc.lineAt(heading.next).from - 1;
  return { from, to: Math.max(to, heading.end) };
}

/** The innermost section containing `pos`, heading line included. */
export function sectionAt(list: readonly Heading[], pos: number): Heading | null {
  let found: Heading | null = null;
  for (const heading of list) {
    if (heading.from > pos) break;
    if (pos <= Math.max(heading.end, heading.to)) found = heading;
  }
  return found;
}

const HEADING_MARKUP = new Set([
  "HeaderMark", "EmphasisMark", "StrikethroughMark", "HighlightMark", "CodeMark", "LinkMark", "URL", "LinkTitle",
  "LinkLabel",
]);

/** Text of a heading without its markup, as GitHub uses for anchors. */
export function headingText(state: EditorState, from: number, to: number, tree = syntaxTree(state)): string {
  let text = "";
  let pos = from;
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.from < from || !HEADING_MARKUP.has(node.name)) return;
      if (node.from > pos) text += state.sliceDoc(pos, node.from);
      pos = Math.max(pos, node.to);
      return false;
    },
  });
  if (pos < to) text += state.sliceDoc(pos, to);
  return text.trim();
}
