//! The `mod` URI scheme: serves an enabled mod's own files to the sandboxed
//! frames its code runs in. Every response carries a CSP that confines the
//! frame to that one mod's files, with no network and no nested frames.
//! Only the app's main webview may load it, and an installed mod's files only
//! as approved.
//!
//! Paths are `/<id>/<file>`; `/<id>/__host/<file>` is the app's own frame
//! code and fonts. The id is in the path, not the host, because Windows
//! rewrites `mod://x` to `http://mod.x`.

use std::borrow::Cow;

use base64::Engine;
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use super::{folder, Mods, Served};

pub const SCHEME: &str = "mod";

/// The host frame code (src/mods/runtime/frame/) and its fonts, built in.
const LOGIC_JS: &str = include_str!("../../../src/mods/runtime/frame/logic.js");
const VIEW_JS: &str = include_str!("../../../src/mods/runtime/frame/view.js");
const BASE_CSS: &str = include_str!("../../../src/mods/runtime/frame/base.css");
const FONT_400: &[u8] = include_bytes!("../../../node_modules/@fontsource/fira-code/files/fira-code-latin-400-normal.woff2");
const FONT_600: &[u8] = include_bytes!("../../../node_modules/@fontsource/fira-code/files/fira-code-latin-600-normal.woff2");

/// The host every mod URL uses: `mod://localhost`, or `http://mod.localhost` on Windows.
fn host() -> &'static str {
    if cfg!(windows) {
        "mod.localhost"
    } else {
        "localhost"
    }
}

/// Where a mod's files are served from, ending in `/`.
pub fn base_url(id: &str) -> String {
    if cfg!(windows) {
        format!("http://{}/{id}/", host())
    } else {
        format!("{SCHEME}://{}/{id}/", host())
    }
}

/// The policy for every file of one mod, `base` being its base URL. Scripts,
/// styles, images, fonts and media only from that mod; workers only from
/// blobs (its main script runs in one); no network, frames, forms or base
/// changes.
pub fn csp(base: &str) -> String {
    format!(
        "default-src 'none'; script-src {base}; style-src {base} 'unsafe-inline'; img-src {base} data: blob:; \
         font-src {base} data:; media-src {base}; worker-src blob:; connect-src 'none'; frame-src 'none'; \
         form-action 'none'; base-uri 'none'"
    )
}

pub fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Puts the host's stylesheet and view script into a mod's HTML page, right
/// after its `<head>` tag; without one, after its doctype (so the page keeps
/// standards mode), or else at the very start.
pub fn inject(html: &str, id: &str) -> String {
    let tags = format!(r#"<link rel="stylesheet" href="/{id}/__host/base.css"><script src="/{id}/__host/view.js"></script>"#);
    let at = head_end(html).unwrap_or_else(|| doctype_end(html));
    format!("{}{tags}{}", &html[..at], &html[at..])
}

/// Just after the first `<head>` or `<head ...>` tag, if any.
fn head_end(html: &str) -> Option<usize> {
    // ASCII lower-casing keeps every byte offset the same.
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<head") {
        let after = from + i + "<head".len();
        match lower.as_bytes().get(after) {
            Some(b'>') => return Some(after + 1),
            Some(c) if c.is_ascii_whitespace() || *c == b'/' => return lower[after..].find('>').map(|j| after + j + 1),
            _ => from = after, // <header>, <heading>
        }
    }
    None
}

fn doctype_end(html: &str) -> usize {
    let lead = html.len() - html.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']).len();
    if html[lead..].to_ascii_lowercase().starts_with("<!doctype") {
        if let Some(end) = html[lead..].find('>') {
            return lead + end + 1;
        }
    }
    0
}

/// The page a mod's main script runs from: the script travels inside it as
/// base64 data (never run there), and the host's logic.js starts it in a worker.
pub fn logic_html(id: &str, main: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(main);
    format!(
        r#"<!doctype html><meta charset="utf-8"><script id="main" type="application/octet-stream">{encoded}</script><script src="/{id}/__host/logic.js"></script>"#
    )
}

/// Answers a request from a webview. File reads happen off the main thread.
pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    // Only the app's own window draws mods.
    if ctx.webview_label() != "main" {
        responder.respond(refused(StatusCode::FORBIDDEN));
        return;
    }
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let response = match app.try_state::<Mods>() {
            Some(mods) => respond(&mods, &request),
            None => refused(StatusCode::NOT_FOUND),
        };
        responder.respond(response);
    });
}

pub fn respond(mods: &Mods, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    if request.method() != Method::GET {
        return refused(StatusCode::METHOD_NOT_ALLOWED);
    }
    if request.uri().host() != Some(host()) {
        return refused(StatusCode::FORBIDDEN);
    }
    // Mod pages are drawn only inside frames, never as the window's own page.
    // While that page loads, a request may be for it, so none is answered
    // (webview.rs; Linux only).
    if mods.window_loading() {
        return refused(StatusCode::FORBIDDEN);
    }
    // Webviews that say what a request is for are refused a mod page as the
    // window's page here too. WebKitGTK does not send this header, so on
    // Linux this check does nothing; the one above does the work there.
    if request.headers().get("sec-fetch-dest").is_some_and(|dest| dest == "document") {
        return refused(StatusCode::FORBIDDEN);
    }
    let Some(parts) = split_path(request.uri().path()) else { return refused(StatusCode::NOT_FOUND) };
    let Some((id, rest)) = parts.split_first() else { return refused(StatusCode::NOT_FOUND) };
    let Some(served) = mods.served(id) else { return refused(StatusCode::NOT_FOUND) };
    let file = match rest {
        [host, name] if host == "__host" => host_file(mods, id, &served, name),
        _ => mod_file(mods, id, &served, rest),
    };
    match file {
        Some((body, kind)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, kind)
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(header::CONTENT_SECURITY_POLICY, csp(&base_url(id)))
            // A dev mod's files change while its author works on it.
            .header(header::CACHE_CONTROL, "no-store")
            // Frames have an opaque origin, and fonts load with CORS. The CSP
            // already keeps each mod's frames to that mod's own files.
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(body)
            .expect("valid response"),
        None => refused(StatusCode::NOT_FOUND),
    }
}

/// base.css with the font inlined. WebKitGTK does not treat custom schemes as
/// CORS-enabled, and font loads from a sandboxed (opaque-origin) frame are CORS
/// requests, so a font file URL would be refused there; `font-src` allows data:.
fn base_css() -> &'static str {
    static CSS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CSS.get_or_init(|| {
        let data = |font: &[u8]| {
            format!("data:font/woff2;base64,{}", base64::engine::general_purpose::STANDARD.encode(font))
        };
        BASE_CSS
            .replace("url(\"fira-code-400.woff2\")", &format!("url(\"{}\")", data(FONT_400)))
            .replace("url(\"fira-code-600.woff2\")", &format!("url(\"{}\")", data(FONT_600)))
    })
}

/// The app's own files under `/<id>/__host/`.
fn host_file(mods: &Mods, id: &str, served: &Served, name: &str) -> Option<(Cow<'static, [u8]>, &'static str)> {
    let fixed: &'static [u8] = match name {
        "logic.js" => LOGIC_JS.as_bytes(),
        "view.js" => VIEW_JS.as_bytes(),
        "base.css" => base_css().as_bytes(),
        "fira-code-400.woff2" => FONT_400,
        "fira-code-600.woff2" => FONT_600,
        "logic.html" => {
            let main = served.main.as_ref()?;
            let parts: Vec<String> = main.split('/').map(str::to_string).collect();
            let script = read_mod_file(mods, id, served, &parts)?;
            return Some((Cow::Owned(logic_html(id, &script).into_bytes()), content_type(name)));
        }
        _ => return None,
    };
    Some((Cow::Borrowed(fixed), content_type(name)))
}

/// One of the mod's own files; HTML pages get the host's tags.
fn mod_file(mods: &Mods, id: &str, served: &Served, parts: &[String]) -> Option<(Cow<'static, [u8]>, &'static str)> {
    let name = parts.last()?;
    let bytes = read_mod_file(mods, id, served, parts)?;
    let body = if name.to_ascii_lowercase().ends_with(".html") {
        inject(&String::from_utf8_lossy(&bytes), id).into_bytes()
    } else {
        bytes
    };
    Some((Cow::Owned(body), content_type(name)))
}

/// Reads a file of the mod, if it is there and may be served as it is now
/// (an installed mod's files must be as approved: Mods::may_serve).
fn read_mod_file(mods: &Mods, id: &str, served: &Served, parts: &[String]) -> Option<Vec<u8>> {
    let path = folder::resolve(&served.dir, parts)?;
    let bytes = read_limited(&path)?;
    mods.may_serve(id, served, &path, &bytes).then_some(bytes)
}

/// Reads a file no larger than a whole mod may be (a dev mod can grow after its check).
fn read_limited(path: &std::path::Path) -> Option<Vec<u8>> {
    if std::fs::metadata(path).ok()?.len() > folder::MAX_BYTES {
        return None;
    }
    std::fs::read(path).ok()
}

/// The decoded parts of a request path, or None if any part is not plain.
fn split_path(path: &str) -> Option<Vec<String>> {
    let parts: Option<Vec<String>> = path.strip_prefix('/')?.split('/').map(percent_decode).collect();
    parts.filter(|parts| parts.iter().all(|p| folder::is_part(p)))
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn refused(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'")
        .body(Cow::Borrowed(&[][..]))
        .expect("valid response")
}

#[cfg(test)]
mod tests {
    use super::super::folder::tests::{temp_dir, write};
    use super::*;

    const MANIFEST: &str = r#"{ "id": "ada.clock", "name": "Clock", "version": "1.0.0", "api": 1,
        "main": "main.js", "contributes": { "views": [{ "id": "p", "title": "P", "entry": "views/panel.html" }] } }"#;

    fn enabled_mod(name: &str) -> Mods {
        let source = temp_dir(&format!("{name}-src"));
        write(&source, "mod.json", MANIFEST);
        write(&source, "main.js", "host.log('hi')");
        write(&source, "views/panel.html", "<!doctype html><html><head><title>P</title></head><body>P</body></html>");
        write(&source, "views/style.css", "p{}");
        let mods = Mods::open(temp_dir(&format!("{name}-data")), false);
        mods.install(source.to_str().unwrap()).unwrap();
        mods.set_enabled("ada.clock", true, vec![]).unwrap();
        mods
    }

    fn get(mods: &Mods, url: &str) -> Response<Cow<'static, [u8]>> {
        respond(mods, &Request::builder().uri(url).body(Vec::new()).unwrap())
    }

    fn url(path: &str) -> String {
        format!("{}{path}", base_url("ada.clock"))
    }

    fn text(response: &Response<Cow<'static, [u8]>>) -> String {
        String::from_utf8_lossy(response.body()).into_owned()
    }

    #[test]
    fn the_policy_confines_a_mod_to_its_own_files() {
        let policy = csp("mod://localhost/ada.clock/");
        assert!(policy.starts_with("default-src 'none'; script-src mod://localhost/ada.clock/;"));
        for part in [
            "style-src mod://localhost/ada.clock/ 'unsafe-inline'",
            "img-src mod://localhost/ada.clock/ data: blob:",
            "font-src mod://localhost/ada.clock/ data:",
            "worker-src blob:",
            "connect-src 'none'",
            "frame-src 'none'",
            "form-action 'none'",
            "base-uri 'none'",
        ] {
            assert!(policy.contains(part), "{part}");
        }
        assert!(policy.ends_with("form-action 'none'; base-uri 'none'"));
        assert!(!policy.contains("unsafe-eval"));
        let base = base_url("ada.clock");
        assert!(base == "mod://localhost/ada.clock/" || base == "http://mod.localhost/ada.clock/");
    }

    #[test]
    fn content_types_follow_the_extension() {
        assert_eq!(content_type("a/b.HTML"), "text/html; charset=utf-8");
        assert_eq!(content_type("x.mjs"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("f.woff2"), "font/woff2");
        assert_eq!(content_type("photo.JPEG"), "image/jpeg");
        assert_eq!(content_type("data.bin"), "application/octet-stream");
        assert_eq!(content_type("README"), "application/octet-stream");
    }

    #[test]
    fn host_tags_go_after_the_head_tag() {
        let tags = r#"<link rel="stylesheet" href="/a.b/__host/base.css"><script src="/a.b/__host/view.js"></script>"#;
        assert_eq!(inject("<html><HEAD lang=x><title>t</title>", "a.b"), format!("<html><HEAD lang=x>{tags}<title>t</title>"));
        assert_eq!(inject("<header>h</header><head>", "a.b"), format!("<header>h</header><head>{tags}"));
        assert_eq!(inject("<!DOCTYPE html>\n<p>no head</p>", "a.b"), format!("<!DOCTYPE html>{tags}\n<p>no head</p>"));
        assert_eq!(inject("<p>bare</p>", "a.b"), format!("{tags}<p>bare</p>"));
        assert_eq!(inject("<heading>", "a.b"), format!("{tags}<heading>"));
    }

    #[test]
    fn the_logic_page_carries_the_main_script_as_data() {
        let page = logic_html("a.b", b"</script><script>alert(1)</script>");
        assert!(page.starts_with(r#"<!doctype html><meta charset="utf-8"><script id="main" type="application/octet-stream">"#));
        assert!(page.ends_with(r#"</script><script src="/a.b/__host/logic.js"></script>"#));
        assert_eq!(page.matches("</script>").count(), 2, "the script cannot close its tag");
        assert!(page.contains("PC9zY3JpcHQ+"), "base64 of the script");
    }

    #[test]
    fn serves_an_enabled_mods_files_with_the_policy() {
        let mods = enabled_mod("serve");
        let page = get(&mods, &url("views/panel.html"));
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(page.headers()["content-type"], "text/html; charset=utf-8");
        assert_eq!(page.headers()["x-content-type-options"], "nosniff");
        assert_eq!(page.headers()["content-security-policy"], csp(&base_url("ada.clock")).as_str());
        assert!(text(&page).contains(r#"<head><link rel="stylesheet" href="/ada.clock/__host/base.css">"#));

        let css = get(&mods, &url("views/style.css"));
        assert_eq!((css.status(), text(&css).as_str()), (StatusCode::OK, "p{}"), "only HTML is changed");

        // Webviews do not pass the fragment on; were one sent, it changes nothing.
        assert_eq!(get(&mods, &url("views/style.css#k=0123abcd")).status(), StatusCode::OK);

        let logic = get(&mods, &url("__host/logic.html"));
        assert_eq!(logic.status(), StatusCode::OK);
        let encoded = base64::engine::general_purpose::STANDARD.encode("host.log('hi')");
        assert!(text(&logic).contains(&encoded));
        assert_eq!(get(&mods, &url("__host/fira-code-400.woff2")).headers()["content-type"], "font/woff2");
        assert_eq!(get(&mods, &url("__host/logic.js")).status(), StatusCode::OK);
        assert_eq!(get(&mods, &url("__host/other.js")).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn refuses_anything_else() {
        let mods = enabled_mod("refuse");
        for path in ["../ada.clock/main.js", "%2e%2e/%2e%2e/etc/passwd", "views/..%2fmain.js", "views/%2e%2e/main.js", "missing.js", "views", ""] {
            assert_eq!(get(&mods, &url(path)).status(), StatusCode::NOT_FOUND, "{path}");
        }
        let other_host = url("main.js").replacen("localhost", "evil", 1);
        assert_eq!(get(&mods, &other_host).status(), StatusCode::FORBIDDEN);
        assert_eq!(get(&mods, &url("main.js").replacen("ada.clock", "other.mod", 1)).status(), StatusCode::NOT_FOUND);

        let post = Request::builder().method(Method::POST).uri(url("main.js")).body(Vec::new()).unwrap();
        assert_eq!(respond(&mods, &post).status(), StatusCode::METHOD_NOT_ALLOWED);
        let top = Request::builder().uri(url("views/panel.html")).header("sec-fetch-dest", "document").body(Vec::new()).unwrap();
        assert_eq!(respond(&mods, &top).status(), StatusCode::FORBIDDEN);

        // Nothing while the window's own page loads: the request may be for it.
        mods.set_window_loading(true);
        assert_eq!(get(&mods, &url("views/panel.html")).status(), StatusCode::FORBIDDEN);
        mods.set_window_loading(false);
        assert_eq!(get(&mods, &url("views/panel.html")).status(), StatusCode::OK);

        // Once turned off, nothing of it is served.
        mods.set_enabled("ada.clock", false, vec![]).unwrap();
        assert_eq!(get(&mods, &url("views/panel.html")).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn the_font_is_inlined_into_base_css() {
        let css = base_css();
        assert_eq!(css.matches("url(\"data:font/woff2;base64,").count(), 2, "both weights");
        assert!(!css.contains("fira-code-400.woff2") && !css.contains("fira-code-600.woff2"));
    }

    #[test]
    fn serves_an_installed_mods_files_only_as_approved() {
        let mods = enabled_mod("approved");
        let dir = mods.served("ada.clock").unwrap().dir;
        assert_eq!(get(&mods, &url("views/style.css")).status(), StatusCode::OK);
        // A missing file is only missing.
        assert_eq!(get(&mods, &url("views/missing.css")).status(), StatusCode::NOT_FOUND);
        assert!(mods.served("ada.clock").is_some());

        // Its main script changed while it ran (an agent with Run, say).
        write(&dir, "main.js", "host.log('injected')");
        assert_eq!(get(&mods, &url("__host/logic.html")).status(), StatusCode::NOT_FOUND);
        // Nothing of it is served any more, and the next list shows it changed.
        assert_eq!(get(&mods, &url("views/style.css")).status(), StatusCode::NOT_FOUND);
        let record = mods.list().mods.into_iter().find(|r| r.id == "ada.clock").unwrap();
        assert!(record.changed && !record.enabled);

        // Approved again, it is served; a file added since is not.
        mods.set_enabled("ada.clock", true, vec![]).unwrap();
        assert_eq!(get(&mods, &url("__host/logic.html")).status(), StatusCode::OK);
        write(&dir, "views/extra.js", "added");
        assert_eq!(get(&mods, &url("views/extra.js")).status(), StatusCode::NOT_FOUND);
        assert!(mods.served("ada.clock").is_none());
    }

    #[test]
    fn serves_a_dev_mod_as_it_is_now() {
        let source = temp_dir("dev-scheme-src");
        write(&source, "mod.json", MANIFEST);
        write(&source, "main.js", "host.log('hi')");
        write(&source, "views/panel.html", "<p>P</p>");
        let mods = Mods::open(temp_dir("dev-scheme-data"), false);
        mods.dev_load(source.to_str().unwrap()).unwrap();
        mods.set_enabled("ada.clock", true, vec![]).unwrap();
        write(&source, "views/new.css", "p{}");
        assert_eq!(get(&mods, &url("views/new.css")).status(), StatusCode::OK);
        write(&source, "main.js", "host.log('edited')");
        let encoded = base64::engine::general_purpose::STANDARD.encode("host.log('edited')");
        assert!(text(&get(&mods, &url("__host/logic.html"))).contains(&encoded));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_links_added_after_approval() {
        let mods = enabled_mod("links");
        let dir = mods.served("ada.clock").unwrap().dir;
        std::os::unix::fs::symlink("/etc/hostname", dir.join("host.txt")).unwrap();
        assert_eq!(get(&mods, &url("host.txt")).status(), StatusCode::NOT_FOUND);
    }
}
