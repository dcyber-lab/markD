# markd

A local Markdown editor that renders in place, Typora / Obsidian style: lines without the cursor show the rendered result, and the line you're editing shows its source. Built with Tauri 2 (Rust) and CodeMirror 6.

Files stay plain Markdown on disk. Rendering is only a view layer on top of the source, so saving never rewrites your formatting.

## Development

```bash
pnpm install
pnpm tauri dev                 # run in development mode
pnpm tauri dev -- -- note.md   # open a file on startup
pnpm tauri build               # build an installer for the current platform
```

Requires Rust, Node 22+, pnpm, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

## Shortcuts

| Shortcut | Action |
|---|---|
| ⌘/Ctrl + N | New |
| ⌘/Ctrl + O | Open |
| ⌘/Ctrl + S | Save (Save As for untitled documents) |
| ⌘/Ctrl + Shift + S | Save As |
| ⌘/Ctrl + \ | Toggle live rendering / source mode |
| ⌘/Ctrl + F | Find and replace |
| ⌘/Ctrl + click a link | Open it in the system browser |

## What renders live

Headings, bold / italic / strikethrough, inline code, links, bullet lists, task lists (click to toggle), blockquotes, horizontal rules, fenced code blocks (with syntax highlighting), and images (relative local paths or remote URLs). Tables are currently only aligned with a monospace font.

## Layout

```
src/
  main.ts           document state, shortcuts, external changes, close confirmation
  editor.ts         CodeMirror 6 setup, theme, highlighting, mode switching
  live-preview.ts   live rendering: hide markup, style content, swap in widgets from the syntax tree
  widgets.ts        image / bullet / checkbox widgets and image path resolution
  platform.ts       platform helpers (⌘ vs Ctrl)
  api.ts            typed wrappers for backend commands
src-tauri/src/lib.rs  open / atomic save / watch for external changes / CLI argument
```

## Security

- **The backend decides every file path** (from the CLI argument or a system dialog). The frontend can only submit content; it cannot name a path to read or write.
- Raw HTML in Markdown is not rendered (it stays visible as source), and image widgets only set `src`, so there is no HTML injection surface. The production build also enforces a CSP that blocks inline scripts and `eval`.
- Local images are served through Tauri's asset protocol with an empty default scope; opening a file allows only that file's directory.

## Roadmap

- [ ] Render tables as real table widgets (needs block decorations from a StateField)
- [ ] Math (KaTeX) and Mermaid diagrams, loaded on demand
- [ ] Paste / drop images into `./assets/` automatically
- [ ] File associations and macOS "Open With" (`RunEvent::Opened`)
- [ ] Export to HTML / PDF
