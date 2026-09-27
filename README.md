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
| ⌘/Ctrl + click a link | Open it in the system browser |

## Features

**Live rendering:** headings, bold / italic / strikethrough, inline code, links, bullet lists, task lists (click to toggle), blockquotes, horizontal rules, fenced code blocks (with syntax highlighting), and images (relative local paths or remote URLs). Tables are currently only aligned with a monospace font.

**Folder sidebar:** open a folder to browse its subfolders and Markdown files (hidden entries are skipped; folders load lazily as you expand them). Right-click for New File, New Folder, Rename (inline), Move to Trash, and Reveal in Finder / Explorer. The tree follows changes made on disk, and the last folder, expanded folders, and sidebar width are restored on the next launch. Switching files from the sidebar saves unsaved changes first; an untitled document asks before discarding.

**Images:** paste an image (e.g. a screenshot) or drop image files onto the window, and markd stores them in an `assets/` folder next to the document and inserts a relative link such as `![](assets/image-20260927-161305.png)`. Existing names are never overwritten (`-1`, `-2`, ... are appended), and images already in `assets/` are linked rather than copied. An untitled document is saved first so the images have somewhere to go.

## Layout

```
src/
  main.ts           document state, shortcuts, external changes, close confirmation
  editor.ts         CodeMirror 6 setup, theme, highlighting, mode switching
  live-preview.ts   live rendering: hide markup, style content, swap in widgets from the syntax tree
  widgets.ts        image / bullet / checkbox widgets and image path resolution
  images.ts         paste / drop images and insert links
  sidebar.ts        folder tree, context menu, inline rename, resizing
  platform.ts       platform helpers (⌘ vs Ctrl, "Reveal in Finder" label)
  api.ts            typed wrappers for backend commands
src-tauri/src/
  lib.rs            open / atomic save / watch the open file / startup state
  folder.rs         open folder, listing, create / rename / trash, path checks
  images.rs         store pasted and dropped images in assets/
```

## Security

- **The backend decides which paths are reachable.** Single files come from the command line or a system dialog, and the frontend only submits their content. Sidebar operations take paths from the frontend, but only inside the folder the user opened: every command resolves symlinks and `..` first and rejects anything outside that folder, and new names may not contain path separators.
- Raw HTML in Markdown is not rendered (it stays visible as source), and image widgets only set `src`, so there is no HTML injection surface. The production build also enforces a CSP that blocks inline scripts and `eval`.
- Local images are served through Tauri's asset protocol with an empty default scope; only the open folder and the open file's directory are allowed.
- Pasted images reach the backend as bytes only, and dropped files are read from the OS drop event in Rust, so the frontend never names a source or destination path. Images always land in the open document's `assets/` folder, with the suggested name reduced to a plain file name with an image extension.
- Deleting moves items to the system trash rather than removing them permanently.

## Known limitations

- The open folder is watched recursively. That is cheap on macOS and Windows, but on Linux (inotify) a very large folder can hit the system's watch limit.

## Roadmap

- [ ] Render tables as real table widgets (needs block decorations from a StateField)
- [ ] Math (KaTeX) and Mermaid diagrams, loaded on demand
- [ ] Drag and drop to move files in the sidebar; search across the folder
- [ ] File associations and macOS "Open With" (`RunEvent::Opened`)
- [ ] Export to HTML / PDF
