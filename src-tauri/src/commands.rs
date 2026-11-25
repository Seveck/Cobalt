//! Tauri IPC commands. Convention (see `cobalt_core::ipc`): zero or one parameter named
//! `args`, results as `Result<T, CobaltError>`.

use cobalt_core::ipc::AppInfo;
use cobalt_core::{CONTRACT_VERSION, CobaltError, SCHEMA_VERSION, paths};

#[tauri::command]
pub fn app_info() -> Result<AppInfo, CobaltError> {
    let data_dir = paths::cobalt_home()?;
    Ok(AppInfo {
        name: "Cobalt".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        contract_version: CONTRACT_VERSION.into(),
        schema_version: SCHEMA_VERSION,
        data_dir: data_dir.to_string_lossy().into_owned(),
    })
}
