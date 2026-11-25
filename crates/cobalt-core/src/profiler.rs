//! Hardware profiler: RAM / CPU via `sysinfo`, GPU adapters via `wgpu` (feature `hardware`),
//! and the pure Eco / Balanced / Ultra recommendation rules.
//!
//! Rules (nominal RAM = total RAM rounded to the nearest GiB, so an "8 GB" machine that
//! reports 7.6 GiB counts as 8):
//! - **Eco**: nominal RAM < 8 GiB, or fewer than 4 logical cores.
//! - **Ultra**: nominal RAM > 16 GiB **and** a discrete GPU.
//! - **Balanced**: everything else.
//!
//! Reason keys (i18n): `onboarding.reason.{low_ram, few_cores, balanced_ram, high_ram_gpu,
//! no_discrete_gpu}`.

use crate::catalog::Catalog;
use crate::engine::{default_engine_for_tier, default_model_for_tier};
use crate::enums::{GpuDeviceType, HardwareTier};
use crate::error::Result;
use crate::hardware::{GpuInfo, TierRecommendation};

pub const GIB: u64 = 1024 * 1024 * 1024;

/// Total RAM rounded to the nearest whole GiB.
pub fn nominal_ram_gib(total_ram_bytes: u64) -> u64 {
    (total_ram_bytes + GIB / 2) / GIB
}

/// Picks the tier and the i18n key explaining it.
pub fn recommend_tier(
    total_ram_bytes: u64,
    logical_cores: u32,
    gpus: &[GpuInfo],
) -> (HardwareTier, &'static str) {
    let ram = nominal_ram_gib(total_ram_bytes);
    let discrete = gpus
        .iter()
        .any(|g| g.device_type == GpuDeviceType::DiscreteGpu);
    if ram < 8 {
        (HardwareTier::Eco, "onboarding.reason.low_ram")
    } else if logical_cores < 4 {
        (HardwareTier::Eco, "onboarding.reason.few_cores")
    } else if ram > 16 && discrete {
        (HardwareTier::Ultra, "onboarding.reason.high_ram_gpu")
    } else if ram > 16 {
        (HardwareTier::Balanced, "onboarding.reason.no_discrete_gpu")
    } else {
        (HardwareTier::Balanced, "onboarding.reason.balanced_ram")
    }
}

/// Builds the recommendation; `is_installed(relative_dest)` tells which artifacts are already
/// present so `download_bytes` is the exact remaining download.
pub fn build_recommendation(
    catalog: &Catalog,
    tier: HardwareTier,
    reason_key: &str,
    is_installed: impl Fn(&str) -> bool,
) -> Result<TierRecommendation> {
    let engine = default_engine_for_tier(tier);
    let model_id = default_model_for_tier(tier);
    let download_bytes = catalog
        .artifacts_for(engine, model_id)?
        .iter()
        .filter(|a| !is_installed(&a.relative_dest))
        .map(|a| a.size_bytes)
        .sum();
    Ok(TierRecommendation {
        tier,
        engine,
        model_id: model_id.to_owned(),
        download_bytes,
        reason_key: reason_key.to_owned(),
    })
}

#[cfg(feature = "hardware")]
mod detect {
    use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

    use super::{build_recommendation, recommend_tier};
    use crate::catalog::Catalog;
    use crate::enums::{GpuBackend, GpuDeviceType};
    use crate::error::{CobaltError, Result};
    use crate::hardware::{GpuInfo, HardwareProfile};

    /// Detects the machine profile. GPU enumeration never fails the whole profile: when no
    /// adapter can be queried the GPU list is simply empty.
    pub async fn detect_hardware(
        catalog: &Catalog,
        is_installed: impl Fn(&str) -> bool,
    ) -> Result<HardwareProfile> {
        let (total_ram, available_ram, cpu_brand, logical) = tokio::task::spawn_blocking(|| {
            let sys = System::new_with_specifics(
                RefreshKind::nothing()
                    .with_memory(MemoryRefreshKind::nothing().with_ram())
                    .with_cpu(CpuRefreshKind::nothing()),
            )
            .map_err(|e| CobaltError::Internal(format!("sysinfo: {e}")))?;
            let brand = sys
                .cpus()
                .first()
                .map(|c| c.brand().trim().to_owned())
                .unwrap_or_default();
            let logical = u32::try_from(sys.cpus().len()).unwrap_or(u32::MAX);
            Ok::<_, CobaltError>((sys.total_memory(), sys.available_memory(), brand, logical))
        })
        .await
        .map_err(|e| CobaltError::Internal(format!("hardware probe task: {e}")))??;

        let physical_cores = System::physical_core_count()
            .ok()
            .and_then(|n| u32::try_from(n).ok());
        let gpus = detect_gpus().await;
        let logical_cores = logical.max(1);
        let (tier, reason) = recommend_tier(total_ram, logical_cores, &gpus);
        let recommendation = build_recommendation(catalog, tier, reason, is_installed)?;

        Ok(HardwareProfile {
            os: std::env::consts::OS.to_owned(),
            os_version: System::long_os_version().ok(),
            arch: std::env::consts::ARCH.to_owned(),
            total_ram_bytes: total_ram,
            available_ram_bytes: available_ram,
            cpu_brand,
            physical_cores,
            logical_cores,
            gpus,
            recommendation,
        })
    }

    async fn detect_gpus() -> Vec<GpuInfo> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let mut adapters = instance.enumerate_adapters(wgpu::Backends::PRIMARY).await;
        if adapters.is_empty() {
            adapters = instance.enumerate_adapters(wgpu::Backends::GL).await;
        }
        let mut gpus: Vec<GpuInfo> = Vec::new();
        for adapter in adapters {
            let info = adapter.get_info();
            let gpu = GpuInfo {
                name: info.name.clone(),
                vendor_id: info.vendor,
                device_type: map_device_type(info.device_type),
                backend: map_backend(info.backend),
            };
            // The same physical GPU is often exposed by several backends; keep the first.
            if !gpus
                .iter()
                .any(|g| g.name == gpu.name && g.vendor_id == gpu.vendor_id)
            {
                gpus.push(gpu);
            }
        }
        gpus
    }

    fn map_device_type(t: wgpu::DeviceType) -> GpuDeviceType {
        match t {
            wgpu::DeviceType::DiscreteGpu => GpuDeviceType::DiscreteGpu,
            wgpu::DeviceType::IntegratedGpu => GpuDeviceType::IntegratedGpu,
            wgpu::DeviceType::VirtualGpu => GpuDeviceType::VirtualGpu,
            wgpu::DeviceType::Cpu => GpuDeviceType::Cpu,
            _ => GpuDeviceType::Other,
        }
    }

    fn map_backend(b: wgpu::Backend) -> GpuBackend {
        match b {
            wgpu::Backend::Vulkan => GpuBackend::Vulkan,
            wgpu::Backend::Metal => GpuBackend::Metal,
            wgpu::Backend::Dx12 => GpuBackend::Dx12,
            wgpu::Backend::Gl => GpuBackend::Gl,
            wgpu::Backend::BrowserWebGpu => GpuBackend::BrowserWebGpu,
            _ => GpuBackend::Other,
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[tokio::test]
        async fn detects_this_machine() {
            let catalog = Catalog::builtin().unwrap();
            let profile = detect_hardware(catalog, |_| false).await.unwrap();
            assert!(profile.total_ram_bytes > 0);
            assert!(profile.logical_cores >= 1);
            assert!(profile.recommendation.download_bytes > 0);
        }
    }
}

#[cfg(feature = "hardware")]
pub use detect::detect_hardware;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::enums::{EngineKind, GpuBackend};

    fn gpu(t: GpuDeviceType) -> GpuInfo {
        GpuInfo {
            name: "gpu".into(),
            vendor_id: 0x10de,
            device_type: t,
            backend: GpuBackend::Vulkan,
        }
    }

    #[test]
    fn tier_rules() {
        let discrete = [gpu(GpuDeviceType::DiscreteGpu)];
        let integrated = [gpu(GpuDeviceType::IntegratedGpu)];
        // 4 GiB laptop
        assert_eq!(recommend_tier(4 * GIB, 8, &integrated).0, HardwareTier::Eco);
        // "8 GB" machine reporting 7.6 GiB with 4 threads (this dev box) -> Balanced
        let seven_six = 7 * GIB + 6 * GIB / 10;
        assert_eq!(
            recommend_tier(seven_six, 4, &integrated).0,
            HardwareTier::Balanced
        );
        // 8 GiB but dual-core
        assert_eq!(
            recommend_tier(8 * GIB, 2, &[]),
            (HardwareTier::Eco, "onboarding.reason.few_cores")
        );
        // 16 GiB + discrete GPU is not Ultra (needs > 16)
        assert_eq!(
            recommend_tier(16 * GIB, 8, &discrete).0,
            HardwareTier::Balanced
        );
        // 32 GiB without discrete GPU
        assert_eq!(
            recommend_tier(32 * GIB, 16, &integrated),
            (HardwareTier::Balanced, "onboarding.reason.no_discrete_gpu")
        );
        assert_eq!(
            recommend_tier(32 * GIB, 16, &discrete).0,
            HardwareTier::Ultra
        );
    }

    #[test]
    fn recommendation_counts_only_missing_artifacts() {
        let catalog = Catalog::builtin().unwrap();
        let full = build_recommendation(catalog, HardwareTier::Eco, "r", |_| false).unwrap();
        assert_eq!(full.engine, EngineKind::SqliteVec);
        assert_eq!(full.model_id, "multilingual-e5-small");
        assert_eq!(
            full.download_bytes,
            catalog
                .model("multilingual-e5-small")
                .unwrap()
                .spec
                .size_bytes
        );
        let partial = build_recommendation(catalog, HardwareTier::Eco, "r", |p| {
            p.ends_with("model.onnx")
        })
        .unwrap();
        assert!(partial.download_bytes < full.download_bytes);
        let none = build_recommendation(catalog, HardwareTier::Eco, "r", |_| true).unwrap();
        assert_eq!(none.download_bytes, 0);
    }
}
