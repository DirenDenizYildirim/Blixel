//! Saved agents: each one's settings as the interface sent them, and the
//! last session of its program, to carry on its conversation, both under one
//! keyed check (a changed session id would carry on another conversation).
//! A row that fails its check was changed outside the app: it loads lowered,
//! its agent may not run, and it stays that way, whatever later automatic
//! saves send, until the user reviews it and saves it from the agent's form.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::data::{err, now, project_scope};
use super::mac::{self, UNTRUSTED};
use super::projects;
use crate::agents::settings::AgentConfig;

/// Largest saved agent, as JSON text: instructions and rule packs included.
const MAX_AGENT_BYTES: usize = 1024 * 1024;
const MAX_ID_CHARS: usize = 100;

/// Ids name folders on disk, so they are plain: letters, digits, - and _.
pub fn check_id(what: &str, id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_ID_CHARS || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("A {what}'s id may only use letters, digits, - and _ (at most {MAX_ID_CHARS})."));
    }
    Ok(())
}

/// The app's own folder for a project's agents' programs (their settings and
/// sessions), under the app's data folder; removed with the project.
pub fn project_dir(app_data: &Path, project_id: &str) -> Result<PathBuf, String> {
    check_id("project", project_id)?;
    Ok(app_data.join("projects").join(project_id))
}

pub fn agent_dir(app_data: &Path, project_id: &str, agent_id: &str) -> Result<PathBuf, String> {
    check_id("agent", agent_id)?;
    Ok(project_dir(app_data, project_id)?.join("agents").join(agent_id))
}

/// A saved agent as the interface gets it.
#[derive(Debug)]
pub struct Saved {
    pub agent: Value,
    /// False while its row is untrusted: `agent` is lowered
    /// (`lower_untrusted`) and the agent may not run.
    pub trusted: bool,
}

impl Saved {
    pub fn id(&self) -> &str {
        self.agent["id"].as_str().unwrap_or_default()
    }

    /// The settings the core enforces, for agents that run for real
    /// (scripted placeholders never reach the core).
    pub fn config(&self) -> Option<AgentConfig> {
        if self.agent["placeholder"] == Value::Bool(true) {
            return None;
        }
        serde_json::from_value(self.agent.clone()).ok()
    }

    pub fn to_json(&self) -> Value {
        json!({ "agent": self.agent, "trust": if self.trusted { "ok" } else { "changed-outside" } })
    }
}

/// What the check covers: where the row is, the settings and the session.
fn parts<'a>(project_id: &'a str, agent_id: &'a str, json: &'a str, session: Option<&'a str>) -> [&'a str; 5] {
    ["agent", project_id, agent_id, json, session.unwrap_or("")]
}

/// For settings whose row was changed outside the app: every tool's Allow
/// becomes Ask and every connector Off (as `AgentConfig::lower_untrusted`).
pub fn lower_untrusted(agent: &mut Value) {
    if let Some(map) = agent.get_mut("permissions").and_then(Value::as_object_mut) {
        for setting in map.values_mut() {
            if setting == "allow" {
                *setting = json!("ask");
            }
        }
    }
    if let Some(map) = agent.get_mut("connectors").and_then(Value::as_object_mut) {
        for setting in map.values_mut() {
            *setting = json!("off");
        }
    }
}

struct Row {
    json: String,
    mac: String,
    session: Option<String>,
}

fn row(conn: &Connection, project_id: &str, agent_id: &str) -> Result<Option<Row>, String> {
    conn.query_row(
        "SELECT json, mac, session_id FROM agents WHERE project_id = ?1 AND agent_id = ?2",
        (project_id, agent_id),
        |r| Ok(Row { json: r.get(0)?, mac: r.get(1)?, session: r.get(2)? }),
    )
    .optional()
    .map_err(err)
}

/// Whether the row passes its check. A row that fails is marked untrusted,
/// so it stays so even if it is changed back. An unreadable key is an error:
/// nothing is marked for good because the keychain was locked.
fn passes(conn: &Connection, project_id: &str, agent_id: &str, row: &Row) -> Result<bool, String> {
    if mac::check(&parts(project_id, agent_id, &row.json, row.session.as_deref()), &row.mac)? {
        return Ok(true);
    }
    if row.mac != UNTRUSTED {
        conn.execute("UPDATE agents SET mac = ?3 WHERE project_id = ?1 AND agent_id = ?2", (project_id, agent_id, UNTRUSTED))
            .map_err(err)?;
    }
    Ok(false)
}

/// Saves an agent's settings. Its id comes from `agent`; its first save time
/// stays. A new agent, a trusted row, or a save the user `reviewed` (the
/// agent form's own Save) is signed and trusted. Any other save of an
/// untrusted row keeps it untrusted and lowered, so the interface's automatic
/// saves never trust settings the user has not looked at.
///
/// The session stays only on a row that passes its check: after a review the
/// agent starts a new conversation, since its saved session was not part of
/// what the user saw.
pub fn save(conn: &mut Connection, project_id: &str, agent: &Value, reviewed: bool) -> Result<Saved, String> {
    projects::get(conn, project_id)?;
    let agent_id = agent["id"].as_str().ok_or("This agent has no id.")?;
    check_id("agent", agent_id)?;
    let tx = conn.transaction().map_err(err)?;
    let existing = row(&tx, project_id, agent_id)?;
    let passed = match &existing {
        Some(row) => passes(&tx, project_id, agent_id, row).map_err(|e| format!("Cannot save this agent: {e}"))?,
        None => true,
    };
    let trusted = reviewed || passed;
    let mut agent = agent.clone();
    if !trusted {
        lower_untrusted(&mut agent);
    }
    let text = serde_json::to_string(&agent).map_err(|e| e.to_string())?;
    if text.len() > MAX_AGENT_BYTES {
        return Err(format!("This agent's settings are too large to save ({} KB).", text.len() / 1024));
    }
    let session = existing.and_then(|row| row.session).filter(|_| passed);
    let mac = if trusted {
        mac::sign(&parts(project_id, agent_id, &text, session.as_deref())).map_err(|e| format!("Cannot save this agent: {e}"))?
    } else {
        UNTRUSTED.to_string()
    };
    tx.execute(
        "INSERT INTO agents (project_id, agent_id, json, mac, session_id, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (project_id, agent_id) DO UPDATE SET
             json = excluded.json, mac = excluded.mac, session_id = excluded.session_id, updated = excluded.updated",
        params![project_id, agent_id, text, mac, session, now()],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(Saved { agent, trusted })
}

/// A project's agents in the order they were made, each checked.
pub fn load(conn: &Connection, project_id: &str) -> Result<Vec<Saved>, String> {
    projects::get(conn, project_id)?;
    let mut stmt = conn
        .prepare("SELECT agent_id, json, mac, session_id FROM agents WHERE project_id = ?1 ORDER BY created, rowid")
        .map_err(err)?;
    let rows = stmt
        .query_map([project_id], |r| Ok((r.get::<_, String>(0)?, Row { json: r.get(1)?, mac: r.get(2)?, session: r.get(3)? })))
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err)?;
    let mut saved = Vec::with_capacity(rows.len());
    for (agent_id, row) in rows {
        let Ok(mut agent) = serde_json::from_str::<Value>(&row.json) else {
            eprintln!("skipped saved agent {agent_id}: its settings do not parse");
            continue;
        };
        // The id inside must be the row's, or a row could stand in for another agent.
        if !agent.is_object() || agent["id"] != Value::String(agent_id.clone()) {
            eprintln!("skipped saved agent {agent_id}: its settings are not an agent's");
            continue;
        }
        // Without the key nothing can be checked: lowered for now, not marked.
        let trusted = passes(conn, project_id, &agent_id, &row).unwrap_or(false);
        if !trusted {
            lower_untrusted(&mut agent);
        }
        // Nothing runs yet when a project opens; live status comes in events.
        agent["status"] = json!("idle");
        saved.push(Saved { agent, trusted });
    }
    Ok(saved)
}

/// Forgets an agent and its chat. Its tasks stay (they are flagged by the interface).
pub fn remove(conn: &mut Connection, project_id: &str, agent_id: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(err)?;
    tx.execute("DELETE FROM agents WHERE project_id = ?1 AND agent_id = ?2", (project_id, agent_id)).map_err(err)?;
    tx.execute(
        "DELETE FROM items WHERE scope = ?1 AND list = ?2",
        (project_scope(project_id), format!("chat:{agent_id}")),
    )
    .map_err(err)?;
    tx.commit().map_err(err)
}

/// Where an agent's program starts from.
#[derive(Debug, PartialEq)]
pub enum Resume {
    /// A new conversation: nothing saved to carry on from.
    Fresh,
    /// Carry on this session.
    Session(String),
    /// The row fails its check (changed outside the app since it loaded):
    /// the agent may not run until the user reviews it.
    Changed,
}

/// The agent's last session, from a row that still passes its check.
pub fn resume(conn: &Connection, project_id: &str, agent_id: &str) -> Result<Resume, String> {
    let Some(row) = row(conn, project_id, agent_id)? else { return Ok(Resume::Fresh) };
    if !passes(conn, project_id, agent_id, &row)? {
        return Ok(Resume::Changed);
    }
    Ok(row.session.filter(|s| !s.is_empty()).map_or(Resume::Fresh, Resume::Session))
}

/// Remembers the agent's session, signed with the rest of a trusted row; an
/// untrusted row stays untrusted. An agent not saved yet has nowhere to keep it.
pub fn set_session(conn: &mut Connection, project_id: &str, agent_id: &str, session_id: &str) -> Result<(), String> {
    if session_id.is_empty() || session_id.len() > 200 {
        return Err("unexpected session id".into());
    }
    let tx = conn.transaction().map_err(err)?;
    let Some(row) = row(&tx, project_id, agent_id)? else { return Ok(()) };
    let mac = if passes(&tx, project_id, agent_id, &row)? {
        mac::sign(&parts(project_id, agent_id, &row.json, Some(session_id)))?
    } else {
        UNTRUSTED.to_string()
    };
    tx.execute(
        "UPDATE agents SET session_id = ?3, mac = ?4 WHERE project_id = ?1 AND agent_id = ?2",
        (project_id, agent_id, session_id, mac),
    )
    .map_err(err)?;
    tx.commit().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Db;

    pub fn agent(id: &str, name: &str) -> Value {
        json!({
            "id": id,
            "name": name,
            "role": "",
            "avatarStyle": "classic",
            "hue": null,
            "runsOn": "api-key",
            "program": "claude-code",
            "model": "sonnet",
            "effort": "medium",
            "instructions": "Be careful.",
            "readNotes": true,
            "permissions": { "read": "allow", "edit": "allow", "run": "ask", "commit": "off", "push": "off" },
            "editPaths": "",
            "rulePacks": [{ "modId": "m", "packId": "p", "label": "Docs", "instructions": "", "editArea": "docs/**", "protect": [], "hash": "h" }],
            "connectors": { "c1": "allow", "c2": "ask" },
            "canMessage": false,
            "takesTasks": true,
            "canGiveTo": [],
            "typingSpeed": 12,
            "dailyLimit": "",
            "whenIdle": "wait",
            "status": "working",
            "placeholder": false
        })
    }

    fn db_with_projects() -> Db {
        let db = Db::memory();
        let conn = db.conn.lock().unwrap();
        for id in ["p1", "p2"] {
            conn.execute(
                "INSERT INTO projects (id, name, folder, created, last_opened) VALUES (?1, ?1, ?2, 1, 1)",
                (id, format!("/{id}")),
            )
            .unwrap();
        }
        drop(conn);
        db
    }

    #[test]
    fn agents_are_saved_listed_and_removed() {
        let db = db_with_projects();
        let mut conn = db.conn.lock().unwrap();
        save(&mut conn, "p1", &agent("a1", "Ada"), false).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        save(&mut conn, "p1", &agent("b2", "Bo"), false).unwrap();
        save(&mut conn, "p2", &agent("a1", "Ada elsewhere"), false).unwrap();

        let saved = load(&conn, "p1").unwrap();
        assert_eq!(saved.iter().map(Saved::id).collect::<Vec<_>>(), ["a1", "b2"], "in the order they were made");
        assert!(saved.iter().all(|s| s.trusted), "new agents are trusted");
        assert_eq!(saved[0].agent["permissions"]["edit"], "allow");
        assert_eq!(saved[0].agent["status"], "idle");
        let config = saved[0].config().unwrap();
        assert_eq!((config.id.as_str(), config.rule_packs.len(), config.connectors.len()), ("a1", 1, 2));
        assert_eq!(saved[0].to_json()["trust"], "ok");

        // Saving again keeps its place and its session, still trusted.
        assert_eq!(resume(&conn, "p1", "a1").unwrap(), Resume::Fresh);
        set_session(&mut conn, "p1", "a1", "s-1").unwrap();
        let again = save(&mut conn, "p1", &agent("a1", "Ada renamed"), false).unwrap();
        assert!(again.trusted);
        let saved = load(&conn, "p1").unwrap();
        assert!(saved[0].trusted);
        assert_eq!(saved[0].agent["name"], "Ada renamed");
        assert_eq!(resume(&conn, "p1", "a1").unwrap(), Resume::Session("s-1".into()));
        assert_eq!(resume(&conn, "p2", "a1").unwrap(), Resume::Fresh, "projects are separate");
        assert_eq!(resume(&conn, "p1", "nobody").unwrap(), Resume::Fresh);
        set_session(&mut conn, "p1", "nobody", "s-2").unwrap();
        assert_eq!(load(&conn, "p2").unwrap()[0].agent["name"], "Ada elsewhere");

        // Placeholders are saved, but never reach the core.
        let mut scripted = agent("c3", "Scripted");
        scripted["placeholder"] = json!(true);
        save(&mut conn, "p1", &scripted, false).unwrap();
        assert!(load(&conn, "p1").unwrap()[2].config().is_none());

        // Removing takes its chat with it, and nothing of other agents or projects.
        let chat = |id: &str| (id.to_string(), json!({ "id": id }));
        crate::store::data::items_put(&mut conn, "project:p1", "chat:a1", &[chat("1")], 10).unwrap();
        crate::store::data::items_put(&mut conn, "project:p1", "chat:b2", &[chat("1")], 10).unwrap();
        crate::store::data::items_put(&mut conn, "project:p2", "chat:a1", &[chat("1")], 10).unwrap();
        remove(&mut conn, "p1", "a1").unwrap();
        assert_eq!(load(&conn, "p1").unwrap().iter().map(Saved::id).collect::<Vec<_>>(), ["b2", "c3"]);
        assert!(crate::store::data::items_load(&conn, "project:p1", "chat:a1", 10).unwrap().is_empty());
        assert_eq!(crate::store::data::items_load(&conn, "project:p1", "chat:b2", 10).unwrap().len(), 1);
        assert_eq!(crate::store::data::items_load(&conn, "project:p2", "chat:a1", 10).unwrap().len(), 1);
        assert_eq!(load(&conn, "p2").unwrap().len(), 1);
    }

    fn json_of(conn: &Connection, agent_id: &str) -> String {
        conn.query_row("SELECT json FROM agents WHERE agent_id = ?1", [agent_id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_row_changed_outside_the_app_is_lowered_until_reviewed() {
        let db = db_with_projects();
        let mut conn = db.conn.lock().unwrap();
        save(&mut conn, "p1", &agent("a1", "Ada"), false).unwrap();
        save(&mut conn, "p1", &agent("b2", "Bo"), false).unwrap();

        // Something with write access to the database gives itself Run.
        let text = json_of(&conn, "a1");
        let tampered = text.replace(r#""run":"ask""#, r#""run":"allow""#);
        assert_ne!(text, tampered);
        conn.execute("UPDATE agents SET json = ?1 WHERE agent_id = 'a1'", [&tampered]).unwrap();

        let saved = load(&conn, "p1").unwrap();
        let (a, b) = (&saved[0], &saved[1]);
        assert!(!a.trusted);
        assert_eq!(a.to_json()["trust"], "changed-outside");
        assert_eq!(a.agent["permissions"], json!({ "read": "ask", "edit": "ask", "run": "ask", "commit": "off", "push": "off" }));
        assert_eq!(a.agent["connectors"], json!({ "c1": "off", "c2": "off" }), "every connector is off");
        let config = a.config().unwrap();
        assert_eq!(config.permissions.run, crate::agents::settings::Setting::Ask);
        assert_eq!(config.connectors["c1"], crate::agents::settings::Setting::Off);
        assert!(b.trusted, "the other agent is untouched");
        assert_eq!(b.agent["permissions"]["edit"], "allow");

        // Marked: changing it back does not trust it again.
        conn.execute("UPDATE agents SET json = ?1 WHERE agent_id = 'a1'", [&text]).unwrap();
        assert!(!load(&conn, "p1").unwrap()[0].trusted, "still untrusted");
        assert_eq!(resume(&conn, "p1", "a1").unwrap(), Resume::Changed);

        // An automatic save (a model list arriving, say) stores the new
        // settings, lowered, and keeps the row untrusted.
        let mut automatic = agent("a1", "Ada");
        automatic["model"] = json!("opus");
        let kept = save(&mut conn, "p1", &automatic, false).unwrap();
        assert!(!kept.trusted);
        assert_eq!(kept.to_json()["trust"], "changed-outside");
        assert_eq!(kept.agent["permissions"]["edit"], "ask");
        let saved = load(&conn, "p1").unwrap();
        assert!(!saved[0].trusted);
        assert_eq!((saved[0].agent["model"].as_str(), saved[0].agent["permissions"]["read"].as_str()), (Some("opus"), Some("ask")));
        // Nor does a session arriving meanwhile.
        set_session(&mut conn, "p1", "a1", "s-9").unwrap();
        assert!(!load(&conn, "p1").unwrap()[0].trusted);

        // Only the user's reviewed save trusts it again, with a new conversation.
        let mut reviewed = agent("a1", "Ada");
        reviewed["permissions"]["run"] = json!("allow");
        let trusted = save(&mut conn, "p1", &reviewed, true).unwrap();
        assert!(trusted.trusted);
        let saved = load(&conn, "p1").unwrap();
        assert!(saved[0].trusted);
        assert_eq!((saved[0].agent["permissions"]["run"].as_str(), saved[0].agent["connectors"]["c1"].as_str()), (Some("allow"), Some("allow")));
        assert_eq!(resume(&conn, "p1", "a1").unwrap(), Resume::Fresh, "the unchecked session is gone");
        // Later automatic saves keep it trusted.
        assert!(save(&mut conn, "p1", &reviewed, false).unwrap().trusted);
    }

    #[test]
    fn a_changed_session_or_place_fails_the_check() {
        let db = db_with_projects();
        let mut conn = db.conn.lock().unwrap();
        save(&mut conn, "p1", &agent("a1", "Ada"), false).unwrap();
        save(&mut conn, "p1", &agent("b2", "Bo"), false).unwrap();
        set_session(&mut conn, "p1", "a1", "s-1").unwrap();
        assert_eq!(resume(&conn, "p1", "a1").unwrap(), Resume::Session("s-1".into()));

        // Another conversation's id, put in by something outside the app.
        conn.execute("UPDATE agents SET session_id = 'someone-else' WHERE agent_id = 'a1'", []).unwrap();
        assert_eq!(resume(&conn, "p1", "a1").unwrap(), Resume::Changed);
        assert!(!load(&conn, "p1").unwrap()[0].trusted);

        // A row copied to another project fails too.
        conn.execute("UPDATE agents SET project_id = 'p2' WHERE agent_id = 'b2'", []).unwrap();
        assert!(!load(&conn, "p2").unwrap()[0].trusted, "moved to another project");
        // A row whose id inside differs from its key is not loaded at all.
        save(&mut conn, "p1", &agent("c3", "Cy"), false).unwrap();
        conn.execute("UPDATE agents SET json = replace(json, '\"id\":\"c3\"', '\"id\":\"zz\"') WHERE agent_id = 'c3'", []).unwrap();
        assert_eq!(load(&conn, "p1").unwrap().iter().map(Saved::id).collect::<Vec<_>>(), ["a1"]);
        // A check written in without the key does not pass either.
        conn.execute("UPDATE agents SET mac = 'ab' WHERE agent_id = 'a1'", []).unwrap();
        assert!(!load(&conn, "p1").unwrap()[0].trusted);
    }

    #[test]
    fn bad_ids_and_unknown_projects_are_refused() {
        let db = db_with_projects();
        let mut conn = db.conn.lock().unwrap();
        for id in ["", "../x", "a/b", "a b", "é"] {
            assert!(save(&mut conn, "p1", &agent(id, "X"), true).is_err(), "{id:?}");
        }
        assert!(save(&mut conn, "nope", &agent("a1", "X"), true).is_err());
        assert!(save(&mut conn, "demo", &agent("a1", "X"), true).unwrap_err().contains("demo"));
        assert!(load(&conn, "nope").is_err());
        assert!(project_dir(Path::new("/data"), "../etc").is_err());
        assert_eq!(agent_dir(Path::new("/data"), "p1", "a1").unwrap(), Path::new("/data/projects/p1/agents/a1"));
    }
}
