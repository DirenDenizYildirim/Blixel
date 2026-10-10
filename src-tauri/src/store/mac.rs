//! A keyed check (HMAC-SHA256) on saved rows that grant an agent anything:
//! a project (its folder), an agent's settings, a connector. Without the
//! key, kept in the system keychain, a changed row cannot pass the check. A
//! row that fails loads lowered and stays untrusted until the user reviews
//! and saves it (see `UNTRUSTED`).
//!
//! What it can and cannot do: it catches rows changed by anything that lacks
//! the key, such as another program or a stray edit. It does not stop an
//! agent allowed to run commands: commands run as the user, and on Linux the
//! keychain (Secret Service) hands its items to any program of the user once
//! it is unlocked, this key included. Such an agent could sign a row of its
//! own. Run therefore means "can do what you can do" until agent commands
//! run in a sandbox without access to the keychain or the app's data.

use std::sync::{Mutex, OnceLock};

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// The key's name in the keychain.
#[cfg(not(test))]
const KEY_NAME: &str = "store-check-key";

/// The check stored for a row that failed its check and has not been
/// reviewed since. It never passes, so no later save can trust the row again
/// by accident: only the user's explicit save signs it anew.
pub const UNTRUSTED: &str = "";

static KEY: OnceLock<[u8; 32]> = OnceLock::new();
/// Held while the key is read or made, so two threads never make two keys.
static LOADING: Mutex<()> = Mutex::new(());

/// The key, read from the keychain once, or made and stored there on first
/// use. A keychain that cannot be read is an error, never a new key: that
/// would make every saved row fail its check.
fn key() -> Result<&'static [u8; 32], String> {
    if let Some(key) = KEY.get() {
        return Ok(key);
    }
    let _held = LOADING.lock().map_err(|_| "check key lock poisoned")?;
    if let Some(key) = KEY.get() {
        return Ok(key);
    }
    let key = load()?;
    Ok(KEY.get_or_init(|| key))
}

#[cfg(not(test))]
fn load() -> Result<[u8; 32], String> {
    if let Some(stored) = crate::secrets::get(KEY_NAME)? {
        if let Some(key) = from_hex(&stored).and_then(|k| <[u8; 32]>::try_from(k).ok()) {
            return Ok(key);
        }
        // A damaged key is replaced; rows signed with it then load as changed.
    }
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).map_err(|e| format!("could not make the check key: {e}"))?;
    crate::secrets::set(KEY_NAME, &to_hex(&key))?;
    Ok(key)
}

/// Tests never touch the user's keychain.
#[cfg(test)]
fn load() -> Result<[u8; 32], String> {
    Ok([7; 32])
}

fn mac_of(key: &[u8], parts: &[&str]) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
    // Each part's length first, so ("ab", "c") and ("a", "bc") differ.
    for part in parts {
        mac.update(&(part.len() as u64).to_be_bytes());
        mac.update(part.as_bytes());
    }
    mac
}

/// The check for a row, as hex. `parts` should name the kind of row and
/// everything that identifies it, e.g. `["agent", project_id, agent_id, json]`,
/// so a row cannot be moved to another place and still pass.
pub fn sign(parts: &[&str]) -> Result<String, String> {
    Ok(to_hex(&mac_of(key()?, parts).finalize().into_bytes()))
}

/// Whether `mac` is the check for these parts. False when the key cannot be
/// read, so a row is never trusted without it.
pub fn verify(parts: &[&str], mac: &str) -> bool {
    check(parts, mac).unwrap_or(false)
}

/// Like `verify`, but an error when the key cannot be read: nothing is known
/// then, so a row must not be marked untrusted for good because of it.
pub fn check(parts: &[&str], mac: &str) -> Result<bool, String> {
    let key = key()?;
    let Some(given) = from_hex(mac) else { return Ok(false) };
    Ok(mac_of(key, parts).verify_slice(&given).is_ok())
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signed_row_passes_and_a_changed_one_fails() {
        let mac = sign(&["agent", "p1", "a1", r#"{"run":"ask"}"#]).unwrap();
        assert_eq!(mac.len(), 64);
        assert!(verify(&["agent", "p1", "a1", r#"{"run":"ask"}"#], &mac));
        assert!(!verify(&["agent", "p1", "a1", r#"{"run":"allow"}"#], &mac), "changed content");
        assert!(!verify(&["agent", "p2", "a1", r#"{"run":"ask"}"#], &mac), "moved to another project");
        assert!(!verify(&["agent", "p1a", "1", r#"{"run":"ask"}"#], &mac), "parts are not just joined");
        assert!(!verify(&["agent", "p1", "a1", r#"{"run":"ask"}"#], UNTRUSTED), "no check");
        assert!(!verify(&["agent", "p1", "a1", r#"{"run":"ask"}"#], "zz"), "not hex");
        assert!(!verify(&["agent", "p1", "a1", r#"{"run":"ask"}"#], &mac[..62]), "cut short");
    }

    #[test]
    fn hex_round_trips() {
        assert_eq!(from_hex(&to_hex(&[0, 1, 0xab, 0xff])), Some(vec![0, 1, 0xab, 0xff]));
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("éé"), None, "not ASCII");
    }
}
