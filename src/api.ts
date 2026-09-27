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

export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  /** Where the bucket is publicly readable (e.g. a CDN); links point here. */
  publicUrl: string;
  pathStyle: boolean;
  accessKeyId: string;
}

export interface Settings {
  images: {
    /** Image store id for new images, e.g. `local` or `s3`. */
    storage: string;
    s3: S3Settings;
  };
}

/** Settings as returned by the backend. Secrets stay in the OS keychain and are never sent. */
export interface SettingsView extends Settings {
  hasS3Secret: boolean;
  /** The base URL S3 image links start with, once S3 is configured. */
  s3PublicBase: string | null;
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

  /** Store pasted image bytes in the document's `assets` folder; returns the relative link. */
  saveImage: (bytes: Uint8Array, name: string) =>
    invoke<string>("save_image", bytes, { headers: { "x-file-name": name } }),
  /** Copy the images from the last OS drop into `assets`; returns their relative links. */
  importDroppedImages: () => invoke<string[]>("import_dropped_images"),

  getSettings: () => invoke<SettingsView>("get_settings"),
  /** `s3Secret`: null keeps the stored secret, "" removes it, anything else replaces it. */
  setSettings: (settings: Settings, s3Secret: string | null = null) =>
    invoke<SettingsView>("set_settings", { settings, s3Secret }),

  /** Upload pasted image bytes to S3; returns the public link. */
  s3UploadImage: (bytes: Uint8Array, name: string) =>
    invoke<string>("s3_upload_image", bytes, { headers: { "x-file-name": name } }),
  /** Upload the images from the last OS drop to S3; returns their public links. */
  s3UploadDropped: () => invoke<string[]>("s3_upload_dropped"),
  /** Upload, read back and delete a test object; resolves with a success message. */
  s3Test: () => invoke<string>("s3_test"),
};
