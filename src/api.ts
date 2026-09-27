import { invoke } from "@tauri-apps/api/core";

export interface DocInfo {
  path: string;
  dir: string;
  name: string;
  content: string;
}

export interface FolderInfo {
  root: string;
  name: string;
}

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface Renamed {
  path: string;
  /** The open document, if the rename moved it. */
  doc: DocInfo | null;
}

export interface InitialState {
  folder: FolderInfo | null;
  doc: DocInfo | null;
}

// Commands defined in src-tauri/src. The backend decides every path: files come from system
// dialogs or the command line, and folder operations are limited to the folder the user opened.
export const backend = {
  initialState: () => invoke<InitialState>("initial_state"),
  openFile: () => invoke<DocInfo | null>("open_file"),
  saveFile: (content: string) => invoke<void>("save_file", { content }),
  saveFileAs: (content: string) => invoke<DocInfo | null>("save_file_as", { content }),

  openFolder: () => invoke<FolderInfo | null>("open_folder"),
  listDir: (path: string) => invoke<Entry[]>("list_dir", { path }),
  openEntry: (path: string) => invoke<DocInfo>("open_entry", { path }),
  createFile: (dir: string, name: string) => invoke<string>("create_file", { dir, name }),
  createDir: (dir: string, name: string) => invoke<string>("create_dir", { dir, name }),
  renameEntry: (path: string, name: string) => invoke<Renamed>("rename_entry", { path, name }),
  deleteEntry: (path: string) => invoke<boolean>("delete_entry", { path }),
};
