//! Hardware profile DTOs (`sysinfo` + `wgpu`). The profiler itself lands in Phase 1.

use serde::{Deserialize, Serialize};

use crate::enums::{EngineKind, GpuBackend, GpuDeviceType, HardwareTier};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GpuInfo {
    pub name: String,
    pub vendor_id: u32,
    pub device_type: GpuDeviceType,
    pub backend: GpuBackend,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TierRecommendation {
    pub tier: HardwareTier,
    pub engine: EngineKind,
    pub model_id: String,
    /// Exact bytes to download (model + engine binaries not yet installed).
    pub download_bytes: u64,
    /// i18n key explaining the choice (e.g. `onboarding.reason.low_ram`).
    pub reason_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HardwareProfile {
    /// `linux` | `windows` | `macos`.
    pub os: String,
    pub os_version: Option<String>,
    pub arch: String,
    pub total_ram_bytes: u64,
    pub available_ram_bytes: u64,
    pub cpu_brand: String,
    pub physical_cores: Option<u32>,
    pub logical_cores: u32,
    pub gpus: Vec<GpuInfo>,
    pub recommendation: TierRecommendation,
}
