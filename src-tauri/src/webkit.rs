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
//! It also reports what WebKit ended up with (`record_renderer`): the variables
//! and who set them, the WebKitGTK version, and the hardware-acceleration policy
//! read back from the live webview. GH #17 took a video and a measurement round
//! to learn that the webview was painting on the CPU; one log line says it.

use std::path::Path;
use std::sync::Mutex;

use tauri::Manager;

/// Our own opt-out. A user whose machine is made *worse* by the workaround
/// needs an escape hatch, and the obvious one — setting
/// `WEBKIT_DISABLE_DMABUF_RENDERER=0` — does not work: WebKit's own checks are
/// presence-based in places, so "0" can read as "yes, disable it". A separate
/// variable of ours has no such ambiguity.
const OPT_OUT: &str = "SINDRICAD_NO_GPU_WORKAROUND";

/// The WebKitGTK knob we set. Deliberately NOT
/// `WEBKIT_DISABLE_COMPOSITING_MODE`, which also avoids the crash but turns off
/// accelerated compositing wholesale — a bad trade for an app whose main view is
/// a WebGL canvas, and the mode under which the reporter of issue #6 also saw
/// viewport pointer capture stick (that is bug 2 of the same issue, unfixed).
///
/// It is NOT narrower, though it was chosen as if it were. On WebKitGTK 2.44
/// and later it turns hardware acceleration off entirely: measured on 2.52.6
/// (GH #17, .fable/gh17-video/RESULT.md), webkit://gpu reports `Policy: never`,
/// the settings' hardware-acceleration policy reads back `never` after an
/// explicit ALWAYS, and the web process holds no GPU renderer. Every frame is
/// painted on the CPU. Drawing a rectangle in an empty sketch ran at 22 ms a
/// frame on a full fast core and 49 ms (20 fps) on half of one, against 16.7 ms
/// with the GPU. That is a smoothness cost, not a correctness one, and it still
/// beats not launching; `record_renderer` puts the policy in every log.
///
/// WebKit documents the variable as a transitional debugging escape hatch that
/// will eventually be removed. When it goes, this module has to be revisited
/// rather than quietly stop working.
const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

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

/// Whether to disable the DMABUF renderer, and why. The reason is carried so the
/// startup log says what happened; a silent environment change is exactly the
/// kind of thing that makes a later field report unreadable.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Disable,
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
const SKIP_ALREADY_SET: &str = "WEBKIT_DISABLE_DMABUF_RENDERER already set by the environment";
const SKIP_NO_NVIDIA: &str = "no Nvidia driver";

/// Issue #6 (Nobara/Fedora 44, RTX 5080, driver 595.84, Wayland):
/// `WebKitWebProcess` takes a SIGSEGV inside `libnvidia-eglcore` on launch and
/// the app dies before painting anything — no dialog, no message, nothing the
/// user can act on. The reporter confirmed that EITHER
/// `WEBKIT_DISABLE_DMABUF_RENDERER=1` or `WEBKIT_DISABLE_COMPOSITING_MODE=1`
/// avoids it; we pick the narrower one.
///
/// This fires for every Nvidia machine, not only broken ones, because there is
/// no way to tell them apart before the crash. That costs the working majority
/// the per-frame cost described on `DMABUF` (measured with the variable set on
/// non-Nvidia hardware; there is no Nvidia hardware here); the alternative costs
/// the affected minority the entire application.
fn decide(
    nvidia_present: bool,
    dmabuf_already_set: bool,
    opted_out: bool,
    force_software: bool,
) -> Decision {
    // Software GL outranks everything: it is the most explicit request a user can
    // make here, and it is asked for by someone whose app does not currently
    // start at all.
    if force_software {
        return Decision::ForceSoftware;
    }
    // Precedence: an explicit human beats our guess, both ways round. Someone
    // running with the variable already set is mid-workaround (the issue #6
    // reporter is, right now) and must not have it changed under them.
    if opted_out {
        return Decision::Skip(SKIP_OPT_OUT);
    }
    if dmabuf_already_set {
        return Decision::Skip(SKIP_ALREADY_SET);
    }
    if !nvidia_present {
        return Decision::Skip(SKIP_NO_NVIDIA);
    }
    Decision::Disable
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

/// Keep the startup lines and add the live webview's own report: the WebKitGTK
/// version and the hardware-acceleration policy read back AFTER creation, which
/// is the only reliable sign of CPU painting (the WebGL renderer string the
/// frontend logs reads the same in every mode). Call from `setup`, once the
/// main window exists.
pub fn record_renderer(app: &tauri::AppHandle, startup: Vec<String>) {
    app.manage(GpuFacts(Mutex::new(startup)));
    let Some(window) = app.get_webview_window("main") else { return };
    let handle = app.clone();
    let read = window.with_webview(move |webview| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        let policy = webview
            .inner()
            .settings()
            .map_or("unknown", |s| policy_name(s.hardware_acceleration_policy()));
        let line = renderer_line(&tauri::webview_version().unwrap_or_default(), policy);
        // through the sidecar so the line reaches sidecar.log as well as stdout
        match handle.try_state::<crate::sidecar::Sidecar>() {
            Some(sidecar) => sidecar.log_line(&line),
            None => println!("{line}"),
        }
        if let Ok(mut facts) = handle.state::<GpuFacts>().0.lock() {
            facts.push(line);
        }
    });
    if let Err(e) = read {
        println!("[gpu] could not read the webview's renderer settings: {e}");
    }
}

/// Apply the workaround. MUST run before the webview is created: WebKit reads
/// these variables when it spawns its web process, and the process inherits the
/// environment as it stood at that moment.
///
/// Returns the `[gpu]` lines it printed, for `record_renderer`. They are
/// printed here, not later, so a launch that dies creating the webview (#6)
/// still shows them.
pub fn apply_gpu_workarounds() -> Vec<String> {
    let user_env = render_env();
    let decision = decide(
        nvidia_driver_present_under(Path::new("/")),
        std::env::var_os(DMABUF).is_some(),
        std::env::var_os(OPT_OUT).is_some(),
        std::env::var_os(FORCE_SOFTWARE).is_some(),
    );

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
        Decision::Disable => {
            std::env::set_var(DMABUF, "1");
            // Logged unconditionally: when this machine later files a bug, the
            // terminal output needs to show that we changed the renderer.
            lines.push(format!(
                "[gpu] Nvidia driver detected — disabling the WebKitGTK DMABUF renderer \
                 (issue #6). Set {OPT_OUT}=1 to keep it."
            ));
        }
        // The two environment-driven skips are worth a line for the same reason;
        // "no Nvidia driver" is the ordinary case and stays quiet.
        Decision::Skip(SKIP_NO_NVIDIA) => {}
        Decision::Skip(reason) => {
            lines.push(format!("[gpu] leaving the WebKitGTK renderer alone: {reason}"));
        }
    }
    // Every launch, the ordinary case included: a report needs to say what was
    // set as much as what we changed.
    lines.push(env_line(&user_env, &render_env()));
    for line in &lines {
        println!("{line}");
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reason this module exists: an Nvidia machine must come up with the
    /// DMABUF renderer off, or WebKit segfaults before the app paints (#6).
    #[test]
    fn nvidia_machine_disables_the_dmabuf_renderer() {
        assert_eq!(decide(true, false, false, false), Decision::Disable);
    }

    /// Everyone else keeps the fast path. A blanket disable would have been the
    /// easy fix and would have cost every Linux user buffer sharing for a fault
    /// only Nvidia has.
    #[test]
    fn non_nvidia_machines_are_untouched() {
        assert_eq!(decide(false, false, false, false), Decision::Skip(SKIP_NO_NVIDIA));
    }

    /// A human who has already set the variable — like the #6 reporter running
    /// his workaround today — outranks the probe, on Nvidia and off it. Changing
    /// it under him would silently swap the configuration he reported against.
    #[test]
    fn an_existing_setting_is_never_overridden() {
        assert!(matches!(decide(true, true, false, false), Decision::Skip(_)));
        assert!(matches!(decide(false, true, false, false), Decision::Skip(_)));
    }

    /// And the escape hatch has to beat the probe, or a machine the workaround
    /// harms has no way out.
    #[test]
    fn the_opt_out_beats_detection() {
        assert_eq!(decide(true, false, true, false), Decision::Skip(SKIP_OPT_OUT));
        // …and beats an existing setting too, so one variable always wins.
        assert_eq!(decide(true, true, true, false), Decision::Skip(SKIP_OPT_OUT));
    }

    /// The switch a user reaches for when the app will not start at all. It has
    /// to beat every other rule, including the opt-out: those two say different
    /// things ("do not guess for me" versus "I know what I need"), and someone
    /// who set both has already had a launch fail.
    #[test]
    fn force_software_beats_everything_else() {
        assert_eq!(decide(false, false, false, true), Decision::ForceSoftware);
        assert_eq!(decide(true, false, false, true), Decision::ForceSoftware);
        assert_eq!(decide(true, true, false, true), Decision::ForceSoftware);
        assert_eq!(decide(true, true, true, true), Decision::ForceSoftware);
    }

    /// The ordinary machine must be untouched by the new switch existing. This
    /// is the regression that would cost every working Linux user frame rate.
    #[test]
    fn an_unset_switch_changes_nothing() {
        assert_eq!(decide(false, false, false, false), Decision::Skip(SKIP_NO_NVIDIA));
        assert_eq!(decide(true, false, false, false), Decision::Disable);
    }

    /// The probe is filesystem shape, so it is worth pinning: a bare
    /// `/sys/module/nvidia` directory (nvidia_drm can appear on hybrid systems)
    /// is not enough — we look for the version files the real driver writes.
    #[test]
    fn the_probe_matches_the_paths_the_nvidia_driver_actually_writes() {
        let tmp = std::env::temp_dir().join("sindricad-webkit-probe-test");
        let _ = std::fs::remove_dir_all(&tmp);

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
    ///
    /// This mutates process-wide environment, which is why it restores what it
    /// found and why nothing else in this crate reads these two variables.
    #[test]
    fn the_applier_reads_the_variables_it_documents() {
        let restore = std::env::var_os(DMABUF);
        std::env::remove_var(DMABUF);
        std::env::set_var(OPT_OUT, "1");

        apply_gpu_workarounds();
        assert!(
            std::env::var_os(DMABUF).is_none(),
            "the opt-out must stop the applier setting {DMABUF}, on Nvidia hardware or not"
        );

        std::env::remove_var(OPT_OUT);
        if let Some(v) = restore {
            std::env::set_var(DMABUF, v);
        }
    }
}
