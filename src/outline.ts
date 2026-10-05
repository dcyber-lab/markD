import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type Heading, headings, headingText } from "./markdown-headings";

// The outline: the document's headings in the sidebar. Clicking one scrolls to it, and the heading
// of the section at the top of the window is highlighted as you scroll.

/** Wait this long after the last edit before listing the headings again. */
const REBUILD_MS = 150;
/** The heading this far below the top of the window counts as the one being read. */
const READING_OFFSET = 80;
/**
 * The editor only parses a little past the window, so the outline parses the rest itself, for up
 * to this long per rebuild. A document too large for that lists the headings parsed so far.
 */
const PARSE_MS = 50;

export class Outline {
  private list: Heading[] = [];
  private rows: HTMLElement[] = [];
  private active = -1;
  private view: EditorView | null = null;

  constructor(private readonly el: HTMLElement) {
    el.addEventListener("click", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".outline-row");
      const heading = row && this.list[Number(row.dataset.index)];
      if (heading && this.view) this.reveal(this.view, heading);
    });
  }

  /** Include in the editor so the outline follows the document. */
  readonly extension = ViewPlugin.define((view) => {
    this.view = view;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => this.highlight(view));
    };
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    // Not right away: the layout, which highlighting reads, cannot be read while the view updates.
    let timer = window.setTimeout(() => this.rebuild(view));
    return {
      update: (u: ViewUpdate) => {
        this.view = u.view;
        if (u.docChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
          clearTimeout(timer);
          timer = window.setTimeout(() => this.rebuild(u.view), REBUILD_MS);
        } else if (u.geometryChanged) {
          onScroll();
        }
      },
      destroy: () => {
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        view.scrollDOM.removeEventListener("scroll", onScroll);
      },
    };
  });

  private rebuild(view: EditorView) {
    const { state } = view;
    const tree = ensureSyntaxTree(state, state.doc.length, PARSE_MS) ?? syntaxTree(state);
    this.list = headings(tree);
    const top = Math.min(...this.list.map((h) => h.level));
    this.rows = this.list.map((heading, i) => {
      const row = document.createElement("div");
      row.className = "outline-row";
      row.dataset.index = String(i);
      row.dataset.level = String(heading.level);
      row.style.setProperty("--depth", String(heading.level - top));
      row.textContent = headingText(state, heading.from, heading.to, tree) || "(untitled)";
      row.title = row.textContent;
      return row;
    });
    if (this.rows.length) {
      this.el.replaceChildren(...this.rows);
    } else {
      const empty = document.createElement("p");
      empty.className = "outline-empty";
      empty.textContent = "No headings";
      this.el.replaceChildren(empty);
    }
    this.active = -1;
    this.highlight(view);
  }

  private highlight(view: EditorView) {
    const top = view.scrollDOM.getBoundingClientRect().top;
    const pos = view.lineBlockAtHeight(top + READING_OFFSET - view.documentTop).from;
    let index = -1;
    for (let i = 0; i < this.list.length && this.list[i].from <= pos; i++) index = i;
    if (index === this.active) return;
    this.rows[this.active]?.classList.remove("is-active");
    this.active = index;
    const row = this.rows[index];
    if (!row) return;
    row.classList.add("is-active");
    if (this.el.offsetParent) row.scrollIntoView({ block: "nearest" });
  }

  private reveal(view: EditorView, heading: Heading) {
    // Moving the cursor to the heading also unfolds a section it is folded inside.
    view.dispatch({
      selection: { anchor: heading.from },
      effects: EditorView.scrollIntoView(heading.from, { y: "start", yMargin: 48 }),
    });
    view.focus();
  }
}
