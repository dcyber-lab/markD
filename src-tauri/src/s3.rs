//! Images in an S3-compatible bucket: uploads, a connection test, and the `markd-cache://`
//! protocol, which serves those images from a local cache so they still display offline.

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use percent_encoding::percent_decode_str;
use reqwest::Url;
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use sha2::{Digest, Sha256};
use tauri::{
    http::{self, header::CONTENT_TYPE, StatusCode},
    ipc::Request,
    AppHandle, Manager, State, UriSchemeContext, UriSchemeResponder, Wry,
};

use crate::{
    images, io_err,
    settings::{self, S3Settings},
    AppState,
};

pub(crate) const CACHE_SCHEME: &str = "markd-cache";
const SIGNED_URL_TTL: Duration = Duration::from_secs(300);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Object keys include a content hash, so an object never changes and can be cached forever.
const CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

struct Target {
    bucket: Bucket,
    credentials: Credentials,
    prefix: String,
    public_base: String,
}

fn region(s: &S3Settings) -> &str {
    match s.region.trim() {
        "" => "us-east-1",
        region => region,
    }
}

fn bucket(s: &S3Settings) -> Result<Bucket, String> {
    let endpoint = match s.endpoint.trim().trim_end_matches('/') {
        "" => format!("https://s3.{}.amazonaws.com", region(s)),
        endpoint => endpoint.to_string(),
    };
    let endpoint: Url = endpoint.parse().map_err(|e| format!("invalid S3 endpoint: {e}"))?;
    let style = if s.path_style { UrlStyle::Path } else { UrlStyle::VirtualHost };
    Bucket::new(endpoint, style, s.bucket.trim().to_string(), region(s).to_string())
        .map_err(|e| format!("invalid S3 endpoint: {e:?}"))
}

/// The URL S3 image links start with: the public URL if set, otherwise the bucket's own URL.
pub(crate) fn public_base(s: &S3Settings) -> Option<String> {
    match s.public_url.trim().trim_end_matches('/') {
        "" if s.bucket.trim().is_empty() => None,
        "" => bucket(s).ok().map(|b| b.base_url().as_str().trim_end_matches('/').to_string()),
        url => Some(url.to_string()),
    }
}

fn target(app: &AppHandle) -> Result<Target, String> {
    let s = settings::load(app).images.s3;
    if s.bucket.trim().is_empty() || s.access_key_id.trim().is_empty() {
        return Err("S3 is not set up yet: open Settings (⌘/Ctrl+,) and fill in the bucket and keys".into());
    }
    let secret = settings::s3_secret()?.ok_or("the S3 secret access key is not set")?;
    let mut prefix = s.prefix.trim().trim_start_matches('/').to_string();
    if !prefix.is_empty() && !prefix.ends_with('/') {
        prefix.push('/');
    }
    Ok(Target {
        bucket: bucket(&s)?,
        credentials: Credentials::new(s.access_key_id.trim(), secret),
        public_base: public_base(&s).ok_or("the S3 bucket is not set")?,
        prefix,
    })
}

/// `<prefix><stem>-<content hash>.<ext>`: unique per content, so uploads never overwrite.
fn object_key(t: &Target, stem: &str, ext: &str, bytes: &[u8]) -> String {
    let hash: String = Sha256::digest(bytes)[..5].iter().map(|b| format!("{b:02x}")).collect();
    let stem: String = stem
        .chars()
        .map(|c| if c.is_whitespace() || matches!(c, '/' | '\\' | '?' | '#' | '%') { '-' } else { c })
        .collect();
    format!("{}{stem}-{hash}.{ext}", t.prefix)
}

/// The public link for an object, with each path segment percent-encoded.
fn link(t: &Target, key: &str) -> Result<String, String> {
    let mut url: Url = t.public_base.parse().map_err(|e| format!("invalid public URL: {e}"))?;
    url.path_segments_mut()
        .map_err(|_| "invalid public URL".to_string())?
        .pop_if_empty()
        .extend(key.split('/'));
    Ok(url.into())
}

/// Turn an S3 error response into a readable message (S3 errors are XML with a `<Message>`).
async fn check(response: reqwest::Response) -> Result<(), String> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().await.unwrap_or_default();
    let message = body
        .split("<Message>")
        .nth(1)
        .and_then(|m| m.split("</Message>").next())
        .unwrap_or(body.trim());
    Err(format!("S3 returned {status}: {message}"))
}

async fn put(client: &reqwest::Client, t: &Target, key: &str, body: Vec<u8>, content_type: &str) -> Result<(), String> {
    let mut action = t.bucket.put_object(Some(&t.credentials), key);
    action.headers_mut().insert("content-type", content_type);
    action.headers_mut().insert("cache-control", CACHE_CONTROL);
    let response = client
        .put(action.sign(SIGNED_URL_TTL))
        .header("content-type", content_type)
        .header("cache-control", CACHE_CONTROL)
        .body(body)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("S3 upload failed: {e}"))?;
    check(response).await
}

/// Upload an image and keep a copy in the cache, so it displays right away and offline.
async fn upload_image(app: &AppHandle, client: &reqwest::Client, t: &Target, stem: &str, ext: &str, bytes: Vec<u8>) -> Result<String, String> {
    let key = object_key(t, stem, ext, &bytes);
    let url = link(t, &key)?;
    put(client, t, &key, bytes.clone(), images::mime_type(ext)).await?;
    store_in_cache(app, &url, &bytes);
    Ok(url)
}

#[tauri::command]
pub(crate) async fn s3_upload_image(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<String, String> {
    let t = target(&app)?;
    let (bytes, stem, ext) = images::pasted_image(&request)?;
    upload_image(&app, &state.http, &t, &stem, &ext, bytes.to_vec()).await
}

#[tauri::command]
pub(crate) async fn s3_upload_dropped(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let t = target(&app)?;
    let mut links = Vec::new();
    for src in images::take_dropped(&state) {
        let ext = images::image_extension(&src).ok_or("unsupported image type")?;
        let stem = src.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        let bytes = fs::read(&src).map_err(|e| io_err(&src, e))?;
        links.push(upload_image(&app, &state.http, &t, &stem, &ext, bytes).await?);
    }
    Ok(links)
}

/// Upload a small object, read it back through the public URL, then delete it.
#[tauri::command]
pub(crate) async fn s3_test(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let t = target(&app)?;
    let key = format!("{}markd-connection-test.txt", t.prefix);
    put(&state.http, &t, &key, b"markd".to_vec(), "text/plain").await?;
    let url = link(&t, &key)?;
    let read = state.http.get(&url).timeout(REQUEST_TIMEOUT).send().await;
    let delete = t.bucket.delete_object(Some(&t.credentials), &key).sign(SIGNED_URL_TTL);
    let _ = state.http.delete(delete).timeout(REQUEST_TIMEOUT).send().await;
    match read {
        Ok(r) if r.status().is_success() => Ok(format!("Upload works and {url} is publicly readable.")),
        Ok(r) => Err(format!(
            "Upload works, but {url} returned {}. Make the bucket or its CDN publicly readable.",
            r.status()
        )),
        Err(e) => Err(format!("Upload works, but {url} could not be read: {e}")),
    }
}

fn cache_path(app: &AppHandle, url: &str) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("images");
    let name: String = Sha256::digest(url.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let ext = images::image_extension(Path::new(Url::parse(url).ok()?.path()))?;
    Some(dir.join(format!("{name}.{ext}")))
}

fn store_in_cache(app: &AppHandle, url: &str, bytes: &[u8]) {
    let Some(path) = cache_path(app, url) else { return };
    let part = path.with_extension("part");
    let _ = path
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|_| fs::write(&part, bytes))
        .and_then(|_| fs::rename(&part, &path));
}

/// The bytes and content type for an image under the S3 public URL: from the cache, or
/// downloaded and cached on first use.
async fn cached_image(app: &AppHandle, encoded: &str) -> Result<(Vec<u8>, &'static str), StatusCode> {
    let url = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .into_owned();
    let base = public_base(&settings::load(app).images.s3).ok_or(StatusCode::FORBIDDEN)?;
    if !url.starts_with(&format!("{base}/")) {
        return Err(StatusCode::FORBIDDEN);
    }
    let path = cache_path(app, &url).ok_or(StatusCode::FORBIDDEN)?;
    let mime = images::mime_type(path.extension().and_then(|e| e.to_str()).unwrap_or_default());
    if let Ok(bytes) = fs::read(&path) {
        return Ok((bytes, mime));
    }
    let response = app
        .state::<AppState>()
        .http
        .get(&url)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    if !response.status().is_success() {
        return Err(StatusCode::NOT_FOUND);
    }
    let bytes = response.bytes().await.map_err(|_| StatusCode::BAD_GATEWAY)?.to_vec();
    store_in_cache(app, &url, &bytes);
    Ok((bytes, mime))
}

/// `markd-cache://localhost/<percent-encoded image URL>`. Only URLs under the configured S3 public
/// URL are served, so this cannot be used to fetch arbitrary addresses.
pub(crate) fn cache_protocol(ctx: UriSchemeContext<'_, Wry>, request: http::Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let encoded = request.uri().path().trim_start_matches('/').to_string();
    tauri::async_runtime::spawn(async move {
        let response = match cached_image(&app, &encoded).await {
            Ok((bytes, mime)) => http::Response::builder().header(CONTENT_TYPE, mime).body(bytes),
            Err(status) => http::Response::builder().status(status).body(Vec::new()),
        };
        if let Ok(response) = response {
            responder.respond(response);
        }
    });
}
