//! The checks a mod's `mod.json` must pass before the mod can be turned on.
//! The interface reads the declarative parts (themes, layouts, rule packs);
//! the core checks what decides which files run and what they may do.

use std::path::Path;

use serde_json::Value;

use super::folder;

/// The mod API's major version this build runs (API_MAJOR in src/mods/types.ts).
pub const API_MAJOR: u64 = 1;
/// The capabilities a mod may ask for (Capability in src/mods/types.ts).
pub const CAPABILITIES: [&str; 2] = ["files:read", "agents:read"];
/// A mod.json larger than this is refused unread.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// What the core relies on from a manifest that passed the checks.
#[derive(Debug)]
pub struct Checked {
    pub id: String,
    /// The script that runs in a worker, relative to the folder.
    pub main: Option<String>,
    /// HTML files drawn in views.
    pub views: Vec<String>,
    pub permissions: Vec<String>,
}

impl Checked {
    /// Whether any of its code runs: a main script or a view.
    pub fn has_code(&self) -> bool {
        self.main.is_some() || !self.views.is_empty()
    }
}

/// "author.name": lower-case letters, digits and dashes, with one dot.
pub fn is_valid_id(id: &str) -> bool {
    let part = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let mut parts = id.split('.');
    matches!((parts.next(), parts.next(), parts.next()), (Some(a), Some(b), None) if part(a) && part(b))
}

/// Reads `mod.json` from a mod folder, refusing a link or an oversized file.
pub fn read(dir: &Path) -> Result<Value, String> {
    let path = dir.join("mod.json");
    let meta = std::fs::symlink_metadata(&path).map_err(|_| "Its mod.json is missing.".to_string())?;
    if !meta.is_file() {
        return Err("Its mod.json is missing.".into());
    }
    if meta.len() > MAX_MANIFEST_BYTES {
        return Err("Its mod.json is larger than 1 MB.".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read its mod.json: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Its mod.json is not valid JSON: {e}"))
}

/// The id a manifest gives, if it is a valid one.
pub fn id_of(manifest: &Value) -> Option<&str> {
    manifest.get("id").and_then(Value::as_str).filter(|id| is_valid_id(id))
}

/// Checks a parsed manifest against the folder's files (sorted relative paths).
pub fn check(manifest: &Value, files: &[String]) -> Result<Checked, String> {
    let m = manifest.as_object().ok_or("Its mod.json must hold an object.")?;
    let id = match m.get("id") {
        Some(Value::String(id)) if is_valid_id(id) => id.clone(),
        Some(Value::String(id)) => {
            return Err(format!(
                "Its id \"{id}\" must look like author.name: lower-case letters, digits and dashes, with one dot."
            ))
        }
        _ => return Err("Its mod.json has no id.".into()),
    };
    match m.get("api").and_then(Value::as_u64) {
        Some(API_MAJOR) => {}
        Some(other) => return Err(format!("It is made for mod API version {other}; this app runs version {API_MAJOR}.")),
        None => return Err(format!("Its mod.json does not say which mod API it is made for (\"api\": {API_MAJOR}).")),
    }
    if !m.get("name").and_then(Value::as_str).is_some_and(|n| !n.trim().is_empty()) {
        return Err("Its mod.json has no name.".into());
    }
    if !m.get("version").and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty()) {
        return Err("Its mod.json has no version.".into());
    }
    let main = match m.get("main") {
        None | Some(Value::Null) => None,
        Some(Value::String(path)) => {
            in_folder(files, "Its main script", path)?;
            Some(path.clone())
        }
        Some(_) => return Err("Its main must be the path of a script in its folder.".into()),
    };
    let permissions = match m.get("permissions") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(list)) => {
            let mut permissions = Vec::new();
            for p in list {
                match p.as_str() {
                    Some(p) if CAPABILITIES.contains(&p) => permissions.push(p.to_string()),
                    _ => return Err(format!("It asks for a permission this app does not know: {p}.")),
                }
            }
            permissions
        }
        Some(_) => return Err("Its permissions must be a list.".into()),
    };
    let mut views = Vec::new();
    match m.get("contributes").and_then(|c| c.get("views")) {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            for view in list {
                let Some(entry) = view.get("entry").and_then(Value::as_str) else {
                    return Err("Each of its views needs an entry: the HTML file it draws.".into());
                };
                in_folder(files, "Its view", entry)?;
                if !entry.to_ascii_lowercase().ends_with(".html") {
                    return Err(format!("Its view \"{entry}\" must be an .html file."));
                }
                views.push(entry.to_string());
            }
        }
        Some(_) => return Err("Its views must be a list.".into()),
    }
    Ok(Checked { id, main, views, permissions })
}

/// A path from the manifest must name one of the folder's own files.
fn in_folder(files: &[String], what: &str, path: &str) -> Result<(), String> {
    if !folder::is_inside(path) {
        return Err(format!("{what} \"{path}\" must be a path inside its folder, such as \"main.js\"."));
    }
    if files.binary_search_by(|f| f.as_str().cmp(path)).is_err() {
        return Err(format!("{what} \"{path}\" is not in its folder."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn files() -> Vec<String> {
        vec!["main.js".into(), "mod.json".into(), "views/panel.html".into()]
    }

    fn base() -> Value {
        json!({ "id": "ada.clock", "name": "Clock", "version": "1.0.0", "api": 1 })
    }

    fn with(key: &str, value: Value) -> Value {
        let mut m = base();
        m[key] = value;
        m
    }

    fn error(manifest: Value) -> String {
        check(&manifest, &files()).unwrap_err()
    }

    #[test]
    fn ids_look_like_author_and_name() {
        for good in ["ada.clock", "a-1.b-2", "0.0"] {
            assert!(is_valid_id(good), "{good}");
        }
        for bad in ["clock", "Ada.clock", "ada.clock.extra", ".clock", "ada.", "ada_x.clock", "../x.y", "ada.clöck", ""] {
            assert!(!is_valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_plain_manifest_passes() {
        let checked = check(&base(), &files()).unwrap();
        assert_eq!(checked.id, "ada.clock");
        assert!(!checked.has_code());
    }

    #[test]
    fn required_fields_are_checked() {
        assert!(error(json!([])).contains("object"));
        assert!(error(with("id", json!("Clock"))).contains("author.name"));
        assert!(error(with("api", json!(2))).contains("API version 2"));
        assert!(error(with("api", Value::Null)).contains("which mod API"));
        assert!(error(with("version", json!(""))).contains("no version"));
        assert!(error(with("name", json!(" "))).contains("no name"));
        assert!(error(with("permissions", json!(["files:write"]))).contains("does not know"));
    }

    #[test]
    fn code_paths_must_name_files_inside_the_folder() {
        let checked = check(&with("main", json!("main.js")), &files()).unwrap();
        assert_eq!(checked.main.as_deref(), Some("main.js"));
        assert!(checked.has_code());
        for bad in ["../main.js", "/main.js", "views/../main.js", "./main.js"] {
            assert!(error(with("main", json!(bad))).contains("inside its folder"), "{bad}");
        }
        assert!(error(with("main", json!("missing.js"))).contains("not in its folder"));

        let views = |entry: &str| with("contributes", json!({ "views": [{ "id": "p", "title": "P", "entry": entry }] }));
        assert_eq!(check(&views("views/panel.html"), &files()).unwrap().views, vec!["views/panel.html"]);
        assert!(error(views("../panel.html")).contains("inside its folder"));
        assert!(error(views("main.js")).contains(".html"));
    }

    #[test]
    fn permissions_are_known_capabilities() {
        let checked = check(&with("permissions", json!(["files:read", "agents:read"])), &files()).unwrap();
        assert_eq!(checked.permissions, vec!["files:read", "agents:read"]);
    }
}
