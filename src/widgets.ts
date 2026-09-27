import { type EditorView, WidgetType } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";

const hasScheme = /^[a-z][a-z0-9+.-]*:|^\/\//i;
const windowsAbsolute = /^[a-z]:[\\/]|^\\\\/i;

/** Turn an image address from markdown into a URL the WebView can load; null if it cannot be resolved (a relative path in an unsaved document). */
export function resolveImageSrc(src: string, baseDir: string | null): string | null {
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
  // Local files go through the asset protocol; the backend only allows the current document's directory.
  return convertFileSrc(absolute ? path : `${baseDir}/${path}`);
}

export class ImageWidget extends WidgetType {
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

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-lp-bullet";
    el.textContent = "•";
    return el;
  }

  ignoreEvent() {
    return false;
  }
}

export const bullet = new BulletWidget();

/** Task list `- [ ]` / `- [x]`; clicking toggles the marker in the source. */
export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    box.checked = this.checked;
    box.addEventListener("click", (e) => e.preventDefault());
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      // The widget DOM may be reused, so look up its position at click time.
      const pos = view.posAtDOM(box);
      const line = view.state.doc.lineAt(pos);
      const i = line.text.indexOf("[", pos - line.from);
      if (i < 0) return;
      const at = line.from + i + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: this.checked ? " " : "x" } });
    });
    return box;
  }

  ignoreEvent() {
    return true;
  }
}
