import { Menu, type MenuItemOptions, type PredefinedMenuItemOptions } from "@tauri-apps/api/menu";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { backend, type DocInfo, type Entry, type FolderInfo } from "./api";
import { revealLabel } from "./platform";

const WIDTH_KEY = "markd.sidebar.width";
const HIDDEN_KEY = "markd.sidebar.hidden";
const EXPANDED_KEY = "markd.sidebar.expanded:";
const MIN_WIDTH = 160;
const MAX_WIDTH = 480;

type Editing = { kind: "rename"; path: string } | { kind: "new-file" | "new-folder"; dir: string };

export interface SidebarHandlers {
  openFile(path: string): Promise<void>;
  openFolder(): Promise<void>;
  /** A rename moved the open document; this is its new location. */
  docMoved(doc: DocInfo): void;
  /** The open document was moved to the trash. */
  docRemoved(): void;
  /** Run a task, reporting failures in the status bar. */
  run(task: () => Promise<unknown>): void;
}

// UI preferences only, so failing to read or write them is fine.
function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

/** The folder tree. Folders are listed lazily as they are expanded. */
export class Sidebar {
  private folder: FolderInfo | null = null;
  private listings = new Map<string, Entry[]>();
  /** Every rendered entry, with the folder it is listed in. */
  private entries = new Map<string, { entry: Entry; parent: string }>();
  private expanded = new Set<string>();
  private active: string | null = null;
  private editing: Editing | null = null;
  private generation = 0;
  private menu: Menu | null = null;

  private readonly tree: HTMLElement;
  private readonly nameEl: HTMLElement;

  constructor(
    private readonly el: HTMLElement,
    private readonly handlers: SidebarHandlers,
  ) {
    this.tree = el.querySelector<HTMLElement>("#tree")!;
    this.nameEl = el.querySelector<HTMLElement>("#folder-name")!;

    el.querySelector("#open-folder")!.addEventListener("click", () => handlers.run(handlers.openFolder));
    el.querySelector("#new-file")!.addEventListener("click", () =>
      handlers.run(() => this.startCreate("new-file", this.folder!.root)),
    );
    el.querySelector("#new-folder")!.addEventListener("click", () =>
      handlers.run(() => this.startCreate("new-folder", this.folder!.root)),
    );

    this.tree.addEventListener("click", (e) => {
      const entry = this.entryAt(e.target);
      if (!entry) return;
      handlers.run(() => (entry.isDir ? this.toggle(entry.path) : handlers.openFile(entry.path)));
    });
    this.tree.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.folder) handlers.run(() => this.showMenu(this.entryAt(e.target)));
    });

    this.setWidth(loadPref(WIDTH_KEY, 240));
    el.hidden = loadPref(HIDDEN_KEY, false);
    this.setupResizer(el.querySelector<HTMLElement>("#sidebar-resizer")!);
  }

  async setFolder(folder: FolderInfo | null) {
    this.folder = folder;
    this.editing = null;
    this.listings.clear();
    this.expanded = new Set(folder ? loadPref<string[]>(EXPANDED_KEY + folder.root, []) : []);
    this.el.classList.toggle("has-folder", folder !== null);
    this.nameEl.textContent = folder?.name ?? "";
    this.nameEl.title = folder?.root ?? "";
    await this.refresh();
  }

  /** Re-read the root and every expanded folder, e.g. after a change on disk. */
  async refresh() {
    // While a name is being typed, skip; the tree refreshes once the edit finishes.
    if (this.editing) return;
    const gen = ++this.generation;
    if (!this.folder) {
      this.render();
      return;
    }
    const dirs = [this.folder.root, ...this.expanded];
    const results = await Promise.allSettled(dirs.map((dir) => backend.listDir(dir)));
    if (gen !== this.generation) return; // a newer refresh or folder switch won
    this.listings.clear();
    results.forEach((result, i) => {
      if (result.status === "fulfilled") this.listings.set(dirs[i], result.value);
      else this.expanded.delete(dirs[i]); // removed or renamed on disk
    });
    this.saveExpanded();
    this.render();
  }

  setActive(path: string | null) {
    this.active = path;
    if (!this.editing) this.render();
  }

  show() {
    this.el.hidden = false;
    savePref(HIDDEN_KEY, false);
  }

  toggleVisible() {
    this.el.hidden = !this.el.hidden;
    savePref(HIDDEN_KEY, this.el.hidden);
  }

  private entryAt(target: EventTarget | null): Entry | null {
    const row = (target as Element | null)?.closest<HTMLElement>(".tree-row[data-path]");
    return row ? (this.entries.get(row.dataset.path!)?.entry ?? null) : null;
  }

  private saveExpanded() {
    if (this.folder) savePref(EXPANDED_KEY + this.folder.root, [...this.expanded]);
  }

  private async toggle(path: string) {
    if (this.expanded.delete(path)) {
      this.saveExpanded();
      this.render();
      return;
    }
    this.expanded.add(path);
    this.saveExpanded();
    if (!this.listings.has(path)) this.listings.set(path, await backend.listDir(path));
    this.render();
  }

  private render() {
    this.entries.clear();
    const rows: HTMLElement[] = [];
    const editing = this.editing;

    const walk = (dir: string, depth: number) => {
      if (editing && editing.kind !== "rename" && editing.dir === dir) {
        rows.push(this.inputRow(editing, depth, ""));
      }
      for (const entry of this.listings.get(dir) ?? []) {
        this.entries.set(entry.path, { entry, parent: dir });
        if (editing?.kind === "rename" && editing.path === entry.path) {
          rows.push(this.inputRow(editing, depth, entry.name));
        } else {
          rows.push(this.row(entry, depth));
        }
        if (entry.isDir && this.expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    if (this.folder) walk(this.folder.root, 0);
    this.tree.replaceChildren(...rows);

    const input = this.tree.querySelector<HTMLInputElement>(".tree-input");
    if (input) {
      input.focus();
      // Select the name without its extension, like Finder and VS Code.
      const dot = input.value.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    }
  }

  private row(entry: Entry, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.classList.toggle("is-dir", entry.isDir);
    row.classList.toggle("is-open", this.expanded.has(entry.path));
    row.classList.toggle("is-active", entry.path === this.active);
    row.dataset.path = entry.path;
    row.style.setProperty("--depth", String(depth));

    const twisty = document.createElement("span");
    twisty.className = "tree-twisty";
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = entry.name;
    row.append(twisty, label);
    return row;
  }

  private inputRow(editing: Editing, depth: number, value: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row is-editing";
    row.style.setProperty("--depth", String(depth));
    const twisty = document.createElement("span");
    twisty.className = "tree-twisty";
    const input = document.createElement("input");
    input.className = "tree-input";
    input.value = value;
    input.spellcheck = false;
    input.placeholder = editing.kind === "new-folder" ? "Folder name" : editing.kind === "new-file" ? "File name" : "";

    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.handlers.run(() => this.finishEditing(editing, commit ? input.value : ""));
    };
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return; // Enter confirms an IME candidate, not the name
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
      else return;
      e.preventDefault();
    });
    input.addEventListener("blur", () => finish(true));

    row.append(twisty, input);
    return row;
  }

  private async startCreate(kind: "new-file" | "new-folder", dir: string) {
    if (dir !== this.folder!.root && !this.expanded.has(dir)) {
      this.expanded.add(dir);
      this.saveExpanded();
      if (!this.listings.has(dir)) this.listings.set(dir, await backend.listDir(dir));
    }
    this.editing = { kind, dir };
    this.render();
  }

  private startRename(path: string) {
    this.editing = { kind: "rename", path };
    this.render();
  }

  private async finishEditing(editing: Editing, value: string) {
    if (this.editing !== editing) return; // superseded by another edit
    this.editing = null;
    const name = value.trim();
    try {
      if (!name) return;
      if (editing.kind === "rename") {
        const current = this.entries.get(editing.path)?.entry;
        if (!current || name === current.name) return;
        const result = await backend.renameEntry(editing.path, name);
        if (this.expanded.delete(editing.path)) this.expanded.add(result.path);
        if (result.doc) this.handlers.docMoved(result.doc);
      } else if (editing.kind === "new-file") {
        await this.handlers.openFile(await backend.createFile(editing.dir, name));
      } else {
        this.expanded.add(await backend.createDir(editing.dir, name));
      }
      this.saveExpanded();
    } finally {
      await this.refresh();
    }
  }

  private async remove(entry: Entry) {
    const confirmed = await ask(`Move "${entry.name}" to the Trash?`, {
      title: "markd",
      kind: "warning",
      okLabel: "Move to Trash",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    const removedDoc = await backend.deleteEntry(entry.path);
    this.expanded.delete(entry.path);
    this.saveExpanded();
    if (removedDoc) this.handlers.docRemoved();
    await this.refresh();
  }

  private async showMenu(entry: Entry | null) {
    const { run } = this.handlers;
    const dir = !entry ? this.folder!.root : entry.isDir ? entry.path : this.entries.get(entry.path)!.parent;
    const items: (MenuItemOptions | PredefinedMenuItemOptions)[] = [
      { text: "New File", action: () => run(() => this.startCreate("new-file", dir)) },
      { text: "New Folder", action: () => run(() => this.startCreate("new-folder", dir)) },
    ];
    if (entry) {
      items.push(
        { item: "Separator" },
        { text: "Rename", action: () => this.startRename(entry.path) },
        { text: "Move to Trash", action: () => run(() => this.remove(entry)) },
        { item: "Separator" },
        { text: revealLabel, action: () => run(() => revealItemInDir(entry.path)) },
      );
    }
    // Menus are backend resources; keep only the latest one alive.
    void this.menu?.close();
    this.menu = await Menu.new({ items });
    await this.menu.popup();
  }

  private setWidth(px: number) {
    this.el.style.width = `${Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px))}px`;
  }

  private setupResizer(handle: HTMLElement) {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const left = this.el.getBoundingClientRect().left;
      const move = (ev: PointerEvent) => this.setWidth(ev.clientX - left);
      handle.addEventListener("pointermove", move);
      handle.addEventListener(
        "pointerup",
        () => {
          handle.removeEventListener("pointermove", move);
          savePref(WIDTH_KEY, this.el.getBoundingClientRect().width);
        },
        { once: true },
      );
    });
  }
}
