//! What agents spend: one row per project, agent and day (the computer's
//! local calendar day, "YYYY-MM-DD"), added to as each agent's program
//! reports its cost. The daily limit is checked against these rows. Rows stay
//! when an agent is removed (the money was spent); they go with the project.

use std::collections::HashMap;
use std::sync::MutexGuard;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::data::err;
use super::Db;

/// The schema's steps for `Db::migrate("usage", ...)`. Only ever add steps.
const STEPS: [&str; 1] = ["CREATE TABLE usage (
    project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    day TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, agent_id, day)
);"];

fn lock(db: &Db) -> Result<MutexGuard<'_, Connection>, String> {
    db.migrate("usage", &STEPS)?;
    db.lock()
}

/// Adds to an agent's spend for `day`, counting `turns` more turns that
/// reported a cost, and returns the day's total.
pub fn add(db: &Db, project_id: &str, agent_id: &str, day: &str, usd: f64, turns: i64) -> Result<f64, String> {
    let conn = lock(db)?;
    conn.query_row(
        "INSERT INTO usage (project_id, agent_id, day, cost_usd, turns) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (project_id, agent_id, day) DO UPDATE SET
             cost_usd = cost_usd + excluded.cost_usd, turns = turns + excluded.turns
         RETURNING cost_usd",
        params![project_id, agent_id, day, usd, turns],
        |r| r.get(0),
    )
    .map_err(err)
}

/// What an agent spent on `day`.
pub fn spent(db: &Db, project_id: &str, agent_id: &str, day: &str) -> Result<f64, String> {
    let conn = lock(db)?;
    let usd: Option<f64> = conn
        .query_row(
            "SELECT cost_usd FROM usage WHERE project_id = ?1 AND agent_id = ?2 AND day = ?3",
            (project_id, agent_id, day),
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    Ok(usd.unwrap_or(0.0))
}

/// What each of a project's agents spent on `day`; agents that spent nothing are missing.
pub fn day_totals(db: &Db, project_id: &str, day: &str) -> Result<HashMap<String, f64>, String> {
    let conn = lock(db)?;
    let mut stmt = conn.prepare("SELECT agent_id, cost_usd FROM usage WHERE project_id = ?1 AND day = ?2").map_err(err)?;
    let rows = stmt.query_map((project_id, day), |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

/// One agent's spend on one day.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    pub day: String,
    pub agent_id: String,
    pub usd: f64,
    pub turns: i64,
}

/// A project's rows from `first_day` on, oldest first.
pub fn since(db: &Db, project_id: &str, first_day: &str) -> Result<Vec<Day>, String> {
    let conn = lock(db)?;
    let mut stmt = conn
        .prepare("SELECT day, agent_id, cost_usd, turns FROM usage WHERE project_id = ?1 AND day >= ?2 ORDER BY day, agent_id")
        .map_err(err)?;
    let rows = stmt
        .query_map((project_id, first_day), |r| Ok(Day { day: r.get(0)?, agent_id: r.get(1)?, usd: r.get(2)?, turns: r.get(3)? }))
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        let db = Db::memory();
        for id in ["p1", "p2"] {
            db.lock()
                .unwrap()
                .execute("INSERT INTO projects (id, name, folder, created, last_opened) VALUES (?1, ?1, ?2, 1, 1)", (id, format!("/{id}")))
                .unwrap();
        }
        db
    }

    #[test]
    fn spend_adds_up_per_project_agent_and_day() {
        let db = db();
        assert_eq!(add(&db, "p1", "a", "2026-10-10", 0.25, 1).unwrap(), 0.25);
        assert!((add(&db, "p1", "a", "2026-10-10", 0.5, 1).unwrap() - 0.75).abs() < 1e-9);
        add(&db, "p1", "a", "2026-10-11", 0.1, 1).unwrap();
        add(&db, "p1", "b", "2026-10-10", 2.0, 3).unwrap();
        add(&db, "p2", "a", "2026-10-10", 9.0, 1).unwrap();

        assert!((spent(&db, "p1", "a", "2026-10-10").unwrap() - 0.75).abs() < 1e-9);
        assert_eq!(spent(&db, "p1", "a", "2026-10-11").unwrap(), 0.1, "a new day starts from nothing");
        assert_eq!(spent(&db, "p1", "a", "2026-10-12").unwrap(), 0.0);
        assert_eq!(spent(&db, "p1", "nobody", "2026-10-10").unwrap(), 0.0);
        let totals = day_totals(&db, "p1", "2026-10-10").unwrap();
        assert_eq!(totals.len(), 2);
        assert!((totals["a"] - 0.75).abs() < 1e-9 && totals["b"] == 2.0, "{totals:?}");

        let days = since(&db, "p1", "2026-10-10").unwrap();
        assert_eq!(days.iter().map(|d| (d.day.as_str(), d.agent_id.as_str(), d.turns)).collect::<Vec<_>>(), [
            ("2026-10-10", "a", 2),
            ("2026-10-10", "b", 3),
            ("2026-10-11", "a", 1)
        ]);
        assert_eq!(since(&db, "p1", "2026-10-11").unwrap().len(), 1);

        // Unknown projects keep nothing, and a removed project takes its rows with it.
        assert!(add(&db, "nope", "a", "2026-10-10", 1.0, 1).is_err());
        db.lock().unwrap().execute("DELETE FROM projects WHERE id = 'p2'", []).unwrap();
        assert_eq!(spent(&db, "p2", "a", "2026-10-10").unwrap(), 0.0);
    }
}
