import type { Text } from "@codemirror/state";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { backend, type DocInfo } from "./api";
import { createEditor, type Mode } from "./editor";
import { hasModKey } from "./platform";
import { Sidebar } from "./sidebar";

const appWindow = getCurrentWindow();
const workspace = document.querySelector<HTMLElement>("#workspace")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const countEl = document.querySelector<HTMLElement>("#word-count")!;
const modeButton = document.querySelector<HTMLButtonElement>("#mode-toggle")!;
const sidebarButton = document.querySelector<HTMLButtonElement>("#sidebar-toggle")!;

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

const sidebar = new Sidebar(document.querySelector<HTMLElement>("#sidebar")!, {
  openFile: openFromTree,
  openFolder: () => commands.openFolder(),
  docMoved(moved) {
    doc = moved;
    editor.setBaseDir(moved.dir);
    sidebar.setActive(moved.path);
    refreshTitle();
    setStatus(`Renamed to ${moved.path}`);
  },
  docRemoved() {
    load(null);
    setStatus("Moved the open document to the Trash");
  },
  run,
});

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
  sidebar.setActive(info?.path ?? null);
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

/** Before switching documents: save changes to a file on disk, or confirm discarding an untitled one. */
async function leaveCurrent(): Promise<boolean> {
  if (!isDirty()) return true;
  if (!doc) return confirmDiscard();
  await commands.save();
  return true;
}

async function openFromTree(path: string) {
  if (path === doc?.path) return;
  if (!(await leaveCurrent())) return;
  load(await backend.openEntry(path));
}

const commands = {
  async newFile() {
    if (await leaveCurrent()) load(null);
  },

  async open() {
    if (!(await leaveCurrent())) return;
    const info = await backend.openFile();
    if (info) {
      load(info);
      setStatus(`Opened ${info.path}`);
    }
  },

  async openFolder() {
    const folder = await backend.openFolder();
    if (!folder) return;
    sidebar.show();
    await sidebar.setFolder(folder);
    setStatus(`Opened folder ${folder.root}`);
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
    sidebar.setActive(info.path);
    refreshTitle();
    setStatus(`Saved ${info.path}`);
  },

  async toggleMode() {
    setMode(mode === "live" ? "source" : "live");
  },

  async toggleSidebar() {
    sidebar.toggleVisible();
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
    : key === "o" ? (e.shiftKey ? commands.openFolder : commands.open)
    : key === "s" ? (e.shiftKey ? commands.saveAs : commands.save)
    : key === "e" && e.shiftKey ? commands.toggleSidebar
    : key === "\\" ? commands.toggleMode
    : null;
  if (!command) return;
  e.preventDefault();
  run(command);
});

modeButton.addEventListener("click", () => run(commands.toggleMode));
sidebarButton.addEventListener("click", () => run(commands.toggleSidebar));

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

void listen("tree-changed", () => run(() => sidebar.refresh()));

void appWindow.onCloseRequested(async (e) => {
  if (!(await confirmDiscard())) e.preventDefault();
});

setMode(mode);
run(async () => {
  const initial = await backend.initialState();
  await sidebar.setFolder(initial.folder);
  load(initial.doc);
});
