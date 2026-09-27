import { EditorView, WidgetType } from "@codemirror/view";
import type { MarkdPlugin, PluginApp } from "../api";

// ```mermaid code blocks render as diagrams. Mermaid is large, so it loads on first use, and it
// renders asynchronously: a diagram shows as source until it is ready, and stays source if Mermaid
// cannot parse it. Strict security mode sanitizes the SVG it returns.

type Mermaid = typeof import("mermaid").default;

let mermaid: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  mermaid ??= import("mermaid").then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
    });
    return m;
  });
  return mermaid;
}

/** Rendered diagrams by source. Failures are remembered so broken diagrams are not retried. */
const diagrams = new Map<string, { svg: string } | { error: string }>();

/** Sources waiting to render. While typing in a diagram each keystroke asks for a new version, so
 * rendering waits for a pause and skips versions that are no longer in the document. */
let wanted = new Set<string>();
let timer: number | undefined;
let seq = 0;

function request(app: PluginApp, code: string) {
  wanted.add(code);
  clearTimeout(timer);
  timer = window.setTimeout(() => void renderWanted(app), 300);
}

async function renderWanted(app: PluginApp) {
  const doc = app.editor.view.state.doc.toString();
  const codes = [...wanted].filter((code) => !diagrams.has(code) && doc.includes(code));
  wanted = new Set();
  if (codes.length === 0) return;
  let m: Mermaid;
  try {
    m = await loadMermaid();
  } catch (e) {
    app.workspace.setStatus(`Diagrams unavailable: ${e}`, "error");
    for (const code of codes) diagrams.set(code, { error: String(e) });
    return;
  }
  for (const code of codes) {
    const id = `markd-mermaid-${++seq}`;
    try {
      diagrams.set(code, { svg: (await m.render(id, code)).svg });
    } catch (e) {
      diagrams.set(code, { error: String(e) });
    } finally {
      // Mermaid renders in a temporary element; make sure none is left behind after an error.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  }
  while (diagrams.size > 100) diagrams.delete(diagrams.keys().next().value!);
  app.render.refresh();
}

/** A rendered diagram. A click puts the cursor in its source; `offset` is where, from its start. */
class DiagramWidget extends WidgetType {
  constructor(
    readonly svg: string,
    readonly offset: number,
  ) {
    super();
  }

  eq(other: DiagramWidget) {
    return other.svg === this.svg && other.offset === this.offset;
  }

  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-lp-mermaid";
    el.innerHTML = this.svg;
    el.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(el) + this.offset } });
      view.focus();
    });
    return el;
  }
}

const theme = EditorView.baseTheme({
  ".cm-lp-mermaid": { padding: "8px 32px", overflowX: "auto", textAlign: "center", cursor: "text" },
  ".cm-lp-mermaid svg": { maxWidth: "100%", height: "auto" },
});

export const mermaidDiagrams: MarkdPlugin = {
  id: "markd.mermaid",
  name: "Mermaid diagrams",

  activate(app) {
    app.editor.addExtension(theme);

    app.render.block("FencedCode", (node, state) => {
      const info = node.node.getChild("CodeInfo");
      if (!info || state.sliceDoc(info.from, info.to).trim().toLowerCase() !== "mermaid") return null;
      const text = node.node.getChild("CodeText");
      if (!text) return null;
      const code = state.sliceDoc(text.from, text.to);
      const diagram = diagrams.get(code);
      if (!diagram) {
        request(app, code);
        return null;
      }
      return "svg" in diagram ? new DiagramWidget(diagram.svg, text.from - node.from) : null;
    });
  },
};
