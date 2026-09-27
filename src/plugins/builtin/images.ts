import { EditorView, WidgetType } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { backend } from "../../api";
import { h } from "../../dom";
import type { ExtensionPoint, MarkdPlugin, PluginApp } from "../api";
import { frontMatterValue } from "./front-matter";

// Renders images in live mode and stores pasted or dropped images through an image store: the
// `assets/` folder next to the document by default, or any store another plugin adds (e.g. S3).
// Stores decide where files go; this side only inserts the links they return.

/** Where pasted and dropped images are stored. Plugins add stores to `IMAGE_STORES`. */
export interface ImageStore {
  /** Used in settings and front matter, e.g. `image-storage: s3`. */
  id: string;
  /** Shown in Settings and status messages. */
  name: string;
  /** Whether images are stored next to the document, so an untitled one must be saved first. */
  needsSavedDocument?: boolean;
  /** Store pasted image bytes; returns the link to insert. */
  savePasted(bytes: Uint8Array, name: string): Promise<string>;
  /** Store the images from the last OS drop; returns the links to insert. */
  importDropped(): Promise<string[]>;
  /** A URL to load `src` from instead (e.g. a local cache), or null to load it as is. */
  displayUrl?(src: string): string | null;
}

export const IMAGE_STORES = "markd.images.stores";

const localStore: ImageStore = {
  id: "local",
  name: "assets/ next to the document",
  needsSavedDocument: true,
  savePasted: (bytes, name) => backend.saveImage(bytes, name),
  importDropped: () => backend.importDroppedImages(),
};

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
function resolveImageSrc(src: string, baseDir: string | null, stores: readonly ImageStore[]): string | null {
  // CommonMark allows wrapping a destination containing spaces in <...>
  if (src.startsWith("<") && src.endsWith(">")) src = src.slice(1, -1);
  for (const store of stores) {
    const url = store.displayUrl?.(src);
    if (url) return url;
  }
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
  /**
   * @param src what the WebView loads (possibly a cache or asset URL); null if unresolvable
   * @param source the address as written in the document, shown when the image cannot load
   */
  constructor(
    readonly src: string | null,
    readonly alt: string,
    readonly source: string,
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
      const where = this.src ? this.source : `${this.source} (relative path in an unsaved document)`;
      wrap.textContent = `Image unavailable: ${this.alt || where}`;
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

/** Alt text from a link's file name, without the extension or a content-hash suffix. */
function altFromLink(link: string): string {
  let name = link.slice(link.lastIndexOf("/") + 1);
  try {
    name = decodeURIComponent(name);
  } catch {
    // not percent-encoded
  }
  return name.replace(/\.[^.]+$/, "").replace(/-[0-9a-f]{10}$/, "");
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

/**
 * The store for new images in this document: `image-storage` in its front matter, else the
 * global setting. Saves an untitled document first when the store keeps images next to it.
 * Returns null if the user cancelled saving.
 */
async function storeForDocument(app: PluginApp, stores: ExtensionPoint<ImageStore>): Promise<ImageStore | null> {
  const override = frontMatterValue(app.editor.view.state.doc, "image-storage");
  const id = override ?? ((await backend.getSettings()).images.storage || localStore.id);
  const store = stores.items().find((s) => s.id === id);
  if (!store) throw new Error(`Unknown image storage "${id}"${override ? " in front matter" : ""}`);
  if (store.needsSavedDocument && !(await app.workspace.ensureSaved())) return null;
  return store;
}

async function addImages(app: PluginApp, store: ImageStore, count: number, save: () => Promise<string[]>) {
  const what = count === 1 ? "image" : count > 1 ? `${count} images` : "images";
  app.workspace.setStatus(`Saving ${what} to ${store.name}…`);
  const links = await save();
  app.workspace.setStatus(`Saved ${what} to ${store.name}`);
  return links;
}

function pasteHandler(app: PluginApp, stores: ExtensionPoint<ImageStore>) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type in MIME_EXTENSIONS);
      if (files.length === 0) return false;
      event.preventDefault();
      app.workspace.run(async () => {
        const store = await storeForDocument(app, stores);
        if (!store) return;
        const links = await addImages(app, store, files.length, async () => {
          const links: string[] = [];
          for (const file of files) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            links.push(imageMarkdown(await store.savePasted(bytes, pastedName(MIME_EXTENSIONS[file.type]))));
          }
          return links;
        });
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

/** Settings: which store new images go to. */
function settingsSection(app: PluginApp, stores: ExtensionPoint<ImageStore>) {
  return {
    id: "images",
    title: "Images",
    render(el: HTMLElement) {
      const choices = h("div", { class: "settings-choices" });
      el.append(
        h("div", { class: "settings-label" }, "Store pasted and dropped images in"),
        choices,
        h(
          "p",
          { class: "settings-hint" },
          "A document can override this in its front matter, e.g. ",
          h("code", {}, "image-storage: local"),
          " or ",
          h("code", {}, "image-storage: s3"),
          ".",
        ),
      );
      app.workspace.run(async () => {
        const current = (await backend.getSettings()).images.storage || localStore.id;
        for (const store of stores.items()) {
          const input = h("input", { type: "radio", name: "image-storage", value: store.id, checked: store.id === current });
          input.addEventListener("change", () =>
            app.workspace.run(async () => {
              const settings = await backend.getSettings();
              await backend.setSettings({ images: { ...settings.images, storage: store.id } });
              app.workspace.setStatus(`New images go to ${store.name}`);
            }),
          );
          choices.append(h("label", { class: "settings-choice" }, input, store.name));
        }
      });
    },
  };
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
    const stores = app.extensionPoint<ImageStore>(IMAGE_STORES);
    stores.add(localStore);

    app.editor.addExtension([theme, pasteHandler(app, stores)]);
    app.settings.addSection(settingsSection(app, stores));

    app.render.node("Image", (node, ctx) => {
      if (ctx.isActive(node.from, node.to)) return;
      const marks = node.node.getChildren("LinkMark");
      const url = node.node.getChild("URL");
      const alt = marks.length >= 2 ? ctx.state.sliceDoc(marks[0].to, marks[1].from) : "";
      const source = url ? ctx.state.sliceDoc(url.from, url.to) : "";
      const src = url ? resolveImageSrc(source, ctx.baseDir, stores.items()) : null;
      ctx.replace(node.from, node.to, new ImageWidget(src, alt, source));
      return false;
    });

    // Import images dropped onto the window and link them where they were dropped.
    stopDropListener = listen<{ x: number; y: number }>("images-dropped", ({ payload }) =>
      app.workspace.run(async () => {
        const view = app.editor.view;
        // Tauri reports the drop in physical pixels relative to the webview.
        const scale = window.devicePixelRatio || 1;
        const at = view.posAtCoords({ x: payload.x / scale, y: payload.y / scale }) ?? view.state.selection.main.head;
        const store = await storeForDocument(app, stores);
        if (!store) return;
        const links = await addImages(app, store, 0, () => store.importDropped());
        const pos = Math.min(at, view.state.doc.length);
        insertImages(view, pos, pos, links.map((link) => imageMarkdown(link, altFromLink(link))));
      }),
    );
  },

  deactivate() {
    void stopDropListener?.then((stop) => stop());
    stopDropListener = null;
  },
};
