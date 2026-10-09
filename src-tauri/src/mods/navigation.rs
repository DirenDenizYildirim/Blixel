//! Keeps every frame in the window on the app itself or on mod files. A mod
//! frame that tries to open an outside page, or any other URL, is stopped.
//!
//! The window's own page must be the app. Tauri's navigation handler cannot
//! tell the window's page from a frame (neither can WebKitGTK's), so this
//! guard lets mod pages through for both. Two other checks keep a mod page
//! from acting as the window's page: app commands answer only the app's page
//! (`app_only`), and on Linux mod files are refused while the window's page
//! loads, and a page other than the app sends the window back (webview.rs).

use tauri::ipc::Invoke;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

/// `dev_url` is the dev server the window loads from in development, if any.
pub fn guard<R: Runtime>(dev_url: Option<Url>) -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(move |_, url| {
            let ok = allowed(url, dev_url.as_ref());
            if !ok {
                eprintln!("navigation refused: {url}");
            }
            ok
        })
        .build()
}

/// Wraps the app's command handler so that every app command is refused
/// unless the webview that calls it shows the app's own page. Tauri treats
/// any custom scheme as the app, and gives whatever page the window shows
/// the key that commands need, so a mod page that became the window's page
/// could otherwise call them.
pub fn app_only<R: Runtime>(
    dev_url: Option<Url>,
    commands: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let on_app = invoke.message.webview_ref().url().is_ok_and(|url| is_app(&url, dev_url.as_ref()));
        if !on_app {
            let command = invoke.message.command().to_string();
            eprintln!("command refused, the window is not on the app: {command}");
            invoke.resolver.reject(format!("{command} is open only to the app's own page."));
            return true;
        }
        commands(invoke)
    }
}

pub fn allowed(url: &Url, dev_url: Option<&Url>) -> bool {
    is_app(url, dev_url) || is_mod_file(url) || (url.scheme() == "about" && matches!(url.path(), "blank" | "srcdoc"))
}

/// The app's own page: `tauri://localhost` on Linux and macOS,
/// `http(s)://tauri.localhost` on Windows, or the dev server in development.
pub fn is_app(url: &Url, dev_url: Option<&Url>) -> bool {
    let plain_port = url.port().is_none();
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")) => plain_port,
        _ => dev_url.is_some_and(|dev| {
            url.scheme() == dev.scheme()
                && url.host_str() == dev.host_str()
                && url.port_or_known_default() == dev.port_or_known_default()
        }),
    }
}

/// A mod's file: `mod://localhost` on Linux and macOS, `http(s)://mod.localhost` on Windows.
fn is_mod_file(url: &Url) -> bool {
    let plain_port = url.port().is_none();
    matches!((url.scheme(), url.host_str()), ("mod", Some("localhost")) | ("http" | "https", Some("mod.localhost"))) && plain_port
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(url: &str, dev: Option<&str>) -> bool {
        let dev = dev.map(|d| Url::parse(d).unwrap());
        allowed(&Url::parse(url).unwrap(), dev.as_ref())
    }

    fn app(url: &str, dev: Option<&str>) -> bool {
        let dev = dev.map(|d| Url::parse(d).unwrap());
        is_app(&Url::parse(url).unwrap(), dev.as_ref())
    }

    #[test]
    fn frames_stay_on_the_app_and_mod_files() {
        for url in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "mod://localhost/ada.clock/views/panel.html",
            "http://mod.localhost/ada.clock/__host/logic.html",
            // Frames carry a one-time key in the fragment.
            "mod://localhost/ada.clock/__host/logic.html#k=0123abcd",
            "http://mod.localhost/ada.clock/view.html#k=0123abcd",
            "about:blank",
            "about:srcdoc",
        ] {
            assert!(ok(url, None), "{url}");
        }
        for url in [
            "https://example.com/",
            "http://localhost:1420/",
            "mod://evil/ada.clock/a.html",
            "mod://localhost:8080/ada.clock/a.html",
            "http://mod.localhost.example.com/",
            "http://tauri.localhost:8080/",
            "data:text/html,<p>",
            "blob:mod://localhost/1234",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "about:config",
            "ipc://localhost/cmd",
        ] {
            assert!(!ok(url, None), "{url}");
        }
    }

    #[test]
    fn the_dev_server_is_allowed_in_development() {
        assert!(ok("http://localhost:1420/", Some("http://localhost:1420")));
        assert!(ok("http://localhost:1420/src/main.tsx", Some("http://localhost:1420")));
        assert!(!ok("http://localhost:1421/", Some("http://localhost:1420")));
        assert!(!ok("https://localhost:1420/", Some("http://localhost:1420")));
    }

    #[test]
    fn only_the_app_itself_may_use_app_commands() {
        for url in ["tauri://localhost/", "tauri://localhost/a.html?x#y", "http://tauri.localhost/", "https://tauri.localhost/"] {
            assert!(app(url, None), "{url}");
        }
        assert!(app("http://localhost:1420/", Some("http://localhost:1420")), "the dev server in development");
        for url in [
            "mod://localhost/ada.clock/views/panel.html",
            "http://mod.localhost/ada.clock/views/panel.html",
            "about:blank",
            "about:srcdoc",
            "tauri://evil/",
            "tauri://localhost:1/",
            "http://localhost:1420/",
            "https://example.com/",
            "data:text/html,<p>",
            "blob:tauri://localhost/1234",
        ] {
            assert!(!app(url, None), "{url}");
        }
        assert!(!app("mod://localhost/ada.clock/a.html", Some("http://localhost:1420")));
        assert!(!app("http://localhost:1421/", Some("http://localhost:1420")));
    }
}
