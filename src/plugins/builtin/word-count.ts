import type { MarkdPlugin } from "../api";

// Shows the word count in the status bar. CJK characters count one each.

const DELAY_MS = 300;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return cjk + words;
}

export const wordCount: MarkdPlugin = {
  id: "markd.word-count",
  name: "Word count",

  activate(app) {
    const el = app.statusBar.add("words");
    let timer: number | undefined;
    const update = () => {
      clearTimeout(timer);
      el.textContent = `${countWords(app.editor.view.state.doc.toString())} words`;
    };
    app.events.on("doc-opened", update);
    app.events.on("doc-changed", () => {
      clearTimeout(timer);
      timer = window.setTimeout(update, DELAY_MS);
    });
  },
};
