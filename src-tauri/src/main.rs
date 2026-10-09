// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Set before any threads start.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::path::Path::new("/proc/driver/nvidia/version").exists()
    {
        // WebKitGTK's DMA-BUF renderer crashes on NVIDIA drivers under Wayland
        // ("Error 71 (Protocol error) dispatching to Wayland display").
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    // Agents get exactly the key the user stored in Blixel. Other Anthropic
    // credentials in the environment would take precedence over it, and agent
    // commands should not see them either.
    for name in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ] {
        std::env::remove_var(name);
    }
    blixel_lib::run()
}
