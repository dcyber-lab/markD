import { SearchCursor } from "@codemirror/search";
import { EditorView, WidgetType } from "@codemirror/view";
import type { MarkdPlugin, PluginApp } from "../api";

// ```mermaid code blocks render as diagrams. Mermaid is large, so it loads on first use, and it
// renders asynchronously: a diagram shows as source until it is ready, and stays source if Mermaid
// cannot parse it. Strict security mode sanitizes the SVG it returns. Diagrams follow the light or
// dark theme, and render again when it changes.

type Mermaid = typeof import("mermaid").default;

let mermaid: Promise<Mermaid> | null = null;
let mermaidTheme = "";

const darkQuery = matchMedia("(prefers-color-scheme: dark)");

/** Mermaid's theme for the app's current colors: a theme picked in Settings, else the system's. */
function currentTheme(): "dark" | "default" {
  const picked = document.documentElement.dataset.theme;
  return (picked ? picked === "dark" : darkQuery.matches) ? "dark" : "default";
}

async function loadMermaid(theme: "dark" | "default"): Promise<Mermaid> {
  mermaid ??= import("mermaid").then(({ default: m }) => m);
  const m = await mermaid;
  if (theme !== mermaidTheme) {
    m.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme });
    mermaidTheme = theme;
  }
  return m;
}

/** Rendered diagrams by theme and source. Failures are remembered so broken diagrams are not retried. */
const diagrams = new Map<string, { svg: string } | { error: string }>();

/** Sources waiting to render. While typing in a diagram each keystroke asks for a new version, so
 * rendering waits for a pause and skips versions that are no longer in the document. */
let wanted = new Set<string>();
let timer: number | undefined;
let seq = 0;

function request(app: PluginApp, key: string) {
  wanted.add(key);
  clearTimeout(timer);
  timer = window.setTimeout(() => void renderWanted(app), 300);
}

/** Whether `text` is in the document, searched in place (a huge document is not copied into one string). */
function inDocument(app: PluginApp, text: string): boolean {
  return !new SearchCursor(app.editor.view.state.doc, text).next().done;
}

async function renderWanted(app: PluginApp) {
  const theme = currentTheme();
  // Only versions still in the document, for the theme in use now.
  const keys = [...wanted].filter((key) => !diagrams.has(key) && key.startsWith(`${theme}\n`) && inDocument(app, codeOf(key)));
  wanted = new Set();
  if (keys.length === 0) return;
  let m: Mermaid;
  try {
    m = await loadMermaid(theme);
  } catch (e) {
    app.workspace.setStatus(`Diagrams unavailable: ${e}`, "error");
    for (const key of keys) diagrams.set(key, { error: String(e) });
    return;
  }
  for (const key of keys) {
    const id = `markd-mermaid-${++seq}`;
    try {
      diagrams.set(key, { svg: (await m.render(id, codeOf(key))).svg });
    } catch (e) {
      diagrams.set(key, { error: String(e) });
    } finally {
      // Mermaid renders in a temporary element; make sure none is left behind after an error.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  }
  while (diagrams.size > 100) diagrams.delete(diagrams.keys().next().value!);
  app.render.refresh();
}

const codeOf = (key: string) => key.slice(key.indexOf("\n") + 1);

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

    // Re-render in the new colors when the theme changes, from Settings or the system.
    const refresh = () => app.render.refresh();
    darkQuery.addEventListener("change", refresh);
    new MutationObserver(refresh).observe(document.documentElement, { attributeFilter: ["data-theme"] });

    app.render.block("FencedCode", (node, state) => {
      const info = node.node.getChild("CodeInfo");
      if (!info || state.sliceDoc(info.from, info.to).trim().toLowerCase() !== "mermaid") return null;
      const text = node.node.getChild("CodeText");
      if (!text) return null;
      const key = `${currentTheme()}\n${state.sliceDoc(text.from, text.to)}`;
      const diagram = diagrams.get(key);
      if (!diagram) {
        request(app, key);
        return null;
      }
      return "svg" in diagram ? new DiagramWidget(diagram.svg, text.from - node.from) : null;
    });
  },
};
