//! WhatsApp Bridge — tray-first Tauri app that supervises the
//! whatsapp-claude-bridge daemon as a sidecar and fronts its dashboard.
//!
//! - No dock icon on macOS (Accessory activation policy); tray icon everywhere.
//! - Sidecar runs with cwd = "bridge home" dir and WA_BRIDGE_HOME set, so the
//!   compiled daemon reads .env / auth/ / data/ / logs/ from there.
//! - /status is polled every 10s (token = WA_API_TOKEN from that .env) to feed
//!   the tray status line and fire notifications.

use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_PORT: u16 = 8477;
const POLL_INTERVAL: Duration = Duration::from_secs(10);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A run longer than this is "stable" — the respawn backoff resets.
const STABLE_RUN: Duration = Duration::from_secs(60);

struct BridgeState {
    /// Home dir the daemon runs in (.env, auth/, data/, logs/ live here).
    home: PathBuf,
    child: Mutex<Option<CommandChild>>,
    quitting: AtomicBool,
    /// Signalled by "Restart Bridge" — wakes/short-circuits the respawn backoff.
    restart: Arc<tokio::sync::Notify>,
}

// ── bridge home + .env helpers ─────────────────────────────────────

/// WA_BRIDGE_HOME env var wins (dev: point it at the repo checkout);
/// otherwise a per-user app-data dir. Created if missing.
fn resolve_home(app: &AppHandle) -> PathBuf {
    let home = std::env::var("WA_BRIDGE_HOME")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            app.path()
                .app_data_dir()
                .expect("no app data dir")
                .join("bridge")
        });
    let _ = std::fs::create_dir_all(&home);
    home
}

/// First run has no .env — without WA_API_TOKEN the daemon refuses to start
/// its control API, killing the dashboard and status polling. Generate a
/// random token once (and default port) so a fresh install works out of the box.
fn ensure_env(home: &Path) {
    if env_value(home, "WA_API_TOKEN").is_some() {
        return;
    }
    let mut bytes = [0u8; 32];
    if getrandom::fill(&mut bytes).is_err() {
        return; // no entropy source — daemon will just run API-less, as before
    }
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let env_path = home.join(".env");
    let existing = std::fs::read_to_string(&env_path).unwrap_or_default();
    let mut contents = existing.clone();
    if !contents.is_empty() && !contents.ends_with('\n') {
        contents.push('\n');
    }
    contents.push_str(&format!("WA_API_TOKEN={token}\n"));
    if existing.is_empty() {
        contents.push_str(&format!("WA_API_PORT={DEFAULT_PORT}\n"));
    }
    if std::fs::write(&env_path, contents).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&env_path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

/// PATH for the sidecar. A GUI app launched from Finder/login item inherits
/// the stripped system PATH (no /opt/homebrew/bin, no ~/.local/bin), so the
/// daemon couldn't find `claude`/`codex`. Prefer the user's login-shell PATH,
/// then make sure the usual CLI install locations are present.
fn sidecar_path() -> String {
    let mut path = login_shell_path()
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    #[cfg(unix)]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let extras = [
            format!("{home}/.local/bin"),
            format!("{home}/.bun/bin"),
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
        ];
        for extra in extras {
            if !path.split(':').any(|p| p == extra) {
                if !path.is_empty() {
                    path.push(':');
                }
                path.push_str(&extra);
            }
        }
    }
    path
}

#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let out = std::process::Command::new(shell)
        .args(["-lc", "printf %s \"$PATH\""])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() {
        None
    } else {
        Some(p)
    }
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<String> {
    None
}

/// Minimal .env reader — enough for WA_API_TOKEN / WA_API_PORT.
fn env_value(home: &Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(home.join(".env")).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(value) = rest.trim_start().strip_prefix('=') {
                let value = value.trim().trim_matches('"').trim_matches('\'');
                return Some(value.to_string());
            }
        }
    }
    None
}

fn api_port(home: &Path) -> u16 {
    env_value(home, "WA_API_PORT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

// ── loopback HTTP (no client crate needed for 127.0.0.1) ───────────

fn http_get_json(port: u16, path: &str, token: &str) -> Option<serde_json::Value> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(3))).ok()?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-wa-token: {token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b)?;
    // Tolerate chunked encoding by slicing the outermost JSON object.
    let start = body.find('{')?;
    let end = body.rfind('}')?;
    serde_json::from_str(&body[start..=end]).ok()
}

fn notify(app: &AppHandle, body: &str) {
    let _ = app
        .notification()
        .builder()
        .title("WhatsApp Bridge")
        .body(body)
        .show();
}

// ── sidecar supervisor ─────────────────────────────────────────────

/// Spawns the daemon and keeps it alive: respawn with exponential backoff
/// when it dies, reset backoff after a stable run, stop when quitting.
fn start_supervisor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Guard against the repo's launchd service (or any other instance):
        // if something already answers /status on our port, spawning a second
        // daemon would mean two WhatsApp sessions and a tray silently
        // monitoring the wrong one. Refuse instead.
        let (home, restart) = {
            let state = app.state::<BridgeState>();
            (state.home.clone(), state.restart.clone())
        };
        let port = api_port(&home);
        let token = env_value(&home, "WA_API_TOKEN").unwrap_or_default();
        if let Some(resp) = http_get_json(port, "/status", &token) {
            let msg = if resp.get("error").is_some() {
                format!(
                    "Another bridge instance owns port {port} (launchd service?). \
                     Not starting a second daemon — stop it (npm run uninstall-service) \
                     and relaunch this app."
                )
            } else {
                format!("A bridge daemon is already running on port {port} — not starting a second one.")
            };
            notify(&app, &msg);
            return;
        }

        let mut backoff = BACKOFF_MIN;
        loop {
            {
                let state = app.state::<BridgeState>();
                if state.quitting.load(Ordering::SeqCst) {
                    break;
                }
            }
            let envs: HashMap<String, String> = HashMap::from([
                (
                    "WA_BRIDGE_HOME".to_string(),
                    home.to_string_lossy().to_string(),
                ),
                // GUI-launched apps get a stripped PATH — restore the user's.
                ("PATH".to_string(), sidecar_path()),
                // Lets the daemon self-exit if this app dies without cleanup.
                ("WA_PARENT_PID".to_string(), std::process::id().to_string()),
            ]);
            let spawned = app
                .shell()
                .sidecar("wa-bridge-daemon")
                .map(|cmd| cmd.current_dir(&home).envs(envs))
                .and_then(|cmd| cmd.spawn());
            let (mut rx, child) = match spawned {
                Ok(pair) => pair,
                Err(e) => {
                    notify(&app, &format!("Failed to start bridge daemon: {e}"));
                    backoff = backoff_sleep(&restart, backoff).await;
                    continue;
                }
            };
            let started = Instant::now();
            *app.state::<BridgeState>().child.lock().unwrap() = Some(child);
            // Quit may have raced the spawn: its kill_child found None while
            // we were spawning, so the fresh child would be orphaned. Re-check.
            if app.state::<BridgeState>().quitting.load(Ordering::SeqCst) {
                kill_child(&app);
                break;
            }

            // Drain events until the process terminates (stdout/stderr are
            // dropped — the daemon writes its own logs/ under the home dir).
            while let Some(event) = rx.recv().await {
                if matches!(event, CommandEvent::Terminated(_)) {
                    break;
                }
            }
            *app.state::<BridgeState>().child.lock().unwrap() = None;

            if app.state::<BridgeState>().quitting.load(Ordering::SeqCst) {
                break;
            }
            if started.elapsed() >= STABLE_RUN {
                backoff = BACKOFF_MIN;
            }
            notify(
                &app,
                &format!("Bridge process stopped — restarting in {}s.", backoff.as_secs()),
            );
            backoff = backoff_sleep(&restart, backoff).await;
        }
    });
}

/// Sleep out the backoff, unless "Restart Bridge" fires — then wake at once.
/// Returns the next backoff to use (doubled, or reset on a manual restart).
async fn backoff_sleep(restart: &tokio::sync::Notify, backoff: Duration) -> Duration {
    match tokio::time::timeout(backoff, restart.notified()).await {
        Ok(()) => BACKOFF_MIN,
        Err(_) => (backoff * 2).min(BACKOFF_MAX),
    }
}

fn kill_child(app: &AppHandle) {
    let taken = app.state::<BridgeState>().child.lock().unwrap().take();
    if let Some(child) = taken {
        let _ = child.kill();
    }
}

// ── status polling ─────────────────────────────────────────────────

fn start_status_poll(app: AppHandle, status_item: MenuItem<Wry>) {
    std::thread::spawn(move || {
        let mut prev_logged_out = false;
        let mut prev_pending: i64 = 0;
        loop {
            {
                let state = app.state::<BridgeState>();
                if state.quitting.load(Ordering::SeqCst) {
                    break;
                }
            }
            let home = app.state::<BridgeState>().home.clone();
            let token = env_value(&home, "WA_API_TOKEN").unwrap_or_default();
            let status = http_get_json(api_port(&home), "/status", &token);

            let text = match &status {
                None => "Bridge: not responding".to_string(),
                // An answer that rejects our token = another instance owns the
                // port (e.g. the launchd service) — say so, don't fake "disconnected".
                Some(s) if s.get("error").is_some() => {
                    "Bridge: port owned by another instance".to_string()
                }
                Some(s) => {
                    let logged_out = s["loggedOut"].as_bool().unwrap_or(false);
                    let connected = s["connected"].as_bool().unwrap_or(false);
                    let pending = s["pendingSends"].as_i64().unwrap_or(0);

                    if logged_out && !prev_logged_out {
                        notify(&app, "WhatsApp logged the session out — open the dashboard to re-link.");
                    }
                    prev_logged_out = logged_out;

                    if pending > 0 && prev_pending == 0 {
                        notify(&app, &format!("{pending} send(s) pending — bridge may be offline."));
                    }
                    prev_pending = pending;

                    if logged_out {
                        "Bridge: logged out (re-link needed)".to_string()
                    } else if connected {
                        "Bridge: connected".to_string()
                    } else {
                        "Bridge: disconnected".to_string()
                    }
                }
            };

            // Menu mutations must happen on the main thread.
            let item = status_item.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = item.set_text(text);
            });

            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

// ── dashboard window ───────────────────────────────────────────────

fn open_dashboard(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("dashboard") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    let home = &app.state::<BridgeState>().home;
    let port = api_port(home);
    let url = format!("http://127.0.0.1:{port}")
        .parse()
        .expect("valid dashboard url");
    // The dashboard page prompts for WA_API_TOKEN on first load and stores it
    // under this localStorage key (src/ui.ts TOKEN_KEY) — normally the app's
    // own token is the one the daemon it manages actually uses, so hand it
    // over before the page's own script runs and the prompt never appears.
    // BUT: if another instance already owns this port (the preflight guard
    // in start_supervisor refused to spawn our own daemon), that instance
    // has its OWN token — ours would be silently wrong and lock the user out
    // with an unrecoverable 401 instead of the normal manual-entry prompt.
    // Verify our token actually authenticates against whatever answers this
    // port before injecting it; otherwise let the page ask, as if unmanaged.
    let token = env_value(home, "WA_API_TOKEN").unwrap_or_default();
    let token_verified = http_get_json(port, "/status", &token)
        .map(|v| v.get("error").is_none())
        .unwrap_or(false);
    // Either set the verified token, or clear anything stale from a previous
    // (possibly wrong) run so the page's manual prompt starts clean instead
    // of silently reusing a token that no longer authenticates.
    let init_script = if token_verified {
        format!("try {{ localStorage.setItem('wa-bridge-token', {token:?}); }} catch (e) {{}}")
    } else {
        "try { localStorage.removeItem('wa-bridge-token'); } catch (e) {}".to_string()
    };
    let result = WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::External(url))
        .title("WhatsApp Bridge")
        .inner_size(1100.0, 780.0)
        .initialization_script(&init_script)
        .build();
    if let Err(e) = result {
        notify(app, &format!("Could not open dashboard: {e}"));
    }
}

// ── app entry ──────────────────────────────────────────────────────

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // Tray-only on macOS: no dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            let home = resolve_home(&handle);
            ensure_env(&home);
            app.manage(BridgeState {
                home,
                child: Mutex::new(None),
                quitting: AtomicBool::new(false),
                restart: Arc::new(tokio::sync::Notify::new()),
            });

            // ── tray menu ──────────────────────────────────────────
            let open = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
            let status_item =
                MenuItem::with_id(app, "status", "Bridge: starting…", false, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "Restart Bridge", true, None::<&str>)?;
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart_item = CheckMenuItem::with_id(
                app,
                "autostart",
                "Start at Login",
                true,
                autostart_enabled,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &PredefinedMenuItem::separator(app)?,
                    &status_item,
                    &restart,
                    &PredefinedMenuItem::separator(app)?,
                    &autostart_item,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            // ── tray icon: monochrome template on macOS, colored app
            //    icon on Windows (template-black would vanish on dark taskbars).
            let tray_builder = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("WhatsApp Bridge");
            #[cfg(target_os = "macos")]
            let tray_builder = tray_builder
                .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true);
            #[cfg(not(target_os = "macos"))]
            let tray_builder = tray_builder.icon(
                app.default_window_icon()
                    .cloned()
                    .unwrap_or(Image::from_bytes(include_bytes!("../icons/tray.png"))?),
            );

            let autostart_for_menu = autostart_item.clone();
            tray_builder
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => open_dashboard(app),
                    "restart" => {
                        // Kill the child (supervisor respawns it) AND signal the
                        // supervisor: if the daemon is already dead we may be
                        // mid-backoff — notify_one leaves a permit so the sleep
                        // wakes immediately and the backoff resets to minimum.
                        kill_child(app);
                        app.state::<BridgeState>().restart.notify_one();
                        notify(app, "Restarting bridge daemon…");
                    }
                    "autostart" => {
                        let autolaunch = app.autolaunch();
                        let currently = autolaunch.is_enabled().unwrap_or(false);
                        let result = if currently {
                            autolaunch.disable()
                        } else {
                            autolaunch.enable()
                        };
                        if let Err(e) = result {
                            notify(app, &format!("Start-at-login change failed: {e}"));
                        }
                        let now_enabled = autolaunch.is_enabled().unwrap_or(false);
                        let _ = autostart_for_menu.set_checked(now_enabled);
                    }
                    "quit" => {
                        app.state::<BridgeState>()
                            .quitting
                            .store(true, Ordering::SeqCst);
                        kill_child(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            start_supervisor(handle.clone());
            start_status_poll(handle, status_item);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building WhatsApp Bridge app");

    app.run(|app, event| match event {
        // Tray-only app: closing the dashboard window must not exit.
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        // Belt-and-braces: never leave the daemon orphaned on exit.
        RunEvent::Exit => {
            app.state::<BridgeState>()
                .quitting
                .store(true, Ordering::SeqCst);
            kill_child(app);
        }
        _ => {}
    });
}
