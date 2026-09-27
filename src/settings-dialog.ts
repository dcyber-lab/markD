import { h } from "./dom";
import type { PluginHost } from "./plugins/host";

/** Open the Settings dialog. Its sections come from plugins and are rebuilt on every open. */
export function openSettings(host: PluginHost) {
  let dialog = document.querySelector<HTMLDialogElement>("#settings");
  if (!dialog) {
    dialog = h("dialog", { id: "settings" });
    document.body.append(dialog);
  }
  const close = h("button", { type: "button", class: "icon-button", title: "Close" }, "✕");
  close.addEventListener("click", () => dialog.close());

  const body = h("div", { class: "settings-body" });
  for (const section of host.settingsSections()) {
    const el = h("section", { class: "settings-section" });
    body.append(h("h2", {}, section.title), el);
    try {
      section.render(el);
    } catch (e) {
      el.textContent = `This section failed to load: ${e}`;
    }
  }

  dialog.replaceChildren(h("header", { class: "settings-header" }, h("h1", {}, "Settings"), close), body);
  dialog.showModal();
}
