import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";

// Reference-style links and images, `[text][label]` / `![alt][label]` with `[label]: url` elsewhere.

/** Labels match case-insensitively with runs of whitespace collapsed, as in CommonMark. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Blocks a link reference definition can sit in. */
const CONTAINERS = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);

const cache = new WeakMap<Tree, Map<string, string>>();

/** Link reference definitions by normalized label. The first definition of a label wins. */
export function linkReferences(state: EditorState): Map<string, string> {
  const tree = syntaxTree(state);
  let refs = cache.get(tree);
  if (refs) return refs;
  refs = new Map();
  const found = refs;
  tree.iterate({
    enter(node) {
      if (node.name === "LinkReference") {
        const label = node.node.getChild("LinkLabel");
        const url = node.node.getChild("URL");
        if (label && url) {
          const key = normalizeLabel(state.sliceDoc(label.from + 1, label.to - 1));
          if (!found.has(key)) found.set(key, unbracket(state.sliceDoc(url.from, url.to)));
        }
        return false;
      }
      return CONTAINERS.has(node.name);
    },
  });
  cache.set(tree, refs);
  return refs;
}

/** `<url>` is allowed in link destinations. */
function unbracket(url: string): string {
  return url.startsWith("<") && url.endsWith(">") ? url.slice(1, -1) : url;
}

/**
 * The destination of a Link or Image node: its inline URL, or the definition its label refers to.
 * Null when it refers to a label that is not defined, which CommonMark renders as plain text.
 */
export function linkDestination(state: EditorState, node: SyntaxNode): string | null {
  const url = node.getChild("URL");
  if (url) return unbracket(state.sliceDoc(url.from, url.to));
  const marks = node.getChildren("LinkMark");
  // `[text]()` has an empty destination but is still an inline link.
  if (marks.length >= 3) return "";
  if (marks.length < 2) return null;
  // `[text][label]`, or `[text][]` / `[text]` where the text is the label.
  const label = node.getChild("LinkLabel");
  const explicit = label && label.to - label.from > 2 ? state.sliceDoc(label.from + 1, label.to - 1) : null;
  const text = explicit ?? state.sliceDoc(marks[0].to, marks[1].from);
  return linkReferences(state).get(normalizeLabel(text)) ?? null;
}
