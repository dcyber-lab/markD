import { invoke } from "@tauri-apps/api/core";

export interface DocInfo {
  path: string;
  dir: string;
  name: string;
  content: string;
}

// Commands defined in src-tauri/src/lib.rs. The backend decides every path; the frontend only sends content.
export const backend = {
  initialFile: () => invoke<DocInfo | null>("initial_file"),
  openFile: () => invoke<DocInfo | null>("open_file"),
  saveFile: (content: string) => invoke<void>("save_file", { content }),
  saveFileAs: (content: string) => invoke<DocInfo | null>("save_file_as", { content }),
};
