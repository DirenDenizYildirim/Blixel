//! The interface's own data: documents (one value per key: settings, a
//! project's screen state) and item lists (chats, tasks), each in a scope,
//! "app" or "project:<id>". Values are JSON the core does not look into.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

/// Longest key, list name or item id, in characters.
const MAX_NAME_CHARS: usize = 200;
/// Largest document and item, as JSON text.
pub const MAX_DOC_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_ITEM_BYTES: usize = 256 * 1024;
/// Most items one call may write, and most a list may keep.
const MAX_ITEMS_PER_CALL: usize = 10_000;
const MAX_KEEP: u32 = 100_000;

/// The schema's steps for `Db::migrate("store", ...)`. Only ever add steps.
pub const SCHEMA: &[&str] = &["
    CREATE TABLE docs (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
    );
    CREATE TABLE items (
        scope TEXT NOT NULL,
        list TEXT NOT NULL,
        id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, list, id)
    );
    CREATE INDEX items_by_seq ON items (scope, list, seq);
    CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        created INTEGER NOT NULL,
        last_opened INTEGER NOT NULL
    );
    CREATE TABLE agents (
        project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        json TEXT NOT NULL,
        mac TEXT NOT NULL,
        session_id TEXT,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        PRIMARY KEY (project_id, agent_id)
    );
", "
    -- The keyed check on a project's name and folder (projects.rs). Rows made
    -- before it have none, so they ask the user to confirm their folder once.
    ALTER TABLE projects ADD COLUMN mac TEXT NOT NULL DEFAULT '';
"];

/// Milliseconds since 1970, as the interface counts time.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn err(e: rusqlite::Error) -> String {
    format!("database: {e}")
}

/// The scope for a project's own data.
pub fn project_scope(project_id: &str) -> String {
    format!("project:{project_id}")
}

/// A scope is "app" or a saved project's. Anything else is refused, so data
/// never lands under a project that does not exist (the demo's included).
pub fn check_scope(conn: &Connection, scope: &str) -> Result<(), String> {
    if scope == "app" {
        return Ok(());
    }
    let Some(id) = scope.strip_prefix("project:") else {
        return Err(format!("Unknown scope “{scope}”: use “app” or “project:<id>”."));
    };
    if id == "demo" {
        return Err("The demo project is not saved.".into());
    }
    let known = conn
        .query_row("SELECT 1 FROM projects WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map_err(err)?;
    known.ok_or_else(|| format!("No saved project has the id “{id}”."))
}

fn check_name(what: &str, name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(format!("The {what} is empty."));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("The {what} is longer than {MAX_NAME_CHARS} characters."));
    }
    Ok(())
}

fn to_text(value: &Value, limit: usize, what: &str) -> Result<String, String> {
    let text = serde_json::to_string(value).map_err(|e| e.to_string())?;
    if text.len() > limit {
        return Err(format!("This {what} is too large to save ({} KB; the limit is {} KB).", text.len() / 1024, limit / 1024));
    }
    Ok(text)
}

// ---- Documents ----

pub fn doc_get(conn: &Connection, scope: &str, key: &str) -> Result<Option<Value>, String> {
    check_scope(conn, scope)?;
    check_name("key", key)?;
    let text: Option<String> = conn
        .query_row("SELECT value FROM docs WHERE scope = ?1 AND key = ?2", (scope, key), |r| r.get(0))
        .optional()
        .map_err(err)?;
    // A value that no longer parses reads as missing rather than breaking the app.
    Ok(text.and_then(|t| serde_json::from_str(&t).ok()))
}

/// Stores a document; None removes it.
pub fn doc_set(conn: &Connection, scope: &str, key: &str, value: Option<&Value>) -> Result<(), String> {
    check_scope(conn, scope)?;
    check_name("key", key)?;
    match value {
        None => conn.execute("DELETE FROM docs WHERE scope = ?1 AND key = ?2", (scope, key)).map_err(err)?,
        Some(value) => {
            let text = to_text(value, MAX_DOC_BYTES, "setting")?;
            conn.execute(
                "INSERT INTO docs (scope, key, value, updated) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated = excluded.updated",
                params![scope, key, text, now()],
            )
            .map_err(err)?
        }
    };
    Ok(())
}

// ---- Item lists ----

/// The newest `limit` items, oldest first.
pub fn items_load(conn: &Connection, scope: &str, list: &str, limit: u32) -> Result<Vec<Value>, String> {
    check_scope(conn, scope)?;
    check_name("list name", list)?;
    let mut stmt = conn
        .prepare(
            "SELECT value FROM (
                 SELECT value, seq FROM items WHERE scope = ?1 AND list = ?2 ORDER BY seq DESC LIMIT ?3
             ) ORDER BY seq ASC",
        )
        .map_err(err)?;
    let texts = stmt
        .query_map(params![scope, list, limit], |r| r.get::<_, String>(0))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    Ok(texts.iter().filter_map(|t| serde_json::from_str(t).ok()).collect())
}

/// Adds or replaces items by id. A replaced item keeps its place; a new one
/// goes after every other. Then only the newest `keep` stay. An item that
/// cannot be stored (too large, or a bad id) is left out, and its id is in
/// the answer, so one oversized chat entry never stops the rest from saving.
pub fn items_put(conn: &mut Connection, scope: &str, list: &str, items: &[(String, Value)], keep: u32) -> Result<Vec<String>, String> {
    check_scope(conn, scope)?;
    check_name("list name", list)?;
    if items.len() > MAX_ITEMS_PER_CALL {
        return Err(format!("Too many items in one save ({}; the limit is {MAX_ITEMS_PER_CALL}).", items.len()));
    }
    let keep = keep.min(MAX_KEEP);
    let mut rows = Vec::with_capacity(items.len());
    let mut refused = Vec::new();
    for (id, value) in items {
        match check_name("item id", id).and_then(|()| to_text(value, MAX_ITEM_BYTES, "item")) {
            Ok(text) => rows.push((id.as_str(), text)),
            Err(e) => {
                eprintln!("left out item {id:.40} of {list:.40}: {e}");
                refused.push(id.clone());
            }
        }
    }
    let tx = conn.transaction().map_err(err)?;
    let mut next: i64 = tx
        .query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM items WHERE scope = ?1 AND list = ?2", (scope, list), |r| r.get(0))
        .map_err(err)?;
    {
        let mut update = tx.prepare("UPDATE items SET value = ?4 WHERE scope = ?1 AND list = ?2 AND id = ?3").map_err(err)?;
        let mut insert = tx
            .prepare("INSERT INTO items (scope, list, id, seq, value) VALUES (?1, ?2, ?3, ?4, ?5)")
            .map_err(err)?;
        for (id, text) in &rows {
            if update.execute(params![scope, list, id, text]).map_err(err)? == 0 {
                insert.execute(params![scope, list, id, next, text]).map_err(err)?;
                next += 1;
            }
        }
    }
    tx.execute(
        "DELETE FROM items WHERE scope = ?1 AND list = ?2 AND seq NOT IN (
             SELECT seq FROM items WHERE scope = ?1 AND list = ?2 ORDER BY seq DESC LIMIT ?3
         )",
        params![scope, list, keep],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(refused)
}

/// Removes the given items, or the whole list when `ids` is None.
pub fn items_delete(conn: &mut Connection, scope: &str, list: &str, ids: Option<&[String]>) -> Result<(), String> {
    check_scope(conn, scope)?;
    check_name("list name", list)?;
    let Some(ids) = ids else {
        conn.execute("DELETE FROM items WHERE scope = ?1 AND list = ?2", (scope, list)).map_err(err)?;
        return Ok(());
    };
    let tx = conn.transaction().map_err(err)?;
    {
        let mut delete = tx.prepare("DELETE FROM items WHERE scope = ?1 AND list = ?2 AND id = ?3").map_err(err)?;
        for id in ids {
            delete.execute((scope, list, id)).map_err(err)?;
        }
    }
    tx.commit().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Db;
    use serde_json::json;

    fn db() -> Db {
        let db = Db::memory();
        db.conn
            .lock()
            .unwrap()
            .execute("INSERT INTO projects (id, name, folder, created, last_opened) VALUES ('p1', 'One', '/one', 1, 1)", [])
            .unwrap();
        db
    }

    fn ids(values: &[Value]) -> Vec<&str> {
        values.iter().map(|v| v["id"].as_str().unwrap()).collect()
    }

    fn item(id: &str, text: &str) -> (String, Value) {
        (id.to_string(), json!({ "id": id, "text": text }))
    }

    #[test]
    fn the_schema_is_made_once() {
        let db = db();
        // Running the steps again changes nothing and fails nothing.
        db.migrate("store", SCHEMA).unwrap();
        let conn = db.conn.lock().unwrap();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(tables, ["agents", "docs", "items", "migrations", "projects"]);
        let steps: i64 = conn.query_row("SELECT COUNT(*) FROM migrations WHERE module = 'store'", [], |r| r.get(0)).unwrap();
        assert_eq!(steps, SCHEMA.len() as i64);
    }

    #[test]
    fn a_later_step_runs_once_on_an_existing_database() {
        let db = db();
        let mut steps = SCHEMA.to_vec();
        steps.push("ALTER TABLE docs ADD COLUMN note TEXT;");
        db.migrate("store", &steps).unwrap();
        db.migrate("store", &steps).unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO docs (scope, key, value, updated, note) VALUES ('app', 'k', '1', 1, 'n')", []).unwrap();
    }

    #[test]
    fn documents_are_set_read_and_removed() {
        let db = db();
        let conn = db.conn.lock().unwrap();
        assert_eq!(doc_get(&conn, "app", "settings").unwrap(), None);
        doc_set(&conn, "app", "settings", Some(&json!({ "v": 1, "editor": { "fontSize": 14 } }))).unwrap();
        doc_set(&conn, "project:p1", "settings", Some(&json!("project's own"))).unwrap();
        assert_eq!(doc_get(&conn, "app", "settings").unwrap(), Some(json!({ "v": 1, "editor": { "fontSize": 14 } })));
        assert_eq!(doc_get(&conn, "project:p1", "settings").unwrap(), Some(json!("project's own")));
        doc_set(&conn, "app", "settings", Some(&json!(2))).unwrap();
        assert_eq!(doc_get(&conn, "app", "settings").unwrap(), Some(json!(2)));
        doc_set(&conn, "app", "settings", None).unwrap();
        assert_eq!(doc_get(&conn, "app", "settings").unwrap(), None);
        assert_eq!(doc_get(&conn, "project:p1", "settings").unwrap(), Some(json!("project's own")));
    }

    #[test]
    fn scopes_names_and_sizes_are_checked() {
        let db = db();
        let conn = db.conn.lock().unwrap();
        for scope in ["", "App", "project:", "project:nope", "project:demo", "projects:p1", "app "] {
            assert!(doc_set(&conn, scope, "k", Some(&json!(1))).is_err(), "{scope:?}");
            assert!(doc_get(&conn, scope, "k").is_err(), "{scope:?}");
            assert!(items_load(&conn, scope, "tasks", 10).is_err(), "{scope:?}");
        }
        assert!(doc_set(&conn, "app", "", Some(&json!(1))).is_err());
        assert!(doc_set(&conn, "app", &"k".repeat(201), Some(&json!(1))).is_err());
        doc_set(&conn, "app", &"k".repeat(200), Some(&json!(1))).unwrap();
        assert!(doc_set(&conn, "app", "big", Some(&json!("x".repeat(MAX_DOC_BYTES)))).is_err());
        doc_set(&conn, "app", "fits", Some(&json!("x".repeat(MAX_DOC_BYTES - 2)))).unwrap();
        drop(conn);
        let mut conn = db.conn.lock().unwrap();
        assert!(items_put(&mut conn, "project:gone", "tasks", &[item("a", "")], 10).is_err());
        assert!(items_put(&mut conn, "app", "", &[item("a", "")], 10).is_err());
        let too_many: Vec<_> = (0..=MAX_ITEMS_PER_CALL).map(|i| item(&i.to_string(), "")).collect();
        assert!(items_put(&mut conn, "app", "tasks", &too_many, 100_000).is_err());
        assert!(items_load(&conn, "app", "tasks", 10).unwrap().is_empty(), "a refused save writes nothing");
    }

    #[test]
    fn items_that_cannot_be_stored_are_left_out_and_the_rest_saved() {
        let db = db();
        let mut conn = db.conn.lock().unwrap();
        items_put(&mut conn, "app", "chat:a", &[item("1", "one"), item("2", "two")], 10).unwrap();
        let big = ("2".to_string(), json!({ "id": "2", "text": "x".repeat(MAX_ITEM_BYTES) }));
        let long_id = "i".repeat(201);
        let batch = [item("3", "three"), big, (String::new(), json!(1)), (long_id.clone(), json!(1)), item("4", "four")];
        let refused = items_put(&mut conn, "app", "chat:a", &batch, 10).unwrap();
        assert_eq!(refused, ["2".to_string(), String::new(), long_id]);
        let all = items_load(&conn, "app", "chat:a", 10).unwrap();
        assert_eq!(ids(&all), ["1", "2", "3", "4"]);
        assert_eq!(all[1]["text"], "two", "the last stored version of a refused item stays");
        assert!(items_put(&mut conn, "app", "chat:a", &[item("5", "five")], 10).unwrap().is_empty());
    }

    #[test]
    fn items_keep_their_place_and_the_newest_stay() {
        let db = db();
        let mut conn = db.conn.lock().unwrap();
        let scope = "project:p1";
        items_put(&mut conn, scope, "chat:a", &[item("1", "one"), item("2", "two"), item("3", "three")], 100).unwrap();
        assert_eq!(ids(&items_load(&conn, scope, "chat:a", 100).unwrap()), ["1", "2", "3"]);

        // Replacing keeps the first position; new ids go last.
        items_put(&mut conn, scope, "chat:a", &[item("4", "four"), item("1", "one, edited")], 100).unwrap();
        let all = items_load(&conn, scope, "chat:a", 100).unwrap();
        assert_eq!(ids(&all), ["1", "2", "3", "4"]);
        assert_eq!(all[0]["text"], "one, edited");

        // Loading takes the newest, oldest first.
        assert_eq!(ids(&items_load(&conn, scope, "chat:a", 2).unwrap()), ["3", "4"]);
        assert!(items_load(&conn, scope, "chat:a", 0).unwrap().is_empty());

        // Trimming drops the oldest.
        items_put(&mut conn, scope, "chat:a", &[item("5", "five")], 3).unwrap();
        assert_eq!(ids(&items_load(&conn, scope, "chat:a", 100).unwrap()), ["3", "4", "5"]);

        // The same id twice in one call is one item with the last value.
        items_put(&mut conn, scope, "chat:a", &[item("6", "a"), item("6", "b")], 100).unwrap();
        let all = items_load(&conn, scope, "chat:a", 100).unwrap();
        assert_eq!(ids(&all), ["3", "4", "5", "6"]);
        assert_eq!(all[3]["text"], "b");

        // Lists and scopes are separate.
        items_put(&mut conn, scope, "chat:b", &[item("1", "b's")], 100).unwrap();
        items_put(&mut conn, "app", "chat:a", &[item("1", "app's")], 100).unwrap();
        assert_eq!(items_load(&conn, scope, "chat:b", 100).unwrap().len(), 1);
        assert_eq!(items_load(&conn, scope, "chat:a", 100).unwrap().len(), 4);

        items_delete(&mut conn, scope, "chat:a", Some(&["4".into(), "missing".into()])).unwrap();
        assert_eq!(ids(&items_load(&conn, scope, "chat:a", 100).unwrap()), ["3", "5", "6"]);
        items_put(&mut conn, scope, "chat:a", &[item("7", "seven")], 100).unwrap();
        assert_eq!(ids(&items_load(&conn, scope, "chat:a", 100).unwrap()), ["3", "5", "6", "7"]);
        items_delete(&mut conn, scope, "chat:a", None).unwrap();
        assert!(items_load(&conn, scope, "chat:a", 100).unwrap().is_empty());
        assert_eq!(items_load(&conn, scope, "chat:b", 100).unwrap().len(), 1, "other lists stay");
    }
}
