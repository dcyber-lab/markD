import { getCurrentWindow } from "@tauri-apps/api/window";
import { h } from "../../dom";
import type { MarkdPlugin } from "../api";

// Settings → Appearance: the editor's fonts, font size, line height, text width and color theme.
// Everything applies immediately through CSS variables on #workspace, so the sidebar and status
// bar keep the system font. Settings are kept per machine in localStorage, like the view mode.

type Theme = "system" | "light" | "dark";

interface Appearance {
  /** Font names, comma-separated; empty for the system font. */
  textFont: string;
  codeFont: string;
  fontSize: number;
  lineHeight: number;
  /** Maximum text width in px; 0 for the full window width. */
  width: number;
  theme: Theme;
}

const DEFAULTS: Appearance = { textFont: "", codeFont: "", fontSize: 15, lineHeight: 1.75, width: 820, theme: "system" };

const FONT_SIZES = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24];
const LINE_HEIGHTS = [1.4, 1.5, 1.6, 1.75, 1.9, 2.0];
const WIDTHS: [number, string][] = [
  [680, "Narrow (680px)"],
  [820, "Medium (820px)"],
  [1040, "Wide (1040px)"],
  [0, "Full width"],
];
const THEMES: [Theme, string][] = [
  ["system", "Follow the system"],
  ["light", "Light"],
  ["dark", "Dark"],
];

const KEY = "markd.appearance";

function load(): Appearance {
  let saved: Partial<Appearance> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    // Unreadable or unavailable storage: use the defaults
  }
  const pick = <T,>(value: unknown, allowed: readonly T[], fallback: T) =>
    allowed.includes(value as T) ? (value as T) : fallback;
  return {
    textFont: typeof saved.textFont === "string" ? saved.textFont : DEFAULTS.textFont,
    codeFont: typeof saved.codeFont === "string" ? saved.codeFont : DEFAULTS.codeFont,
    fontSize: pick(saved.fontSize, FONT_SIZES, DEFAULTS.fontSize),
    lineHeight: pick(saved.lineHeight, LINE_HEIGHTS, DEFAULTS.lineHeight),
    width: pick(saved.width, WIDTHS.map(([w]) => w), DEFAULTS.width),
    theme: pick(saved.theme, THEMES.map(([t]) => t), DEFAULTS.theme),
  };
}

function save(appearance: Appearance) {
  try {
    localStorage.setItem(KEY, JSON.stringify(appearance));
  } catch {
    // Not persisted; the settings only last for this session
  }
}

const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif",
  "ui-monospace", "ui-rounded", "math", "emoji",
]);

/**
 * A CSS font stack from what the user typed, falling back to the default stack so a font that is
 * not installed still leaves readable text. Names are quoted; quotes and CSS punctuation dropped.
 */
function fontStack(input: string, fallback: string): string | null {
  const names = input
    .split(",")
    .map((name) => name.replace(/["'\\;:{}()<>]/g, "").trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  return [...names.map((name) => (GENERIC_FAMILIES.has(name.toLowerCase()) ? name : `"${name}"`)), fallback].join(", ");
}

function apply(appearance: Appearance) {
  const root = document.documentElement;
  const workspace = document.querySelector<HTMLElement>("#workspace");
  if (workspace) {
    // The defaults stay on :root, so they are always the fallback for a custom font.
    const defaults = getComputedStyle(root);
    const set = (name: string, value: string | null) =>
      value === null ? workspace.style.removeProperty(name) : workspace.style.setProperty(name, value);
    set("--font-text", fontStack(appearance.textFont, defaults.getPropertyValue("--font-text")));
    set("--font-mono", fontStack(appearance.codeFont, defaults.getPropertyValue("--font-mono")));
    set("--editor-font-size", `${appearance.fontSize}px`);
    set("--editor-line-height", String(appearance.lineHeight));
    set("--editor-width", appearance.width ? `${appearance.width}px` : "none");
  }
  if (appearance.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = appearance.theme;
  // The window frame follows too (title bar on macOS and Windows); not critical if it fails.
  getCurrentWindow()
    .setTheme(appearance.theme === "system" ? null : appearance.theme)
    .catch(() => {});
}

function settingsSection(el: HTMLElement) {
  let current = load();
  const update = (change: Partial<Appearance>) => {
    current = { ...current, ...change };
    save(current);
    apply(current);
  };

  const field = (label: string, input: HTMLElement, hint = "") =>
    h("label", { class: "settings-field" }, h("span", {}, label), input, ...(hint ? [h("small", {}, hint)] : []));
  const select = <T extends string | number>(options: [T, string][], value: T, onChange: (value: T) => void) => {
    const input = h("select", {}, ...options.map(([v, label]) => h("option", { value: String(v), selected: v === value }, label)));
    input.addEventListener("change", () => onChange(options[input.selectedIndex][0]));
    return input;
  };
  // A font change lays out the whole document again, so wait for a pause in typing; a half-typed
  // name is not a font anyway.
  const pending = new Set<number>();
  const font = (value: string, placeholder: string, onChange: (value: string) => void) => {
    const input = h("input", { type: "text", value, placeholder, spellcheck: false, autocomplete: "off" });
    let timer: number | undefined;
    input.addEventListener("input", () => {
      if (timer !== undefined) pending.delete(timer);
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        pending.delete(timer!);
        onChange(input.value);
      }, 300);
      pending.add(timer);
    });
    return input;
  };

  const reset = h("button", { type: "button" }, "Reset to defaults");
  reset.addEventListener("click", () => {
    for (const timer of pending) clearTimeout(timer);
    update(DEFAULTS);
    el.replaceChildren();
    settingsSection(el);
  });

  el.append(
    field("Theme", select(THEMES, current.theme, (theme) => update({ theme }))),
    field(
      "Text font",
      font(current.textFont, "System font", (textFont) => update({ textFont })),
      "Font names separated by commas; the first one installed is used, e.g. LXGW WenKai, Georgia",
    ),
    field(
      "Code font",
      font(current.codeFont, "System monospace font", (codeFont) => update({ codeFont })),
      "Used for code, tables and source mode, e.g. JetBrains Mono",
    ),
    field("Font size", select(FONT_SIZES.map((s) => [s, `${s}px`]), current.fontSize, (fontSize) => update({ fontSize }))),
    field("Line height", select(LINE_HEIGHTS.map((l) => [l, String(l)]), current.lineHeight, (lineHeight) => update({ lineHeight }))),
    field("Text width", select(WIDTHS, current.width, (width) => update({ width }))),
    h("div", { class: "settings-actions" }, reset),
    h("p", { class: "settings-hint" }, "⌘/Ctrl + = and ⌘/Ctrl + − zoom the whole window."),
  );
}

export const appearance: MarkdPlugin = {
  id: "markd.appearance",
  name: "Appearance",

  activate(app) {
    // Plugins start before the editor is created, so the saved look applies from the first paint.
    apply(load());
    app.settings.addSection({ id: "appearance", title: "Appearance", render: settingsSection });
    let lastWidth = DEFAULTS.width;
    app.commands.add({
      id: "view.toggle-full-width",
      title: "Toggle Full Width",
      key: "Mod-Alt-w",
      run: async () => {
        const current = load();
        if (current.width !== 0) lastWidth = current.width;
        const next = { ...current, width: current.width === 0 ? lastWidth : 0 };
        save(next);
        apply(next);
      },
    });
  },
};
