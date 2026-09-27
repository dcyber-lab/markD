import type { Text } from "@codemirror/state";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { backend, type DocInfo } from "./api";
import { createEditor, type Mode } from "./editor";
import { hasModKey } from "./platform";

const appWindow = getCurrentWindow();
const workspace = document.querySelector<HTMLElement>("#workspace")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const countEl = document.querySelector<HTMLElement>("#word-count")!;
const modeButton = document.querySelector<HTMLButtonElement>("#mode-toggle")!;

const MODE_KEY = "markd.mode";
const COUNT_DELAY_MS = 300;

let doc: DocInfo | null = null;
let mode: Mode = readMode();
let countTimer: number | undefined;
let windowTitle = "";

const editor = createEditor(document.querySelector<HTMLElement>("#editor")!, {
  mode,
  onChange() {
    refreshTitle();
    clearTimeout(countTimer);
    countTimer = window.setTimeout(refreshCount, COUNT_DELAY_MS);
  },
});
/** Content matching what is on disk, used to detect unsaved changes. */
let savedDoc: Text = editor.view.state.doc;

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "source" ? "source" : "live";
  } catch {
    return "live";
  }
}

const isDirty = () => !editor.view.state.doc.eq(savedDoc);

function setStatus(message: string, kind: "info" | "error" = "info") {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

function refreshTitle() {
  const title = `${isDirty() ? "● " : ""}${doc?.name ?? "Untitled"} — markd`;
  if (title === windowTitle) return;
  windowTitle = title;
  document.title = title;
  void appWindow.setTitle(title);
}

function countWords(text: string): number {
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
  const han = text.match(cjk)?.length ?? 0;
  const words = text.replace(cjk, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return han + words;
}

function refreshCount() {
  clearTimeout(countTimer);
  countEl.textContent = `${countWords(editor.text())} words`;
}

function load(info: DocInfo | null) {
  doc = info;
  editor.load(info?.content ?? "", info?.dir ?? null);
  savedDoc = editor.view.state.doc;
  refreshTitle();
  refreshCount();
  editor.focus();
}

function setMode(next: Mode) {
  mode = next;
  workspace.dataset.mode = next;
  modeButton.textContent = next === "live" ? "Live" : "Source";
  editor.setMode(next);
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    // Not persisted; the mode only lasts for this session
  }
}

async function confirmDiscard(): Promise<boolean> {
  if (!isDirty()) return true;
  return ask("You have unsaved changes. Discard them?", { title: "markd", kind: "warning" });
}

const commands = {
  async newFile() {
    if (await confirmDiscard()) load(null);
  },

  async open() {
    if (!(await confirmDiscard())) return;
    const info = await backend.openFile();
    if (info) {
      load(info);
      setStatus(`Opened ${info.path}`);
    }
  },

  async save() {
    if (!doc) return commands.saveAs();
    // Saving is async and the user may keep typing, so remember the version we sent.
    const snapshot = editor.view.state.doc;
    await backend.saveFile(snapshot.toString());
    savedDoc = snapshot;
    refreshTitle();
    setStatus(`Saved ${doc.path}`);
  },

  async saveAs() {
    const snapshot = editor.view.state.doc;
    const info = await backend.saveFileAs(snapshot.toString());
    if (!info) return;
    doc = info;
    editor.setBaseDir(info.dir);
    savedDoc = snapshot;
    refreshTitle();
    setStatus(`Saved ${info.path}`);
  },

  async toggleMode() {
    setMode(mode === "live" ? "source" : "live");
  },
};

function run(command: () => Promise<unknown>) {
  command().catch((e) => setStatus(String(e), "error"));
}

window.addEventListener("keydown", (e) => {
  if (!hasModKey(e) || e.altKey) return;
  const key = e.key.toLowerCase();
  const command =
    key === "n" ? commands.newFile
    : key === "o" ? commands.open
    : key === "s" ? (e.shiftKey ? commands.saveAs : commands.save)
    : key === "\\" ? commands.toggleMode
    : null;
  if (!command) return;
  e.preventDefault();
  run(command);
});

modeButton.addEventListener("click", () => run(commands.toggleMode));

void listen<string>("file-changed", ({ payload }) => {
  if (isDirty()) {
    setStatus("File changed on disk, but you have unsaved changes here, so it was not reloaded", "error");
    return;
  }
  editor.replace(payload);
  savedDoc = editor.view.state.doc;
  refreshTitle();
  refreshCount();
  setStatus("File changed on disk and was reloaded");
});

void appWindow.onCloseRequested(async (e) => {
  if (!(await confirmDiscard())) e.preventDefault();
});

setMode(mode);
run(async () => load(await backend.initialFile()));
