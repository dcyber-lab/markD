import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { backend } from "./api";

// Pasted and dropped images are stored by the backend in `assets/` next to the document; the
// editor only inserts the returned relative links.

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

export interface ImageOptions {
  /** Make sure the document is saved (images go next to it); false if the user cancelled. */
  ensureSaved(): Promise<boolean>;
  /** Run a task, reporting failures in the status bar. */
  run(task: () => Promise<unknown>): void;
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

export function imagePaste(opts: ImageOptions): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type in MIME_EXTENSIONS);
      if (files.length === 0) return false;
      event.preventDefault();
      opts.run(async () => {
        if (!(await opts.ensureSaved())) return;
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
    // File drops from the OS are handled by the backend (see listenForDroppedImages); make sure
    // CodeMirror never inserts a dropped file's contents as text.
    drop(event) {
      if (!event.dataTransfer?.files.length) return false;
      event.preventDefault();
      return true;
    },
  });
}

/** Import images dropped onto the window and link them where they were dropped. */
export function listenForDroppedImages(view: EditorView, opts: ImageOptions) {
  return listen<{ x: number; y: number }>("images-dropped", ({ payload }) =>
    opts.run(async () => {
      // Tauri reports the drop in physical pixels relative to the webview.
      const scale = window.devicePixelRatio || 1;
      const at = view.posAtCoords({ x: payload.x / scale, y: payload.y / scale }) ?? view.state.selection.main.head;
      if (!(await opts.ensureSaved())) return;
      const links = await backend.importDroppedImages();
      const alt = (link: string) => link.slice(link.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
      const pos = Math.min(at, view.state.doc.length);
      insertImages(view, pos, pos, links.map((link) => imageMarkdown(link, alt(link))));
    }),
  );
}
