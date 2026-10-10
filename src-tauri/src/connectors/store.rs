//! Connector records in the app's database, each with a keyed check so a
//! record changed by anything but the app (an agent's command, say) is
//! noticed. Secret values live in the keychain, never in a row.

use crate::store::Db;

use super::model::{Connector, Transport, Trust};

/// Secret values, kept apart so tests need no keychain.
pub trait Keys: Send + Sync {
    fn secret(&self, name: &str) -> Result<Option<String>, String>;
    /// None removes it.
    fn set_secret(&self, name: &str, value: Option<&str>) -> Result<(), String>;
}

/// The system keychain.
pub struct Keychain;

impl Keys for Keychain {
    fn secret(&self, name: &str) -> Result<Option<String>, String> {
        crate::secrets::get(name)
    }

    fn set_secret(&self, name: &str, value: Option<&str>) -> Result<(), String> {
        match value {
            Some(v) => crate::secrets::set(name, v),
            None => crate::secrets::delete(name),
        }
    }
}

const STEPS: [&str; 1] = ["CREATE TABLE connectors (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    template TEXT,
    created INTEGER NOT NULL,
    transport TEXT NOT NULL,
    approved_hash TEXT,
    mac TEXT NOT NULL
);"];

fn lock(db: &Db) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, String> {
    db.migrate("connectors", &STEPS)?;
    db.conn.lock().map_err(|_| "database lock poisoned".to_string())
}

/// What the keyed check covers: the whole row as stored.
fn signed_text(c: &Connector, transport: &str) -> String {
    serde_json::json!([c.slug, c.name, c.template, c.created, transport, c.approved_hash]).to_string()
}

fn sign(c: &Connector, transport: &str) -> Result<String, String> {
    crate::store::mac::sign(&["connector", &c.id, &signed_text(c, transport)])
}

fn verify(c: &Connector, transport: &str, mac: &str) -> bool {
    crate::store::mac::verify(&["connector", &c.id, &signed_text(c, transport)], mac)
}

pub fn load_all(db: &Db) -> Result<Vec<Connector>, String> {
    let conn = lock(db)?;
    let mut stmt = conn
        .prepare("SELECT id, slug, name, template, created, transport, approved_hash, mac FROM connectors ORDER BY created, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, String>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (id, slug, name, template, created, transport_text, approved_hash, mac) = row.map_err(|e| e.to_string())?;
        // A row whose transport no longer reads is skipped, not fatal for the others.
        let Ok(transport) = serde_json::from_str::<Transport>(&transport_text) else {
            eprintln!("blixel: connector {id} has an unreadable transport");
            continue;
        };
        let mut c = Connector { id, slug, name, template, created, transport, approved_hash, trust: Trust::Ok };
        if !verify(&c, &transport_text, &mac) {
            c.trust = Trust::ChangedOutside;
            c.approved_hash = None;
        }
        out.push(c);
    }
    Ok(out)
}

/// Inserts or replaces a record, signing it.
pub fn put(db: &Db, c: &Connector) -> Result<(), String> {
    let transport = serde_json::to_string(&c.transport.without_secrets()).map_err(|e| e.to_string())?;
    let mac = sign(c, &transport)?;
    let conn = lock(db)?;
    conn.execute(
        "INSERT INTO connectors (id, slug, name, template, created, transport, approved_hash, mac)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET slug = ?2, name = ?3, template = ?4, created = ?5, transport = ?6,
             approved_hash = ?7, mac = ?8",
        rusqlite::params![c.id, c.slug, c.name, c.template, c.created, transport, c.approved_hash, mac],
    )
    .map_err(|e| match e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
            format!("Another connector already uses the short name \"{}\".", c.slug)
        }
        e => e.to_string(),
    })?;
    Ok(())
}

pub fn delete(db: &Db, id: &str) -> Result<(), String> {
    lock(db)?.execute("DELETE FROM connectors WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
pub mod testing {
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Secrets in memory.
    #[derive(Default)]
    pub struct MemoryKeys(pub Mutex<HashMap<String, String>>);

    impl super::Keys for MemoryKeys {
        fn secret(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(name).cloned())
        }
        fn set_secret(&self, name: &str, value: Option<&str>) -> Result<(), String> {
            let mut map = self.0.lock().unwrap();
            match value {
                Some(v) => map.insert(name.into(), v.into()),
                None => map.remove(name),
            };
            Ok(())
        }
    }
}
