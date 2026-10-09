//! API keys live in the operating system's keychain, never in the project,
//! the app's own storage, chat or logs. The interface can store or replace a
//! key and ask whether one exists, but can never read it back.

const SERVICE: &str = "blixel";

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &format!("{provider}-api-key")).map_err(|e| e.to_string())
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
