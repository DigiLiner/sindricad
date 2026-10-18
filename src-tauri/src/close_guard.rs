//! A close the webview cannot answer still finishes.
//!
//! The frontend's close guard (src/io/windowClose.ts) listens for
//! `tauri://close-requested` so it can ask about unsaved work, and once that
//! listener exists Tauri holds EVERY close until JS calls `destroy()`. A webview
//! that cannot answer (a long synchronous stall, or a crashed web process, the
//! WebKitGTK blank page) would leave a window that the X, Alt+F4 and the window
//! manager can never close. So every close request starts a watchdog: the guard
//! acks first thing on every request (`close_guard_ack`), even while its prompt
//! is up, and a request still unacked after `ACK_TIMEOUT` closes the window.
//!
//! On macOS the app menu's Quit (Cmd+Q) is routed into this same close, see
//! `app_menu`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{AppHandle, Manager, Runtime};

const ACK_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Default)]
pub struct CloseGuard {
    requests: AtomicU64,
    acks: AtomicU64,
}

/// The webview's close guard saw the request(s): every one so far is answered.
#[tauri::command]
pub fn close_guard_ack(state: tauri::State<'_, CloseGuard>) {
    state.acks.store(state.requests.load(Ordering::SeqCst), Ordering::SeqCst);
}

/// Request `n` is answered once any ack has covered it.
fn should_force_close(request: u64, acks: u64) -> bool {
    acks < request
}

/// Called for every CloseRequested on the window. Does not prevent anything:
/// Tauri already holds the close while the JS listener exists.
pub fn on_close_requested<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let Some(state) = window.try_state::<CloseGuard>() else { return };
    let n = state.requests.fetch_add(1, Ordering::SeqCst) + 1;
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ACK_TIMEOUT);
        let acks = window.state::<CloseGuard>().acks.load(Ordering::SeqCst);
        if should_force_close(n, acks) {
            let msg = "close: the window did not answer, closing anyway";
            match window.try_state::<crate::sidecar::Sidecar>() {
                Some(sidecar) => sidecar.log_line(msg),
                None => println!("{msg}"),
            }
            // The last window going exits the app through the usual
            // ExitRequested, which kills the sidecar. Already gone is fine.
            let _ = window.destroy();
        }
    });
}

/// Menu id of the macOS app menu's Quit, which replaces the native one.
pub const QUIT_MENU_ID: &str = "sindri-quit";

/// macOS: Tauri's default menu, with the app menu's Quit (and so Cmd+Q) asking
/// about unsaved work like the X does (GitHub #61). The native Quit sends
/// `terminate:`, which never raises CloseRequested, and tao implements no
/// `applicationShouldTerminate:`, so nothing can veto it later either: it
/// arrives as RunEvent::Exit, never as a preventable ExitRequested. Our item
/// asks the main window to close instead, so it gets the guard and the
/// watchdog above, and the exit after it reaps the sidecar as any close does.
/// Not covered: the Dock's Quit and logging out, which still send terminate:.
/// Compiled everywhere so Linux CI type-checks it; only macOS installs it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    // the app menu (named after the app) is the first submenu on macOS
    let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() else {
        eprintln!("menu: no app menu found, Cmd+Q quits without asking");
        return Ok(menu);
    };
    let labels: Vec<Option<String>> = app_menu
        .items()?
        .iter()
        .map(|item| match item {
            MenuItemKind::Predefined(p) => p.text().ok(),
            _ => None,
        })
        .collect();
    let Some(at) = native_quit_position(&labels) else {
        eprintln!("menu: no native Quit found, Cmd+Q quits without asking");
        return Ok(menu);
    };
    let text = format!("Quit {}", app.package_info().name);
    let quit = MenuItem::with_id(app, QUIT_MENU_ID, text, true, Some("CmdOrCtrl+Q"))?;
    app_menu.remove_at(at)?;
    app_menu.insert(&quit, at)?;
    Ok(menu)
}

/// Where the native Quit sits among a submenu's items: `Some(label)` for a
/// native (predefined) item, `None` for any other kind.
fn native_quit_position(labels: &[Option<String>]) -> Option<usize> {
    labels
        .iter()
        .position(|l| l.as_deref().is_some_and(|l| l == "Quit" || l.starts_with("Quit ")))
}

/// The app menu's Quit: the same request as the titlebar X.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn quit<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window("main") {
        Some(window) => {
            let _ = window.close();
        }
        // nothing left to ask in; the exit still reaps the sidecar
        None => app.exit(0),
    }
}

#[cfg(test)]
mod tests {
    use super::{native_quit_position, should_force_close};

    fn labels(items: &[Option<&str>]) -> Vec<Option<String>> {
        items.iter().map(|l| l.map(str::to_string)).collect()
    }

    #[test]
    fn the_native_quit_is_found_where_tauri_puts_it() {
        // Tauri 2's macOS app submenu: About, -, Services, -, Hide, Hide Others, -, Quit
        let app_menu = labels(&[
            Some("About SindriCAD"), Some(""), Some("Services"), Some(""),
            Some("Hide SindriCAD"), Some("Hide Others"), Some(""), Some("Quit SindriCAD"),
        ]);
        assert_eq!(native_quit_position(&app_menu), Some(7));
        // wherever it moves to, as long as it is a native item called Quit
        let moved = labels(&[Some("Quit SindriCAD"), Some("About SindriCAD")]);
        assert_eq!(native_quit_position(&moved), Some(0));
    }

    #[test]
    fn no_native_quit_leaves_the_menu_alone() {
        // a custom item (None) is never taken for the native one, nor is an
        // item that merely mentions quitting
        assert_eq!(native_quit_position(&labels(&[None, Some("About SindriCAD")])), None);
        assert_eq!(native_quit_position(&labels(&[Some("Quitter SindriCAD")])), None);
        assert_eq!(native_quit_position(&[]), None);
    }

    #[test]
    fn an_unanswered_request_forces_the_close() {
        assert!(should_force_close(1, 0));
        // a second X while the webview is wedged: the old ack does not cover it
        assert!(should_force_close(3, 2));
    }

    #[test]
    fn an_answered_request_leaves_the_close_to_the_webview() {
        assert!(!should_force_close(1, 1));
        // the ack sets acks = requests, so a later ack covers earlier requests too
        assert!(!should_force_close(2, 3));
    }
}
