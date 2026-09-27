import { WidgetType } from "@codemirror/view";
import type { MarkdPlugin, PluginApp } from "../api";

// `:smile:` shows as 😄, using GitHub's shortcodes. The list loads on first use; unknown names
// (and things like the `:30:` in `10:30:45`) stay as written.

let emoji: Map<string, string> | null = null;
let loading = false;

function load(app: PluginApp) {
  if (loading) return;
  loading = true;
  import("gemoji")
    .then(({ gemoji }) => {
      emoji = new Map();
      for (const entry of gemoji) for (const name of entry.names) emoji.set(name, entry.emoji);
      app.render.refresh();
    })
    .catch((e) => app.workspace.setStatus(`Emoji unavailable: ${e}`, "error"));
}

class EmojiWidget extends WidgetType {
  constructor(readonly emoji: string) {
    super();
  }

  eq(other: EmojiWidget) {
    return other.emoji === this.emoji;
  }

  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.emoji;
    return span;
  }
}

export const emojiShortcodes: MarkdPlugin = {
  id: "markd.emoji",
  name: "Emoji",

  activate(app) {
    app.render.node("Emoji", (node, ctx) => {
      if (ctx.isActive(node.from, node.to)) return;
      if (!emoji) return load(app);
      const char = emoji.get(ctx.state.sliceDoc(node.from + 1, node.to - 1));
      if (char) ctx.replace(node.from, node.to, new EmojiWidget(char));
    });
  },
};
