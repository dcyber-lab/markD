// The plugin API. Built-in features are written against it too, so everything a feature needs
// from the app should be reachable from here.

import type { EditorState, Extension } from "@codemirror/state";
import type { EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import type { MarkdownConfig } from "@lezer/markdown";
import type { DocInfo, FolderInfo } from "../api";

export const API_VERSION = 1;

/** Undoes a registration. Everything a plugin registers is also undone when it is deactivated. */
export type Disposable = () => void;

export interface MarkdPlugin {
  /** Unique id, e.g. `markd.images` or `acme.math`. */
  id: string;
  name: string;
  activate(app: PluginApp): void | Promise<void>;
  deactivate?(): void;
}

export interface Command {
  id: string;
  title: string;
  /** Key binding in CodeMirror notation, e.g. `Mod-Shift-o` (`Mod` is ⌘ on macOS, Ctrl elsewhere). */
  key?: string;
  run(): unknown;
}

/** What a node renderer can do to the line(s) it is rendering. */
export interface RenderContext {
  readonly state: EditorState;
  /** Directory of the open document, for resolving relative paths; null when it is untitled. */
  readonly baseDir: string | null;
  /** True when the selection touches the lines of `from..to`; those lines should show their source. */
  isActive(from: number, to: number): boolean;
  /** Hide `from..to`. Ranges spanning a line break are ignored. */
  hide(from: number, to: number): void;
  /** Replace `from..to` with a widget. Ranges spanning a line break are ignored. */
  replace(from: number, to: number, widget: WidgetType): void;
  /** Add a CSS class to the text in `from..to`. */
  mark(from: number, to: number, className: string): void;
  /** Add a CSS class to each line in `from..to`; the class may depend on the line's start. */
  lineClass(from: number, to: number, className: string | ((lineFrom: number) => string)): void;
}

/**
 * Renders one syntax node in live mode. `node` is only valid during the call; use `node.node`
 * to keep or navigate it. Return `false` to skip the node's children.
 */
export type NodeRenderer = (node: SyntaxNodeRef, ctx: RenderContext) => void | false;

/**
 * Renders a top-level block node (e.g. `"Table"`) as one widget that replaces all of its lines in
 * live mode while the selection is outside them. Return null, or throw, to show the source instead.
 * Blocks nested in lists or blockquotes are not offered, since their lines carry markup of the
 * enclosing block.
 */
export type BlockRenderer = (node: SyntaxNodeRef, state: EditorState) => WidgetType | null;

export interface EventMap {
  /** A document was opened, or a new untitled one started (`null`). */
  "doc-opened": DocInfo | null;
  "doc-saved": DocInfo;
  /** The editor content changed; fires on every edit, so debounce heavy work. */
  "doc-changed": undefined;
  "folder-opened": FolderInfo | null;
}

/**
 * A named list plugins contribute to, letting one plugin extend another. The images plugin, for
 * example, reads image stores from `markd.images.stores`, and the S3 plugin adds one.
 */
export interface ExtensionPoint<T> {
  add(item: T): Disposable;
  items(): readonly T[];
}

/** A section in the Settings dialog. */
export interface SettingsSection {
  id: string;
  title: string;
  /** Fill `el` with the section's controls. Called each time the dialog opens. */
  render(el: HTMLElement): void;
}

export interface PluginApp {
  readonly apiVersion: number;

  commands: {
    add(command: Command): Disposable;
  };

  extensionPoint<T>(id: string): ExtensionPoint<T>;

  settings: {
    addSection(section: SettingsSection): Disposable;
  };

  markdown: {
    /** Extend the Markdown parser (a `@lezer/markdown` extension), e.g. to add `$math$`. */
    addSyntax(extension: MarkdownConfig): Disposable;
  };

  render: {
    /** Render syntax nodes with these names (e.g. `"Image"`) in live mode. */
    node(names: string | string[], renderer: NodeRenderer): Disposable;
    /** Render whole block nodes with these names as widgets in live mode. */
    block(names: string | string[], renderer: BlockRenderer): Disposable;
    /** Re-render live mode, e.g. after a setting that renderers depend on changed. */
    refresh(): void;
  };

  editor: {
    /** Add any CodeMirror extension: themes, keymaps, DOM event handlers, view plugins, ... */
    addExtension(extension: Extension): Disposable;
    /** The editor view. It is reused across documents. */
    readonly view: EditorView;
  };

  statusBar: {
    /** A status bar element owned by the plugin; removed when the plugin is deactivated. */
    add(id: string): HTMLElement;
  };

  events: {
    on<K extends keyof EventMap>(name: K, handler: (payload: EventMap[K]) => void): Disposable;
  };

  workspace: {
    /** The open document, or null when it is untitled. */
    readonly doc: DocInfo | null;
    /** Make sure the document has a file on disk; false if the user cancelled Save As. */
    ensureSaved(): Promise<boolean>;
    /**
     * Open a file, saving changes to the current document first. Only files inside the open folder
     * can be opened this way; anything else is rejected by the backend.
     */
    open(path: string): Promise<void>;
    setStatus(message: string, kind?: "info" | "error"): void;
    /** Run a task, reporting a failure in the status bar. */
    run(task: () => Promise<unknown>): void;
  };
}
