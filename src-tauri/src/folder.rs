//! The open folder shown in the sidebar. The frontend may only touch paths inside the folder the
//! user picked (or passed on the command line); every command re-checks that.

use std::{
    fs,
    path::{Path, PathBuf},
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

use crate::{io_err, open_path, track, AppState, DocInfo};

const STATE_FILE: &str = "state.json";

pub(crate) struct OpenFolder {
    pub(crate) root: PathBuf,
    _watcher: Debouncer<RecommendedWatcher>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderInfo {
    root: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Renamed {
    path: String,
    /// The open document, if the rename moved it.
    doc: Option<DocInfo>,
}

/// Make `path` the open folder: allow it on the asset protocol, watch it for changes, and remember
/// it for the next launch.
pub(crate) fn open_folder_at(app: &AppHandle, path: &Path) -> Result<FolderInfo, String> {
    let root = dunce::canonicalize(path).map_err(|e| io_err(path, e))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|e| e.to_string())?;

    let handle = app.clone();
    let mut watcher = new_debouncer(
        Duration::from_millis(300),
        move |res: DebounceEventResult| {
            if res.is_ok() {
                let _ = handle.emit("tree-changed", ());
            }
        },
    )
    .map_err(|e| e.to_string())?;
    watcher
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| io_err(&root, e))?;

    let info = FolderInfo {
        root: root.display().to_string(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.display().to_string()),
    };
    remember_folder(app, &root);
    *app.state::<AppState>().folder.lock().unwrap() = Some(OpenFolder {
        root,
        _watcher: watcher,
    });
    Ok(info)
}

fn remember_folder(app: &AppHandle, root: &Path) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let state = serde_json::json!({ "folder": root.to_string_lossy() });
    let _ = fs::create_dir_all(&dir).and_then(|_| fs::write(dir.join(STATE_FILE), state.to_string()));
}

pub(crate) fn remembered_folder(app: &AppHandle) -> Option<PathBuf> {
    let text = fs::read_to_string(app.path().app_config_dir().ok()?.join(STATE_FILE)).ok()?;
    let state: serde_json::Value = serde_json::from_str(&text).ok()?;
    let path = PathBuf::from(state.get("folder")?.as_str()?);
    path.is_dir().then_some(path)
}

/// Resolve a path from the frontend and make sure it lies inside the open folder. Symlinks are
/// resolved first, so a link pointing outside the folder is rejected too. Returns `(root, path)`.
fn inside_folder(state: &AppState, path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = state
        .folder
        .lock()
        .unwrap()
        .as_ref()
        .map(|f| f.root.clone())
        .ok_or("no folder is open")?;
    let path = dunce::canonicalize(path).map_err(|e| io_err(Path::new(path), e))?;
    if !path.starts_with(&root) {
        return Err(format!("{} is outside the open folder", path.display()));
    }
    Ok((root, path))
}

fn valid_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(format!("invalid name: {name:?}"));
    }
    Ok(name)
}

#[tauri::command]
pub(crate) async fn open_folder(app: AppHandle) -> Result<Option<FolderInfo>, String> {
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    open_folder_at(&app, &path).map(Some)
}

/// Folders and files directly inside `path`, folders first. Hidden entries are skipped.
#[tauri::command]
pub(crate) async fn list_dir(state: State<'_, AppState>, path: String) -> Result<Vec<Entry>, String> {
    let (_, dir) = inside_folder(&state, &path)?;
    let mut entries: Vec<Entry> = fs::read_dir(&dir)
        .map_err(|e| io_err(&dir, e))?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            let is_dir = path.is_dir();
            (!name.starts_with('.')).then(|| Entry {
                name,
                path: path.display().to_string(),
                is_dir,
            })
        })
        .collect();
    entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
pub(crate) async fn open_entry(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<DocInfo, String> {
    let (_, path) = inside_folder(&state, &path)?;
    open_path(&app, &path)
}

/// Create an empty file in `dir`. A name without an extension gets `.md`.
#[tauri::command]
pub(crate) async fn create_file(
    state: State<'_, AppState>,
    dir: String,
    name: String,
) -> Result<String, String> {
    let (_, dir) = inside_folder(&state, &dir)?;
    let mut name = valid_name(&name)?.to_string();
    if Path::new(&name).extension().is_none() {
        name.push_str(".md");
    }
    let path = dir.join(name);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| io_err(&path, e))?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub(crate) async fn create_dir(
    state: State<'_, AppState>,
    dir: String,
    name: String,
) -> Result<String, String> {
    let (_, dir) = inside_folder(&state, &dir)?;
    let path = dir.join(valid_name(&name)?);
    fs::create_dir(&path).map_err(|e| io_err(&path, e))?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub(crate) async fn rename_entry(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<Renamed, String> {
    let (root, from) = inside_folder(&state, &path)?;
    if from == root {
        return Err("cannot rename the open folder itself".into());
    }
    let to = from.with_file_name(valid_name(&name)?);
    // On case-insensitive file systems a case-only rename sees `to` as already existing.
    if to.exists() && dunce::canonicalize(&to).ok().as_deref() != Some(from.as_path()) {
        return Err(format!("{} already exists", to.display()));
    }
    fs::rename(&from, &to).map_err(|e| io_err(&from, e))?;

    // Keep tracking the open document if it was renamed, or moved along with its folder.
    let moved = state.doc.lock().unwrap().as_ref().and_then(|d| {
        let rest = d.path.strip_prefix(&from).ok()?;
        let path = if rest.as_os_str().is_empty() { to.clone() } else { to.join(rest) };
        Some((path, d.on_disk.clone()))
    });
    let doc = match moved {
        Some((path, content)) => Some(track(&app, path, content)?),
        None => None,
    };
    Ok(Renamed {
        path: to.display().to_string(),
        doc,
    })
}

/// Move a file or folder to the system trash. Returns whether the open document was inside it.
#[tauri::command]
pub(crate) async fn delete_entry(state: State<'_, AppState>, path: String) -> Result<bool, String> {
    let (root, target) = inside_folder(&state, &path)?;
    if target == root {
        return Err("cannot delete the open folder itself".into());
    }
    trash::delete(&target).map_err(|e| io_err(&target, e))?;
    let mut doc = state.doc.lock().unwrap();
    let removed = doc.as_ref().is_some_and(|d| d.path.starts_with(&target));
    if removed {
        *doc = None;
    }
    Ok(removed)
}
