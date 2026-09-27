import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { baseDir, livePreview, openLinkOnModClick } from "./live-preview";

/** live: rendered in place inside the editor; source: plain markdown source. */
export type Mode = "live" | "source";

// Colors come from CSS variables in styles.css so light/dark themes live in one place.
const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: "700", color: "var(--heading)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--link)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)" },
  { tag: [t.processingInstruction, t.labelName, t.contentSeparator, t.quote], color: "var(--muted)" },
  // Languages embedded in fenced code blocks
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--syn-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-fn)" },
  { tag: [t.typeName, t.className], color: "var(--syn-type)" },
  { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-editor)", lineHeight: "1.75" },
  ".cm-content": { padding: "32px 0 40vh", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 32px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { backgroundColor: "var(--selection)" },
  ".cm-placeholder": { color: "var(--muted)" },
});

export interface EditorOptions {
  mode: Mode;
  onChange: () => void;
  /** Extra extensions, kept across document loads. */
  extensions?: Extension[];
}

export function createEditor(parent: HTMLElement, opts: EditorOptions) {
  const modeSlot = new Compartment();
  const dirSlot = new Compartment();
  const modeExtension = (mode: Mode): Extension => (mode === "live" ? livePreview : highlightActiveLine());
  let mode = opts.mode;

  const extensions = (dir: string | null): Extension[] => [
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(highlight),
    theme,
    openLinkOnModClick,
    placeholder("⌘/Ctrl+O open  ·  ⌘/Ctrl+S save  ·  ⌘/Ctrl+\\ toggle source mode"),
    modeSlot.of(modeExtension(mode)),
    dirSlot.of(baseDir.of(dir)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange();
    }),
    opts.extensions ?? [],
  ];

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: "", extensions: extensions(null) }),
  });

  return {
    view,

    text: () => view.state.doc.toString(),

    /** Open a new document: rebuild the whole state and clear undo history. */
    load(text: string, dir: string | null) {
      view.setState(EditorState.create({ doc: text, extensions: extensions(dir) }));
    },

    /** Reload after an external change: applied as a normal edit so it can be undone, keeping the cursor where possible. */
    replace(text: string) {
      const head = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: head },
      });
    },

    /** The directory changes after "Save As", so relative image paths must be re-resolved. */
    setBaseDir(dir: string | null) {
      view.dispatch({ effects: dirSlot.reconfigure(baseDir.of(dir)) });
    },

    setMode(next: Mode) {
      mode = next;
      view.dispatch({ effects: modeSlot.reconfigure(modeExtension(next)) });
    },

    focus: () => view.focus(),
  };
}
