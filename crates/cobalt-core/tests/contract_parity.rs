//! Drift guard between the Rust contracts and their TypeScript mirror
//! (`src/types/contracts.ts`) plus the bundled theme manifest.

use cobalt_core::config::AppSettings;
use cobalt_core::enums::*;
use cobalt_core::theme::ThemeManifest;

const TS: &str = include_str!("../../../src/types/contracts.ts");
const IPC_RS: &str = include_str!("../src/ipc.rs");
const EVENTS_RS: &str = include_str!("../src/events.rs");
const MINIMAL_THEME: &str = include_str!("../../../src/themes/minimal/manifest.json");

fn assert_literals(name: &str, literals: impl IntoIterator<Item = &'static str>) {
    for lit in literals {
        assert!(
            TS.contains(&format!("\"{lit}\"")),
            "{name} literal \"{lit}\" missing in contracts.ts"
        );
    }
}

#[test]
fn enum_literals_exist_in_typescript() {
    assert_literals("SourceType", SourceType::ALL.iter().map(|v| v.as_str()));
    assert_literals(
        "MemoryCategory",
        MemoryCategory::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals("MemoryStatus", MemoryStatus::ALL.iter().map(|v| v.as_str()));
    assert_literals("EdgeType", EdgeType::ALL.iter().map(|v| v.as_str()));
    assert_literals(
        "TelemetryOperation",
        TelemetryOperation::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals("HardwareTier", HardwareTier::ALL.iter().map(|v| v.as_str()));
    assert_literals("EngineKind", EngineKind::ALL.iter().map(|v| v.as_str()));
    assert_literals(
        "EmbeddingProvider",
        EmbeddingProvider::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals("Quantization", Quantization::ALL.iter().map(|v| v.as_str()));
    assert_literals(
        "TokenEncoding",
        TokenEncoding::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals("Language", Language::ALL.iter().map(|v| v.as_str()));
    assert_literals(
        "FileAvailability",
        FileAvailability::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals("LayoutType", LayoutType::ALL.iter().map(|v| v.as_str()));
    assert_literals("WriteAction", WriteAction::ALL.iter().map(|v| v.as_str()));
    assert_literals("AiClient", AiClient::ALL.iter().map(|v| v.as_str()));
    assert_literals(
        "GpuDeviceType",
        GpuDeviceType::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals("GpuBackend", GpuBackend::ALL.iter().map(|v| v.as_str()));
    assert_literals(
        "DownloadPhase",
        DownloadPhase::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals("EngineState", EngineState::ALL.iter().map(|v| v.as_str()));
    assert_literals(
        "EngineSwapPhase",
        EngineSwapPhase::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals("CheckStatus", CheckStatus::ALL.iter().map(|v| v.as_str()));
    assert_literals(
        "ThemeCompatibility",
        ThemeCompatibility::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals(
        "PastLifeSource",
        PastLifeSource::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals(
        "MemoryChangeKind",
        MemoryChangeKind::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals(
        "DuplicateKind",
        DuplicateKind::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals(
        "SemanticEdgesMode",
        SemanticEdgesMode::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals(
        "ClusterSizeMetric",
        ClusterSizeMetric::ALL.iter().map(|v| v.as_str()),
    );
    assert_literals("NodeShape", NodeShape::ALL.iter().map(|v| v.as_str()));
    assert_literals("ConfigFormat", ConfigFormat::ALL.iter().map(|v| v.as_str()));
    assert_literals("McpTransport", McpTransport::ALL.iter().map(|v| v.as_str()));
}

fn string_consts(source: &str) -> Vec<String> {
    source
        .lines()
        .filter(|l| l.trim_start().starts_with("pub const") && l.contains("&str = \""))
        .filter_map(|l| l.split('"').nth(1).map(str::to_owned))
        .collect()
}

#[test]
fn every_ipc_command_is_in_the_typescript_map() {
    let commands = string_consts(IPC_RS);
    assert!(
        commands.len() > 60,
        "unexpectedly few commands parsed: {}",
        commands.len()
    );
    for cmd in commands {
        assert!(
            TS.contains(&format!("  {cmd}: {{ args:")),
            "IPC command `{cmd}` missing in IpcCommandMap"
        );
    }
}

#[test]
fn every_event_is_in_the_typescript_map() {
    let events = string_consts(EVENTS_RS);
    assert_eq!(events.len(), 8);
    for ev in events {
        assert!(
            TS.contains(&format!("\"{ev}\": ")),
            "event `{ev}` missing in EventPayloadMap"
        );
    }
}

fn collect_keys(value: &serde_json::Value, out: &mut Vec<String>) {
    if let serde_json::Value::Object(map) = value {
        for (k, v) in map {
            out.push(k.clone());
            collect_keys(v, out);
        }
    }
}

#[test]
fn app_settings_fields_exist_in_typescript() {
    let json = serde_json::to_value(AppSettings::default()).unwrap();
    let mut keys = Vec::new();
    collect_keys(&json, &mut keys);
    for key in keys {
        assert!(
            TS.contains(&format!("  {key}: ")),
            "AppSettings field `{key}` missing in contracts.ts"
        );
    }
}

#[test]
fn builtin_theme_manifest_parses() {
    let manifest: ThemeManifest = serde_json::from_str(MINIMAL_THEME).unwrap();
    assert_eq!(manifest.id, cobalt_core::config::BUILTIN_THEME_ID);
    assert_eq!(manifest.hardware_tier, HardwareTier::Eco);
    assert_eq!(manifest.layout_type, LayoutType::Galaxy);
    assert!(manifest.mesh_path.is_none());
}

#[test]
fn default_models_match_typescript() {
    use cobalt_core::engine::{
        PRO_ENGLISH_MODELS, default_engine_for_tier, default_model_for_tier,
    };
    for tier in HardwareTier::ALL {
        let model = default_model_for_tier(*tier);
        let engine = default_engine_for_tier(*tier);
        assert!(
            TS.contains(&format!("  {}: \"{model}\",", tier.as_str())),
            "default model for {tier} differs in contracts.ts"
        );
        assert!(
            TS.contains(&format!("  {}: \"{}\",", tier.as_str(), engine.as_str())),
            "default engine for {tier} differs in contracts.ts"
        );
    }
    for m in PRO_ENGLISH_MODELS {
        assert!(
            TS.contains(&format!("\"{m}\"")),
            "Pro model {m} missing in contracts.ts"
        );
    }
}
