//! API keys live in the operating system's keychain, never in the project,
//! the app's own storage, chat or logs. The interface can store or replace a
//! key and ask whether one exists, but can never read it back.

const SERVICE: &str = "blixel";

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &format!("{provider}-api-key")).map_err(|e| e.to_string())
}

/// A named secret of the app's own (a connector's token, the store's check key...).
/// Names are namespaced by their owner, e.g. "connector:<id>:<var>".
#[cfg_attr(test, allow(dead_code, reason = "tests never touch the keychain"))]
pub fn get(name: &str) -> Result<Option<String>, String> {
    match keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read the keychain: {e}")),
    }
}

#[cfg_attr(test, allow(dead_code, reason = "tests never touch the keychain"))]
pub fn set(name: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, name)
        .map_err(|e| e.to_string())?
        .set_password(value)
        .map_err(|e| format!("could not save to the keychain: {e}"))
}

/// Removes a secret; removing one that isn't there is fine.
#[allow(dead_code, reason = "used by connectors")]
pub fn delete(name: &str) -> Result<(), String> {
    match keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not remove from the keychain: {e}")),
    }
}

pub fn api_key(provider: &str) -> Result<Option<String>, String> {
    match entry(provider)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("could not read the keychain: {e}")),
    }
}

#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("the key is empty".into());
    }
    entry(&provider)?
        .set_password(key)
        .map_err(|e| format!("could not save to the keychain: {e}"))
}

#[tauri::command]
pub fn has_api_key(provider: String) -> Result<bool, String> {
    Ok(api_key(&provider)?.is_some())
}
