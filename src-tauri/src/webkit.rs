//! WebKitGTK GPU workarounds, applied before the webview starts (Linux only).
//!
//! macOS (WKWebView) and Windows (WebView2) are different engines entirely and
//! read none of these variables, which is why the whole module is Linux-gated.
//!
//! Split into a pure `decide` plus a thin applier for the same reason
//! `sidecar::configure_env` is split out: this is behaviour that only misfires
//! on hardware nobody here builds on, so the decision has to be assertable
//! without the hardware. Nothing in this file has been exercised against an
//! actual Nvidia GPU by me — see the test module.
//!
//! On Nvidia the workaround is a TRIAL with a remembered fallback: launch with
//! shared-memory buffers (`FORCE_SHM`, GPU compositing kept), and if a launch
//! with them never reaches the interface, use `DMABUF` (CPU painting, the old
//! workaround) on that machine from then on. The memory is a marker file in the
//! app data dir (`MARKER_FILE`); see `Marker` for its life cycle.
//!
//! It also reports what WebKit ended up with (`record_renderer`): the variables
//! and who set them, the WebKitGTK version, and the hardware-acceleration policy
//! read back from the live webview. GH #17 took a video and a measurement round
//! to learn that the webview was painting on the CPU; one log line says it.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;

/// Our own opt-out. A user whose machine is made *worse* by the workaround
/// needs an escape hatch, and the obvious one — setting
/// `WEBKIT_DISABLE_DMABUF_RENDERER=0` — does not work: WebKit's own checks are
/// presence-based in places, so "0" can read as "yes, disable it". A separate
/// variable of ours has no such ambiguity.
const OPT_OUT: &str = "SINDRICAD_NO_GPU_WORKAROUND";

/// What an Nvidia machine gets first. It keeps WebKit's GPU compositing and
/// changes only how finished frames reach the GTK widget: through shared memory
/// instead of DMA-BUF, which is the path issue #6 crashed in. Measured on
/// WebKitGTK 2.52.6 (GH #17, .fable/gh17-video/RESULT.md): webkit://gpu reports
/// `Policy: always` with Shared Memory buffers, and drawing a rectangle in an
/// empty sketch holds 16.7 ms a frame on a full core and 20.5 ms on half of one.
///
/// NOT confirmed to avoid the #6 crash: there is no Nvidia hardware here. One
/// outside report (unsloth #9393, an RTX 2070 SUPER whose plain DMA-BUF failed)
/// says it does. That uncertainty is why it is a trial with a fallback.
const FORCE_SHM: &str = "WEBKIT_DMABUF_RENDERER_FORCE_SHM";

/// The fallback, and what every Nvidia machine got before GH #17. Deliberately
/// NOT `WEBKIT_DISABLE_COMPOSITING_MODE`, which also avoids the crash but was
/// the mode under which the reporter of issue #6 also saw viewport pointer
/// capture stick (that is bug 2 of the same issue, unfixed).
///
/// It was chosen as the narrow switch, and it is not. On WebKitGTK 2.44 and
/// later it turns hardware acceleration off entirely: measured on 2.52.6,
/// webkit://gpu reports `Policy: never`, the settings' hardware-acceleration
/// policy reads back `never` after an explicit ALWAYS, and the web process holds
/// no GPU renderer. Every frame is painted on the CPU. The same rectangle ran at
/// 22 ms a frame on a full fast core and 49 ms (20 fps) on half of one. That is
/// a smoothness cost, not a correctness one, and it still beats not launching.
///
/// WebKit documents the variable as a transitional debugging escape hatch that
/// will eventually be removed. When it goes, this module has to be revisited
/// rather than quietly stop working.
const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// The variables that choose WebKit's renderer. A user who set any of them is
/// choosing it themselves (the issue #6 reporter ran with one for weeks), so we
/// set nothing on top. Other `WEBKIT_*` variables (logging, the inspector) say
/// nothing about the renderer and do not switch the workaround off.
const USER_RENDERER_VARS: [&str; 5] = [
    DMABUF,
    FORCE_SHM,
    "WEBKIT_FORCE_DMABUF_RENDERER",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
    "WEBKIT_FORCE_COMPOSITING_MODE",
];

/// Last-resort switch for a machine whose driver cannot give the viewport a
/// WebGL2 context at all, so the app opens showing only the static shell: the
/// logo, and no menus. Reported on Debian Bookworm with a 2009 NVIDIA G105M,
/// which the current proprietary driver has dropped, leaving the open-source
/// nouveau driver and no WebGL2.
///
/// Deliberately OPT-IN, and deliberately not automatic. There is no reliable way
/// to predict a WebGL2 failure from the Rust side before the webview exists:
/// nouveau's presence does not imply it, and the proprietary-driver probe below
/// is looking for a completely different fault (a SIGSEGV before anything
/// paints, whereas this machine paints fine and only the 3D context dies).
/// Guessing here would slow down every working Linux machine to rescue a few.
///
/// All this does is set LIBGL_ALWAYS_SOFTWARE for the user, so the workaround
/// the in-app panel recommends can be made permanent in a .desktop file rather
/// than retyped in a terminal every launch. Software rasterising is slow on
/// large models; it is not slow compared with not starting.
const FORCE_SOFTWARE: &str = "SINDRICAD_FORCE_SOFTWARE_GL";
const SOFTWARE_GL: &str = "LIBGL_ALWAYS_SOFTWARE";

/// The variables this module set, comma-separated, so a process WE start (the
/// restart into the fallback, the restart after an update) can tell them from
/// the user's. It inherits our environment, and without this it read our
/// `FORCE_SHM` as the user's own choice and kept it, fallback or not.
const OURS: &str = "SINDRICAD_GPU_VARS_SET";

/// tauri.conf.json's `identifier`, which names the app data dir. Needed before
/// Tauri exists (the variables must be set before the webview is), so it is
/// repeated here; a test pins the two together.
const APP_IDENTIFIER: &str = "dev.sindricad.app";
const MARKER_FILE: &str = "gpu-fallback.json";

/// What the marker file says about shared-memory buffers on this machine.
///
/// `Pending` is written before the webview starts and cleared once the trial
/// passes (`TrialEvent::Passed`), so a launch that dies in between leaves it
/// behind. The next launch reads that as a crash and writes `Failed`, which
/// stays: the fallback is for good, until the file is deleted (the `[gpu]` line
/// names it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Marker {
    None,
    Pending,
    Failed,
}

/// What to set, and why. The reason is carried so the startup log says what
/// happened; a silent environment change is exactly the kind of thing that
/// makes a later field report unreadable.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nvidia: shared-memory buffers, on trial until the interface loads.
    ForceShm,
    /// Nvidia, the fallback: the DMABUF renderer off, so CPU painting. One of
    /// the `FALLBACK_*` reasons below.
    Disable(&'static str),
    /// The user asked for software GL via `SINDRICAD_FORCE_SOFTWARE_GL`. Checked
    /// FIRST, because a machine that cannot make a context at all has nothing to
    /// gain from any decision about the DMABUF renderer.
    ForceSoftware,
    /// Left alone, for one of the `SKIP_*` reasons below.
    Skip(&'static str),
}

// Named so the applier can match on them instead of repeating the prose, which
// would drift apart from `decide` the first time either is reworded.
const SKIP_OPT_OUT: &str = "opted out via SINDRICAD_NO_GPU_WORKAROUND";
const SKIP_ALREADY_SET: &str = "a WebKit renderer variable is already set by the environment";
const SKIP_NO_NVIDIA: &str = "no Nvidia driver";
const FALLBACK_CRASHED: &str = "the last launch with shared-memory buffers ended before it was known to work";
const FALLBACK_REMEMBERED: &str = "an earlier launch with shared-memory buffers crashed or never reached the interface";
const FALLBACK_NO_MARKER: &str =
    "the fallback marker cannot be written, so a crash with shared-memory buffers could not be caught";

/// Issue #6 (Nobara/Fedora 44, RTX 5080, driver 595.84, Wayland):
/// `WebKitWebProcess` takes a SIGSEGV inside `libnvidia-eglcore` on launch and
/// the app dies before painting anything — no dialog, no message, nothing the
/// user can act on. The reporter confirmed that EITHER
/// `WEBKIT_DISABLE_DMABUF_RENDERER=1` or `WEBKIT_DISABLE_COMPOSITING_MODE=1`
/// avoids it.
///
/// This fires for every Nvidia machine, not only broken ones, because there is
/// no way to tell them apart before the crash. Every Nvidia machine first tries
/// `FORCE_SHM`, which costs nothing where it works; a machine where it does not
/// pays one failed launch and then gets `DMABUF`, whose cost is CPU painting.
fn decide(
    nvidia_present: bool,
    user_renderer_var: bool,
    opted_out: bool,
    force_software: bool,
    marker: Marker,
) -> Decision {
    // Software GL outranks everything: it is the most explicit request a user can
    // make here, and it is asked for by someone whose app does not currently
    // start at all.
    if force_software {
        return Decision::ForceSoftware;
    }
    // Precedence: an explicit human beats our guess, both ways round. Someone
    // running with a renderer variable already set is mid-workaround (the issue
    // #6 reporter was) and must not have it changed under them.
    if opted_out {
        return Decision::Skip(SKIP_OPT_OUT);
    }
    if user_renderer_var {
        return Decision::Skip(SKIP_ALREADY_SET);
    }
    if !nvidia_present {
        return Decision::Skip(SKIP_NO_NVIDIA);
    }
    match marker {
        Marker::None => Decision::ForceShm,
        Marker::Pending => Decision::Disable(FALLBACK_CRASHED),
        Marker::Failed => Decision::Disable(FALLBACK_REMEMBERED),
    }
}

/// The marker a decision leaves before the webview starts; `None` leaves the
/// file as it is. A trial is marked pending; a pending marker found at start
/// becomes the permanent failure.
fn marker_for(decision: &Decision) -> Option<Marker> {
    match decision {
        Decision::ForceShm => Some(Marker::Pending),
        Decision::Disable(FALLBACK_CRASHED) => Some(Marker::Failed),
        _ => None,
    }
}

/// What can happen to a launch on trial after the webview exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrialEvent {
    /// The frontend checked in (`frontend_ready`).
    Ready,
    /// `TRIAL_WINDOW` after Ready with no crash, or a clean exit after Ready.
    Passed,
    /// The frontend has not checked in after `FRONTEND_READY_TIMEOUT`.
    WatchdogFired,
    /// WebKit reports its web process crashed.
    WebProcessCrashed,
}

/// How long the interface has to stay up after checking in before the trial
/// passes. Ready alone is not enough: boot.ts checks in before the viewport has
/// made its WebGL context or composited a frame, which is where a GPU-path
/// crash would come from.
pub const TRIAL_WINDOW: std::time::Duration = std::time::Duration::from_secs(10);

/// Where a trial stands.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct TrialState {
    ready: bool,
    /// passed or crashed: the trial is decided and nothing changes it.
    decided: bool,
}

/// The marker a trial event writes, and whether to restart into the fallback
/// now. `None`: nothing to do.
///
/// - Ready puts the marker back to pending, which undoes the watchdog's verdict
///   on a slow start that got there after all.
/// - Passed clears it: shared-memory buffers work on this machine.
/// - The watchdog records the failure but does not restart. It cannot tell a
///   dead renderer from a slow cold start, and a restart would cut short a
///   launch that was about to succeed.
/// - A crash records the failure, and restarts if the interface had not loaded.
///   That restart is clean: nothing has loaded, so there is no work to lose, and
///   the next launch reads `Failed` and comes up on the fallback, so it happens
///   once. After the interface loaded the user may have work open, so they get
///   WebKit's crash and the fallback on their next launch.
fn trial_outcome(event: TrialEvent, state: TrialState) -> Option<(Marker, bool)> {
    if state.decided {
        return None;
    }
    match event {
        TrialEvent::Ready => Some((Marker::Pending, false)),
        TrialEvent::Passed => state.ready.then_some((Marker::None, false)),
        TrialEvent::WatchdogFired => (!state.ready).then_some((Marker::Failed, false)),
        TrialEvent::WebProcessCrashed => Some((Marker::Failed, !state.ready)),
    }
}

fn parse_marker(text: &str) -> Marker {
    let value: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
    match value.get("forceShm").and_then(|v| v.as_str()) {
        Some("pending") => Marker::Pending,
        Some("failed") => Marker::Failed,
        _ => Marker::None,
    }
}

/// A missing or unreadable marker reads as none: the machine tries again.
fn read_marker(path: &Path) -> Marker {
    std::fs::read_to_string(path).map_or(Marker::None, |text| parse_marker(&text))
}

fn write_marker(path: &Path, marker: Marker) -> std::io::Result<()> {
    let state = match marker {
        Marker::None => {
            return match std::fs::remove_file(path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            };
        }
        Marker::Pending => "pending",
        Marker::Failed => "failed",
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::json!({ "forceShm": state }).to_string())
}

/// Tauri's app data dir on Linux, worked out the way it does (dirs::data_dir):
/// `$XDG_DATA_HOME` if absolute, else `$HOME/.local/share`, then the identifier.
fn app_data_dir_from(
    xdg_data_home: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    let base = xdg_data_home
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| home.map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join(APP_IDENTIFIER))
}

/// The distribution's ID when it is Debian or derived from it. Debian's
/// webkit2gtk carries `disable-nvidia-dmabuf.patch` (verified on trixie
/// 2.52.6), which turns DMA-BUF off on Nvidia before `FORCE_SHM` is read, so the
/// webview paints on the CPU whatever we set unless
/// `WEBKIT_FORCE_DMABUF_RENDERER=1`. We do not set that: it re-enables the
/// path #6 crashed in. Ubuntu and its derivatives are ASSUMED to inherit the
/// patch.
fn debian_family(os_release: &str) -> Option<String> {
    let field = |key: &str| {
        os_release
            .lines()
            .find_map(|l| l.strip_prefix(key))
            .map(|v| v.trim().trim_matches('"').to_string())
    };
    let id = field("ID=")?;
    let like = field("ID_LIKE=").unwrap_or_default();
    let family = |s: &str| s.split_whitespace().any(|w| w == "debian" || w == "ubuntu");
    (family(&id) || family(&like)).then_some(id)
}

/// Is the Nvidia userspace driver in play?
///
/// `/proc/driver/nvidia/version` is the canonical marker for the loaded Nvidia
/// kernel module, proprietary or open-kernel — both ship the same
/// `libnvidia-eglcore`, which is where the crash lives, so both must match.
/// Nouveau creates neither path and is unaffected.
///
/// Takes a root so a test can point it at a fixture; production passes "/".
fn nvidia_driver_present_under(root: &Path) -> bool {
    root.join("proc/driver/nvidia/version").exists()
        || root.join("sys/module/nvidia/version").exists()
}

/// Variables that decide how WebKitGTK renders, reported with who set them.
/// Every `WEBKIT_*` one, since WebKit adds and retires them between releases,
/// plus software GL and our own two switches.
fn is_render_var(name: &str) -> bool {
    name.starts_with("WEBKIT_") || [SOFTWARE_GL, OPT_OUT, FORCE_SOFTWARE].contains(&name)
}

/// The rendering variables currently set, sorted by name.
fn render_env() -> Vec<(String, String)> {
    let mut vars: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| {
            let k = k.into_string().ok()?;
            is_render_var(&k).then(|| (k, v.to_string_lossy().into_owned()))
        })
        .collect();
    vars.sort();
    vars
}

/// One `[gpu]` line naming each rendering variable and who set it: one that
/// was already there with the same value is the user's, anything else is ours.
/// Values are cut short; a bug report redacts paths in them like any other line.
fn env_line(before: &[(String, String)], after: &[(String, String)]) -> String {
    if after.is_empty() {
        return "[gpu] WebKit environment: nothing set".to_string();
    }
    let vars: Vec<String> = after
        .iter()
        .map(|(name, value)| {
            let who = if before.iter().any(|(n, v)| n == name && v == value) {
                "the user"
            } else {
                "SindriCAD"
            };
            let value: String = value.chars().take(64).collect();
            format!("{name}={value} (set by {who})")
        })
        .collect();
    format!("[gpu] WebKit environment: {}", vars.join(", "))
}

/// What the live webview says about itself. `never` is the state GH #17 was:
/// WebKit paints every frame on the CPU, whatever the GPU is.
fn renderer_line(webkit_version: &str, policy: &str) -> String {
    let note = if policy == "never" { " (every frame is painted on the CPU)" } else { "" };
    format!("[gpu] WebKitGTK {webkit_version}, hardware acceleration policy read back: {policy}{note}")
}

fn policy_name(policy: webkit2gtk::HardwareAccelerationPolicy) -> &'static str {
    use webkit2gtk::HardwareAccelerationPolicy as P;
    match policy {
        P::Always => "always",
        P::Never => "never",
        P::OnDemand => "on-demand",
        _ => "unknown",
    }
}

/// The `[gpu]` lines this shell knows, kept for bug reports (tinkeratlas.rs
/// prepends them to the breadcrumbs, which is where a report's facts live).
pub struct GpuFacts(pub Mutex<Vec<String>>);

/// A launch on trial with shared-memory buffers: where its marker is, and
/// where the trial stands.
struct GpuTrial {
    marker: PathBuf,
    state: Mutex<TrialState>,
}

/// What `apply_gpu_workarounds` hands to `record_renderer`.
pub struct GpuStartup {
    lines: Vec<String>,
    /// The marker path when this launch is a `FORCE_SHM` trial.
    trial: Option<PathBuf>,
}

/// A `[gpu]` line to stdout and sidecar.log (the file a bug report attaches),
/// and into the facts every bug report leads with.
fn log_fact(app: &tauri::AppHandle, line: String) {
    match app.try_state::<crate::sidecar::Sidecar>() {
        Some(sidecar) => sidecar.log_line(&line),
        None => println!("{line}"),
    }
    if let Some(facts) = app.try_state::<GpuFacts>() {
        if let Ok(mut facts) = facts.0.lock() {
            facts.push(line);
        }
    }
}

/// Keep the startup lines and add the live webview's own report: the WebKitGTK
/// version and the hardware-acceleration policy read back AFTER creation, which
/// is the only reliable sign of CPU painting (the WebGL renderer string the
/// frontend logs reads the same in every mode). Also listens for the web
/// process dying, which ends a trial. Call from `setup`, once the main window
/// exists.
pub fn record_renderer(app: &tauri::AppHandle, startup: GpuStartup) {
    app.manage(GpuFacts(Mutex::new(startup.lines)));
    if let Some(marker) = startup.trial {
        // The marker was placed before Tauri existed, by `app_data_dir_from`'s
        // reckoning. If Tauri's differs, the two would never meet again.
        if app.path().app_data_dir().ok().as_deref() != marker.parent() {
            log_fact(app, format!("[gpu] the fallback marker {} is not in the app data dir", marker.display()));
        }
        app.manage(GpuTrial { marker, state: Mutex::new(TrialState::default()) });
    }
    let Some(window) = app.get_webview_window("main") else { return };
    let handle = app.clone();
    let read = window.with_webview(move |webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        let webview = webview.inner();
        let policy = webview
            .settings()
            .map_or("unknown", |s| policy_name(s.hardware_acceleration_policy()));
        log_fact(&handle, renderer_line(&tauri::webview_version().unwrap_or_default(), policy));
        webview.connect_web_process_terminated(move |_, reason| {
            log_fact(&handle, format!("[gpu] the WebKit web process ended: {reason:?}"));
            if reason == webkit2gtk::WebProcessTerminationReason::Crashed {
                trial_event(&handle, TrialEvent::WebProcessCrashed);
            }
        });
    });
    if let Err(e) = read {
        println!("[gpu] could not read the webview's renderer settings: {e}");
    }
}

/// Carry a trial event to the marker. Nothing happens unless this launch is a
/// `FORCE_SHM` trial.
pub fn trial_event(app: &tauri::AppHandle, event: TrialEvent) {
    let Some(trial) = app.try_state::<GpuTrial>() else { return };
    // Held across the write, so two events cannot interleave their markers.
    let Ok(mut state) = trial.state.lock() else { return };
    let Some((marker, restart)) = trial_outcome(event, *state) else { return };
    match event {
        TrialEvent::Ready => state.ready = true,
        TrialEvent::Passed | TrialEvent::WebProcessCrashed => state.decided = true,
        TrialEvent::WatchdogFired => {}
    }
    let written = write_marker(&trial.marker, marker);
    drop(state);
    if event == TrialEvent::Ready {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(TRIAL_WINDOW);
            trial_event(&handle, TrialEvent::Passed);
        });
    }
    let line = match event {
        TrialEvent::Ready => return, // the line comes with Passed
        TrialEvent::Passed => format!("[gpu] the interface is up with {FORCE_SHM}=1; keeping it"),
        TrialEvent::WatchdogFired => format!(
            "[gpu] the interface has not loaded with {FORCE_SHM}=1; later launches use {DMABUF}=1 \
             unless it loads after all"
        ),
        TrialEvent::WebProcessCrashed if restart => format!(
            "[gpu] the web process crashed before the interface loaded with {FORCE_SHM}=1; \
             restarting with {DMABUF}=1"
        ),
        TrialEvent::WebProcessCrashed => format!(
            "[gpu] the web process crashed with {FORCE_SHM}=1; later launches use {DMABUF}=1"
        ),
    };
    log_fact(app, line);
    if let Err(e) = &written {
        log_fact(app, format!("[gpu] could not update {}: {e}", trial.marker.display()));
    }
    // Only once the failure is on disk: otherwise the restart would come back
    // up on the same trial and could crash in a loop.
    if restart && written.is_ok() {
        crate::restart_for_update(app.clone());
    }
}

/// Apply the workaround. MUST run before the webview is created: WebKit reads
/// these variables when it spawns its web process, and the process inherits the
/// environment as it stood at that moment.
///
/// The `[gpu]` lines are printed here, not later, so a launch that dies
/// creating the webview (#6) still shows them.
pub fn apply_gpu_workarounds() -> GpuStartup {
    let marker = app_data_dir_from(std::env::var_os("XDG_DATA_HOME"), std::env::var_os("HOME"))
        .map(|d| d.join(MARKER_FILE));
    apply_under(Path::new("/"), marker)
}

/// `apply_gpu_workarounds` with the filesystem root and the marker path
/// supplied, so a test can run the real thing against a fixture.
fn apply_under(root: &Path, marker_path: Option<PathBuf>) -> GpuStartup {
    if let Some(ours) = std::env::var_os(OURS) {
        for name in ours.to_string_lossy().split(',').filter(|n| !n.is_empty()) {
            std::env::remove_var(name);
        }
        std::env::remove_var(OURS);
    }
    let user_env = render_env();
    let nvidia = nvidia_driver_present_under(root);
    let mut decision = decide(
        nvidia,
        USER_RENDERER_VARS.iter().any(|v| std::env::var_os(v).is_some()),
        std::env::var_os(OPT_OUT).is_some(),
        std::env::var_os(FORCE_SOFTWARE).is_some(),
        marker_path.as_deref().map_or(Marker::None, read_marker),
    );
    if let Some(next) = marker_for(&decision) {
        let written = marker_path.as_deref().map(|p| write_marker(p, next));
        // A trial that cannot leave its marker could crash on every launch with
        // nothing to stop it, so it does not start.
        if decision == Decision::ForceShm && !matches!(written, Some(Ok(()))) {
            decision = Decision::Disable(FALLBACK_NO_MARKER);
        }
    }
    let marker_name = marker_path
        .as_deref()
        .map_or_else(|| "(no app data dir)".to_string(), |p| p.display().to_string());

    let mut lines = Vec::new();
    match decision {
        Decision::ForceSoftware => {
            // Both, not just the first: the two faults this rescues are
            // different (no WebGL2 at all, and a driver that crashes the web
            // process), and someone reaching for this switch has already had
            // one launch fail. Neither is set if the user set it themselves.
            std::env::set_var(SOFTWARE_GL, "1");
            if std::env::var_os(DMABUF).is_none() {
                std::env::set_var(DMABUF, "1");
            }
            lines.push(format!(
                "[gpu] {FORCE_SOFTWARE} is set — forcing {SOFTWARE_GL}=1 and disabling the \
                 WebKitGTK DMABUF renderer. Rendering will be slower."
            ));
        }
        // Both Nvidia branches are logged unconditionally: when this machine
        // later files a bug, the output needs to show that we changed the renderer.
        Decision::ForceShm => {
            std::env::set_var(FORCE_SHM, "1");
            lines.push(format!(
                "[gpu] Nvidia driver detected — WebKitGTK keeps GPU compositing with shared-memory \
                 buffers ({FORCE_SHM}=1, issue #6). If a launch with it crashes or never reaches the \
                 interface, later launches use {DMABUF}=1 (marker {marker_name}). Set {OPT_OUT}=1 to keep WebKit's default."
            ));
        }
        Decision::Disable(reason) => {
            std::env::set_var(DMABUF, "1");
            lines.push(format!(
                "[gpu] Nvidia driver detected — disabling the WebKitGTK DMABUF renderer, so every \
                 frame is painted on the CPU: {reason}. Delete {marker_name} to try shared-memory \
                 buffers again."
            ));
        }
        // The two environment-driven skips are worth a line for the same reason;
        // "no Nvidia driver" is the ordinary case and stays quiet.
        Decision::Skip(SKIP_NO_NVIDIA) => {}
        Decision::Skip(reason) => {
            lines.push(format!("[gpu] leaving the WebKitGTK renderer alone: {reason}"));
        }
    }
    if nvidia {
        let os_release = std::fs::read_to_string(root.join("etc/os-release")).unwrap_or_default();
        if let Some(id) = debian_family(&os_release) {
            lines.push(format!(
                "[gpu] note: {id} is Debian-based, and Debian's WebKitGTK turns DMA-BUF off on \
                 Nvidia itself, which may leave the webview painting on the CPU whatever is set \
                 here. WEBKIT_FORCE_DMABUF_RENDERER=1 lifts that; it is not set automatically."
            ));
        }
    }
    // Every launch, the ordinary case included: a report needs to say what was
    // set as much as what we changed.
    let now = render_env();
    let set_here: Vec<&str> = now
        .iter()
        .filter(|(n, v)| !user_env.iter().any(|(un, uv)| un == n && uv == v))
        .map(|(n, _)| n.as_str())
        .collect();
    if !set_here.is_empty() {
        std::env::set_var(OURS, set_here.join(","));
    }
    lines.push(env_line(&user_env, &now));
    for line in &lines {
        println!("{line}");
    }
    let trial = (decision == Decision::ForceShm).then_some(marker_path).flatten();
    GpuStartup { lines, trial }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests that set process-wide variables take this, so they never see each
    /// other's environment.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Remove every variable the applier reads or writes, returning what was
    /// there so the test can put it back.
    fn clear_env() -> Vec<(&'static str, Option<std::ffi::OsString>)> {
        let names = USER_RENDERER_VARS.iter().copied().chain([OPT_OUT, FORCE_SOFTWARE, SOFTWARE_GL, OURS]);
        names
            .map(|n| {
                let v = std::env::var_os(n);
                std::env::remove_var(n);
                (n, v)
            })
            .collect()
    }

    fn restore_env(saved: Vec<(&'static str, Option<std::ffi::OsString>)>) {
        for (n, v) in saved {
            match v {
                Some(v) => std::env::set_var(n, v),
                None => std::env::remove_var(n),
            }
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sindricad-webkit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The reason this module exists: an Nvidia machine must not come up on the
    /// DMA-BUF path issue #6 crashed in. With nothing remembered it tries
    /// shared-memory buffers, and marks the try as pending first.
    #[test]
    fn a_fresh_nvidia_machine_tries_shared_memory_buffers() {
        let d = decide(true, false, false, false, Marker::None);
        assert_eq!(d, Decision::ForceShm);
        assert_eq!(marker_for(&d), Some(Marker::Pending));
    }

    /// A pending marker found at start means the last try never reached the
    /// interface: fall back now, and for good.
    #[test]
    fn a_pending_marker_found_at_start_falls_back_for_good() {
        let d = decide(true, false, false, false, Marker::Pending);
        assert_eq!(d, Decision::Disable(FALLBACK_CRASHED));
        assert_eq!(marker_for(&d), Some(Marker::Failed));

        let d = decide(true, false, false, false, Marker::Failed);
        assert_eq!(d, Decision::Disable(FALLBACK_REMEMBERED));
        assert_eq!(marker_for(&d), None, "a remembered failure is left as it is");
    }

    /// Everyone else keeps the fast path, whatever a marker says.
    #[test]
    fn non_nvidia_machines_are_untouched() {
        for m in [Marker::None, Marker::Pending, Marker::Failed] {
            let d = decide(false, false, false, false, m);
            assert_eq!(d, Decision::Skip(SKIP_NO_NVIDIA));
            assert_eq!(marker_for(&d), None);
        }
    }

    /// A human who has already set a renderer variable — like the #6 reporter
    /// running his workaround — outranks the probe and the marker, on Nvidia
    /// and off it. Changing it under him would silently swap the configuration
    /// he reported against.
    #[test]
    fn an_existing_setting_is_never_overridden() {
        for m in [Marker::None, Marker::Pending, Marker::Failed] {
            let d = decide(true, true, false, false, m);
            assert_eq!(d, Decision::Skip(SKIP_ALREADY_SET));
            assert_eq!(marker_for(&d), None);
        }
        assert!(matches!(decide(false, true, false, false, Marker::None), Decision::Skip(_)));
    }

    /// And the escape hatch has to beat the probe, or a machine the workaround
    /// harms has no way out.
    #[test]
    fn the_opt_out_beats_detection() {
        assert_eq!(decide(true, false, true, false, Marker::None), Decision::Skip(SKIP_OPT_OUT));
        assert_eq!(decide(true, false, true, false, Marker::Pending), Decision::Skip(SKIP_OPT_OUT));
        // …and beats an existing setting too, so one variable always wins.
        assert_eq!(decide(true, true, true, false, Marker::None), Decision::Skip(SKIP_OPT_OUT));
    }

    /// The switch a user reaches for when the app will not start at all. It has
    /// to beat every other rule, including the opt-out: those two say different
    /// things ("do not guess for me" versus "I know what I need"), and someone
    /// who set both has already had a launch fail.
    #[test]
    fn force_software_beats_everything_else() {
        assert_eq!(decide(false, false, false, true, Marker::None), Decision::ForceSoftware);
        assert_eq!(decide(true, false, false, true, Marker::None), Decision::ForceSoftware);
        assert_eq!(decide(true, true, false, true, Marker::Pending), Decision::ForceSoftware);
        assert_eq!(decide(true, true, true, true, Marker::Failed), Decision::ForceSoftware);
    }

    /// After the webview exists, walked the way trial_event walks it.
    #[test]
    fn trial_events_write_the_marker_and_restart_only_on_an_early_crash() {
        let fresh = TrialState::default();
        let ready = TrialState { ready: true, decided: false };
        let decided = TrialState { ready: true, decided: true };
        // ready, then the window passes: cleared
        assert_eq!(trial_outcome(TrialEvent::Ready, fresh), Some((Marker::Pending, false)));
        assert_eq!(trial_outcome(TrialEvent::Passed, ready), Some((Marker::None, false)));
        // no clearing without ready (an exit before the interface came up)
        assert_eq!(trial_outcome(TrialEvent::Passed, fresh), None);
        // the watchdog records a failure without a restart; a late ready undoes it
        assert_eq!(trial_outcome(TrialEvent::WatchdogFired, fresh), Some((Marker::Failed, false)));
        assert_eq!(trial_outcome(TrialEvent::WatchdogFired, ready), None);
        // a crash before ready: failed AND restart; inside the window: failed only
        assert_eq!(trial_outcome(TrialEvent::WebProcessCrashed, fresh), Some((Marker::Failed, true)));
        assert_eq!(trial_outcome(TrialEvent::WebProcessCrashed, ready), Some((Marker::Failed, false)));
        // once decided, nothing changes it: a crash after the trial passed is not the buffers'
        for e in [TrialEvent::Ready, TrialEvent::Passed, TrialEvent::WatchdogFired, TrialEvent::WebProcessCrashed] {
            assert_eq!(trial_outcome(e, decided), None, "{e:?}");
        }
    }

    #[test]
    fn the_marker_file_round_trips_and_clears() {
        let dir = scratch("marker");
        let path = dir.join("sub").join(MARKER_FILE);
        assert_eq!(read_marker(&path), Marker::None, "no file reads as none");
        write_marker(&path, Marker::Pending).unwrap();
        assert_eq!(read_marker(&path), Marker::Pending);
        write_marker(&path, Marker::Failed).unwrap();
        assert_eq!(read_marker(&path), Marker::Failed);
        write_marker(&path, Marker::None).unwrap();
        assert!(!path.exists(), "ready removes the file");
        write_marker(&path, Marker::None).unwrap(); // and again is fine
        assert_eq!(parse_marker("not json"), Marker::None);
        assert_eq!(parse_marker(r#"{"forceShm":"bogus"}"#), Marker::None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The marker has to land where Tauri's app data dir is, or a later launch
    /// would never find it.
    #[test]
    fn the_app_data_dir_is_worked_out_like_tauri_does() {
        let some = |s: &str| Some(std::ffi::OsString::from(s));
        assert_eq!(app_data_dir_from(some("/x/data"), some("/home/u")), Some(PathBuf::from("/x/data/dev.sindricad.app")));
        assert_eq!(
            app_data_dir_from(some("relative"), some("/home/u")),
            Some(PathBuf::from("/home/u/.local/share/dev.sindricad.app")),
            "a relative XDG_DATA_HOME is ignored, as dirs::data_dir ignores it"
        );
        assert_eq!(app_data_dir_from(None, None), None);
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], APP_IDENTIFIER, "the identifier here must match tauri.conf.json");
    }

    #[test]
    fn debian_and_its_derivatives_are_recognised() {
        assert_eq!(debian_family("PRETTY_NAME=\"Debian GNU/Linux 13\"\nID=debian\n"), Some("debian".into()));
        assert_eq!(debian_family("ID=ubuntu\nID_LIKE=debian\n"), Some("ubuntu".into()));
        assert_eq!(debian_family("ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n"), Some("linuxmint".into()));
        assert_eq!(debian_family("ID=pop\nID_LIKE=\"ubuntu debian\"\n"), Some("pop".into()));
        assert_eq!(debian_family("ID=fedora\n"), None);
        assert_eq!(debian_family("ID=nobara\nID_LIKE=\"rhel centos fedora\"\n"), None);
        assert_eq!(debian_family(""), None);
    }

    /// The real applier, three launches on a fixture Nvidia machine: a trial,
    /// the launch after it died, and the one after that. Then the two ways out:
    /// a user's own renderer variable, and a marker that cannot be written.
    #[test]
    fn the_applier_walks_the_trial_across_launches() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved = clear_env();
        let root = scratch("root");
        std::fs::create_dir_all(root.join("proc/driver/nvidia")).unwrap();
        std::fs::write(root.join("proc/driver/nvidia/version"), "NVRM version …").unwrap();
        let marker = root.join("data").join(MARKER_FILE);

        let first = apply_under(&root, Some(marker.clone()));
        assert_eq!(std::env::var_os(FORCE_SHM).as_deref(), Some("1".as_ref()));
        assert!(std::env::var_os(DMABUF).is_none());
        assert_eq!(read_marker(&marker), Marker::Pending);
        assert_eq!(first.trial.as_deref(), Some(marker.as_path()));
        assert!(first.lines[0].contains("shared-memory buffers"), "{:?}", first.lines);
        assert!(first.lines.last().unwrap().contains("WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 (set by SindriCAD)"));

        // that launch died before the interface: the marker is still pending
        clear_env();
        let second = apply_under(&root, Some(marker.clone()));
        assert!(std::env::var_os(FORCE_SHM).is_none());
        assert_eq!(std::env::var_os(DMABUF).as_deref(), Some("1".as_ref()));
        assert_eq!(read_marker(&marker), Marker::Failed);
        assert!(second.trial.is_none());
        assert!(second.lines[0].contains(FALLBACK_CRASHED), "{:?}", second.lines);

        // and the launch after that is a restart WE made: it inherits our
        // variables, which must not read as the user's
        let third = apply_under(&root, Some(marker.clone()));
        assert_eq!(std::env::var_os(DMABUF).as_deref(), Some("1".as_ref()));
        assert!(third.lines[0].contains(FALLBACK_REMEMBERED), "{:?}", third.lines);

        // a user's own renderer variable wins and the marker is left alone
        clear_env();
        std::fs::remove_file(&marker).unwrap();
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        let user = apply_under(&root, Some(marker.clone()));
        assert!(std::env::var_os(FORCE_SHM).is_none() && std::env::var_os(DMABUF).is_none());
        assert!(!marker.exists());
        assert!(user.trial.is_none());

        // no place for the marker: no trial either
        clear_env();
        let blind = apply_under(&root, None);
        assert_eq!(std::env::var_os(DMABUF).as_deref(), Some("1".as_ref()));
        assert!(std::env::var_os(FORCE_SHM).is_none());
        assert!(blind.lines[0].contains(FALLBACK_NO_MARKER), "{:?}", blind.lines);

        // a Debian-based system gets the note about its own patch
        clear_env();
        std::fs::create_dir_all(root.join("etc")).unwrap();
        std::fs::write(root.join("etc/os-release"), "ID=ubuntu\nID_LIKE=debian\n").unwrap();
        let deb = apply_under(&root, Some(marker.clone()));
        assert!(deb.lines.iter().any(|l| l.contains("ubuntu is Debian-based")), "{:?}", deb.lines);

        restore_env(saved);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The probe is filesystem shape, so it is worth pinning: a bare
    /// `/sys/module/nvidia` directory (nvidia_drm can appear on hybrid systems)
    /// is not enough — we look for the version files the real driver writes.
    #[test]
    fn the_probe_matches_the_paths_the_nvidia_driver_actually_writes() {
        let tmp = scratch("probe");

        std::fs::create_dir_all(tmp.join("sys/module/nvidia")).unwrap();
        assert!(
            !nvidia_driver_present_under(&tmp),
            "an empty module directory must not count as the driver"
        );

        std::fs::create_dir_all(tmp.join("proc/driver/nvidia")).unwrap();
        std::fs::write(tmp.join("proc/driver/nvidia/version"), "NVRM version …").unwrap();
        assert!(
            nvidia_driver_present_under(&tmp),
            "/proc/driver/nvidia/version is the canonical marker"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// GH #17: the report has to say who set each rendering variable, because
    /// "we set DISABLE_DMABUF" and "the user did" call for different answers.
    #[test]
    fn the_env_line_says_who_set_each_variable() {
        let v = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
        };
        let before = v(&[("LIBGL_ALWAYS_SOFTWARE", "0"), ("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1")]);
        let after = v(&[
            ("LIBGL_ALWAYS_SOFTWARE", "1"),
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "1"),
            ("WEBKIT_DMABUF_RENDERER_FORCE_SHM", "1"),
        ]);
        assert_eq!(
            env_line(&before, &after),
            "[gpu] WebKit environment: LIBGL_ALWAYS_SOFTWARE=1 (set by SindriCAD), \
             WEBKIT_DISABLE_DMABUF_RENDERER=1 (set by SindriCAD), \
             WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 (set by the user)",
            "a variable we changed is ours even if the user had set it to something else"
        );
        assert_eq!(env_line(&[], &[]), "[gpu] WebKit environment: nothing set");
        let long = "x".repeat(200);
        assert_eq!(env_line(&[], &v(&[("WEBKIT_X", &long)])).matches('x').count(), 64);
    }

    #[test]
    fn only_rendering_variables_are_reported() {
        for name in ["WEBKIT_DISABLE_DMABUF_RENDERER", "WEBKIT_FORCE_DMABUF_RENDERER", SOFTWARE_GL, OPT_OUT, FORCE_SOFTWARE] {
            assert!(is_render_var(name), "{name}");
        }
        for name in ["HOME", "PATH", "XDG_RUNTIME_DIR", "LIBGL_DRIVERS_PATH"] {
            assert!(!is_render_var(name), "{name}");
        }
    }

    /// `never` is the CPU-painting state, and the line has to say so in words:
    /// the policy name alone did not tell anyone in GH #17.
    #[test]
    fn the_renderer_line_names_cpu_painting() {
        assert_eq!(
            renderer_line("2.52.6", policy_name(webkit2gtk::HardwareAccelerationPolicy::Never)),
            "[gpu] WebKitGTK 2.52.6, hardware acceleration policy read back: never (every frame is painted on the CPU)"
        );
        assert_eq!(
            renderer_line("2.52.6", policy_name(webkit2gtk::HardwareAccelerationPolicy::Always)),
            "[gpu] WebKitGTK 2.52.6, hardware acceleration policy read back: always"
        );
    }

    /// `decide` being right is worth nothing if the applier reads the wrong
    /// variables, so exercise the real entry point once. The opt-out path is the
    /// one that can be asserted on any machine: it must leave the environment
    /// untouched whatever hardware the test happens to run on.
    #[test]
    fn the_applier_reads_the_variables_it_documents() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved = clear_env();
        std::env::set_var(OPT_OUT, "1");

        apply_gpu_workarounds();
        assert!(
            std::env::var_os(DMABUF).is_none() && std::env::var_os(FORCE_SHM).is_none(),
            "the opt-out must stop the applier setting either variable, on Nvidia hardware or not"
        );

        restore_env(saved);
    }
}
