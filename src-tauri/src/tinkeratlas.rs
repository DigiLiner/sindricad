//! TinkerAtlas account + publish layer — all tinkeratlas.com HTTP happens HERE,
//! on the native side. The webview never talks to tinkeratlas.com (its CSP
//! connect-src is localhost-only, by design); it calls these commands and Rust
//! owns the network, the desktop token, and the identity cache — the same
//! privilege split printer.rs uses for LAN Moonraker access.
//!
//! The desktop token (`ta_scad_…`, minted on tinkeratlas.com/sindricad/connect)
//! is stored with the cached identity in `app_data_dir()/tinkeratlas.json`,
//! written atomically (tmp + rename) and chmod 600 on unix. Signed-out is the
//! normal state: every command except `ta_publish` works without an account.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Compile-time override for staging/local testing:
/// `SINDRICAD_TA_BASE=http://localhost:3000 cargo tauri dev`.
const BASE: &str = match option_env!("SINDRICAD_TA_BASE") {
    Some(s) => s,
    None => "https://tinkeratlas.com",
};

// --- error taxonomy (mapped to toasts on the frontend) ------------------------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaErrCode {
    Unreachable,
    Unauthorized,
    Rejected,
    Protocol,
    Config,
}

#[derive(Serialize, Clone, Debug)]
pub struct TaError {
    pub code: TaErrCode,
    pub message: String,
}

impl TaError {
    fn new(code: TaErrCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

type TResult<T> = Result<T, TaError>;

// --- account store -------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TaUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Account {
    token: String,
    user: TaUser,
}

fn account_path(app: &AppHandle) -> TResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    Ok(dir.join("tinkeratlas.json"))
}

fn read_account(app: &AppHandle) -> TResult<Option<Account>> {
    let path = account_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s)
            .map(Some)
            .map_err(|e| TaError::new(TaErrCode::Config, format!("tinkeratlas.json: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(TaError::new(TaErrCode::Config, e.to_string())),
    }
}

fn write_account(app: &AppHandle, account: &Account) -> TResult<()> {
    let path = account_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(account)
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    std::fs::write(&tmp, json).map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))
}

// --- helpers --------------------------------------------------------------------

fn http(timeout: Duration) -> TResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| TaError::new(TaErrCode::Protocol, e.to_string()))
}

fn unreachable(e: reqwest::Error) -> TaError {
    TaError::new(TaErrCode::Unreachable, e.to_string())
}

/// A pasted token must be a single printable ASCII word (the real ones are
/// `ta_scad_` + hex). Trims whitespace; rejects anything with spaces or
/// control chars so a garbled paste fails here, not as a confusing 401.
fn sanitize_token(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() || t.len() > 200 {
        return None;
    }
    if !t.chars().all(|c| c.is_ascii_graphic()) {
        return None;
    }
    Some(t.to_string())
}

/// URLs we return to the webview (and later hand to the system browser) must
/// point back at the TinkerAtlas base — never anywhere a compromised response
/// could redirect the user.
fn valid_ta_url(url: &str) -> bool {
    url.starts_with(&format!("{BASE}/")) || url == BASE
}

// --- commands --------------------------------------------------------------------

/// Cached identity from disk — NO network, so startup stays offline-safe.
#[tauri::command]
pub fn ta_account(app: AppHandle) -> TResult<Option<TaUser>> {
    Ok(read_account(&app)?.map(|a| a.user))
}

/// Validate a pasted desktop token against /api/desktop/me and persist it.
#[tauri::command]
pub async fn ta_sign_in(app: AppHandle, token: String) -> TResult<TaUser> {
    let token = sanitize_token(&token)
        .ok_or_else(|| TaError::new(TaErrCode::Unauthorized, "that doesn't look like a token"))?;
    validate_and_store(&app, token).await
}

/// Validate a token against /api/desktop/me and persist it on success —
/// shared by the paste flow (ta_sign_in) and the browser flow.
async fn validate_and_store(app: &AppHandle, token: String) -> TResult<TaUser> {
    let client = http(Duration::from_secs(10))?;
    let resp = client
        .get(format!("{BASE}/api/desktop/me"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(unreachable)?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(TaError::new(TaErrCode::Unauthorized, "token was not accepted"));
    }
    if !status.is_success() {
        let msg = resp.text().await.unwrap_or_default();
        return Err(TaError::new(TaErrCode::Rejected, format!("{status}: {msg}")));
    }
    #[derive(Deserialize)]
    struct MeResponse {
        user: TaUser,
    }
    let me: MeResponse = resp
        .json()
        .await
        .map_err(|e| TaError::new(TaErrCode::Protocol, e.to_string()))?;
    write_account(app, &Account { token, user: me.user.clone() })?;
    Ok(me.user)
}

// --- browser sign-in (RFC 8252-style loopback flow) -----------------------------
// The app listens once on 127.0.0.1:<ephemeral>, opens the system browser at
// {BASE}/sindricad/authorize?port=…&state=…, and the site (after its normal
// login/signup) redirects back to the loopback with a freshly minted desktop
// token. The state nonce ties the callback to THIS attempt, so nothing else on
// the machine can inject a token. The user never sees the token.

const BROWSER_SIGNIN_TIMEOUT: Duration = Duration::from_secs(300);

fn random_state() -> TResult<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Minimal percent-encoding for a URL that rides inside a `returnUrl=` query
/// value (only the characters that would break out of the value).
fn encode_query_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '?' => out.push_str("%3F"),
            '&' => out.push_str("%26"),
            '=' => out.push_str("%3D"),
            '#' => out.push_str("%23"),
            '+' => out.push_str("%2B"),
            ' ' => out.push_str("%20"),
            _ => out.push(c),
        }
    }
    out
}

/// Parse `token` and `state` out of a callback request line like
/// `GET /callback?token=…&state=… HTTP/1.1`. Returns None for other paths.
fn parse_callback(request_line: &str) -> Option<(String, String)> {
    let path = request_line.strip_prefix("GET ")?.split(' ').next()?;
    let query = path.strip_prefix("/callback?")?;
    let mut token = None;
    let mut state = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        match k {
            "token" => token = Some(v.to_string()),
            "state" => state = Some(v.to_string()),
            _ => {}
        }
    }
    Some((token?, state?))
}

async fn respond(sock: &mut tokio::net::TcpStream, status: &str, body: &str) {
    use tokio::io::AsyncWriteExt;
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = sock.write_all(resp.as_bytes()).await;
    let _ = sock.shutdown().await;
}

const CALLBACK_OK_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>SindriCAD</title></head>\
<body style=\"background:#16181d;color:#e6e8ec;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">\
<div style=\"text-align:center\"><h2>You&rsquo;re signed in</h2><p style=\"color:#9aa3af\">Close this tab and return to SindriCAD.</p></div></body></html>";

/// Sign in (or register, with `signup: true`) through the system browser.
/// Resolves once the user authorizes on tinkeratlas.com and the loopback
/// callback delivers the token — or errors after a 5 minute timeout.
#[tauri::command]
pub async fn ta_browser_sign_in(app: AppHandle, signup: bool) -> TResult<TaUser> {
    use tauri_plugin_opener::OpenerExt;
    use tokio::io::AsyncReadExt;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?
        .port();
    let state = random_state()?;

    let authorize = format!("/sindricad/authorize?port={port}&state={state}");
    let url = if signup {
        format!("{BASE}/signup?returnUrl={}", encode_query_value(&authorize))
    } else {
        format!("{BASE}{authorize}")
    };
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| TaError::new(TaErrCode::Config, format!("couldn't open the browser: {e}")))?;

    let deadline = tokio::time::Instant::now() + BROWSER_SIGNIN_TIMEOUT;
    let token = loop {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .ok_or_else(|| TaError::new(TaErrCode::Rejected, "sign-in timed out — try again"))?;
        let (mut sock, _) = tokio::time::timeout(remaining, listener.accept())
            .await
            .map_err(|_| TaError::new(TaErrCode::Rejected, "sign-in timed out — try again"))?
            .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;

        let mut buf = [0u8; 4096];
        let n = match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => n,
            _ => continue,
        };
        let request = String::from_utf8_lossy(&buf[..n]);
        let Some(line) = request.lines().next() else { continue };

        match parse_callback(line) {
            Some((token, cb_state)) if cb_state == state && !token.is_empty() => {
                respond(&mut sock, "200 OK", CALLBACK_OK_HTML).await;
                break token;
            }
            Some(_) => {
                // wrong/missing state: NOT our sign-in attempt — refuse and keep waiting
                respond(&mut sock, "400 Bad Request", "invalid sign-in callback").await;
            }
            None => {
                // favicon and friends
                respond(&mut sock, "404 Not Found", "").await;
            }
        }
    };

    validate_and_store(&app, token).await
}

/// Forget the stored token + identity. Missing file is fine (already signed out).
#[tauri::command]
pub fn ta_sign_out(app: AppHandle) -> TResult<()> {
    let path = account_path(&app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(TaError::new(TaErrCode::Config, e.to_string())),
    }
}

/// Is tinkeratlas.com reachable? Drives the welcome screen's iframe-vs-fallback
/// decision (a cross-origin iframe never reports its own load failure).
#[tauri::command]
pub async fn ta_ping() -> bool {
    let Ok(client) = http(Duration::from_secs(3)) else { return false };
    match client.get(format!("{BASE}/sindricad/welcome")).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// Staging path `app_data_dir()/publish/<name>.<ext>` for the sidecar to write
/// the export into. Same sanitization as slicer.rs `print_staging_path`; the
/// separate dir is what `ta_publish` enforces containment against.
#[tauri::command]
pub fn ta_staging_path(app: AppHandle, name: String, ext: String) -> TResult<String> {
    let dir = publish_dir(&app)?;
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    let stem = if safe.is_empty() { "design".to_string() } else { safe };
    let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    let ext = if ext.is_empty() { "3mf".into() } else { ext };
    Ok(dir.join(format!("{stem}.{ext}")).to_string_lossy().into_owned())
}

fn publish_dir(app: &AppHandle) -> TResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?
        .join("publish");
    std::fs::create_dir_all(&dir).map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    Ok(dir)
}

fn model_mime(ext: &str) -> &'static str {
    match ext {
        "3mf" => "model/3mf",
        "stl" => "model/stl",
        "step" | "stp" => "application/step",
        _ => "application/octet-stream",
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct TaPublishResult {
    pub url: String,
}

#[derive(Serialize, Clone)]
struct PublishProgress {
    stage: &'static str,
}

/// Upload a staged export + cover screenshot as a 3D model on TinkerAtlas.
/// `model_path` must be a file `ta_staging_path` produced — enforced by
/// canonicalized containment in the publish dir, so even a compromised webview
/// can't use this command to exfiltrate arbitrary files.
#[tauri::command]
pub async fn ta_publish(
    app: AppHandle,
    title: String,
    description: String,
    publish: bool,
    model_path: String,
    cover_png_base64: String,
) -> TResult<TaPublishResult> {
    let account = read_account(&app)?
        .ok_or_else(|| TaError::new(TaErrCode::Unauthorized, "not signed in to TinkerAtlas"))?;

    let title = title.trim().to_string();
    if title.len() < 3 || title.len() > 200 {
        // mirrors the models_3d CHECK constraint on the server
        return Err(TaError::new(TaErrCode::Config, "title must be 3–200 characters"));
    }

    let dir = publish_dir(&app)?
        .canonicalize()
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;
    let path = Path::new(&model_path)
        .canonicalize()
        .map_err(|e| TaError::new(TaErrCode::Config, format!("staged model: {e}")))?;
    if !path.starts_with(&dir) {
        return Err(TaError::new(TaErrCode::Config, "model path is outside the staging dir"));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("design.3mf")
        .to_string();

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| TaError::new(TaErrCode::Config, e.to_string()))?;

    let _ = app.emit("ta:publish", PublishProgress { stage: "uploading" });

    let model_part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(model_mime(&ext))
        .map_err(|e| TaError::new(TaErrCode::Protocol, e.to_string()))?;
    let mut form = reqwest::multipart::Form::new()
        .text("title", title)
        .text("description", description)
        .text("publish", if publish { "true" } else { "false" })
        .part("model", model_part);

    if !cover_png_base64.is_empty() {
        use base64::Engine;
        let cover = base64::engine::general_purpose::STANDARD
            .decode(cover_png_base64.as_bytes())
            .map_err(|e| TaError::new(TaErrCode::Config, format!("cover image: {e}")))?;
        let cover_part = reqwest::multipart::Part::bytes(cover)
            .file_name("cover.png")
            .mime_str("image/png")
            .map_err(|e| TaError::new(TaErrCode::Protocol, e.to_string()))?;
        form = form.part("cover", cover_part);
    }

    // uploads can be tens of MB — give them a generous timeout of their own.
    let client = http(Duration::from_secs(180))?;
    let resp = client
        .post(format!("{BASE}/api/desktop/publish"))
        .bearer_auth(&account.token)
        .multipart(form)
        .send()
        .await
        .map_err(unreachable)?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        // token was revoked server-side; keep the file so the UI can offer re-sign-in.
        return Err(TaError::new(TaErrCode::Unauthorized, "sign-in expired or was revoked"));
    }
    if !status.is_success() {
        let msg = resp.text().await.unwrap_or_default();
        return Err(TaError::new(TaErrCode::Rejected, format!("{status}: {msg}")));
    }

    #[derive(Deserialize)]
    struct PublishResponse {
        url: String,
    }
    let out: PublishResponse = resp
        .json()
        .await
        .map_err(|e| TaError::new(TaErrCode::Protocol, e.to_string()))?;
    if !valid_ta_url(&out.url) {
        return Err(TaError::new(TaErrCode::Protocol, "unexpected result URL"));
    }

    let _ = app.emit("ta:publish", PublishProgress { stage: "done" });
    Ok(TaPublishResult { url: out.url })
}

/// Fetch the signed-in user's avatar and return it as a data: URL. The webview's
/// CSP img-src deliberately excludes tinkeratlas.com, but allows data: — so the
/// image rides through here instead of loosening the CSP.
#[tauri::command]
pub async fn ta_avatar(app: AppHandle) -> TResult<Option<String>> {
    let Some(account) = read_account(&app)? else { return Ok(None) };
    let url = account.user.avatar_url;
    if url.is_empty() {
        return Ok(None);
    }
    if !avatar_url_allowed(&url) {
        return Ok(None);
    }
    let client = http(Duration::from_secs(10))?;
    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(None), // avatar is decorative — never fail the caller over it
    };
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .split(';')
        .next()
        .unwrap_or("image/png")
        .to_string();
    if !mime.starts_with("image/") {
        return Ok(None);
    }
    let bytes = match resp.bytes().await {
        Ok(b) if b.len() <= 1_000_000 => b,
        _ => return Ok(None),
    };
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(Some(format!("data:{mime};base64,{b64}")))
}

/// Avatars live on tinkeratlas.com or its storage subdomains (api.tinkeratlas.com).
/// The URL comes from the (trusted) server response we persisted, but keeping the
/// fetch pinned to the platform's hosts costs nothing and closes an SSRF channel
/// if the stored file is ever tampered with.
fn avatar_url_allowed(url: &str) -> bool {
    if url.starts_with(&format!("{BASE}/")) {
        return true;
    }
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    parsed.scheme() == "https"
        && parsed
            .host_str()
            .map(|h| h == "tinkeratlas.com" || h.ends_with(".tinkeratlas.com"))
            .unwrap_or(false)
}

// --- bug reports ------------------------------------------------------------------
//
// In-app bug reporter: assembles a scrubbed diagnostic payload (description,
// breadcrumbs, sidecar-log tail, optional document) and POSTs it to the
// TinkerAtlas ingest endpoint. Works signed OUT (anonymous report, no bearer)
// — the primary use case is "the app is broken", possibly before first
// sign-in. Redaction happens HERE, natively, before anything leaves the
// machine; the server re-scrubs as defense in depth but must never be the
// only line.

const LOG_TAIL_BYTES: usize = 100_000;
const MAX_DOCUMENT_BYTES: usize = 1_500_000;

/// Redact the username segment of OS user directories, generically: any
/// `Users/<name>` or `home/<name>` directory, case-insensitive, with either
/// separator (drive, UNC, `/home`, macOS `/Users`). Pattern-based rather than
/// resolving THIS machine's home dir, so paths embedded from other
/// machines/users (in logs or pasted text) scrub too. A RUN of separators
/// counts as one, because escaped text doubles them: Rust's `{:?}` and
/// Python's `repr` both write `C:\\Users\\name`, and old logs on users' disks
/// are in that shape. `media` covers removable drives (`/media/<name>`,
/// udisks2's `/run/media/<name>`), and a JSON `\uXXXX` escape inside a name
/// is part of the name: the sidecar's `err:` lines are `json.dumps` text,
/// which writes every non-ASCII letter that way.
fn redact_user_paths(s: &str) -> String {
    // A Windows profile folder may hold spaces ("John Smith"), so the name
    // runs to the next separator, quote or line end, not the next space.
    // Past this length that span is more likely prose after the path, and
    // the name is cut at whitespace instead.
    const MAX_NAME_BYTES: usize = 64;
    fn is_sep(b: u8) -> bool {
        b == b'\\' || b == b'/'
    }
    /// 6 when `b` starts with a JSON `\uXXXX` escape, else 0.
    fn unicode_escape_len(b: &[u8]) -> usize {
        let escape = b.len() >= 6
            && b[0] == b'\\'
            && b[1] == b'u'
            && b[2..6].iter().all(u8::is_ascii_hexdigit);
        if escape { 6 } else { 0 }
    }
    fn name_len(rest: &str) -> usize {
        let mut chars = rest.char_indices();
        let end = loop {
            let Some((i, c)) = chars.next() else { break rest.len() };
            if unicode_escape_len(&rest.as_bytes()[i..]) > 0 {
                chars.nth(4); // the escape's `u` and four hex digits
                continue;
            }
            if c == '\\' || c == '/' || c == '"' || c == '\'' || c.is_control() {
                break i;
            }
        };
        if end <= MAX_NAME_BYTES {
            return end;
        }
        rest.find(char::is_whitespace).map_or(end, |ws| ws.min(end))
    }

    // Matching is on bytes against ASCII patterns: an ASCII byte never occurs
    // inside a multi-byte UTF-8 character, so every offset found here is a
    // char boundary. (Offsets from `to_lowercase()` are NOT: 'İ' grows from
    // 2 bytes to 3, which panicked or silently skipped the name.)
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        let root_end = ["users", "home", "media"].iter().find_map(|root| {
            let end = i + 1 + root.len();
            let matched = is_sep(bytes[i])
                && end < bytes.len()
                && bytes[i + 1..end].eq_ignore_ascii_case(root.as_bytes())
                && is_sep(bytes[end]);
            matched.then_some(end)
        });
        let Some(mut name_start) = root_end else {
            i += 1;
            continue;
        };
        let run_start = name_start;
        while name_start < bytes.len() && is_sep(bytes[name_start]) {
            // A `\uXXXX` right after the root's own separator, or after whole
            // escaped `\\` pairs, is the name's first letter, not a separator.
            // Inside a pair (`\\u1234`) it is a login that looks like one.
            let backslashes = bytes[run_start..name_start].iter().filter(|&&b| b == b'\\').count();
            if name_start > run_start
                && backslashes % 2 == 0
                && unicode_escape_len(&bytes[name_start..]) > 0
            {
                break;
            }
            name_start += 1;
        }
        let len = name_len(&s[name_start..]);
        if len > 0 {
            out.push_str(&s[copied..name_start]);
            out.push_str("[REDACTED]");
            copied = name_start + len;
        }
        i = name_start + len;
    }
    out.push_str(&s[copied..]);
    out
}

/// FNV-1a 64-bit, hex — dedup fingerprint (collision-tolerant grouping key,
/// not a security hash; avoids a new crate for sha2).
fn fnv1a64_hex(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Which OS build this is, for reports where the distribution is the story.
///
/// A 0.1.111 report from a Linux user whose webview refused to compile the
/// constraint solver's WASM could not be diagnosed, because the only platform
/// facts collected were "linux" and "x86_64" — neither of which says which
/// WebKitGTK is installed. Paired with `tauri::webview_version()`, this is the
/// difference between "some Linux" and an answerable question.
///
/// Linux reads /etc/os-release rather than shelling out. Windows and macOS
/// return empty for now: there is no std API for it and spawning a process
/// during a bug report is not worth it, and on both of those the webview
/// version is the more useful number anyway.
fn os_version() -> String {
    #[cfg(target_os = "linux")]
    {
        if let Ok(text) = std::fs::read_to_string("/etc/os-release") {
            for line in text.lines() {
                if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
                    return v.trim().trim_matches('"').to_string();
                }
            }
        }
    }
    String::new()
}

/// last `max` bytes of the sidecar log, lossily decoded (never fails the
/// report over a missing/unreadable log — the report IS the diagnostic path).
fn read_log_tail(app: &AppHandle, max: usize) -> Option<String> {
    read_log_tail_at(&app.path().app_data_dir().ok()?.join("sidecar.log"), max)
}

/// The tail starts on a whole line: a cut mid-line can begin past a path's
/// `Users\` anchor, and the redactor would then send the rest of the name.
fn read_log_tail_at(path: &std::path::Path, max: usize) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut start = bytes.len().saturating_sub(max);
    if start > 0 && bytes[start - 1] != b'\n' {
        if let Some(nl) = bytes[start..].iter().position(|&b| b == b'\n') {
            start += nl + 1;
        }
    }
    Some(String::from_utf8_lossy(&bytes[start..]).into_owned())
}

#[derive(Serialize, Clone, Debug)]
pub struct BugReportResult {
    pub bug_id: Option<String>,
    pub deduplicated: bool,
}

const MAX_TAIL_CRUMBS: usize = 20;
const MAX_STICKY_CRUMBS: usize = 24;

/// True iff a crumb carries `crumb()`'s "HH:MM:SS " prefix.
fn is_timestamped(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 9
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[2] == b':'
        && b[3].is_ascii_digit()
        && b[4].is_ascii_digit()
        && b[5] == b':'
        && b[6].is_ascii_digit()
        && b[7].is_ascii_digit()
        && b[8] == b' '
}

/// Trim the trail for upload: keep the LAST 20 ordinary crumbs, but never at the
/// cost of the leading "sticky" facts.
///
/// This used to be a plain `.rev().take(20).rev()`. The frontend deliberately
/// holds one-off startup captures (the HID device inventory) OUTSIDE its 20-slot
/// ring and PREPENDS them, so that dropped exactly those the moment the user did
/// anything — i.e. in every session busy enough to be worth reporting. It cost
/// the privacy exposure of collecting the inventory while delivering none of its
/// diagnostic value.
///
/// CONTRACT with `src/diagnostics/breadcrumbs.ts`: `crumb()` always prefixes
/// "HH:MM:SS ", `stickyFact()` never does. That timestamp is the discriminator —
/// keep the two in step, since a sticky fact that gained a timestamp would
/// silently become droppable again.
fn trim_breadcrumbs(crumbs: &[String]) -> Vec<String> {
    let (rest, sticky): (Vec<&String>, Vec<&String>) =
        crumbs.iter().partition(|b| is_timestamped(b));
    sticky
        .into_iter()
        .take(MAX_STICKY_CRUMBS)
        .chain(rest.into_iter().rev().take(MAX_TAIL_CRUMBS).rev())
        .cloned()
        .collect()
}

/// Keys whose string values in a document are paths on the user's disk: an
/// import's dialog path and an image texture's file. Nothing reads either
/// from a report. Body names, titles and sketch text are the user's own words
/// and are sent as written.
const DOCUMENT_PATH_KEYS: [&str; 2] = ["source", "imagePath"];

/// Redact the path fields of a parsed document. Working on decoded strings
/// rather than the JSON text keeps the result valid JSON by construction.
fn redact_document_paths(v: &mut serde_json::Value) {
    use serde_json::Value;
    match v {
        Value::Array(items) => items.iter_mut().for_each(redact_document_paths),
        Value::Object(fields) => {
            for (key, child) in fields.iter_mut() {
                match child {
                    Value::String(s) if DOCUMENT_PATH_KEYS.contains(&key.as_str()) => {
                        *s = redact_user_paths(s);
                    }
                    _ => redact_document_paths(child),
                }
            }
        }
        _ => {}
    }
}

/// The exact JSON the bug report POSTs, with every user-supplied part
/// scrubbed. Pure (no AppHandle, no platform calls) so a test can assert on
/// the whole wire body rather than on the redactor alone.
#[allow(clippy::too_many_arguments)]
fn build_report_body(
    description: &str,
    app_version: &str,
    os_version: &str,
    webview_version: &str,
    sidecar_connected: bool,
    log_tail: Option<String>,
    breadcrumbs: &[String],
    document_json: Option<&str>,
    locale: Option<&str>,
    category: Option<&str>,
) -> TResult<serde_json::Value> {
    let clean_description = redact_user_paths(description);
    let first_line = clean_description.lines().next().unwrap_or("bug report");
    let title: String = first_line.chars().take(120).collect();
    let fingerprint = fnv1a64_hex(&format!("{app_version}|{first_line}"));

    let log_tail = log_tail.map(|t| redact_user_paths(&t));
    let breadcrumbs: Vec<String> = trim_breadcrumbs(breadcrumbs)
        .into_iter()
        .map(|b| redact_user_paths(&b))
        .collect();

    let document_value: Option<serde_json::Value> = match document_json {
        Some(s) if s.len() > MAX_DOCUMENT_BYTES => {
            return Err(TaError::new(
                TaErrCode::Config,
                "document too large to attach — send the report without it",
            ));
        }
        Some(s) => {
            let mut doc = serde_json::from_str(s).map_err(|e| {
                TaError::new(TaErrCode::Config, format!("document isn't valid JSON: {e}"))
            })?;
            redact_document_paths(&mut doc);
            Some(doc)
        }
        None => None,
    };

    Ok(serde_json::json!({
        "title": title,
        "description": clean_description,
        "app_version": app_version,
        "os": std::env::consts::OS,
        "os_version": os_version,
        "webview_version": webview_version,
        "arch": std::env::consts::ARCH,
        "sidecar_connected": sidecar_connected,
        "log_tail": log_tail,
        "breadcrumbs": breadcrumbs,
        "fingerprint": fingerprint,
        "document_json": document_value,
        "locale": locale.map(|l| l.chars().take(16).collect::<String>()),
        "category": category.map(|c| c.chars().take(16).collect::<String>()),
    }))
}


#[tauri::command]
pub async fn ta_bug_report(
    app: AppHandle,
    description: String,
    app_version: String,
    sidecar_connected: bool,
    include_log: bool,
    breadcrumbs: Vec<String>,
    document_json: Option<String>,
    // Both optional so an older webview build keeps working against this shell.
    // `locale` is the UI language the report was filed from (the breadcrumbs
    // and log stay English regardless); `category` is "bug", "translation" or
    // "other" from the reporter's picker.
    locale: Option<String>,
    category: Option<String>,
) -> TResult<BugReportResult> {
    let description = description.trim().to_string();
    if description.is_empty() {
        return Err(TaError::new(TaErrCode::Config, "describe the problem first"));
    }
    // signed-out is fine — report goes anonymous
    let account = read_account(&app).unwrap_or(None);

    let log_tail = if include_log { read_log_tail(&app, LOG_TAIL_BYTES) } else { None };
    let body = build_report_body(
        &description,
        &app_version,
        &os_version(),
        &tauri::webview_version().unwrap_or_default(),
        sidecar_connected,
        log_tail,
        &breadcrumbs,
        document_json.as_deref(),
        locale.as_deref(),
        category.as_deref(),
    )?;

    let client = http(Duration::from_secs(30))?;
    let mut req = client.post(format!("{BASE}/api/desktop/bug-report")).json(&body);
    if let Some(acct) = &account {
        req = req.bearer_auth(&acct.token);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| TaError::new(TaErrCode::Unreachable, e.to_string()))?;
    let status = resp.status();
    if status.as_u16() == 429 {
        return Err(TaError::new(
            TaErrCode::Rejected,
            "too many reports from this connection — try again later",
        ));
    }
    if !status.is_success() {
        let msg = resp.text().await.unwrap_or_default();
        return Err(TaError::new(
            TaErrCode::Rejected,
            format!("server rejected the report (HTTP {status}): {msg}"),
        ));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| TaError::new(TaErrCode::Protocol, e.to_string()))?;
    Ok(BugReportResult {
        bug_id: v.get("bug_id").and_then(|x| x.as_str()).map(String::from),
        deduplicated: v.get("deduplicated").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

// --- tests -----------------------------------------------------------------------

#[cfg(test)]
mod tests {

    // The HID inventory is captured once at startup and PREPENDED as a sticky
    // fact; a plain tail-truncation dropped it in exactly the busy sessions
    // worth reporting. Pin that it survives.
    #[test]
    fn sticky_breadcrumbs_survive_a_busy_session() {
        let mut crumbs = vec![
            "[spacemouse] picked nothing - of 26 HID interfaces:".to_string(),
            "[spacemouse]   046d:c626 usage 1/8".to_string(),
        ];
        for i in 0..60 {
            crumbs.push(format!("12:34:56 [info] noise {i}"));
        }
        let out = trim_breadcrumbs(&crumbs);
        assert!(out.iter().any(|c| c.contains("26 HID interfaces")),
                "sticky fact was dropped: {out:?}");
        assert!(out[0].starts_with("[spacemouse]"), "sticky facts must lead");
        // ...and the ordinary tail is still the most RECENT 20, not the oldest.
        assert!(out.iter().any(|c| c.contains("noise 59")));
        assert!(!out.iter().any(|c| c.contains("noise 0")));
        assert_eq!(out.len(), 2 + 20);
    }

    #[test]
    fn trim_keeps_plain_trails_unchanged_when_short() {
        let crumbs: Vec<String> = (0..5).map(|i| format!("00:00:0{i} [info] x")).collect();
        assert_eq!(trim_breadcrumbs(&crumbs), crumbs);
    }

    #[test]
    fn sticky_facts_are_themselves_bounded() {
        let crumbs: Vec<String> = (0..100).map(|i| format!("[sticky] fact {i}")).collect();
        assert_eq!(trim_breadcrumbs(&crumbs).len(), MAX_STICKY_CRUMBS);
    }
    use super::*;

    #[test]
    fn user_path_redaction() {
        // Windows drive + the exact field-log shape
        assert_eq!(
            redact_user_paths(r"spawn: C:\Users\alice\AppData\Local\SindriCAD\python.exe"),
            r"spawn: C:\Users\[REDACTED]\AppData\Local\SindriCAD\python.exe"
        );
        // UNC form
        assert_eq!(
            redact_user_paths(r"\\HOST\Users\someone\share"),
            r"\\HOST\Users\[REDACTED]\share"
        );
        // Unix + macOS homes, including a NON-current-machine name
        assert_eq!(
            redact_user_paths("path /home/alice/proj/x.py and /Users/bob/y"),
            "path /home/[REDACTED]/proj/x.py and /Users/[REDACTED]/y"
        );
        // segment ends at whitespace/quote
        assert_eq!(
            redact_user_paths(r#"log at "C:\Users\name" end"#),
            r#"log at "C:\Users\[REDACTED]" end"#
        );
        // untouched text stays byte-identical
        assert_eq!(redact_user_paths("no paths here"), "no paths here");
    }

    #[test]
    fn user_path_redaction_survives_escaped_and_odd_paths() {
        let cases: &[(&str, &str)] = &[
            // The spawn line as 0.1.248 and earlier wrote it: Debug formatting
            // doubles every backslash. Logs in this shape are already on disk.
            (
                r#"spawn: "C:\\Users\\alice\\AppData\\python.exe" "server.py" (cwd "C:\\Users\\alice\\app")"#,
                r#"spawn: "C:\\Users\\[REDACTED]\\AppData\\python.exe" "server.py" (cwd "C:\\Users\\[REDACTED]\\app")"#,
            ),
            // Escaped UNC form
            (r"\\\\HOST\\Users\\someone\\share", r"\\\\HOST\\Users\\[REDACTED]\\share"),
            // Windows with forward slashes, and mixed separators
            (
                "C:/Users/alice/x and C:\\Users/bob\\y",
                "C:/Users/[REDACTED]/x and C:\\Users/[REDACTED]\\y",
            ),
            // A profile folder with a space must not leak its second word
            (r"C:\Users\John Smith\AppData", r"C:\Users\[REDACTED]\AppData"),
            (r#""C:\Users\John Smith""#, r#""C:\Users\[REDACTED]""#),
            // Non-ASCII names, including text whose lowercase changes byte
            // length ('İ' is 2 bytes, its lowercase "i̇" is 3) BEFORE the
            // match, which misaligns offsets taken from a lowercased copy.
            (r"C:\Users\Jörg\x", r"C:\Users\[REDACTED]\x"),
            (r"İİİİ C:\Users\İlker\x", r"İİİİ C:\Users\[REDACTED]\x"),
            ("ẞẞ Ⱥ /home/ẞtraße/x", "ẞẞ Ⱥ /home/[REDACTED]/x"),
        ];
        let failed: Vec<String> = cases
            .iter()
            .filter_map(|(input, want)| {
                let got = std::panic::catch_unwind(|| redact_user_paths(input))
                    .unwrap_or_else(|_| "<panicked>".to_string());
                (got != *want).then(|| format!("\n  in:   {input}\n  got:  {got}\n  want: {want}"))
            })
            .collect();
        assert!(failed.is_empty(), "{} of {} cases wrong:{}", failed.len(), cases.len(), failed.concat());
    }

    // Gaps left by the first pass, each a shape a real report can carry:
    // removable media (udisks2 mounts under /run/media/<user>, Debian's
    // /media/<user>), and the sidecar's `err:` lines, which are json.dumps
    // text, so a non-ASCII name arrives as \uXXXX escapes. The escapes here
    // spell plain letters so the fixtures hold only placeholder names.
    #[test]
    fn user_path_redaction_covers_removable_media_and_json_escapes() {
        let cases: &[(&str, &str)] = &[
            ("/run/media/alice/USB/part.step", "/run/media/[REDACTED]/USB/part.step"),
            (
                "FileNotFoundError: [Errno 2] No such file or directory: '/media/alice/KINGSTON/logo.png'",
                "FileNotFoundError: [Errno 2] No such file or directory: '/media/[REDACTED]/KINGSTON/logo.png'",
            ),
            // An escape inside the name, at its start, and a /home name of escapes
            (
                r#"err: {"source": "C:\\Users\\ali\u0063e\\Desktop\\part.step"}"#,
                r#"err: {"source": "C:\\Users\\[REDACTED]\\Desktop\\part.step"}"#,
            ),
            (
                r#"{"source": "C:\\Users\\\u0061lice\\x.step"}"#,
                r#"{"source": "C:\\Users\\[REDACTED]\\x.step"}"#,
            ),
            (
                r#"err: {"imagePath": "/home/\u0062o\u0062/logo.png"}"#,
                r#"err: {"imagePath": "/home/[REDACTED]/logo.png"}"#,
            ),
            // A login that merely LOOKS like an escape (u + four hex digits)
            // after an escaped backslash: the backslash pair is the separator,
            // and the output must keep both halves or the JSON breaks.
            (
                r#"{"source":"C:\\Users\\u1234\\Desktop\\part.step"}"#,
                r#"{"source":"C:\\Users\\[REDACTED]\\Desktop\\part.step"}"#,
            ),
            (r"spawn: C:\Users\u1234\AppData", r"spawn: C:\Users\[REDACTED]\AppData"),
            // Accepted over-redaction, pinned so it stays a decision
            (r"C:\Users\alice\u1234\x", r"C:\Users\[REDACTED]\x"),
            ("/media/cdrom/x", "/media/[REDACTED]/x"),
            // Prose that names the words without a path stays byte-identical
            ("see Users/Guide and the home/garden page", "see Users/Guide and the home/garden page"),
        ];
        let failed: Vec<String> = cases
            .iter()
            .filter_map(|(input, want)| {
                let got = std::panic::catch_unwind(|| redact_user_paths(input))
                    .unwrap_or_else(|_| "<panicked>".to_string());
                (got != *want).then(|| format!("\n  in:   {input}\n  got:  {got}\n  want: {want}"))
            })
            .collect();
        assert!(failed.is_empty(), "{} of {} cases wrong:{}", failed.len(), cases.len(), failed.concat());
    }

    /// A log file under the OS temp dir, removed on Drop.
    struct TmpLog(std::path::PathBuf);
    impl TmpLog {
        fn new(label: &str, content: &[u8]) -> Self {
            let path = std::env::temp_dir()
                .join(format!("sindricad-test-{label}-{}.log", std::process::id()));
            std::fs::write(&path, content).expect("write tmp log");
            TmpLog(path)
        }
    }
    impl Drop for TmpLog {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn log_tail_starts_on_a_line_boundary() {
        let log = "[sidecar] version 0.1.251\n[sidecar] spawn ok\n[sidecar] LISTENING 8765\n";
        let tmp = TmpLog::new("tail-lines", log.as_bytes());
        let tail = |max| read_log_tail_at(&tmp.0, max).expect("log reads");
        // cut mid-line: the partial line is dropped
        assert_eq!(tail(30), "[sidecar] LISTENING 8765\n");
        // cut exactly at a line start: that line is kept whole
        assert_eq!(tail(25), "[sidecar] LISTENING 8765\n");
        assert_eq!(tail(1000), log);
        // nothing to snap to: keep the tail rather than send nothing
        let flat = TmpLog::new("tail-flat", b"abcdefgh");
        assert_eq!(read_log_tail_at(&flat.0, 3).as_deref(), Some("fgh"));
    }

    // The byte cut used to land wherever LOG_TAIL_BYTES fell, so the first line
    // could start mid-name, past the `Users\` anchor the redactor needs.
    #[test]
    fn log_tail_cut_inside_a_user_path_cannot_leak_the_name() {
        let head = "SindriCAD 0.1.251\nspawn: C:\\Users\\al";
        let rest_of_spawn = "ice\\AppData\\Local\\SindriCAD\\python.exe\n";
        let filler = "[sidecar] ok\n".repeat((LOG_TAIL_BYTES - rest_of_spawn.len()) / 13);
        let pad = "#".repeat(LOG_TAIL_BYTES - rest_of_spawn.len() - filler.len());
        let filler = format!("{pad}{filler}");
        let log = format!("{head}{rest_of_spawn}{filler}");
        assert_eq!(log.len() - LOG_TAIL_BYTES, head.len(), "the cut must land inside the name");

        let tmp = TmpLog::new("tail-cut", log.as_bytes());
        let tail = read_log_tail_at(&tmp.0, LOG_TAIL_BYTES).expect("log reads");
        let sent = redact_user_paths(&tail);
        assert!(!sent.contains("ice"), "partial name leaked: {:?}", &sent[..60]);
        assert_eq!(sent, filler);
    }

    // An import records the dialog path in `source`, an image texture its file
    // in `imagePath`; both ride along when the user attaches the document.
    // Only those path fields are scrubbed: the user's own names and text are not.
    #[test]
    fn attached_document_paths_are_redacted_and_still_json() {
        let doc = r#"{"bodyNames":{"b1":"alice's bracket","b2":"copied from /home/alice/old"},"features":[{"id":"f1","type":"import","source":"C:\\Users\\u1234\\Desktop\\part.step"},{"id":"f2","type":"import","source":"/run/media/alice/USB/scan.stl"},{"id":"f3","type":"texture","imagePath":"/media/bob/K/logo.png"},{"id":"f4","type":"sketch","entities":[{"id":"e1","kind":"line","source":{"kind":"edge","body":"b1"}}]}]}"#;
        let body = build_report_body("crash", "0.1.251", "", "", true, None, &[], Some(doc), None, None)
            .expect("the report builds");
        let d = &body["document_json"];
        assert!(d.is_object(), "document must still be JSON: {d}");
        assert_eq!(d["features"][0]["source"], r"C:\Users\[REDACTED]\Desktop\part.step");
        assert_eq!(d["features"][1]["source"], "/run/media/[REDACTED]/USB/scan.stl");
        assert_eq!(d["features"][2]["imagePath"], "/media/[REDACTED]/K/logo.png");
        assert_eq!(d["features"][3]["entities"][0]["source"]["body"], "b1");
        assert_eq!(d["bodyNames"]["b1"], "alice's bracket");
        assert_eq!(d["bodyNames"]["b2"], "copied from /home/alice/old");

        // a path-free document arrives exactly as parsed
        let plain = r#"{"bodyNames":{"b1":"my/home\nstuff"},"features":[{"id":"f1","type":"box","source":"my home"}]}"#;
        let body = build_report_body("crash", "0.1.251", "", "", true, None, &[], Some(plain), None, None)
            .expect("the report builds");
        assert_eq!(body["document_json"], serde_json::from_str::<serde_json::Value>(plain).unwrap());
    }

    // The whole wire body, every user-supplied part carrying a name in a
    // different shape: none of them may reach the server.
    #[test]
    fn nothing_in_the_report_body_carries_a_username() {
        let description = r"Import of C:\Users\alice\Desktop\x.step crashes";
        let log_tail = "header\nerr: {\"imagePath\": \"/run/media/alice/USB/logo.png\"}\n".to_string();
        let crumbs = vec!["12:00:00 [error] can't read texture image '/media/bob/K/logo.png'".to_string()];
        let doc = r#"{"features":[{"id":"f1","type":"import","source":"C:\\Users\\u1234\\Desktop\\part.step"},{"id":"f2","type":"texture","imagePath":"/home/alice/logo.png"}]}"#;
        let body = build_report_body(
            description, "0.1.251", "", "", true, Some(log_tail), &crumbs, Some(doc), Some("en"), Some("bug"),
        )
        .expect("the report builds");
        let wire = serde_json::to_string(&body).unwrap();
        for name in ["alice", "bob", "u1234"] {
            assert!(!wire.contains(name), "{name} reached the wire: {wire}");
        }
        assert!(body["title"].as_str().unwrap().contains("[REDACTED]"));
        assert_eq!(
            body["breadcrumbs"][0],
            "12:00:00 [error] can't read texture image '/media/[REDACTED]/K/logo.png'"
        );
        assert_eq!(body["document_json"]["features"][0]["source"], r"C:\Users\[REDACTED]\Desktop\part.step");
    }

    #[test]
    fn fingerprint_is_stable_hex() {
        let a = fnv1a64_hex("0.1.48|geometry engine connection lost");
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, fnv1a64_hex("0.1.48|geometry engine connection lost"));
        assert_ne!(a, fnv1a64_hex("0.1.49|geometry engine connection lost"));
    }

    #[test]
    fn token_sanitization() {
        assert_eq!(sanitize_token("  ta_scad_abc123  ").as_deref(), Some("ta_scad_abc123"));
        assert_eq!(sanitize_token(""), None);
        assert_eq!(sanitize_token("   "), None);
        assert_eq!(sanitize_token("two words"), None);
        assert_eq!(sanitize_token("tab\there"), None);
        assert_eq!(sanitize_token("ctrl\u{7}char"), None);
        assert_eq!(sanitize_token(&"x".repeat(201)), None);
    }

    #[test]
    fn ta_url_validation() {
        assert!(valid_ta_url(&format!("{BASE}/profile?tab=3d-models")));
        assert!(valid_ta_url(BASE));
        assert!(!valid_ta_url("https://evil.example/phish"));
        assert!(!valid_ta_url("https://tinkeratlas.com.evil.example/"));
    }

    #[test]
    fn avatar_hosts() {
        assert!(avatar_url_allowed("https://tinkeratlas.com/a.png"));
        assert!(avatar_url_allowed("https://api.tinkeratlas.com/storage/v1/a.png"));
        assert!(!avatar_url_allowed("https://nottinkeratlas.com/a.png"));
        assert!(!avatar_url_allowed("http://api.tinkeratlas.com/a.png"));
        assert!(!avatar_url_allowed("file:///etc/passwd"));
    }

    #[test]
    fn callback_parsing() {
        assert_eq!(
            parse_callback("GET /callback?token=ta_scad_abc&state=deadbeef HTTP/1.1"),
            Some(("ta_scad_abc".into(), "deadbeef".into()))
        );
        assert_eq!(
            parse_callback("GET /callback?state=deadbeef&token=ta_scad_abc HTTP/1.1"),
            Some(("ta_scad_abc".into(), "deadbeef".into()))
        );
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1"), None);
        assert_eq!(parse_callback("GET /callback?token=x HTTP/1.1"), None); // no state
        assert_eq!(parse_callback("POST /callback?token=x&state=y HTTP/1.1"), None);
    }

    #[test]
    fn query_value_encoding() {
        assert_eq!(
            encode_query_value("/sindricad/authorize?port=1234&state=ab"),
            "/sindricad/authorize%3Fport%3D1234%26state%3Dab"
        );
        assert_eq!(encode_query_value("plain/path"), "plain/path");
    }

    #[test]
    fn model_mimes() {
        assert_eq!(model_mime("3mf"), "model/3mf");
        assert_eq!(model_mime("stl"), "model/stl");
        assert_eq!(model_mime("step"), "application/step");
        assert_eq!(model_mime("weird"), "application/octet-stream");
    }
}
