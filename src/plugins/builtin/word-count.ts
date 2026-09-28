import type { Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import type { MarkdPlugin } from "../api";

// Shows the word count in the status bar. CJK characters count one each.
//
// Words never span lines, so the count is kept per edit: the lines an edit touches are counted
// before and after. A newly opened document is counted in slices that yield to the UI, so a very
// large file neither freezes the window nor gets copied into one big string.

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const SLICE_MS = 8;

function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return cjk + words;
}

/** Words on lines `from..to` (line numbers, inclusive). */
function countLines(doc: Text, from: number, to: number): number {
  let count = 0;
  for (let n = from; n <= to; n++) count += countWords(doc.line(n).text);
  return count;
}

/** Line number ranges touched by `from..to` position ranges, with overlapping ranges merged. */
function touchedLines(doc: Text, ranges: [number, number][]): [number, number][] {
  const lines = ranges.map(([from, to]): [number, number] => [doc.lineAt(from).number, doc.lineAt(to).number]);
  const merged: [number, number][] = [];
  for (const [from, to] of lines.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** Beyond this many touched lines (a big paste or deletion), count the whole document in slices. */
const MAX_DELTA_LINES = 5000;

/** Words added (or removed, if negative) by an edit, or null if it touches too many lines. */
function delta(update: ViewUpdate): number | null {
  const before: [number, number][] = [];
  const after: [number, number][] = [];
  update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    before.push([fromA, toA]);
    after.push([fromB, toB]);
  });
  const linesAfter = touchedLines(update.state.doc, after);
  const linesBefore = touchedLines(update.startState.doc, before);
  const size = [...linesAfter, ...linesBefore].reduce((sum, [from, to]) => sum + to - from + 1, 0);
  if (size > MAX_DELTA_LINES) return null;
  let change = 0;
  for (const [from, to] of linesAfter) change += countLines(update.state.doc, from, to);
  for (const [from, to] of linesBefore) change -= countLines(update.startState.doc, from, to);
  return change;
}

export const wordCount: MarkdPlugin = {
  id: "markd.word-count",
  name: "Word count",

  activate(app) {
    const el = app.statusBar.add("words");
    /** The count, or null while a newly opened document is still being counted. */
    let total: number | null = 0;
    /** Words added by edits made while counting. */
    let pending = 0;
    let run = 0;

    const show = () => {
      if (total !== null) el.textContent = `${total} words`;
    };

    const countAll = (doc: Text) => {
      const current = ++run;
      total = null;
      pending = 0;
      el.textContent = "Counting words…";
      const lines = doc.iterLines();
      let count = 0;
      const slice = () => {
        if (current !== run) return;
        const end = performance.now() + SLICE_MS;
        do {
          for (let i = 0; i < 500; i++) {
            const line = lines.next();
            if (line.done) {
              total = count + pending;
              show();
              return;
            }
            count += countWords(line.value);
          }
        } while (performance.now() < end);
        setTimeout(slice, 0);
      };
      slice();
    };

    app.events.on("doc-opened", () => countAll(app.editor.view.state.doc));
    app.editor.addExtension(
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const change = delta(update);
        if (change === null) {
          countAll(update.state.doc);
        } else if (total === null) {
          pending += change;
        } else {
          total += change;
          show();
        }
      }),
    );
  },
};
