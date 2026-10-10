mod agents;
mod connectors;
mod events;
mod mods;
mod rules;
mod secrets;
mod store;
mod workspace;

/// Starts this app's binary as the stand-in agent instead of the app (debug
/// builds only): `stand_in::main`, which `main.rs` runs when this is the first
/// argument.
pub const STAND_IN_FLAG: &str = "--stand-in-agent";
#[cfg(debug_assertions)]
pub mod stand_in;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // In development the window loads from the dev server, so frames may too.
    let dev_url = if tauri::is_dev() { context.config().build.dev_url.clone() } else { None };
    // `--no-mods` starts a session in which no mod runs.
    let no_mods = std::env::args().skip(1).any(|arg| arg == "--no-mods");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(mods::navigation::guard(dev_url.clone()))
        .register_asynchronous_uri_scheme_protocol(mods::scheme::SCHEME, mods::scheme::handle)
        .manage(workspace::Workspace::default())
        .setup({
            let dev_url = dev_url.clone();
            move |app| {
                use tauri::Manager;
                let hub = std::sync::Arc::new(connectors::Hub::default());
                hub.attach(app.handle().clone());
                let db = store::DbRef::App(app.handle().clone());
                app.manage(agents::Agents::new(events::Events::new(app.handle().clone()), hub.clone(), Some(db)));
                // Agents at their daily limit may work again once the day turns. Woken at
                // least every quarter hour, so a changed clock or a suspend is noticed too.
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let most = std::time::Duration::from_secs(15 * 60);
                    loop {
                        tokio::time::sleep(agents::usage::until_tomorrow().unwrap_or(most).min(most)).await;
                        handle.state::<agents::Agents>().refresh_limited();
                    }
                });
                app.manage(hub);
                // A broken or busy database never stops the app: see `store_status`.
                let (db, status) = store::Db::open_or_recover(&app.path().app_data_dir()?);
                app.manage(db);
                app.manage(status);
                app.manage(mods::Mods::open(app.path().app_data_dir()?, no_mods));
                // The window from tauri.conf.json exists by now; its page has not loaded yet.
                let window = app.get_webview_window("main").ok_or("the main window is missing")?;
                mods::webview::prepare(&window, dev_url)?;
                Ok(())
            }
        })
        // App commands answer only the app's own page, never a mod's.
        .invoke_handler(mods::navigation::app_only(dev_url, tauri::generate_handler![
            workspace::open_workspace,
            workspace::list_tree,
            workspace::read_file,
            workspace::write_file,
            secrets::set_api_key,
            secrets::has_api_key,
            agents::upsert_agent,
            agents::send_prompt,
            agents::cancel_turn,
            agents::answer_permission,
            mods::mods_heartbeat,
            mods::mods_list,
            mods::mods_install,
            mods::mods_dev_load,
            mods::mods_uninstall,
            mods::mods_set_enabled,
            mods::mod_storage_get,
            mods::mod_storage_set,
            store::store_status,
            store::store_get,
            store::store_set,
            store::items_load,
            store::items_put,
            store::items_delete,
            store::projects_list,
            store::project_create,
            store::project_for_folder,
            store::project_open,
            store::project_close,
            store::project_update,
            store::project_remove,
            store::files_measure,
            store::files_copy_in,
            agents::agent_save,
            agents::agents_list,
            agents::agent_remove,
            agents::usage_today,
            agents::usage_days,
            connectors::connectors_list,
            connectors::connector_save,
            connectors::connector_remove,
            connectors::connector_set_secret,
            connectors::connector_test,
            connectors::connector_approve,
        ]))
        .build(context)
        .expect("error while building tauri application");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            use tauri::Manager;
            if let Some(mods) = app.try_state::<mods::Mods>() {
                mods.exit();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::Manager;

    fn call(cmd: &str, url: &str) -> InvokeRequest {
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.parse().unwrap(),
            body: InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        }
    }

    /// The app's ACL (build.rs and capabilities/default.json) lets the main
    /// window call app commands and nothing else.
    #[test]
    fn commands_are_allowed_for_the_main_window_only() {
        let app = mock_builder()
            .manage(super::workspace::Workspace::default())
            .invoke_handler(tauri::generate_handler![super::workspace::list_tree, super::secrets::has_api_key])
            .build(tauri::generate_context!())
            .unwrap();
        let main = match app.get_webview_window("main") {
            Some(w) => w,
            None => tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap(),
        };
        let other = tauri::WebviewWindowBuilder::new(&app, "other", Default::default()).build().unwrap();
        let local = if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" };

        let ran = get_ipc_response(&main, call("list_tree", local));
        assert_eq!(ran.unwrap_err(), "no folder is open", "the command ran");
        let refused = get_ipc_response(&other, call("list_tree", local)).unwrap_err().to_string();
        assert!(refused.contains("not allowed"), "{refused}");
        let remote = get_ipc_response(&main, call("list_tree", "https://example.com")).unwrap_err().to_string();
        assert!(remote.contains("not allowed"), "{remote}");
    }

    /// Tauri treats the `mod` scheme as the app and gives whatever page the
    /// window shows the invoke key, so app commands check the page themselves.
    #[test]
    fn app_commands_answer_only_the_apps_own_page() {
        let context = tauri::generate_context!();
        let dev_url = if tauri::is_dev() { context.config().build.dev_url.clone() } else { None };
        let app = mock_builder()
            .manage(super::workspace::Workspace::default())
            .invoke_handler(super::mods::navigation::app_only(dev_url, tauri::generate_handler![super::workspace::list_tree]))
            .build(context)
            .unwrap();
        let main = match app.get_webview_window("main") {
            Some(w) => w,
            None => tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap(),
        };
        let local = if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" };
        assert_eq!(get_ipc_response(&main, call("list_tree", local)).unwrap_err(), "no folder is open", "the command ran");

        main.navigate("mod://localhost/ada.clock/views/panel.html".parse().unwrap()).unwrap();
        let refused = get_ipc_response(&main, call("list_tree", local)).unwrap_err().to_string();
        assert!(refused.contains("list_tree is open only to the app's own page"), "{refused}");
    }
}
