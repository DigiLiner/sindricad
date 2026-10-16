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

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::Manager;

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

#[cfg(test)]
mod tests {
    use super::should_force_close;

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
