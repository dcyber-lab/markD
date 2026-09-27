//! User settings: a JSON file in the app config directory. Secrets never go there; the S3 secret
//! access key lives in the OS keychain and is never sent to the frontend.

use std::fs;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::io_err;

const SETTINGS_FILE: &str = "settings.json";
const KEYCHAIN_SERVICE: &str = "com.dcyberlab.markd";
const S3_SECRET_ACCOUNT: &str = "s3-secret-access-key";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Settings {
    pub(crate) images: ImageSettings,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ImageSettings {
    /// Where new images go: an image store id such as `local` or `s3`.
    pub(crate) storage: String,
    pub(crate) s3: S3Settings,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct S3Settings {
    /// e.g. `https://s3.us-east-1.amazonaws.com` or `https://<account>.r2.cloudflarestorage.com`.
    pub(crate) endpoint: String,
    pub(crate) region: String,
    pub(crate) bucket: String,
    /// Prepended to uploaded object keys, e.g. `images/`.
    pub(crate) prefix: String,
    /// Where the bucket is publicly readable, e.g. a CDN like `https://img.example.com`. Links
    /// point here; when empty they point at the bucket itself.
    pub(crate) public_url: String,
    /// `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key` (MinIO, some OSS).
    pub(crate) path_style: bool,
    pub(crate) access_key_id: String,
}

/// Settings as the frontend sees them: no secrets, only whether one is stored.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    has_s3_secret: bool,
    /// The base URL S3 image links start with, when S3 is configured enough to know it.
    s3_public_base: Option<String>,
}

pub(crate) fn load(app: &AppHandle) -> Settings {
    app.path()
        .app_config_dir()
        .ok()
        .and_then(|dir| fs::read_to_string(dir.join(SETTINGS_FILE)).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| io_err(&dir, e))?;
    let path = dir.join(SETTINGS_FILE);
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| io_err(&path, e))
}

fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, S3_SECRET_ACCOUNT).map_err(|e| format!("keychain: {e}"))
}

pub(crate) fn s3_secret() -> Result<Option<String>, String> {
    match keychain_entry()?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain: {e}")),
    }
}

fn view(settings: Settings) -> Result<SettingsView, String> {
    Ok(SettingsView {
        s3_public_base: crate::s3::public_base(&settings.images.s3),
        has_s3_secret: s3_secret()?.is_some(),
        settings,
    })
}

#[tauri::command]
pub(crate) async fn get_settings(app: AppHandle) -> Result<SettingsView, String> {
    view(load(&app))
}

/// Save settings. `s3_secret`: `None` keeps the stored secret, `""` removes it, anything else
/// replaces it.
#[tauri::command]
pub(crate) async fn set_settings(
    app: AppHandle,
    settings: Settings,
    s3_secret: Option<String>,
) -> Result<SettingsView, String> {
    match s3_secret.as_deref() {
        None => {}
        Some("") => match keychain_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("keychain: {e}")),
        },
        Some(secret) => keychain_entry()?
            .set_password(secret)
            .map_err(|e| format!("keychain: {e}"))?,
    }
    save(&app, &settings)?;
    view(settings)
}
