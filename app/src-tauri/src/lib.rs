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
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
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
const PROVIDERS: [&str; 4] = ["claude", "codex", "gemini", "grok"];

#[derive(Clone, Debug, PartialEq, Eq)]
struct MentionRoute {
    trigger: String,
    provider: String,
    /// Per-call-sign override. None means use that provider's configured/default model.
    model: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum MentionRouteParseError {
    MissingProvider,
    EmptyTrigger,
    UnknownProvider(String),
}

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

// ── agent/call-sign configuration ───────────────────────────────────

fn provider_label(provider: &str) -> &'static str {
    match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        "gemini" => "Gemini",
        "grok" => "Grok",
        _ => "Unknown",
    }
}

fn model_env_key(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some("CLAUDE_MODEL"),
        "codex" => Some("CODEX_MODEL"),
        "gemini" => Some("GEMINI_MODEL"),
        "grok" => Some("GROK_MODEL"),
        _ => None,
    }
}

/// Mirror src/mentions.ts parseMentionRouteEntry exactly. Both call signs and
/// model identifiers may contain colons, so a known provider token is the
/// separator. Prefer the penultimate token for explicit three-field routes,
/// then the legacy final token, then scan right-to-left for a provider before
/// a colon-containing model.
fn parse_mention_route_entry(entry: &str) -> Result<MentionRoute, MentionRouteParseError> {
    let raw = entry.trim();
    let parts: Vec<&str> = raw.split(':').collect();
    if parts.len() < 2 {
        return Err(MentionRouteParseError::MissingProvider);
    }

    let provider_at = |idx: usize| parts[idx].trim().to_lowercase();
    let mut provider_idx = None;
    if parts.len() >= 3 && PROVIDERS.contains(&provider_at(parts.len() - 2).as_str()) {
        provider_idx = Some(parts.len() - 2);
    } else if PROVIDERS.contains(&provider_at(parts.len() - 1).as_str()) {
        provider_idx = Some(parts.len() - 1);
    } else if parts.len() > 2 {
        for idx in (1..=parts.len() - 2).rev() {
            if PROVIDERS.contains(&provider_at(idx).as_str()) {
                provider_idx = Some(idx);
                break;
            }
        }
    }

    let Some(provider_idx) = provider_idx else {
        let candidate_idx = if parts.len() >= 3 {
            parts.len() - 2
        } else {
            parts.len() - 1
        };
        let provider = provider_at(candidate_idx);
        return if provider.is_empty() {
            Err(MentionRouteParseError::MissingProvider)
        } else {
            Err(MentionRouteParseError::UnknownProvider(provider))
        };
    };

    let trigger = parts[..provider_idx].join(":").trim().to_string();
    if trigger.is_empty() {
        return Err(MentionRouteParseError::EmptyTrigger);
    }
    let provider = provider_at(provider_idx);
    let model = parts[provider_idx + 1..].join(":").trim().to_string();
    Ok(MentionRoute {
        trigger,
        provider,
        model: (!model.is_empty()).then_some(model),
    })
}

/// Read the exact routes the daemon will use. Malformed entries are skipped
/// and an empty list falls back to the legacy MENTION_TRIGGER + PROVIDER pair.
fn mention_routes(home: &Path) -> Vec<MentionRoute> {
    let mut routes = Vec::new();
    if let Some(raw) = env_value(home, "MENTION_TRIGGERS") {
        routes.extend(
            raw.split(',')
                .filter_map(|pair| parse_mention_route_entry(pair).ok()),
        );
    }
    if routes.is_empty() {
        let trigger = env_value(home, "MENTION_TRIGGER")
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "@computer".to_string());
        let provider = env_value(home, "PROVIDER")
            .map(|v| v.trim().to_lowercase())
            .filter(|v| PROVIDERS.contains(&v.as_str()))
            .unwrap_or_else(|| "claude".to_string());
        routes.push(MentionRoute {
            trigger,
            provider,
            model: None,
        });
    }
    routes
}

fn triggers_enabled(home: &Path) -> bool {
    env_value(home, "ENABLE_MENTION_TRIGGER")
        .map(|v| !v.eq_ignore_ascii_case("false"))
        .unwrap_or(true)
}

fn format_env_value(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    if value.chars().any(|c| c.is_whitespace() || c == '#' || c == '\'' || c == '"') {
        return format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""));
    }
    value.to_string()
}

/// Surgically update .env while preserving its comments and unrelated keys.
/// The temporary file + rename matches the dashboard settings writer and keeps
/// the API token owner-only.
fn write_env_values(home: &Path, updates: &[(&str, String)]) -> std::io::Result<()> {
    let path = home.join(".env");
    let mut lines: Vec<String> = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect();

    for (key, value) in updates {
        let replacement = format!("{key}={}", format_env_value(value));
        if let Some(line) = lines.iter_mut().find(|line| {
            let trimmed = line.trim_start();
            !trimmed.starts_with('#')
                && trimmed
                    .split_once('=')
                    .map(|(candidate, _)| candidate.trim() == *key)
                    .unwrap_or(false)
        }) {
            *line = replacement;
        } else {
            lines.push(replacement);
        }
    }

    let mut contents = lines.join("\n");
    contents.push('\n');
    let tmp = home.join(".env.tray.tmp");
    std::fs::write(&tmp, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(tmp, &path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn serialize_routes(routes: &[MentionRoute]) -> String {
    routes
        .iter()
        .map(|route| match &route.model {
            Some(model) => format!("{}:{}:{model}", route.trigger, route.provider),
            None => format!("{}:{}", route.trigger, route.provider),
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn save_routes(home: &Path, routes: &[MentionRoute]) -> std::io::Result<()> {
    let serialized = serialize_routes(routes);
    let mut updates = vec![("MENTION_TRIGGERS", serialized)];
    if let Some(first) = routes.first() {
        // Keep the legacy value coherent for older bridge builds/tools.
        updates.push(("MENTION_TRIGGER", first.trigger.clone()));
    }
    write_env_values(home, &updates)
}

fn normalize_call_sign(raw: &str) -> Result<String, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("The call sign cannot be empty.");
    }
    let call_sign = if raw.starts_with('@') {
        raw.to_string()
    } else {
        format!("@{raw}")
    };
    let name = call_sign.trim_start_matches('@');
    if name.is_empty()
        || name.len() > 32
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Use @ followed by 1–32 letters, numbers, hyphens or underscores.");
    }
    Ok(call_sign)
}

fn call_sign_is_unique(routes: &[MentionRoute], candidate: &str, except: Option<usize>) -> bool {
    !routes.iter().enumerate().any(|(idx, route)| {
        Some(idx) != except && route.trigger.eq_ignore_ascii_case(candidate)
    })
}

fn restart_after_config_change(app: &AppHandle, message: &str) {
    kill_child(app);
    app.state::<BridgeState>().restart.notify_one();
    notify(app, message);
}

#[cfg(target_os = "macos")]
fn prompt_text(_app: &AppHandle, title: &str, prompt: &str, default: &str) -> Option<String> {
    let script = r#"on run argv
set answer to display dialog (item 2 of argv) default answer (item 3 of argv) with title (item 1 of argv) buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel"
return text returned of answer
end run"#;
    let output = std::process::Command::new("osascript")
        .args(["-e", script, "--", title, prompt, default])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(not(target_os = "macos"))]
fn prompt_text(app: &AppHandle, _title: &str, _prompt: &str, _default: &str) -> Option<String> {
    notify(app, "Text editing from the tray is currently available on macOS; opening Settings instead.");
    open_dashboard(app);
    None
}

#[cfg(target_os = "macos")]
fn choose_provider(_app: &AppHandle, title: &str) -> Option<String> {
    let script = r#"on run argv
set picked to choose from list {"Claude", "Codex", "Gemini", "Grok"} with title (item 1 of argv) with prompt "Choose the provider for this call sign:" default items {"Claude"} OK button name "Choose" cancel button name "Cancel"
if picked is false then return ""
return item 1 of picked
end run"#;
    let output = std::process::Command::new("osascript")
        .args(["-e", script, "--", title])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let selected = String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
    PROVIDERS.contains(&selected.as_str()).then_some(selected)
}

#[cfg(not(target_os = "macos"))]
fn choose_provider(app: &AppHandle, _title: &str) -> Option<String> {
    notify(
        app,
        "Adding a call sign from the tray is currently available on macOS; opening Settings instead.",
    );
    open_dashboard(app);
    None
}

#[cfg(target_os = "macos")]
fn confirm_remove(_app: &AppHandle, call_sign: &str) -> bool {
    let script = r#"on run argv
display alert "Remove agent call sign?" message ((item 1 of argv) & " will stop triggering its agent after the bridge restarts.") as critical buttons {"Cancel", "Remove"} default button "Cancel" cancel button "Cancel"
return "remove"
end run"#;
    std::process::Command::new("osascript")
        .args(["-e", script, "--", call_sign])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn confirm_remove(app: &AppHandle, _call_sign: &str) -> bool {
    notify(
        app,
        "Removing a call sign from the tray is currently available on macOS; opening Settings instead.",
    );
    open_dashboard(app);
    false
}

fn provider_default_model(home: &Path, provider: &str) -> Option<String> {
    if let Some(key) = model_env_key(provider) {
        if let Some(model) = env_value(home, key).filter(|v| !v.trim().is_empty()) {
            return Some(model);
        }
    }
    let default_provider = env_value(home, "PROVIDER")
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_else(|| "claude".to_string());
    if provider == default_provider {
        if let Some(model) = env_value(home, "MODEL").filter(|v| !v.trim().is_empty()) {
            return Some(model);
        }
    }
    // Codex inherits its model from ~/.codex/config.toml when CODEX_MODEL is
    // blank. Reading just this scalar lets the menu show the actual model the
    // CLI will use without trying to maintain a stale hard-coded model list.
    if provider == "codex" {
        let path = std::env::var("HOME")
            .ok()
            .map(PathBuf::from)?
            .join(".codex/config.toml");
        for line in std::fs::read_to_string(path).ok()?.lines() {
            let Some((key, raw)) = line.trim().split_once('=') else {
                continue;
            };
            if key.trim() == "model" {
                let value = raw.trim().trim_matches('"').trim_matches('\'');
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn route_model_display(home: &Path, route: &MentionRoute) -> String {
    route
        .model
        .clone()
        .or_else(|| provider_default_model(home, &route.provider))
        .unwrap_or_else(|| "provider default".to_string())
}

fn parse_codex_model_cache(text: &str) -> Vec<String> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(models) = root.get("models").and_then(|value| value.as_array()) else {
        return Vec::new();
    };
    let mut slugs: Vec<String> = Vec::new();
    for model in models {
        let visibility = model.get("visibility").and_then(|value| value.as_str());
        // Codex marks models that should not appear in selectors as `hide`.
        // Include the documented list entries and older cache entries that do
        // not carry visibility at all; ignore unknown future classifications.
        if !matches!(visibility, None | Some("list")) {
            continue;
        }
        let Some(slug) = model
            .get("slug")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if !slugs.iter().any(|seen| seen.eq_ignore_ascii_case(slug)) {
            slugs.push(slug.to_string());
        }
    }
    slugs
}

fn codex_cached_models() -> Vec<String> {
    let Some(path) = std::env::var("HOME")
        .ok()
        .map(PathBuf::from)
        .map(|home| home.join(".codex/models_cache.json"))
    else {
        return Vec::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .map(|text| parse_codex_model_cache(&text))
        .unwrap_or_default()
}

fn model_presets(home: &Path, provider: &str) -> Vec<String> {
    let mut presets = match provider {
        // These aliases are advertised by `claude --help` and intentionally
        // survive model-version changes.
        "claude" => vec!["fable".to_string(), "opus".to_string(), "sonnet".to_string()],
        // Codex refreshes this cache itself, so the tray follows the locally
        // installed CLI instead of hard-coding model names that will age out.
        "codex" => codex_cached_models(),
        _ => Vec::new(),
    };
    if let Some(configured) = provider_default_model(home, provider) {
        presets.retain(|preset| !preset.eq_ignore_ascii_case(&configured));
        presets.insert(0, configured);
    }
    presets
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TaskActivity {
    Idle,
    Running(usize),
    Unknown,
}

fn restart_allowed(activity: TaskActivity, has_managed_child: bool) -> bool {
    match activity {
        TaskActivity::Idle => true,
        TaskActivity::Running(_) => false,
        TaskActivity::Unknown => !has_managed_child,
    }
}

fn task_activity(app: &AppHandle) -> TaskActivity {
    let home = &app.state::<BridgeState>().home;
    let token = env_value(home, "WA_API_TOKEN").unwrap_or_default();
    let Some(status) = http_get_json(api_port(home), "/status", &token) else {
        return TaskActivity::Unknown;
    };
    if status.get("error").is_some() {
        return TaskActivity::Unknown;
    }
    let Some(tasks) = status.get("tasks").and_then(|tasks| tasks.as_array()) else {
        return TaskActivity::Unknown;
    };
    let running = tasks
        .iter()
        .filter(|task| task.get("status").and_then(|s| s.as_str()) == Some("running"))
        .count();
    if running == 0 {
        TaskActivity::Idle
    } else {
        TaskActivity::Running(running)
    }
}

/// Provider CLIs can outlive a hard-killed sidecar, so restarts fail closed.
/// If no managed child exists, there is nothing to orphan and a config edit
/// may safely start the daemon again.
fn restart_is_safe(app: &AppHandle, action: &str) -> bool {
    let activity = task_activity(app);
    let has_managed_child = app.state::<BridgeState>().child.lock().unwrap().is_some();
    if restart_allowed(activity, has_managed_child) {
        return true;
    }
    match activity {
        TaskActivity::Idle => true, // handled above
        TaskActivity::Running(count) => {
            notify(
                app,
                &format!(
                    "Cannot {action}: {count} agent task(s) are still running. Wait for them to finish."
                ),
            );
            false
        }
        TaskActivity::Unknown => {
            notify(
                app,
                &format!(
                    "Cannot {action}: bridge task status could not be verified. Try again when Bridge shows connected."
                ),
            );
            false
        }
    }
}

fn short_menu_text(value: &str) -> String {
    const MAX_CHARS: usize = 36;
    if value.chars().count() <= MAX_CHARS {
        value.to_string()
    } else {
        format!("{}…", value.chars().take(MAX_CHARS - 1).collect::<String>())
    }
}

fn clear_submenu(menu: &Submenu<Wry>) -> tauri::Result<()> {
    while !menu.items()?.is_empty() {
        let _ = menu.remove_at(0)?;
    }
    Ok(())
}

fn populate_agents_menu(app: &AppHandle, menu: &Submenu<Wry>) -> tauri::Result<()> {
    clear_submenu(menu)?;
    let home = &app.state::<BridgeState>().home;
    let routes = mention_routes(home);
    let enabled = triggers_enabled(home);

    let enabled_item = CheckMenuItem::with_id(
        app,
        "agent.enabled",
        "Agent call signs enabled",
        true,
        enabled,
        None::<&str>,
    )?;
    menu.append(&enabled_item)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    for (index, route) in routes.iter().enumerate() {
        let model_display = route_model_display(home, route);
        let route_title = format!(
            "{} · {} · {}",
            route.trigger,
            provider_label(&route.provider),
            short_menu_text(&model_display)
        );
        let route_menu = Submenu::with_id(
            app,
            format!("agent.route.{index}"),
            route_title,
            true,
        )?;

        let provider_menu = Submenu::with_id(
            app,
            format!("agent.provider-menu.{index}"),
            format!("Provider: {}", provider_label(&route.provider)),
            true,
        )?;
        for provider in PROVIDERS {
            let checked = if provider == route.provider { "✓ " } else { "" };
            let item = MenuItem::with_id(
                app,
                format!("agent.provider.{index}.{provider}"),
                format!("{checked}{}", provider_label(provider)),
                true,
                None::<&str>,
            )?;
            provider_menu.append(&item)?;
        }
        route_menu.append(&provider_menu)?;

        let model_menu = Submenu::with_id(
            app,
            format!("agent.model-menu.{index}"),
            format!("Model: {}", short_menu_text(&model_display)),
            true,
        )?;
        let source = if route.model.is_some() {
            "Current route override"
        } else {
            "Current provider default"
        };
        let current = MenuItem::with_id(
            app,
            format!("agent.model-current.{index}"),
            format!("{source}: {}", short_menu_text(&model_display)),
            false,
            None::<&str>,
        )?;
        model_menu.append(&current)?;
        model_menu.append(&PredefinedMenuItem::separator(app)?)?;

        let inherited_check = if route.model.is_none() { "✓ " } else { "" };
        let inherited_label = provider_default_model(home, &route.provider)
            .map(|model| format!("Provider default ({})", short_menu_text(&model)))
            .unwrap_or_else(|| "Provider default".to_string());
        let inherited = MenuItem::with_id(
            app,
            format!("agent.model.default.{index}"),
            format!("{inherited_check}{inherited_label}"),
            true,
            None::<&str>,
        )?;
        model_menu.append(&inherited)?;

        for (preset_index, preset) in model_presets(home, &route.provider).iter().enumerate() {
            let checked = if route
                .model
                .as_deref()
                .map(|model| model.eq_ignore_ascii_case(preset))
                .unwrap_or(false)
            {
                "✓ "
            } else {
                ""
            };
            let item = MenuItem::with_id(
                app,
                format!("agent.model.preset.{index}.{preset_index}"),
                format!("{checked}{}", short_menu_text(preset)),
                true,
                None::<&str>,
            )?;
            model_menu.append(&item)?;
        }
        model_menu.append(&PredefinedMenuItem::separator(app)?)?;
        let custom = MenuItem::with_id(
            app,
            format!("agent.model.custom.{index}"),
            "Set Custom Model…",
            true,
            None::<&str>,
        )?;
        model_menu.append(&custom)?;
        route_menu.append(&model_menu)?;

        route_menu.append(&PredefinedMenuItem::separator(app)?)?;
        let rename = MenuItem::with_id(
            app,
            format!("agent.rename.{index}"),
            "Rename Call Sign…",
            true,
            None::<&str>,
        )?;
        route_menu.append(&rename)?;
        let remove_enabled = routes.len() > 1;
        let remove = MenuItem::with_id(
            app,
            format!("agent.remove.{index}"),
            if remove_enabled {
                "Remove Agent…"
            } else {
                "Remove Agent (add another first)"
            },
            remove_enabled,
            None::<&str>,
        )?;
        route_menu.append(&remove)?;
        menu.append(&route_menu)?;
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let add = MenuItem::with_id(app, "agent.add", "Add Agent Call Sign…", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "agent.refresh", "Refresh from .env", true, None::<&str>)?;
    let configure = MenuItem::with_id(
        app,
        "agent.configure",
        "Open Full Settings…",
        true,
        None::<&str>,
    )?;
    menu.append(&add)?;
    menu.append(&refresh)?;
    menu.append(&configure)?;
    Ok(())
}

fn refresh_agents_menu(app: &AppHandle, menu: &Submenu<Wry>) {
    if let Err(e) = populate_agents_menu(app, menu) {
        notify(app, &format!("Could not refresh the agent menu: {e}"));
    }
}

fn save_routes_and_restart(
    app: &AppHandle,
    menu: &Submenu<Wry>,
    routes: &[MentionRoute],
    action: &str,
    success: &str,
) {
    if !restart_is_safe(app, action) {
        // CheckMenuItem state can change before the callback. Rebuilding also
        // guarantees a cancelled action never leaves stale visual state.
        refresh_agents_menu(app, menu);
        return;
    }
    let home = app.state::<BridgeState>().home.clone();
    match save_routes(&home, routes) {
        Ok(()) => {
            // Refresh before restarting so provider/model/checkmark changes are
            // visible the very next time the tray opens.
            refresh_agents_menu(app, menu);
            restart_after_config_change(app, success);
        }
        Err(e) => notify(app, &format!("Could not save agent routing: {e}")),
    }
}

fn valid_custom_model(model: &str) -> bool {
    !model.contains(',')
        && !model.contains(':')
        && !model.contains('\n')
        && !model.contains('\r')
        && model.chars().count() <= 128
}

fn handle_agent_menu_event(app: &AppHandle, menu: &Submenu<Wry>, id: &str) -> bool {
    if id == "agent.configure" {
        open_dashboard(app);
        return true;
    }
    if id == "agent.refresh" {
        refresh_agents_menu(app, menu);
        return true;
    }

    let home = app.state::<BridgeState>().home.clone();
    if id == "agent.enabled" {
        let next = !triggers_enabled(&home);
        if !restart_is_safe(
            app,
            if next {
                "enable agent call signs"
            } else {
                "pause all agent call signs"
            },
        ) {
            refresh_agents_menu(app, menu);
            return true;
        }
        match write_env_values(
            &home,
            &[("ENABLE_MENTION_TRIGGER", next.to_string())],
        ) {
            Ok(()) => {
                refresh_agents_menu(app, menu);
                restart_after_config_change(
                    app,
                    if next {
                        "Agent call signs enabled; restarting bridge…"
                    } else {
                        "Agent call signs paused; restarting bridge…"
                    },
                );
            }
            Err(e) => {
                refresh_agents_menu(app, menu);
                notify(app, &format!("Could not save call-sign state: {e}"));
            }
        }
        return true;
    }

    if id == "agent.add" {
        let Some(raw) = prompt_text(
            app,
            "Add Agent Call Sign",
            "Type the word you will use in WhatsApp (for example @reviewer):",
            "@",
        ) else {
            return true;
        };
        let call_sign = match normalize_call_sign(&raw) {
            Ok(value) => value,
            Err(message) => {
                notify(app, message);
                return true;
            }
        };
        let mut routes = mention_routes(&home);
        if !call_sign_is_unique(&routes, &call_sign, None) {
            notify(app, &format!("{call_sign} is already configured."));
            return true;
        }
        let Some(provider) = choose_provider(app, "Add Agent Call Sign") else {
            return true;
        };
        routes.push(MentionRoute {
            trigger: call_sign.clone(),
            provider: provider.clone(),
            model: None,
        });
        save_routes_and_restart(
            app,
            menu,
            &routes,
            &format!("add {call_sign}"),
            &format!("Added {call_sign} → {}; restarting bridge…", provider_label(&provider)),
        );
        return true;
    }

    if let Some(index) = id
        .strip_prefix("agent.rename.")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let mut routes = mention_routes(&home);
        let Some(route) = routes.get(index).cloned() else {
            refresh_agents_menu(app, menu);
            return true;
        };
        let Some(raw) = prompt_text(
            app,
            "Rename Agent Call Sign",
            "Type the new WhatsApp call sign:",
            &route.trigger,
        ) else {
            return true;
        };
        let call_sign = match normalize_call_sign(&raw) {
            Ok(value) => value,
            Err(message) => {
                notify(app, message);
                return true;
            }
        };
        if call_sign.eq_ignore_ascii_case(&route.trigger) {
            refresh_agents_menu(app, menu);
            return true;
        }
        if !call_sign_is_unique(&routes, &call_sign, Some(index)) {
            notify(app, &format!("{call_sign} is already configured."));
            return true;
        }
        routes[index].trigger = call_sign.clone();
        save_routes_and_restart(
            app,
            menu,
            &routes,
            &format!("rename {} to {call_sign}", route.trigger),
            &format!("Renamed {} to {call_sign}; restarting bridge…", route.trigger),
        );
        return true;
    }

    if let Some(index) = id
        .strip_prefix("agent.remove.")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let mut routes = mention_routes(&home);
        if routes.len() <= 1 {
            refresh_agents_menu(app, menu);
            return true;
        }
        let Some(route) = routes.get(index).cloned() else {
            refresh_agents_menu(app, menu);
            return true;
        };
        if !confirm_remove(app, &route.trigger) {
            return true;
        }
        routes.remove(index);
        save_routes_and_restart(
            app,
            menu,
            &routes,
            &format!("remove {}", route.trigger),
            &format!("Removed {}; restarting bridge…", route.trigger),
        );
        return true;
    }

    if let Some(rest) = id.strip_prefix("agent.provider.") {
        let Some((index, provider)) = rest.split_once('.') else {
            return true;
        };
        let Some(index) = index.parse::<usize>().ok() else {
            return true;
        };
        if !PROVIDERS.contains(&provider) {
            return true;
        }
        let mut routes = mention_routes(&home);
        let Some(route) = routes.get(index).cloned() else {
            refresh_agents_menu(app, menu);
            return true;
        };
        if route.provider == provider {
            refresh_agents_menu(app, menu);
            return true;
        }
        routes[index].provider = provider.to_string();
        // A Claude model name is not valid for Codex (and vice versa). A
        // provider switch therefore intentionally starts from its own default.
        routes[index].model = None;
        save_routes_and_restart(
            app,
            menu,
            &routes,
            &format!("change {} to {}", route.trigger, provider_label(provider)),
            &format!(
                "{} now uses {} with its default model; restarting bridge…",
                route.trigger,
                provider_label(provider)
            ),
        );
        return true;
    }

    if let Some(index) = id
        .strip_prefix("agent.model.default.")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let mut routes = mention_routes(&home);
        let Some(route) = routes.get(index).cloned() else {
            refresh_agents_menu(app, menu);
            return true;
        };
        if route.model.is_none() {
            refresh_agents_menu(app, menu);
            return true;
        }
        routes[index].model = None;
        save_routes_and_restart(
            app,
            menu,
            &routes,
            &format!("reset {} to its provider default model", route.trigger),
            &format!("{} now uses its provider default model; restarting bridge…", route.trigger),
        );
        return true;
    }

    if let Some(rest) = id.strip_prefix("agent.model.preset.") {
        let mut parts = rest.split('.');
        let Some(index) = parts.next().and_then(|value| value.parse::<usize>().ok()) else {
            return true;
        };
        let Some(preset_index) = parts.next().and_then(|value| value.parse::<usize>().ok()) else {
            return true;
        };
        let mut routes = mention_routes(&home);
        let Some(route) = routes.get(index).cloned() else {
            refresh_agents_menu(app, menu);
            return true;
        };
        let Some(model) = model_presets(&home, &route.provider).get(preset_index).cloned() else {
            refresh_agents_menu(app, menu);
            return true;
        };
        if route.model.as_deref() == Some(model.as_str()) {
            refresh_agents_menu(app, menu);
            return true;
        }
        routes[index].model = Some(model.clone());
        save_routes_and_restart(
            app,
            menu,
            &routes,
            &format!("change {} to model {model}", route.trigger),
            &format!("{} now uses {model}; restarting bridge…", route.trigger),
        );
        return true;
    }

    if let Some(index) = id
        .strip_prefix("agent.model.custom.")
        .and_then(|value| value.parse::<usize>().ok())
    {
        let mut routes = mention_routes(&home);
        let Some(route) = routes.get(index).cloned() else {
            refresh_agents_menu(app, menu);
            return true;
        };
        let default = route.model.clone().unwrap_or_default();
        let Some(raw) = prompt_text(
            app,
            &format!("{} Model", route.trigger),
            "Enter the exact model name. Leave blank to use the provider default:",
            &default,
        ) else {
            return true;
        };
        let model = raw.trim();
        if !valid_custom_model(model) {
            notify(app, "Model names must be 128 characters or fewer and cannot contain commas, colons or newlines.");
            return true;
        }
        let next = (!model.is_empty()).then(|| model.to_string());
        if route.model == next {
            refresh_agents_menu(app, menu);
            return true;
        }
        routes[index].model = next.clone();
        let display = next.unwrap_or_else(|| "provider default".to_string());
        save_routes_and_restart(
            app,
            menu,
            &routes,
            &format!("change {} to model {display}", route.trigger),
            &format!("{} now uses {display}; restarting bridge…", route.trigger),
        );
        return true;
    }

    id.starts_with("agent.")
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
            let agents_menu =
                Submenu::with_id(app, "agents", "Agents & Call Signs", true)?;
            populate_agents_menu(&handle, &agents_menu)?;
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
                    &agents_menu,
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
            let agents_for_menu = agents_menu.clone();
            tray_builder
                .on_menu_event(move |app, event| {
                    let id = event.id.as_ref();
                    if handle_agent_menu_event(app, &agents_for_menu, id) {
                        return;
                    }
                    match id {
                        "open" => open_dashboard(app),
                        "restart" => {
                            if !restart_is_safe(app, "restart the bridge") {
                                return;
                            }
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
                            if !restart_is_safe(app, "quit the bridge") {
                                return;
                            }
                            app.state::<BridgeState>()
                                .quitting
                                .store(true, Ordering::SeqCst);
                            kill_child(app);
                            app.exit(0);
                        }
                        _ => {}
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_legacy_two_field_route() {
        assert_eq!(
            parse_mention_route_entry("@computer:claude"),
            Ok(MentionRoute {
                trigger: "@computer".to_string(),
                provider: "claude".to_string(),
                model: None,
            })
        );
    }

    #[test]
    fn parses_route_specific_model() {
        assert_eq!(
            parse_mention_route_entry("@codex:codex:gpt-5.6"),
            Ok(MentionRoute {
                trigger: "@codex".to_string(),
                provider: "codex".to_string(),
                model: Some("gpt-5.6".to_string()),
            })
        );
    }

    #[test]
    fn parses_colon_in_trigger() {
        assert_eq!(
            parse_mention_route_entry("@ops:urgent:codex"),
            Ok(MentionRoute {
                trigger: "@ops:urgent".to_string(),
                provider: "codex".to_string(),
                model: None,
            })
        );
    }

    #[test]
    fn parses_colons_in_model() {
        assert_eq!(
            parse_mention_route_entry("@ops:urgent:codex:openai:gpt-5.6"),
            Ok(MentionRoute {
                trigger: "@ops:urgent".to_string(),
                provider: "codex".to_string(),
                model: Some("openai:gpt-5.6".to_string()),
            })
        );
    }

    #[test]
    fn prefers_penultimate_provider_for_explicit_model() {
        assert_eq!(
            parse_mention_route_entry("@review:claude:codex"),
            Ok(MentionRoute {
                trigger: "@review".to_string(),
                provider: "claude".to_string(),
                model: Some("codex".to_string()),
            })
        );
    }

    #[test]
    fn rejects_malformed_routes() {
        assert_eq!(
            parse_mention_route_entry("@computer"),
            Err(MentionRouteParseError::MissingProvider)
        );
        assert_eq!(
            parse_mention_route_entry("@review:bogus:model-x"),
            Err(MentionRouteParseError::UnknownProvider(
                "bogus".to_string()
            ))
        );
        assert_eq!(
            parse_mention_route_entry(":claude"),
            Err(MentionRouteParseError::EmptyTrigger)
        );
    }

    #[test]
    fn parses_visible_codex_models_from_cache() {
        let cache = r#"{
          "models": [
            { "slug": "gpt-current", "visibility": "list" },
            { "slug": "gpt-hidden", "visibility": "hide" },
            { "slug": "gpt-legacy" },
            { "slug": "GPT-CURRENT", "visibility": "list" },
            { "slug": "gpt-null", "visibility": null },
            { "slug": "gpt-future", "visibility": "preview" },
            { "slug": "", "visibility": "list" }
          ]
        }"#;
        assert_eq!(
            parse_codex_model_cache(cache),
            vec![
                "gpt-current".to_string(),
                "gpt-legacy".to_string(),
                "gpt-null".to_string(),
            ]
        );
        assert!(parse_codex_model_cache("not json").is_empty());
        assert!(parse_codex_model_cache(r#"{"models": {}}"#).is_empty());
    }

    #[test]
    fn tray_routes_round_trip_and_reject_ambiguous_custom_models() {
        let routes = vec![
            MentionRoute {
                trigger: "@computer".to_string(),
                provider: "claude".to_string(),
                model: Some("claude-fable-5".to_string()),
            },
            MentionRoute {
                trigger: "@codex".to_string(),
                provider: "codex".to_string(),
                model: Some("gpt-5.6-sol".to_string()),
            },
        ];
        let encoded = serialize_routes(&routes);
        let decoded: Vec<_> = encoded
            .split(',')
            .map(|entry| parse_mention_route_entry(entry).unwrap())
            .collect();
        assert_eq!(decoded, routes);
        assert!(valid_custom_model("gpt-5.6-sol"));
        assert!(!valid_custom_model("vendor:codex"));
    }

    #[test]
    fn restart_policy_never_kills_active_or_unverified_children() {
        assert!(restart_allowed(TaskActivity::Idle, true));
        assert!(!restart_allowed(TaskActivity::Running(1), true));
        assert!(!restart_allowed(TaskActivity::Unknown, true));
        assert!(restart_allowed(TaskActivity::Unknown, false));
    }
}
