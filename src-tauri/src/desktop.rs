//! Desktop integration: system tray (Open, Read-Only, Quick Note, Quit), global shortcuts,
//! close-to-tray and window helpers.

use std::str::FromStr;
use std::sync::Mutex;

use cobalt_core::config::AppSettings;
use cobalt_core::enums::Language;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::{MAIN_WINDOW, QUICKNOTE_WINDOW};

const TRAY_ID: &str = "cobalt-tray";
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");
const TRAY_ICON_READ_ONLY: &[u8] = include_bytes!("../icons/tray-readonly.png");

/// Actions bound to global shortcuts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutAction {
    QuickNote,
    ToggleReadOnly,
}

/// Currently registered shortcuts (managed state).
#[derive(Default)]
pub struct ShortcutBindings(Mutex<Vec<(Shortcut, ShortcutAction)>>);

/// Read-only checkbox in the tray menu (managed state, to keep it in sync).
pub struct TrayMenuState {
    read_only: CheckMenuItem<Wry>,
}

struct Labels {
    open: &'static str,
    read_only: &'static str,
    quick_note: &'static str,
    quit: &'static str,
    tooltip: &'static str,
    tooltip_read_only: &'static str,
}

fn labels(lang: Language) -> Labels {
    match lang {
        Language::Es => Labels {
            open: "Abrir Cobalt",
            read_only: "Modo Solo Lectura",
            quick_note: "Nota rápida",
            quit: "Salir",
            tooltip: "Cobalt · memoria activa",
            tooltip_read_only: "Cobalt · Solo Lectura (escrituras de IA en pausa)",
        },
        Language::En => Labels {
            open: "Open Cobalt",
            read_only: "Read-Only mode",
            quick_note: "Quick note",
            quit: "Quit",
            tooltip: "Cobalt · memory active",
            tooltip_read_only: "Cobalt · Read-Only (AI writes paused)",
        },
    }
}

pub fn setup_tray(app: &AppHandle, settings: &AppSettings) -> tauri::Result<()> {
    let l = labels(settings.language);
    let open = MenuItem::with_id(app, "open", l.open, true, None::<&str>)?;
    let read_only = CheckMenuItem::with_id(app, "read_only", l.read_only, true, settings.read_only, None::<&str>)?;
    let quick_note = MenuItem::with_id(app, "quick_note", l.quick_note, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", l.quit, true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &quick_note, &read_only, &sep, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon(settings.read_only)?)
        .tooltip(if settings.read_only { l.tooltip_read_only } else { l.tooltip })
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quick_note" => toggle_quicknote(app),
            "read_only" => crate::toggle_read_only(app.clone()),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(TrayMenuState { read_only });
    Ok(())
}

fn tray_icon(read_only: bool) -> tauri::Result<Image<'static>> {
    Image::from_bytes(if read_only { TRAY_ICON_READ_ONLY } else { TRAY_ICON })
}

/// Reflects Read-Only mode in the tray icon, tooltip and checkbox.
pub fn set_tray_read_only(app: &AppHandle, read_only: bool, lang: Language) {
    let l = labels(lang);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(icon) = tray_icon(read_only) {
            let _ = tray.set_icon(Some(icon));
        }
        let _ = tray.set_tooltip(Some(if read_only { l.tooltip_read_only } else { l.tooltip }));
    }
    if let Some(menu) = app.try_state::<TrayMenuState>() {
        let _ = menu.read_only.set_checked(read_only);
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn toggle_quicknote(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(QUICKNOTE_WINDOW) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.center();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

/// (Re)registers the global shortcuts from settings. Failures (e.g. a shortcut already taken
/// by the desktop environment) are logged and skipped, never fatal.
pub fn register_shortcuts(app: &AppHandle, settings: &AppSettings) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut bound = Vec::new();
    for (raw, action) in [
        (settings.shortcuts.quick_note.as_str(), ShortcutAction::QuickNote),
        (settings.shortcuts.toggle_read_only.as_str(), ShortcutAction::ToggleReadOnly),
    ] {
        match Shortcut::from_str(raw) {
            Ok(shortcut) => match gs.register(shortcut) {
                Ok(()) => bound.push((shortcut, action)),
                Err(err) => tracing::warn!(shortcut = raw, %err, "could not register global shortcut"),
            },
            Err(err) => tracing::warn!(shortcut = raw, %err, "invalid global shortcut"),
        }
    }
    if let Some(state) = app.try_state::<ShortcutBindings>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = bound;
    }
}

/// Global shortcut handler (installed on the plugin builder).
pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    let action = app.try_state::<ShortcutBindings>().and_then(|b| {
        b.0.lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .find(|(s, _)| s == shortcut)
            .map(|(_, a)| *a)
    });
    match action {
        Some(ShortcutAction::QuickNote) => toggle_quicknote(app),
        Some(ShortcutAction::ToggleReadOnly) => crate::toggle_read_only(app.clone()),
        None => {}
    }
}
