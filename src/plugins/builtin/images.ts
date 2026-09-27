import { EditorView, WidgetType } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { backend } from "../../api";
import type { MarkdPlugin, PluginApp } from "../api";

// Renders images in live mode, and stores pasted or dropped images in `assets/` next to the
// document. The backend decides where files go; this side only inserts the returned links.

const hasScheme = /^[a-z][a-z0-9+.-]*:|^\/\//i;
const windowsAbsolute = /^[a-z]:[\\/]|^\\\\/i;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

/** Turn an image address from markdown into a URL the WebView can load; null if it cannot be resolved (a relative path in an unsaved document). */
function resolveImageSrc(src: string, baseDir: string | null): string | null {
  // CommonMark allows wrapping a destination containing spaces in <...>
  if (src.startsWith("<") && src.endsWith(">")) src = src.slice(1, -1);
  let path = src;
  try {
    path = decodeURI(src);
  } catch {
    // keep as-is
  }
  const absolute = path.startsWith("/") || windowsAbsolute.test(path);
  if (!absolute && hasScheme.test(path)) return src; // keep https:, data:, etc. as-is
  if (!absolute && !baseDir) return null;
  // Local files go through the asset protocol; the backend only allows the open document's directory and folder.
  return convertFileSrc(absolute ? path : `${baseDir}/${path}`);
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string | null,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-image";
    const showBroken = () => {
      wrap.className = "cm-lp-image cm-lp-image-broken";
      wrap.textContent = `Image unavailable: ${this.alt || this.src || "relative path in an unsaved document"}`;
    };
    if (!this.src) {
      showBroken();
      return wrap;
    }
    const img = document.createElement("img");
    img.decoding = "async"; // keep large images from blocking typing while they decode
    img.src = this.src;
    img.alt = this.alt;
    img.addEventListener("error", showBroken);
    wrap.appendChild(img);
    return wrap;
  }

  // Let the editor move the cursor onto the image when clicked, revealing its source.
  ignoreEvent() {
    return false;
  }
}

/** `![alt](path)`, wrapping the path in `<...>` when it contains spaces or brackets. */
function imageMarkdown(path: string, alt = ""): string {
  const dest = /[\s()<>]/.test(path) ? `<${path}>` : path;
  return `![${alt.replace(/[[\]\\]/g, "\\$&")}](${dest})`;
}

function pastedName(ext: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `image-${stamp}.${ext}`;
}

/**
 * Insert image links in place of `from..to`. When nothing else is on the line, end with a line
 * break so the cursor moves on and the images render right away.
 */
function insertImages(view: EditorView, from: number, to: number, links: string[]) {
  const { state } = view;
  const alone =
    state.sliceDoc(state.doc.lineAt(from).from, from).trim() === "" &&
    state.sliceDoc(to, state.doc.lineAt(to).to).trim() === "";
  const text = links.join("\n") + (alone ? "\n" : "");
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
    userEvent: "input.paste",
  });
  view.focus();
}

function pasteHandler({ workspace }: PluginApp) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type in MIME_EXTENSIONS);
      if (files.length === 0) return false;
      event.preventDefault();
      workspace.run(async () => {
        if (!(await workspace.ensureSaved())) return;
        const links: string[] = [];
        for (const file of files) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          links.push(imageMarkdown(await backend.saveImage(bytes, pastedName(MIME_EXTENSIONS[file.type]))));
        }
        const { from, to } = view.state.selection.main;
        insertImages(view, from, to, links);
      });
      return true;
    },
    // File drops from the OS are handled by the backend (see the images-dropped listener); make
    // sure CodeMirror never inserts a dropped file's contents as text.
    drop(event) {
      if (!event.dataTransfer?.files.length) return false;
      event.preventDefault();
      return true;
    },
  });
}

let stopDropListener: Promise<UnlistenFn> | null = null;

const theme = EditorView.baseTheme({
  ".cm-lp-image img": {
    maxWidth: "100%",
    verticalAlign: "bottom",
    borderRadius: "4px",
  },
  ".cm-lp-image-broken": {
    display: "inline-block",
    padding: "2px 8px",
    border: "1px dashed var(--border)",
    borderRadius: "4px",
    color: "var(--muted)",
    fontSize: "0.9em",
  },
});

export const images: MarkdPlugin = {
  id: "markd.images",
  name: "Images",

  activate(app) {
    app.editor.addExtension([theme, pasteHandler(app)]);

    app.render.node("Image", (node, ctx) => {
      if (ctx.isActive(node.from, node.to)) return;
      const marks = node.node.getChildren("LinkMark");
      const url = node.node.getChild("URL");
      const alt = marks.length >= 2 ? ctx.state.sliceDoc(marks[0].to, marks[1].from) : "";
      const src = url ? resolveImageSrc(ctx.state.sliceDoc(url.from, url.to), ctx.baseDir) : null;
      ctx.replace(node.from, node.to, new ImageWidget(src, alt));
      return false;
    });

    // Import images dropped onto the window and link them where they were dropped.
    const { workspace } = app;
    stopDropListener = listen<{ x: number; y: number }>("images-dropped", ({ payload }) =>
      workspace.run(async () => {
        const view = app.editor.view;
        // Tauri reports the drop in physical pixels relative to the webview.
        const scale = window.devicePixelRatio || 1;
        const at = view.posAtCoords({ x: payload.x / scale, y: payload.y / scale }) ?? view.state.selection.main.head;
        if (!(await workspace.ensureSaved())) return;
        const links = await backend.importDroppedImages();
        const alt = (link: string) => link.slice(link.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
        const pos = Math.min(at, view.state.doc.length);
        insertImages(view, pos, pos, links.map((link) => imageMarkdown(link, alt(link))));
      }),
    );
  },

  deactivate() {
    void stopDropListener?.then((stop) => stop());
    stopDropListener = null;
  },
};
