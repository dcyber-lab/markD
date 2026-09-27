//! Pasted and dropped images, stored in an `assets` folder next to the open document.
//!
//! The frontend never names a path here: pasted images arrive as bytes, and dropped files are
//! taken straight from the OS drop event and held until the frontend asks to import them.

use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};

use serde::Serialize;
use tauri::{ipc::InvokeBody, ipc::Request, AppHandle, Emitter, Manager, PhysicalPosition, State};

use crate::{io_err, AppState};

const ASSETS_DIR: &str = "assets";
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
const MAX_PASTE_BYTES: usize = 50 * 1024 * 1024;

#[derive(Clone, Serialize)]
struct DropPosition {
    x: f64,
    y: f64,
}

pub(crate) fn image_extension(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

pub(crate) fn mime_type(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// A pasted image: raw bytes in the body and a suggested name in the `x-file-name` header.
/// Returns the bytes, a safe file stem and the extension.
pub(crate) fn pasted_image<'a>(request: &'a Request<'_>) -> Result<(&'a [u8], String, String), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw image bytes".into());
    };
    if bytes.len() > MAX_PASTE_BYTES {
        return Err("image is larger than 50 MB".into());
    }
    let suggested = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image.png");
    // Keep only the final path component so a name like `../../x.png` cannot escape.
    let suggested = Path::new(Path::new(suggested).file_name().unwrap_or_default());
    let ext = image_extension(suggested).ok_or("unsupported image type")?;
    let stem = suggested.file_stem().unwrap_or_default().to_string_lossy();
    let stem = stem.trim_start_matches('.');
    let stem = if stem.is_empty() { "image" } else { stem };
    Ok((bytes, stem.to_string(), ext))
}

/// The image files from the last OS drop, emptying the pending list.
pub(crate) fn take_dropped(state: &AppState) -> Vec<PathBuf> {
    std::mem::take(&mut *state.dropped_images.lock().unwrap())
}

/// `<document dir>/assets`, created on demand.
fn assets_dir(state: &AppState) -> Result<PathBuf, String> {
    let doc = state.doc.lock().unwrap().as_ref().map(|d| d.path.clone());
    let doc = doc.ok_or("save the document before adding images")?;
    let dir = doc.parent().ok_or("file has no parent directory")?.join(ASSETS_DIR);
    fs::create_dir_all(&dir).map_err(|e| io_err(&dir, e))?;
    Ok(dir)
}

/// Create a new file in `dir` named after `stem`, adding `-1`, `-2`, ... instead of overwriting.
fn create_unique(dir: &Path, stem: &str, ext: &str) -> Result<(PathBuf, File), String> {
    for n in 0.. {
        let name = if n == 0 { format!("{stem}.{ext}") } else { format!("{stem}-{n}.{ext}") };
        let path = dir.join(name);
        match File::options().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_err(&path, e)),
        }
    }
    unreachable!()
}

/// The link to put in Markdown, relative to the document: `assets/<name>`.
fn link(path: &Path) -> String {
    format!("{ASSETS_DIR}/{}", path.file_name().unwrap_or_default().to_string_lossy())
}

/// Save pasted image bytes. The `x-file-name` header only suggests a name; the directory is always
/// the open document's `assets` folder and the extension must be an image type.
#[tauri::command]
pub(crate) async fn save_image(state: State<'_, AppState>, request: Request<'_>) -> Result<String, String> {
    let (bytes, stem, ext) = pasted_image(&request)?;
    let dir = assets_dir(&state)?;
    let (path, mut file) = create_unique(&dir, &stem, &ext)?;
    file.write_all(bytes).map_err(|e| io_err(&path, e))?;
    Ok(link(&path))
}

/// Called for OS file drops: keep the image paths and tell the frontend where they landed.
pub(crate) fn on_drop(app: &AppHandle, paths: &[PathBuf], position: PhysicalPosition<f64>) {
    let images: Vec<PathBuf> = paths.iter().filter(|p| image_extension(p).is_some()).cloned().collect();
    if images.is_empty() {
        return;
    }
    *app.state::<AppState>().dropped_images.lock().unwrap() = images;
    let _ = app.emit("images-dropped", DropPosition { x: position.x, y: position.y });
}

/// Copy the most recently dropped images into `assets` and return their links. Images that are
/// already in `assets` are linked as they are.
#[tauri::command]
pub(crate) async fn import_dropped_images(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let dir = assets_dir(&state)?;
    let canonical_dir = dunce::canonicalize(&dir).map_err(|e| io_err(&dir, e))?;

    take_dropped(&state)
        .iter()
        .map(|src| {
            let src = dunce::canonicalize(src).map_err(|e| io_err(src, e))?;
            if src.parent() == Some(canonical_dir.as_path()) {
                return Ok(link(&src));
            }
            let ext = image_extension(&src).ok_or("unsupported image type")?;
            let stem = src.file_stem().unwrap_or_default().to_string_lossy();
            let (path, mut file) = create_unique(&dir, &stem, &ext)?;
            let mut reader = File::open(&src).map_err(|e| io_err(&src, e))?;
            io::copy(&mut reader, &mut file).map_err(|e| io_err(&path, e))?;
            Ok(link(&path))
        })
        .collect()
}
