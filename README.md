# MarkSunzun

A local-first Markdown reader built with Rust, Tauri 2, and TypeScript. Open a document or browse a folder; MarkSunzun renders the words and leaves editing to your editor.

## Run

Requirements: a stable Rust toolchain, Node.js 22.12+ (or 20.19+), and npm. On Arch Linux, install the Tauri desktop prerequisites: `base-devel`, `webkit2gtk-4.1`, `gtk3`, `librsvg`, `curl`, `wget`, `file`, and `openssl`. A desktop session and working file chooser portal are needed for native dialogs.

```sh
npm ci
npm start
```

Build and run a standalone executable, with no development server:

```sh
npm run desktop:build
./src-tauri/target/release/marksunzun
./src-tauri/target/release/marksunzun /path/to/notes.md
```

The executable path above is for Linux. Installer bundling is disabled by default. The desktop application has been exercised on Linux; other platforms have not been verified.

## User-local installation (Linux)

Install the built executable into your user-local binary directory:

```sh
install -Dm755 src-tauri/target/release/marksunzun "$HOME/.local/bin/marksunzun"
```

With `~/.local/bin` on your `PATH`, run:

```sh
marksunzun /path/to/notes.md
```

The installed executable is a copy, independent of the project folder. After rebuilding, quit MarkSunzun and repeat the install command.

The user-local desktop entry is `~/.local/share/applications/marksunzun.desktop`, with icons under `~/.local/share/icons/hicolor/`. It adds MarkSunzun to the application menu and the “Open With” options for Markdown files without changing existing default applications.

## Reading

- Open `.md`, `.markdown`, or `.mdown` files through the native picker or a command-line argument.
- Browse folders, filter filenames, and navigate back to the selected folder root.
- Render tables, task lists, footnotes, strikethrough, and syntax-highlighted code in common languages, including Rust. Other code blocks remain readable plain text.
- Follow relative Markdown links, jump between headings, and view local images, including SVG.
- Find text without losing inline formatting; use Enter / Shift+Enter for the next / previous match.
- Dark mode is the default. Use the **Dark mode / Light mode** button in the top-right toolbar to switch themes. Your choice is remembered when you reopen MarkSunzun.
- Read live updates from your editor, including atomic saves. Reload failures retain the last readable document.

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd+O | Open file |
| Ctrl/Cmd+Shift+O | Open folder |
| Ctrl/Cmd+F | Find in document |
| Escape | Close find |

## File access and content safety

Opening a file grants access to its parent folder; opening a folder makes that folder the active root. Relative document links and local images must remain inside that root. Canonical path checks reject symlinks that escape it. To follow a link outside the root, explicitly open the containing folder or target file.

Raw Markdown HTML is ignored, rendered content is sanitized, and remote or embedded images are blocked. SVG is loaded only as an image, never as inline document content. Only explicit HTTP/HTTPS links open in your system browser. The webview has no generic filesystem or shell permissions.

Documents must be UTF-8 and at most 8 MiB; images are limited to 10 MiB each. MarkSunzun does not modify documents.

## Development checks

```sh
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Rust owns file dialogs, scoped reads, Markdown parsing, and file watching in `src-tauri/src/lib.rs`. The reader interface and styles live in `src/main.ts` and `src/style.css`.
