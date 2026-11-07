use base64::{engine::general_purpose::STANDARD, Engine};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use pulldown_cmark::{html, Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use tauri::{AppHandle, Emitter, State};

const DOCUMENT_LIMIT: u64 = 8 * 1024 * 1024;
const IMAGE_LIMIT: u64 = 10 * 1024 * 1024;

#[derive(Serialize)]
struct Document {
    path: String,
    name: String,
    html: String,
    words: usize,
    root: String,
}

#[derive(Serialize)]
struct Directory {
    path: String,
    root: String,
    entries: Vec<DirectoryEntry>,
}

#[derive(Serialize)]
struct DirectoryEntry {
    path: String,
    name: String,
    is_dir: bool,
}

#[derive(Default)]
struct Session {
    root: Option<PathBuf>,
    document: Option<PathBuf>,
    watcher: Option<RecommendedWatcher>,
    startup_path: Option<PathBuf>,
}

struct AppState(Mutex<Session>);

fn session(state: &AppState) -> Result<MutexGuard<'_, Session>, String> {
    state
        .0
        .lock()
        .map_err(|_| "The reader's file session is unavailable. Please restart MarkSunzun.".into())
}

fn path_text(path: &Path) -> Result<String, String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        "This path contains characters that cannot be displayed. Please rename the file or folder.".into()
    })
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| format!("Cannot access ‘{}’: {error}", path.display()))
}

fn active_root(session: &Session) -> Result<&Path, String> {
    session
        .root
        .as_deref()
        .ok_or_else(|| "Open a Markdown file or folder first.".into())
}

fn contained_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let path = canonical(path)?;
    if !path.starts_with(root) {
        return Err(
            "This path is outside the open folder. Use Open file or Open folder to grant access."
                .into(),
        );
    }
    Ok(path)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["md", "markdown", "mdown"]
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

fn markdown_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let path = contained_path(root, path)?;
    if !path.is_file() || !is_markdown(&path) {
        return Err("Choose a Markdown file ending in .md, .markdown, or .mdown.".into());
    }
    Ok(path)
}

fn read_bounded(root: &Path, path: &Path, limit: u64, kind: &str) -> Result<Vec<u8>, String> {
    let file =
        File::open(path).map_err(|error| format!("Cannot read ‘{}’: {error}", path.display()))?;
    // Bind the containment check to the opened handle on Linux, closing symlink-swap races.
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        contained_path(
            root,
            &PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd())),
        )?;
    }
    #[cfg(not(target_os = "linux"))]
    contained_path(root, path)?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Cannot inspect this {kind}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("The selected {kind} is not a regular file."));
    }
    if metadata.len() > limit {
        return Err(format!(
            "This {kind} is too large. The limit is {} MiB.",
            limit / (1024 * 1024)
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read this {kind}: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!(
            "This {kind} is too large. The limit is {} MiB.",
            limit / (1024 * 1024)
        ));
    }
    Ok(bytes)
}

fn render_markdown(source: &str) -> (String, usize) {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS;
    let mut words = 0;
    let mut in_word = false;
    let events = Parser::new_ext(source, options)
        .filter(|event| !matches!(event, Event::Html(_) | Event::InlineHtml(_)))
        .inspect(|event| match event {
            Event::Text(text) | Event::Code(text) => {
                for character in text.chars() {
                    if character.is_whitespace() {
                        in_word = false;
                    } else if !in_word {
                        words += 1;
                        in_word = true;
                    }
                }
            }
            Event::Start(
                Tag::Emphasis
                | Tag::Strong
                | Tag::Strikethrough
                | Tag::Link { .. }
                | Tag::Image { .. },
            )
            | Event::End(
                TagEnd::Emphasis
                | TagEnd::Strong
                | TagEnd::Strikethrough
                | TagEnd::Link
                | TagEnd::Image,
            ) => {}
            _ => in_word = false,
        });
    let mut output = String::new();
    html::push_html(&mut output, events);
    (output, words)
}

fn watch_document(app: &AppHandle, document: &Path) -> Result<RecommendedWatcher, String> {
    let parent = document
        .parent()
        .ok_or("This document has no parent folder.")?;
    let watched_path = document.to_path_buf();
    let watched_parent = parent.to_path_buf();
    let payload = path_text(document)?;
    let app = app.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        match result {
            Ok(event)
                if matches!(
                    event.kind,
                    EventKind::Any
                        | EventKind::Create(_)
                        | EventKind::Modify(_)
                        | EventKind::Remove(_)
                ) =>
            {
                // Parent watching survives editors replacing the file with an atomic rename.
                if event.paths.is_empty()
                    || event
                        .paths
                        .iter()
                        .any(|path| path == &watched_path || path == &watched_parent)
                {
                    let _ = app.emit("document-changed", &payload);
                }
            }
            // Ask the UI to reread if the watch reports a filesystem failure.
            Err(_) => {
                let _ = app.emit("document-changed", &payload);
            }
            _ => {}
        }
    })
    .map_err(|error| format!("Cannot start live updates for this document: {error}"))?;
    watcher
        .watch(parent, RecursiveMode::NonRecursive)
        .map_err(|error| format!("Cannot watch ‘{}’ for changes: {error}", parent.display()))?;
    Ok(watcher)
}

fn load_document(
    app: &AppHandle,
    session: &mut Session,
    root: PathBuf,
    path: &Path,
) -> Result<Document, String> {
    let path = markdown_path(&root, path)?;
    let bytes = read_bounded(&root, &path, DOCUMENT_LIMIT, "document")?;
    let source = String::from_utf8(bytes).map_err(|_| {
        "This document is not UTF-8 text. Save it as UTF-8 and try again.".to_string()
    })?;
    let (html, words) = render_markdown(source.strip_prefix('\u{feff}').unwrap_or(&source));
    let document = Document {
        path: path_text(&path)?,
        name: display_name(&path),
        html,
        words,
        root: path_text(&root)?,
    };
    // Install a replacement only after every fallible step, retaining the last good session on error.
    if session.document.as_deref() != Some(path.as_path())
        || session.root.as_deref() != Some(root.as_path())
        || session.watcher.is_none()
    {
        let watcher = watch_document(app, &path)?;
        session.watcher = Some(watcher);
    }
    session.root = Some(root);
    session.document = Some(path);
    Ok(document)
}

fn directory_contents(root: &Path, path: &Path) -> Result<Directory, String> {
    let path = contained_path(root, path)?;
    if !path.is_dir() {
        return Err("The selected path is not a folder.".into());
    }
    let mut entries = Vec::new();
    for entry in
        fs::read_dir(&path).map_err(|error| format!("Cannot list ‘{}’: {error}", path.display()))?
    {
        let entry = entry.map_err(|error| format!("Cannot read a folder entry: {error}"))?;
        // Broken links and links outside the authorized root are never exposed.
        let Ok(target) = contained_path(root, &entry.path()) else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&target) else {
            continue;
        };
        let is_dir = metadata.is_dir();
        if is_dir || (metadata.is_file() && is_markdown(&target)) {
            entries.push(DirectoryEntry {
                path: path_text(&target)?,
                name: entry.file_name().to_string_lossy().into_owned(),
                is_dir,
            });
        }
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(Directory {
        path: path_text(&path)?,
        root: path_text(root)?,
        entries,
    })
}

#[tauri::command]
async fn pick_file(app: AppHandle, state: State<'_, AppState>) -> Result<Option<Document>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Open Markdown file")
        .add_filter("Markdown", &["md", "markdown", "mdown"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let path = canonical(file.path())?;
    let root = path
        .parent()
        .ok_or("This file has no parent folder.")?
        .to_path_buf();
    let mut session = session(&state)?;
    load_document(&app, &mut session, root, &path).map(Some)
}

#[tauri::command]
async fn pick_folder(state: State<'_, AppState>) -> Result<Option<Directory>, String> {
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_title("Open Markdown folder")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let root = canonical(folder.path())?;
    let directory = directory_contents(&root, &root)?;
    let mut session = session(&state)?;
    if session
        .document
        .as_ref()
        .is_some_and(|path| !path.starts_with(&root))
    {
        session.document = None;
        session.watcher = None;
    }
    session.root = Some(root);
    Ok(Some(directory))
}

#[tauri::command]
fn startup_document(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Document>, String> {
    let mut session = session(&state)?;
    let Some(path) = session.startup_path.take() else {
        return Ok(None);
    };
    let path = canonical(&path)?;
    let root = path
        .parent()
        .ok_or("This file has no parent folder.")?
        .to_path_buf();
    load_document(&app, &mut session, root, &path).map(Some)
}

#[tauri::command]
fn read_document(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Document, String> {
    let mut session = session(&state)?;
    let root = active_root(&session)?.to_path_buf();
    load_document(&app, &mut session, root, Path::new(&path))
}

#[tauri::command]
fn list_directory(state: State<'_, AppState>, path: String) -> Result<Directory, String> {
    let session = session(&state)?;
    directory_contents(active_root(&session)?, Path::new(&path))
}

fn decode_image_source(source: &str) -> Result<PathBuf, String> {
    let source = source.trim();
    let reject_url = |value: &str| {
        value.starts_with("//") || value.starts_with("\\\\") || url::Url::parse(value).is_ok()
    };
    if reject_url(source) {
        return Err(
            "Only local image paths are supported; network and file URLs are blocked.".into(),
        );
    }
    let path = source.split(['?', '#']).next().unwrap_or("");
    let mut bytes = Vec::with_capacity(path.len());
    let mut input = path.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = input.next().and_then(|value| (value as char).to_digit(16));
            let low = input.next().and_then(|value| (value as char).to_digit(16));
            let (Some(high), Some(low)) = (high, low) else {
                return Err("This image has an invalid URL-encoded path.".into());
            };
            bytes.push(((high << 4) | low) as u8);
        } else {
            bytes.push(byte);
        }
    }
    let path =
        String::from_utf8(bytes).map_err(|_| "This image path is not valid UTF-8.".to_string())?;
    if path.is_empty() || path.contains('\0') || reject_url(&path) {
        return Err("This image does not have a supported local path.".into());
    }
    Ok(PathBuf::from(path))
}

fn image_mime(path: &Path) -> Result<&'static str, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    [
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("gif", "image/gif"),
        ("webp", "image/webp"),
        ("avif", "image/avif"),
        ("bmp", "image/bmp"),
        ("ico", "image/x-icon"),
        ("svg", "image/svg+xml"),
    ]
    .into_iter()
    .find(|(allowed, _)| extension.eq_ignore_ascii_case(allowed))
    .map(|(_, mime)| mime)
    .ok_or_else(|| {
        "Unsupported image format. Use PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, or SVG.".into()
    })
}

#[tauri::command]
fn read_image(
    state: State<'_, AppState>,
    document_path: String,
    source: String,
) -> Result<String, String> {
    let session = session(&state)?;
    let root = active_root(&session)?;
    let document = markdown_path(root, Path::new(&document_path))?;
    let relative = decode_image_source(&source)?;
    let parent = document
        .parent()
        .ok_or("This document has no parent folder.")?;
    let path = contained_path(root, &parent.join(relative))?;
    let mime = image_mime(&path)?;
    let bytes = read_bounded(root, &path, IMAGE_LIMIT, "image")?;
    // SVG stays an image data URL: the UI must use <img>, never inline SVG/object/frame.
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn external_url(value: &str) -> Result<url::Url, String> {
    let url =
        url::Url::parse(value).map_err(|_| "This link is not a valid web address.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only http and https links can open in your browser.".into());
    }
    Ok(url)
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let url = external_url(&url)?;
    open::that(url.as_str()).map_err(|error| format!("Cannot open your browser: {error}"))
}

pub fn run() {
    let startup_path = std::env::args_os()
        .skip(1)
        .find(|argument| argument != "--")
        .map(PathBuf::from);
    tauri::Builder::default()
        .manage(AppState(Mutex::new(Session {
            startup_path,
            ..Session::default()
        })))
        .invoke_handler(tauri::generate_handler![
            pick_file,
            pick_folder,
            startup_document,
            read_document,
            list_directory,
            read_image,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("MarkSunzun could not start its desktop window");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);
    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "marksunzun-test-{}-{}",
                std::process::id(),
                NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(canonical(&path).unwrap())
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn containment_uses_path_components_not_string_prefixes() {
        let temporary = TestDirectory::new();
        let root = temporary.0.join("notes");
        let sibling = temporary.0.join("notes-private");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&sibling).unwrap();
        fs::write(root.join("inside.md"), "hello").unwrap();
        fs::write(sibling.join("secret.md"), "secret").unwrap();
        assert!(contained_path(&root, &root.join("inside.md")).is_ok());
        assert!(contained_path(&root, &sibling.join("secret.md")).is_err());
        assert!(contained_path(&root, &root.join("../notes-private/secret.md")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_and_are_not_listed() {
        use std::os::unix::fs::symlink;
        let temporary = TestDirectory::new();
        let root = temporary.0.join("notes");
        fs::create_dir(&root).unwrap();
        fs::write(temporary.0.join("secret.md"), "secret").unwrap();
        fs::write(root.join("safe.md"), "safe").unwrap();
        symlink(temporary.0.join("secret.md"), root.join("escape.md")).unwrap();
        symlink(&temporary.0, root.join("escape-folder")).unwrap();
        assert!(markdown_path(&root, &root.join("escape.md")).is_err());
        let listing = directory_contents(&root, &root).unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "safe.md");
    }

    #[test]
    fn bounded_reads_accept_empty_files_and_reject_oversized_files() {
        let temporary = TestDirectory::new();
        let empty = temporary.0.join("empty.md");
        let large = temporary.0.join("large.md");
        fs::write(&empty, "").unwrap();
        fs::write(&large, "12345").unwrap();
        assert!(read_bounded(&temporary.0, &empty, 4, "document")
            .unwrap()
            .is_empty());
        assert!(read_bounded(&temporary.0, &large, 4, "document").is_err());
    }

    #[test]
    fn markdown_keeps_features_but_never_raw_html() {
        let source = "# Hello **reader**\n\n<script>alert('bad')</script>\n\nText <img src=x onerror=alert(1)> remains.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Read ~~yesterday~~ today\n\nA footnote[^1].\n\n[^1]: A note\n";
        let (html, _) = render_markdown(source);
        assert!(html.contains("<table>"));
        assert!(html.contains("type=\"checkbox\""));
        assert!(html.contains("<del>yesterday</del>"));
        assert!(html.contains("footnote"));
        assert!(!html.contains("<script"));
        assert!(!html.contains("onerror"));
        assert!(!html.contains("alert("));
        assert_eq!(render_markdown("").1, 0);
        assert_eq!(render_markdown("one **two** three").1, 3);
    }

    #[test]
    fn image_paths_decode_once_and_reject_url_sources() {
        assert_eq!(
            decode_image_source("images/a%20b%23c.png?version=1#part").unwrap(),
            PathBuf::from("images/a b#c.png")
        );
        for source in [
            "https://example.org/a.png",
            "file:///etc/passwd",
            "//host/a.png",
            "%2f%2fhost/a.png",
            "data:image/svg+xml,x",
            "bad%GG.png",
            "a%00.png",
        ] {
            assert!(decode_image_source(source).is_err(), "{source}");
        }
    }

    #[test]
    fn image_mime_allowlist_excludes_active_document_formats() {
        assert_eq!(
            image_mime(Path::new("diagram.svg")).unwrap(),
            "image/svg+xml"
        );
        assert_eq!(image_mime(Path::new("photo.JPG")).unwrap(), "image/jpeg");
        assert!(image_mime(Path::new("page.html")).is_err());
        assert!(image_mime(Path::new("code.js")).is_err());
    }

    #[test]
    fn external_links_only_allow_web_protocols() {
        assert!(external_url("https://example.org/read?q=markdown").is_ok());
        assert!(external_url("http://localhost:8080/").is_ok());
        for source in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@example.org",
            "relative.md",
        ] {
            assert!(external_url(source).is_err(), "{source}");
        }
    }
}
