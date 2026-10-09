/// Every command the interface may call. Listing them gives the app an ACL
/// manifest, so Tauri checks each call against capabilities/default.json
/// instead of letting any local page call any command.
const COMMANDS: &[&str] = &[
    "open_workspace",
    "list_tree",
    "read_file",
    "write_file",
    "set_api_key",
    "has_api_key",
    "upsert_agent",
    "send_prompt",
    "cancel_turn",
    "answer_permission",
    "mods_heartbeat",
    "mods_list",
    "mods_install",
    "mods_dev_load",
    "mods_uninstall",
    "mods_set_enabled",
    "mod_storage_get",
    "mod_storage_set",
];

fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
