use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

mod folder;
mod images;

const MD_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "txt"];

/// A document sent to the frontend. Paths are decided only by the backend (a CLI argument or
/// a file the user picked in a system dialog). The frontend cannot read or write arbitrary paths,
/// so even a malicious script smuggled into a document cannot reach other files.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocInfo {
    path: String,
    dir: String,
    name: String,
    content: String,
}

struct OpenDoc {
    path: PathBuf,
    /// Content last read from or written to disk, used to ignore file events caused by our own saves.
    on_disk: String,
    _watcher: Debouncer<RecommendedWatcher>,
}

#[derive(Default)]
struct AppState {
    doc: Mutex<Option<OpenDoc>>,
    folder: Mutex<Option<folder::OpenFolder>>,
    /// Image files from the last OS drop, waiting for the frontend to import them.
    dropped_images: Mutex<Vec<PathBuf>>,
}

fn io_err(path: &Path, e: impl std::fmt::Display) -> String {
    format!("{}: {e}", path.display())
}

fn doc_info(path: &Path, content: String) -> DocInfo {
    DocInfo {
        path: path.display().to_string(),
        dir: path.parent().unwrap_or(path).display().to_string(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        content,
    }
}

/// Make `path` the current document: allow its directory on the asset protocol (for relative image
/// paths) and watch it for external changes.
fn track(app: &AppHandle, path: PathBuf, content: String) -> Result<DocInfo, String> {
    let dir = path.parent().ok_or("file has no parent directory")?.to_path_buf();
    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|e| e.to_string())?;

    // Watch the directory rather than the file: many editors save by writing a temp file and renaming
    // it over the original, and a watch on the file itself would miss that.
    let handle = app.clone();
    let watched = path.clone();
    let mut watcher = new_debouncer(
        Duration::from_millis(200),
        move |res: DebounceEventResult| {
            if res.is_ok_and(|events| events.iter().any(|e| e.path == watched)) {
                reload_from_disk(&handle, &watched);
            }
        },
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| io_err(&dir, e))?;

    let info = doc_info(&path, content.clone());
    *app.state::<AppState>().doc.lock().unwrap() = Some(OpenDoc {
        path,
        on_disk: content,
        _watcher: watcher,
    });
    Ok(info)
}

fn open_path(app: &AppHandle, path: &Path) -> Result<DocInfo, String> {
    let path = dunce::canonicalize(path).map_err(|e| io_err(path, e))?;
    let content = fs::read_to_string(&path).map_err(|e| io_err(&path, e))?;
    track(app, path, content)
}

fn reload_from_disk(app: &AppHandle, path: &Path) {
    // Ignore a deleted or temporarily unreadable file (e.g. mid-replace by another program) and wait
    // for the next event.
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let state = app.state::<AppState>();
    let mut guard = state.doc.lock().unwrap();
    let Some(doc) = guard.as_mut().filter(|d| d.path == path) else {
        return;
    };
    if doc.on_disk == content {
        return;
    }
    doc.on_disk = content.clone();
    drop(guard);
    let _ = app.emit("file-changed", content);
}

/// Write to a temp file in the same directory, then rename it over the target, so a crash mid-write
/// never leaves a truncated file.
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let name = path.file_name().ok_or("invalid file path")?.to_string_lossy();
    let tmp = path.with_file_name(format!(".{name}.markd-tmp"));
    let result = fs::write(&tmp, content)
        .and_then(|_| match fs::metadata(path) {
            // rename swaps in a new file, so carry over the original permission bits.
            Ok(meta) => fs::set_permissions(&tmp, meta.permissions()),
            Err(_) => Ok(()),
        })
        .and_then(|_| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| io_err(path, e))
}

#[derive(Serialize)]
struct InitialState {
    folder: Option<folder::FolderInfo>,
    doc: Option<DocInfo>,
}

/// What to show when the window loads. The command-line argument may be a folder or a file.
#[tauri::command]
async fn initial_state(app: AppHandle, state: State<'_, AppState>) -> Result<InitialState, String> {
    let arg = std::env::args_os()
        .skip(1)
        .find(|a| !a.to_string_lossy().starts_with('-'))
        .map(PathBuf::from);
    let (arg_dir, arg_file) = match arg {
        Some(p) if p.is_dir() => (Some(p), None),
        other => (None, other),
    };

    // Folder: the one already open (after a frontend reload), the argument, or the last one used.
    let current_folder = state.folder.lock().unwrap().as_ref().map(|f| f.root.clone());
    let folder = match current_folder
        .or(arg_dir)
        .or_else(|| folder::remembered_folder(&app))
    {
        Some(root) => Some(folder::open_folder_at(&app, &root)?),
        None => None,
    };

    // Document: the one already open, or the file given as the argument.
    let current_doc = state.doc.lock().unwrap().as_ref().map(|d| d.path.clone());
    let doc = match current_doc.or(arg_file) {
        Some(path) => Some(open_path(&app, &path)?),
        None => None,
    };

    Ok(InitialState { folder, doc })
}

#[tauri::command]
async fn open_file(app: AppHandle) -> Result<Option<DocInfo>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Markdown", MD_EXTENSIONS)
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    open_path(&app, &path).map(Some)
}

#[tauri::command]
async fn save_file(state: State<'_, AppState>, content: String) -> Result<(), String> {
    let mut guard = state.doc.lock().unwrap();
    let doc = guard.as_mut().ok_or("the current document has no file path yet")?;
    write_atomic(&doc.path, &content)?;
    doc.on_disk = content;
    Ok(())
}

#[tauri::command]
async fn save_file_as(app: AppHandle, content: String) -> Result<Option<DocInfo>, String> {
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Markdown", MD_EXTENSIONS)
        .set_file_name("untitled.md")
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    write_atomic(&path, &content)?;
    let path = dunce::canonicalize(&path).map_err(|e| io_err(&path, e))?;
    track(&app, path, content).map(Some)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) = event {
                images::on_drop(window.app_handle(), paths, *position);
            }
        })
        .invoke_handler(tauri::generate_handler![
            initial_state,
            open_file,
            save_file,
            save_file_as,
            folder::open_folder,
            folder::list_dir,
            folder::open_entry,
            folder::create_file,
            folder::create_dir,
            folder::rename_entry,
            folder::delete_entry,
            images::save_image,
            images::import_dropped_images
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
