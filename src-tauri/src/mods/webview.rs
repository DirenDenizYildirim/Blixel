//! The app's own webview, set up for mods. Linux (WebKitGTK) only so far;
//! mods need this checked on other systems before they ship there.
//!
//! - WebKit opens connections that no content policy covers: `<link
//!   rel="preconnect">` and DNS prefetching reach any host, so a mod view
//!   could spell data into host names. Those features are turned off. The
//!   webview's network also goes through a proxy that refuses everything (but
//!   the dev server in development), in case WebKit adds another; the proxy
//!   alone does not stop DNS prefetching, so the features stay off as well.
//! - A mod page must never become the window's own page (navigation.rs).
//!   WebKit does not say which frame a navigation is for, but it does say
//!   when the window's page starts loading: mod files are refused until that
//!   page has committed, and if a page other than the app commits, the window
//!   goes back to the app.
//! - A crash of the web process is noted, so the exit does not count as clean.
//!
//! Runs from setup, right after the window is created and before the main
//! loop runs again, so before the app's page or any mod has loaded.

use tauri::{Runtime, Url, WebviewWindow};

#[cfg(target_os = "linux")]
pub fn prepare<R: Runtime>(window: &WebviewWindow<R>, dev_url: Option<Url>) -> tauri::Result<()> {
    use tauri::Manager;
    let app = window.app_handle().clone();
    window.with_webview(move |webview| linux::prepare(&webview.inner(), app, dev_url))
}

#[cfg(not(target_os = "linux"))]
pub fn prepare<R: Runtime>(_window: &WebviewWindow<R>, _dev_url: Option<Url>) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::{c_char, CStr};

    use tauri::{AppHandle, Manager, Runtime, Url};
    use webkit2gtk::glib::ffi::{gboolean, GFALSE};
    use webkit2gtk::glib::object::ObjectType;
    use webkit2gtk::{
        LoadEvent, NetworkProxyMode, NetworkProxySettings, SettingsExt, WebProcessTerminationReason, WebView, WebViewExt,
        WebsiteDataManagerExt,
    };

    use super::super::{navigation, Mods};

    /// WebKit features that reach the network outside any content policy.
    const NETWORK_FEATURES: [&str; 5] =
        ["LinkPreconnect", "LinkPreconnectEarlyHints", "LinkDNSPrefetch", "LinkPrefetch", "SpeculationRulesPrefetch"];

    /// A port below 1024, which normally only the system can listen on: a
    /// connection is refused at once (or, with the old discard service
    /// running, swallowed).
    const REFUSING_PROXY: &str = "http://127.0.0.1:9";

    #[repr(C)]
    struct FeatureList {
        _private: [u8; 0],
    }

    #[repr(C)]
    struct Feature {
        _private: [u8; 0],
    }

    // The feature API (WebKitGTK 2.42) is newer than the webkit2gtk crate.
    extern "C" {
        fn webkit_settings_get_all_features() -> *mut FeatureList;
        fn webkit_feature_list_get_length(list: *mut FeatureList) -> usize;
        fn webkit_feature_list_get(list: *mut FeatureList, index: usize) -> *mut Feature;
        fn webkit_feature_list_unref(list: *mut FeatureList);
        fn webkit_feature_get_identifier(feature: *mut Feature) -> *const c_char;
        fn webkit_settings_set_feature_enabled(
            settings: *mut webkit2gtk::ffi::WebKitSettings,
            feature: *mut Feature,
            enabled: gboolean,
        );
    }

    pub fn prepare<R: Runtime>(webview: &WebView, app: AppHandle<R>, dev_url: Option<Url>) {
        if let Some(settings) = WebViewExt::settings(webview) {
            // Deprecated and covered by LinkDNSPrefetch on current WebKit; older ones may still read it.
            settings.set_enable_dns_prefetching(false);
            for name in turn_off(&settings) {
                eprintln!("WebKit has no feature {name} to turn off");
            }
        } else {
            eprintln!("cannot reach the webview's settings: link preconnect and DNS prefetching stay on");
        }

        if let Some(data) = webview.website_data_manager() {
            let exempt: Vec<&str> = dev_url.as_ref().and_then(Url::host_str).into_iter().collect();
            let mut proxy = NetworkProxySettings::new(Some(REFUSING_PROXY), &exempt);
            data.set_network_proxy_settings(NetworkProxyMode::Custom, Some(&mut proxy));
        }

        let window_app = app.clone();
        webview.connect_load_changed(move |webview, event| {
            let Some(mods) = window_app.try_state::<Mods>() else { return };
            match event {
                LoadEvent::Started => mods.set_window_loading(true),
                LoadEvent::Committed => {
                    mods.set_window_loading(false);
                    let uri = webview.uri().map(|uri| uri.to_string()).unwrap_or_default();
                    let on_app = Url::parse(&uri).is_ok_and(|url| navigation::is_app(&url, dev_url.as_ref()));
                    if !on_app && webview.can_go_back() {
                        eprintln!("the window left the app for {uri}; going back");
                        webview.go_back();
                    }
                }
                LoadEvent::Finished => mods.set_window_loading(false),
                _ => {}
            }
        });

        webview.connect_web_process_terminated(move |_, reason| {
            if !matches!(reason, WebProcessTerminationReason::TerminatedByApi) {
                if let Some(mods) = app.try_state::<Mods>() {
                    mods.page_crashed();
                }
            }
        });
    }

    /// Turns NETWORK_FEATURES off; returns those this WebKit does not have.
    fn turn_off(settings: &webkit2gtk::Settings) -> Vec<&'static str> {
        let mut missing = NETWORK_FEATURES.to_vec();
        // SAFETY: the list is ours until unref'd, and its features live as long as it does.
        unsafe {
            let list = webkit_settings_get_all_features();
            if list.is_null() {
                return missing;
            }
            for i in 0..webkit_feature_list_get_length(list) {
                let feature = webkit_feature_list_get(list, i);
                if feature.is_null() {
                    continue;
                }
                let id = webkit_feature_get_identifier(feature);
                if id.is_null() {
                    continue;
                }
                let id = CStr::from_ptr(id).to_bytes();
                if let Some(at) = missing.iter().position(|name| name.as_bytes() == id) {
                    webkit_settings_set_feature_enabled(settings.as_ptr(), feature, GFALSE);
                    missing.remove(at);
                }
            }
            webkit_feature_list_unref(list);
        }
        missing
    }
}
