import type { Text } from "@codemirror/state";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { backend, type DocInfo, type OpenedDoc } from "./api";
import { createEditor, type Mode } from "./editor";
import type { Command } from "./plugins/api";
import { builtinPlugins } from "./plugins/builtin";
import { PluginHost } from "./plugins/host";
import { Outline } from "./outline";
import { openSettings } from "./settings-dialog";
import { Sidebar } from "./sidebar";

const appWindow = getCurrentWindow();
const workspaceEl = document.querySelector<HTMLElement>("#workspace")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const saveStateEl = document.querySelector<HTMLElement>("#save-state")!;
const modeButton = document.querySelector<HTMLButtonElement>("#mode-toggle")!;
const sidebarButton = document.querySelector<HTMLButtonElement>("#sidebar-toggle")!;
const settingsButton = document.querySelector<HTMLButtonElement>("#settings-toggle")!;

const MODE_KEY = "markd.mode";

/**
 * Documents larger than this (about 20 MB) open in source mode. Live rendering keeps work per
 * edit that grows with the parsed text, and the parser only runs a limited distance ahead of the
 * view, so far into such a file there would be nothing to render anyway.
 */
const LARGE_DOC_CHARS = 20 * 1024 * 1024;
/** A document with a file is saved this long after the last edit. */
const AUTOSAVE_MS = 1000;

let doc: DocInfo | null = null;
/** The mode the user chose, kept across sessions. */
let preferredMode: Mode = readMode();
/** The mode shown now; a large document shows source whatever the preference. */
let mode: Mode = preferredMode;
/** The open document is over LARGE_DOC_CHARS. */
let largeDoc = false;
/** The open file is not Markdown: shown as highlighted source, never rendered. */
let codeDoc = false;
let windowTitle = "";
let autosaveTimer = 0;
/** The last save started. Saves run one at a time, so an older text never lands on disk last. */
let saving: Promise<unknown> = Promise.resolve();
/** When this document was last written by markd, shown in the status bar. */
let lastSaved: Date | null = null;
let saveFailed = false;

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

const outline = new Outline(document.querySelector<HTMLElement>("#outline")!);

const editor = createEditor(document.querySelector<HTMLElement>("#editor")!, {
  mode,
  onChange() {
    refreshDocState();
    scheduleAutosave();
    host.emit("doc-changed", undefined);
  },
  extensions: () => [host.extension(), outline.extension],
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
    refreshDocState();
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
  delete statusEl.dataset.largeFile;
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

function formatSaveTime(date: Date): string {
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** The window title, and the status bar's note on when the document was saved. */
function refreshDocState() {
  let note = "";
  let hint = "";
  if (!doc) {
    if (isDirty()) {
      note = "Not saved";
      hint = "Untitled documents are not saved automatically: ⌘/Ctrl+S to save";
    }
  } else if (saveFailed) {
    note = "Save failed";
    hint = `Could not write ${doc.path}; markd tries again after the next edit`;
  } else if (lastSaved) {
    note = `Saved ${formatSaveTime(lastSaved)}`;
    hint = `Saved to ${doc.path} (saved automatically as you type)`;
  }
  saveStateEl.textContent = note;
  saveStateEl.title = hint;
  saveStateEl.dataset.kind = saveFailed ? "error" : "info";

  const title = `${isDirty() ? "● " : ""}${doc?.name ?? "Untitled"} — markd`;
  if (title === windowTitle) return;
  windowTitle = title;
  document.title = title;
  void appWindow.setTitle(title);
}

/**
 * Write the editor's text to the open document's file, after any save already under way. Unless
 * forced, a document with nothing unsaved is skipped by the time its turn comes.
 */
function writeDoc(force = false): Promise<void> {
  const next = saving.then(async () => {
    if (!doc || !(force || isDirty())) return;
    // Saving is async and the user may keep typing, so remember the version we sent.
    const snapshot = editor.view.state.doc;
    try {
      await backend.saveFile(snapshot.toString());
    } catch (e) {
      saveFailed = true;
      refreshDocState();
      throw e;
    }
    savedDoc = snapshot;
    lastSaved = new Date();
    if (saveFailed) setStatus(""); // the error shown was about the failed save
    saveFailed = false;
    refreshDocState();
    host.emit("doc-saved", doc);
  });
  saving = next.catch(() => {});
  return next;
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  if (doc) autosaveTimer = window.setTimeout(autosave, AUTOSAVE_MS);
}

/** Save a document that has a file, without a status message. An untitled one waits for Save As. */
function autosave() {
  clearTimeout(autosaveTimer);
  if (doc && isDirty()) run(() => writeDoc());
}

function load(opened: OpenedDoc | null) {
  clearTimeout(autosaveTimer);
  lastSaved = null;
  saveFailed = false;
  // Only the path and name are kept; the text lives in the editor.
  const info = opened && { path: opened.path, dir: opened.dir, name: opened.name };
  doc = info;
  // Pick the mode before loading, so live rendering never starts on a large document.
  largeDoc = (opened?.content.length ?? 0) > LARGE_DOC_CHARS;
  codeDoc = info !== null && !/\.(md|markdown|mdown|txt)$/i.test(info.name);
  const wanted = largeDoc || codeDoc ? "source" : preferredMode;
  if (wanted !== mode) showMode(wanted);
  modeButton.title = codeDoc
    ? "Not a Markdown file: shown as source"
    : largeDoc
    ? "Large file: opened in source mode. ⌘/Ctrl+\\ turns on live rendering (slower)"
    : "⌘/Ctrl+\\";
  editor.load(opened?.content ?? "", info?.dir ?? null, codeDoc ? info!.name : null);
  savedDoc = editor.view.state.doc;
  sidebar.setActive(info?.path ?? null);
  refreshDocState();
  host.emit("doc-opened", info);
  editor.focus();
  if (largeDoc && opened) {
    const mb = Math.round(opened.content.length / (1024 * 1024));
    setStatus(`Large file (about ${mb} MB): showing source. ⌘/Ctrl+\\ turns on live rendering, which is slower`);
    statusEl.dataset.largeFile = "";
  } else if (statusEl.dataset.largeFile !== undefined) {
    // The note was about the previous document.
    setStatus("");
  }
}

function showMode(next: Mode) {
  mode = next;
  workspaceEl.dataset.mode = next;
  modeButton.textContent = next === "live" ? "Live" : "Source";
  editor.setMode(next);
}

/** Switch modes. A switch on a large document applies to it only and is not remembered. */
function setMode(next: Mode) {
  if (codeDoc) return;
  showMode(next);
  if (largeDoc) return;
  preferredMode = next;
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
  // No autosave may start while the backend switches to another document.
  clearTimeout(autosaveTimer);
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
    clearTimeout(autosaveTimer);
    // The status bar's save time is the confirmation.
    await writeDoc(true);
  },

  /** Returns false if the user cancelled the dialog. */
  async saveAs(): Promise<boolean> {
    const snapshot = editor.view.state.doc;
    const info = await backend.saveFileAs(snapshot.toString());
    if (!info) return false;
    doc = info;
    editor.setBaseDir(info.dir);
    savedDoc = snapshot;
    lastSaved = new Date();
    saveFailed = false;
    sidebar.setActive(info.path);
    refreshDocState();
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

  /** Show the outline, or hide the sidebar if the outline is already showing. */
  async toggleOutline() {
    if (sidebar.visible && sidebar.tab === "outline") {
      sidebar.toggleVisible();
    } else {
      sidebar.show();
      sidebar.showTab("outline");
    }
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
  { id: "view.outline", title: "Toggle Outline", key: "Mod-Shift-t", run: commands.toggleOutline },
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

void listen("file-changed", () =>
  run(async () => {
    if (isDirty()) {
      setStatus("File changed on disk, but you have unsaved changes here, so it was not reloaded", "error");
      return;
    }
    const text = await backend.documentContent();
    if (isDirty()) return; // edited while the new text was on its way
    editor.replace(text);
    savedDoc = editor.view.state.doc;
    refreshDocState();
    setStatus("File changed on disk and was reloaded");
  }),
);

void listen("tree-changed", () => run(() => sidebar.refresh()));

// Switching to another app saves right away rather than after the autosave delay.
window.addEventListener("blur", autosave);

// ⌘Q comes here too (see app_menu in lib.rs).
void appWindow.onCloseRequested(async (e) => {
  try {
    if (!(await leaveCurrent())) e.preventDefault();
  } catch (err) {
    e.preventDefault();
    setStatus(`Not closed: the document could not be saved (${err})`, "error");
  }
});

showMode(mode);
run(async () => {
  const initial = await backend.initialState();
  await sidebar.setFolder(initial.folder);
  host.emit("folder-opened", initial.folder);
  load(initial.doc);
});
