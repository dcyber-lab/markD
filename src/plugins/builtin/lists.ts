import { EditorView, WidgetType } from "@codemirror/view";
import type { MarkdPlugin } from "../api";

// Bullet lists render with a dot; task list items render with a checkbox that toggles the source.

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

const bullet = new BulletWidget();

/** Task list `- [ ]` / `- [x]`; clicking toggles the marker in the source. */
class CheckboxWidget extends WidgetType {
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

const theme = EditorView.baseTheme({
  ".cm-lp-bullet": {
    display: "inline-block",
    minWidth: "0.6em",
    color: "var(--muted)",
    fontWeight: "700",
  },
  ".cm-lp-task": {
    margin: "0 2px 0 0",
    verticalAlign: "-2px",
    accentColor: "var(--accent)",
    cursor: "pointer",
  },
  ".cm-lp-task-done": {
    color: "var(--muted)",
    textDecoration: "line-through",
  },
});

export const lists: MarkdPlugin = {
  id: "markd.lists",
  name: "Lists and tasks",

  activate(app) {
    app.editor.addExtension(theme);

    app.render.node("ListMark", (node, ctx) => {
      if (ctx.isActive(node.from, node.to)) return;
      const task = node.node.nextSibling;
      const marker = task?.name === "Task" ? task.firstChild : null;
      if (task && marker?.name === "TaskMarker") {
        const checked = ctx.state.sliceDoc(marker.from + 1, marker.to - 1).toLowerCase() === "x";
        ctx.replace(node.from, marker.to, new CheckboxWidget(checked));
        if (checked) ctx.mark(marker.to, task.to, "cm-lp-task-done");
      } else if (node.node.parent?.parent?.name === "BulletList") {
        ctx.replace(node.from, node.to, bullet);
      }
    });
  },
};
