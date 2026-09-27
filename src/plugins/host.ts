import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { MarkdownConfig } from "@lezer/markdown";
import { nodeRenderers } from "../live-preview";
import { isMac } from "../platform";
import {
  API_VERSION,
  type Command,
  type Disposable,
  type EventMap,
  type MarkdPlugin,
  type NodeRenderer,
  type PluginApp,
} from "./api";

type Listener = (payload: never) => void;

/** Does a CodeMirror-style key such as `Mod-Shift-o` match this event? */
function keyMatches(key: string, e: KeyboardEvent): boolean {
  const parts = key.split(/-(?!$)/);
  const name = parts.pop()!.toLowerCase();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const mod = mods.has("mod");
  return (
    e.key.toLowerCase() === name &&
    e.metaKey === (mods.has("meta") || (mod && isMac)) &&
    e.ctrlKey === (mods.has("ctrl") || (mod && !isMac)) &&
    e.altKey === mods.has("alt") &&
    e.shiftKey === mods.has("shift")
  );
}

function remove<T>(list: T[], item: T) {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}

/**
 * Loads plugins and collects what they contribute. Contributions reach the editor through one
 * compartment, reconfigured whenever a plugin adds or removes something.
 */
export class PluginHost {
  private readonly commands: Command[] = [];
  private readonly syntax: MarkdownConfig[] = [];
  private readonly renderers = new Map<string, NodeRenderer[]>();
  private readonly extensions: Extension[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly active = new Map<string, { plugin: MarkdPlugin; disposers: Disposable[] }>();
  private readonly slot = new Compartment();
  private view: EditorView | null = null;

  constructor(
    private readonly statusBar: HTMLElement,
    private readonly workspace: PluginApp["workspace"],
  ) {}

  /** The editor extension carrying all plugin contributions. Include it in every editor state. */
  extension(): Extension {
    return this.slot.of(this.contributions());
  }

  attach(view: EditorView) {
    this.view = view;
  }

  private contributions(): Extension {
    return [
      markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [...this.syntax] }),
      nodeRenderers.of(new Map(this.renderers)),
      [...this.extensions],
    ];
  }

  private changed() {
    this.view?.dispatch({ effects: this.slot.reconfigure(this.contributions()) });
  }

  /** Add to a list and return how to take it out again. */
  private add<T>(list: T[], item: T, reconfigure = true): Disposable {
    list.push(item);
    if (reconfigure) this.changed();
    return () => {
      remove(list, item);
      if (reconfigure) this.changed();
    };
  }

  addCommand(command: Command): Disposable {
    return this.add(this.commands, command, false);
  }

  /** Run the command bound to this key, if any. Returns whether one ran. */
  handleKey(e: KeyboardEvent): boolean {
    const command = this.commands.find((c) => c.key && keyMatches(c.key, e));
    if (!command) return false;
    this.workspace.run(async () => command.run());
    return true;
  }

  emit<K extends keyof EventMap>(name: K, payload: EventMap[K]) {
    for (const listener of this.listeners.get(name) ?? []) {
      try {
        (listener as (p: EventMap[K]) => void)(payload);
      } catch (e) {
        console.error(`[markd] "${name}" listener failed`, e);
      }
    }
  }

  private report(pluginId: string, e: unknown) {
    console.error(`[markd] plugin ${pluginId} failed`, e);
    this.workspace.setStatus(`Plugin ${pluginId} failed: ${e}`, "error");
  }

  /**
   * Start a plugin. Everything it registers is recorded so `deactivate` can undo it, and its
   * renderers and listeners are wrapped so an error in one plugin cannot break the editor.
   */
  activate(plugin: MarkdPlugin) {
    if (this.active.has(plugin.id)) return;
    const disposers: Disposable[] = [];
    const track = (d: Disposable) => (disposers.push(d), d);
    const host = this;
    let failed = false;

    const guard = <A extends unknown[], R>(fn: (...args: A) => R, fallback: R) =>
      (...args: A): R => {
        try {
          return fn(...args);
        } catch (e) {
          // Report once; a broken renderer would otherwise fire on every keystroke.
          if (!failed) host.report(plugin.id, e);
          failed = true;
          return fallback;
        }
      };

    const app: PluginApp = {
      apiVersion: API_VERSION,
      commands: {
        add: (command) => track(this.addCommand(command)),
      },
      markdown: {
        addSyntax: (extension) => track(this.add(this.syntax, extension)),
      },
      render: {
        node: (names, renderer) => {
          const wrapped = guard(renderer, undefined);
          const lists = (typeof names === "string" ? [names] : names).map((name) => {
            let list = this.renderers.get(name);
            if (!list) this.renderers.set(name, (list = []));
            return list;
          });
          for (const list of lists) list.push(wrapped);
          this.changed();
          return track(() => {
            for (const list of lists) remove(list, wrapped);
            this.changed();
          });
        },
      },
      editor: {
        addExtension: (extension) => track(this.add(this.extensions, extension)),
        get view() {
          return host.view!;
        },
      },
      statusBar: {
        add: (id) => {
          const el = document.createElement("span");
          el.className = "status-item";
          el.dataset.plugin = plugin.id;
          el.dataset.item = id;
          this.statusBar.append(el);
          track(() => el.remove());
          return el;
        },
      },
      events: {
        on: (name, handler) => {
          let set = this.listeners.get(name);
          if (!set) this.listeners.set(name, (set = new Set()));
          const listener = guard(handler, undefined) as Listener;
          set.add(listener);
          return track(() => set.delete(listener));
        },
      },
      workspace: this.workspace,
    };

    this.active.set(plugin.id, { plugin, disposers });
    try {
      void Promise.resolve(plugin.activate(app)).catch((e) => this.report(plugin.id, e));
    } catch (e) {
      this.report(plugin.id, e);
    }
  }

  deactivate(id: string) {
    const entry = this.active.get(id);
    if (!entry) return;
    this.active.delete(id);
    try {
      entry.plugin.deactivate?.();
    } catch (e) {
      this.report(id, e);
    }
    for (const dispose of entry.disposers.reverse()) dispose();
  }
}
