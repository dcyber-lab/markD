import type { Text } from "@codemirror/state";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { backend, type DocInfo } from "./api";
import { createEditor, type Mode } from "./editor";
import type { Command } from "./plugins/api";
import { builtinPlugins } from "./plugins/builtin";
import { PluginHost } from "./plugins/host";
import { openSettings } from "./settings-dialog";
import { Sidebar } from "./sidebar";

const appWindow = getCurrentWindow();
const workspaceEl = document.querySelector<HTMLElement>("#workspace")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const modeButton = document.querySelector<HTMLButtonElement>("#mode-toggle")!;
const sidebarButton = document.querySelector<HTMLButtonElement>("#sidebar-toggle")!;
const settingsButton = document.querySelector<HTMLButtonElement>("#settings-toggle")!;

const MODE_KEY = "markd.mode";

let doc: DocInfo | null = null;
let mode: Mode = readMode();
let windowTitle = "";

// Plugins start before the editor exists so their contributions are part of its first state.
const host = new PluginHost(document.querySelector<HTMLElement>("#status-items")!, {
  get doc() {
    return doc;
  },
  ensureSaved,
  open: openFromTree,
  setStatus,
  run,
});
for (const plugin of builtinPlugins) host.activate(plugin);

const editor = createEditor(document.querySelector<HTMLElement>("#editor")!, {
  mode,
  onChange() {
    refreshTitle();
    host.emit("doc-changed", undefined);
  },
  extensions: () => host.extension(),
});
host.attach(editor.view);
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

function load(info: DocInfo | null) {
  doc = info;
  editor.load(info?.content ?? "", info?.dir ?? null);
  savedDoc = editor.view.state.doc;
  sidebar.setActive(info?.path ?? null);
  refreshTitle();
  host.emit("doc-opened", info);
  editor.focus();
}

function setMode(next: Mode) {
  mode = next;
  workspaceEl.dataset.mode = next;
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

/** Some features store files next to the document, so an untitled one has to be saved first. */
async function ensureSaved(): Promise<boolean> {
  if (doc) return true;
  setStatus("Save the document first; images are stored next to it in ./assets");
  return commands.saveAs();
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
    host.emit("folder-opened", folder);
    setStatus(`Opened folder ${folder.root}`);
  },

  async save() {
    if (!doc) return commands.saveAs();
    // Saving is async and the user may keep typing, so remember the version we sent.
    const snapshot = editor.view.state.doc;
    await backend.saveFile(snapshot.toString());
    savedDoc = snapshot;
    refreshTitle();
    host.emit("doc-saved", doc);
    setStatus(`Saved ${doc.path}`);
  },

  /** Returns false if the user cancelled the dialog. */
  async saveAs(): Promise<boolean> {
    const snapshot = editor.view.state.doc;
    const info = await backend.saveFileAs(snapshot.toString());
    if (!info) return false;
    doc = info;
    editor.setBaseDir(info.dir);
    savedDoc = snapshot;
    sidebar.setActive(info.path);
    refreshTitle();
    host.emit("doc-saved", info);
    setStatus(`Saved ${info.path}`);
    return true;
  },

  async toggleMode() {
    setMode(mode === "live" ? "source" : "live");
  },

  async toggleSidebar() {
    sidebar.toggleVisible();
  },

  async openSettings() {
    openSettings(host);
  },
};

const coreCommands: Command[] = [
  { id: "file.new", title: "New File", key: "Mod-n", run: commands.newFile },
  { id: "file.open", title: "Open File…", key: "Mod-o", run: commands.open },
  { id: "folder.open", title: "Open Folder…", key: "Mod-Shift-o", run: commands.openFolder },
  { id: "file.save", title: "Save", key: "Mod-s", run: commands.save },
  { id: "file.save-as", title: "Save As…", key: "Mod-Shift-s", run: commands.saveAs },
  { id: "view.toggle-source", title: "Toggle Source Mode", key: "Mod-\\", run: commands.toggleMode },
  { id: "view.toggle-sidebar", title: "Toggle Sidebar", key: "Mod-Shift-e", run: commands.toggleSidebar },
  { id: "app.settings", title: "Settings…", key: "Mod-,", run: commands.openSettings },
];
for (const command of coreCommands) host.addCommand(command);

function run(task: () => Promise<unknown>) {
  task().catch((e) => setStatus(String(e), "error"));
}

window.addEventListener("keydown", (e) => {
  if (host.handleKey(e)) e.preventDefault();
});

modeButton.addEventListener("click", () => run(commands.toggleMode));
sidebarButton.addEventListener("click", () => run(commands.toggleSidebar));
settingsButton.addEventListener("click", () => run(commands.openSettings));

void listen<string>("file-changed", ({ payload }) => {
  if (isDirty()) {
    setStatus("File changed on disk, but you have unsaved changes here, so it was not reloaded", "error");
    return;
  }
  editor.replace(payload);
  savedDoc = editor.view.state.doc;
  refreshTitle();
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
  host.emit("folder-opened", initial.folder);
  load(initial.doc);
});
