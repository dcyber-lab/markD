# markd

A local Markdown editor that renders in place, Typora / Obsidian style: lines without the cursor show the rendered result, and the line you're editing shows its source. Built with Tauri 2 (Rust) and CodeMirror 6.

Files stay plain Markdown on disk. Rendering is only a view layer on top of the source, so saving never rewrites your formatting.

## Development

```bash
pnpm install
pnpm tauri dev                   # run in development mode
pnpm tauri dev -- -- note.md     # open a file on startup
pnpm tauri dev -- -- ~/notes     # open a folder on startup
pnpm tauri build                 # build an installer for the current platform
```

Requires Rust, Node 22+, pnpm, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

## Releasing

Push a version tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) then creates a draft release with generated notes, builds the installers, uploads them, and publishes the release once every platform has succeeded:

| Platform | Installers |
|---|---|
| macOS (universal: Apple Silicon + Intel) | `.dmg`, `.app.tar.gz` |
| Windows | `.msi`, `-setup.exe` |
| Linux (built on Ubuntu 22.04) | `.deb`, `.rpm`, `.AppImage` |

- The app version comes from the tag, so there is nothing to bump in the code. Tags must be plain `vX.Y.Z` because Windows installers only accept numeric versions.
- If a platform fails, the release stays a draft. Re-running the failed jobs uploads to the same draft.
- Builds are not signed with a paid certificate yet. On macOS the app is ad-hoc signed, so the first launch needs right-click → Open (or System Settings → Privacy & Security → Open Anyway); on Windows, SmartScreen asks for confirmation. Apple notarization and Windows code signing can be added later through repository secrets.

## Shortcuts

| Shortcut | Action |
|---|---|
| ⌘/Ctrl + N | New |
| ⌘/Ctrl + O | Open file |
| ⌘/Ctrl + Shift + O | Open folder |
| ⌘/Ctrl + S | Save (Save As for untitled documents) |
| ⌘/Ctrl + Shift + S | Save As |
| ⌘/Ctrl + Shift + E | Show / hide the sidebar |
| ⌘/Ctrl + \ | Toggle live rendering / source mode |
| ⌘/Ctrl + F | Find and replace |
| ⌘/Ctrl + , | Settings |
| ⌘/Ctrl + click a link | Open it in the system browser |

## Features

**Live rendering:** headings, bold / italic / strikethrough, inline code, links, bullet lists, task lists (click to toggle), blockquotes, horizontal rules, fenced code blocks (with syntax highlighting), images (relative local paths or remote URLs), and tables. Tables render as real tables with column alignment and inline formatting in cells; clicking a cell, or moving the cursor into a table, shows its source. A table nested in a list or blockquote stays as source in a monospace font.

**Folder sidebar:** open a folder to browse its subfolders and Markdown files (hidden entries are skipped; folders load lazily as you expand them). Right-click for New File, New Folder, Rename (inline), Move to Trash, and Reveal in Finder / Explorer. The tree follows changes made on disk, and the last folder, expanded folders, and sidebar width are restored on the next launch. Switching files from the sidebar saves unsaved changes first; an untitled document asks before discarding.

**Images:** paste an image (e.g. a screenshot) or drop image files onto the window, and markd stores them in an `assets/` folder next to the document and inserts a relative link such as `![](assets/image-20260927-161305.png)`. Existing names are never overwritten (`-1`, `-2`, ... are appended), and images already in `assets/` are linked rather than copied. An untitled document is saved first so the images have somewhere to go.

**S3 image storage:** images can go to any S3-compatible bucket instead (AWS S3, Cloudflare R2, MinIO, Aliyun OSS, ...) that is publicly readable, directly or through a CDN. Links point at the public URL, so documents render anywhere. Uploaded keys include a content hash (`images/image-20260927-172012-9bb75220fd.png`), so nothing is overwritten. markd displays these images through a local cache, so they still show offline once seen. Configure it in Settings (⌘/Ctrl + ,) and use "Save and test" to check the upload and public read. Choose the default storage in Settings; a document can override it in its front matter:

```markdown
---
image-storage: s3   # or local
---
```

## Plugins

Features are built as plugins on a small core. The core owns documents, files, the sidebar and the editor; everything else, including the built-in live rendering, images and word count, is a plugin written against the API in [`src/plugins/api.ts`](src/plugins/api.ts). New features are added the same way.

```ts
import type { MarkdPlugin } from "./plugins/api";

export const example: MarkdPlugin = {
  id: "example.hello",
  name: "Hello",
  activate(app) {
    app.commands.add({ id: "hello.say", title: "Say Hello", key: "Mod-Shift-h", run: () => app.workspace.setStatus("Hello") });
    app.render.node("StrongEmphasis", (node, ctx) => ctx.mark(node.from, node.to, "my-bold"));
    app.events.on("doc-saved", (doc) => console.log("saved", doc.path));
  },
};
```

| API | What it is for |
|---|---|
| `commands.add` | Commands with optional key bindings (`Mod-Shift-o`; `Mod` is ⌘ on macOS, Ctrl elsewhere) |
| `markdown.addSyntax` | Extend the parser with a [`@lezer/markdown`](https://github.com/lezer-parser/markdown) extension, e.g. `$math$` or `[[wiki links]]` |
| `render.node`, `render.refresh` | Render syntax nodes in live mode: hide markup, add classes, replace ranges with widgets |
| `render.block` | Replace a whole top-level block (e.g. a table) with one widget while the cursor is outside it; returning null keeps the source |
| `editor.addExtension` | Any CodeMirror extension: themes, keymaps, DOM event handlers, view plugins |
| `statusBar.add` | An element in the status bar |
| `events.on` | `doc-opened`, `doc-changed`, `doc-saved`, `folder-opened` |
| `workspace` | The open document, `ensureSaved()`, status messages |
| `extensionPoint` | Named lists plugins use to extend each other (the S3 plugin adds a store to `markd.images.stores`) |
| `settings.addSection` | A section in the Settings dialog |

Everything a plugin registers is undone when it is deactivated, and errors thrown by a plugin's renderers or listeners are reported in the status bar instead of breaking the editor.

Built-in plugins live in `src/plugins/builtin/`: basic formatting, lists and tasks, code blocks, tables, front matter, images, S3 image storage, and word count.

Loading third-party plugins from a plugins folder is the next step. Plugins will run with the same privileges as the app itself (like Obsidian's), so the backend's folder-scoped path checks stay the security boundary.

## Layout

```
src/
  main.ts           core: document state, commands, external changes, close confirmation
  editor.ts         CodeMirror 6 setup, theme, highlighting, mode switching
  live-preview.ts   live rendering engine: walks the syntax tree and calls plugin node and block renderers
  plugins/
    api.ts          the plugin API (types)
    host.ts         loads plugins, collects their contributions, isolates their errors
    builtin/        built-in features, one plugin each
  sidebar.ts        folder tree, context menu, inline rename, resizing
  settings-dialog.ts  the Settings dialog (sections come from plugins)
  dom.ts            small element-building helper
  platform.ts       platform helpers (⌘ vs Ctrl, "Reveal in Finder" label)
  api.ts            typed wrappers for backend commands
src-tauri/src/
  lib.rs            open / atomic save / watch the open file / startup state
  folder.rs         open folder, listing, create / rename / trash, path checks
  images.rs         store pasted and dropped images in assets/
  settings.rs       settings file; the S3 secret lives in the OS keychain
  s3.rs             S3 uploads, connection test, markd-cache:// image cache
```

## Security

- **The backend decides which paths are reachable.** Single files come from the command line or a system dialog, and the frontend only submits their content. Sidebar operations take paths from the frontend, but only inside the folder the user opened: every command resolves symlinks and `..` first and rejects anything outside that folder, and new names may not contain path separators.
- Raw HTML in Markdown is not rendered (it stays visible as source), and image widgets only set `src`, so there is no HTML injection surface. The production build also enforces a CSP that blocks inline scripts and `eval`.
- Local images are served through Tauri's asset protocol with an empty default scope; only the open folder and the open file's directory are allowed.
- Pasted images reach the backend as bytes only, and dropped files are read from the OS drop event in Rust, so the frontend never names a source or destination path. Images always land in the open document's `assets/` folder, with the suggested name reduced to a plain file name with an image extension.
- Deleting moves items to the system trash rather than removing them permanently.
- The S3 secret access key is stored in the OS keychain (Keychain, Credential Manager, Secret Service), never in a file, and never sent to the frontend: uploads are signed in Rust.
- `markd-cache://` only serves URLs under the configured S3 public URL, so it cannot be used to fetch arbitrary addresses.

## Known limitations

- The open folder is watched recursively. That is cheap on macOS and Windows, but on Linux (inotify) a very large folder can hit the system's watch limit.

## Roadmap

- [ ] Load third-party plugins from a plugins folder, with enable / disable and a safe mode
- [x] Render tables as real table widgets
- [ ] Math (KaTeX) and Mermaid diagrams, loaded on demand
- [ ] Drag and drop to move files in the sidebar; search across the folder
- [ ] File associations and macOS "Open With" (`RunEvent::Opened`)
- [ ] Export to HTML / PDF
