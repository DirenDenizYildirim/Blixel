//! What a connector is, as the interface sees it (camelCase, like
//! src/model/types.ts), and the rules a saved one must follow.

use serde::{Deserialize, Serialize};

use crate::agents::tools::SERVER_NAME;

/// An environment variable (for a command) or a header (for a URL).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Var {
    pub name: String,
    /// Empty for a secret: its value lives in the keychain.
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub secret: bool,
    /// For a secret, whether a value is stored. Filled in when listed, never saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_set: Option<bool>,
}

/// How the core reaches the server: a command it starts, or a URL.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Transport {
    Command {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: Vec<Var>,
    },
    Url {
        url: String,
        #[serde(default)]
        headers: Vec<Var>,
    },
}

impl Transport {
    pub fn vars(&self) -> &[Var] {
        match self {
            Transport::Command { env, .. } => env,
            Transport::Url { headers, .. } => headers,
        }
    }

    fn vars_mut(&mut self) -> &mut Vec<Var> {
        match self {
            Transport::Command { env, .. } => env,
            Transport::Url { headers, .. } => headers,
        }
    }

    /// The same transport as saved: no secret values, nothing only listed.
    pub fn without_secrets(&self) -> Transport {
        let mut t = self.clone();
        for var in t.vars_mut() {
            if var.secret {
                var.value.clear();
            }
            var.is_set = None;
        }
        t
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Trust {
    #[default]
    Ok,
    /// Its saved record failed its keyed check: something other than the app
    /// changed it. Its approval is cleared, and agents do not get it until the
    /// user saves or approves it again.
    ChangedOutside,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    /// Empty from the interface for a new connector; the core assigns one.
    #[serde(default)]
    pub id: String,
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub template: Option<String>,
    /// Milliseconds since 1970, set by the core when it is created.
    #[serde(default)]
    pub created: i64,
    pub transport: Transport,
    /// Set only by connector_approve; whatever the interface sends is ignored.
    #[serde(default)]
    pub approved_hash: Option<String>,
    #[serde(default)]
    pub trust: Trust,
}

/// A tool as the Connectors page shows it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destructive: Option<bool>,
    /// The JSON schema of its input, as cleaned and given to agents, so the
    /// approval shows what it can be called with.
    pub input_schema: serde_json::Value,
}

/// What the core last saw of a connector.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum State {
    #[default]
    Unchecked,
    Checking,
    /// Its tools are the ones the user approved.
    Ok { tools: Vec<ToolInfo>, hash: String },
    /// Its tools are new or differ from the approved ones: every call asks.
    Changed { tools: Vec<ToolInfo>, hash: String },
    Failed {
        reason: String,
        #[serde(rename = "retriesLeft")]
        retries_left: u32,
    },
    SignIn { reason: String },
}

/// Slugs that would clash with Blixel's own tool server or with server names
/// Claude Code uses itself.
const RESERVED_SLUGS: [&str; 4] = [SERVER_NAME, "workspace", "computer-use", "ide"];

/// A slug names the connector's tools for agents (`mcp__<slug>__<tool>`), so
/// it must survive Claude Code's renaming and splitting unchanged.
pub fn check_slug(slug: &str) -> Result<(), String> {
    let mut chars = slug.chars();
    let starts_with_letter = chars.next().is_some_and(|c| c.is_ascii_lowercase());
    let rest_ok = chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !starts_with_letter || !rest_ok || slug.len() > 24 {
        return Err("The short name must start with a letter and have at most 24 lowercase letters, digits or dashes.".into());
    }
    if RESERVED_SLUGS.contains(&slug) || slug.starts_with("claude") {
        return Err(format!("\"{slug}\" is reserved; pick another short name."));
    }
    Ok(())
}

const MAX_NAME_CHARS: usize = 60;
const MAX_TEXT: usize = 4096;
const MAX_ARGS: usize = 100;
const MAX_VARS: usize = 50;
const MAX_VALUE: usize = 16 * 1024;
/// Headers the MCP client sets itself, and ones that would break the request.
const RESERVED_HEADERS: [&str; 7] =
    ["accept", "content-type", "content-length", "host", "connection", "transfer-encoding", "last-event-id"];

/// A name shown to the user and in agents' requests: one plain line.
pub fn check_name(name: &str) -> Result<String, String> {
    let clean = super::hash::clean_text(name);
    let line = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return Err("Give the connector a name.".into());
    }
    if line.chars().count() > MAX_NAME_CHARS {
        return Err(format!("The name can have at most {MAX_NAME_CHARS} characters."));
    }
    Ok(line)
}

/// Checks a connector from the interface and returns it as it will be
/// saved: name cleaned, secret values moved out (returned separately, to go
/// to the keychain).
pub fn check(mut c: Connector) -> Result<(Connector, Vec<(String, String)>), String> {
    check_slug(&c.slug)?;
    c.name = check_name(&c.name)?;
    if let Some(t) = &c.template {
        let ok = !t.is_empty() && t.len() <= 60 && t.chars().all(|ch| ch.is_ascii_alphanumeric() || "._-".contains(ch));
        if !ok {
            return Err("The template id is not valid.".into());
        }
    }
    let no_nul = |s: &str, what: &str| {
        if s.contains('\0') || s.len() > MAX_TEXT {
            Err(format!("The {what} is too long or has a null character."))
        } else {
            Ok(())
        }
    };
    match &c.transport {
        Transport::Command { command, args, env } => {
            if command.trim().is_empty() {
                return Err("Give the command that starts the server.".into());
            }
            no_nul(command, "command")?;
            if args.len() > MAX_ARGS {
                return Err(format!("At most {MAX_ARGS} arguments."));
            }
            for arg in args {
                no_nul(arg, "argument")?;
            }
            check_vars(env, |name| {
                let mut chars = name.chars();
                let ok = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                    && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
                    && name.len() <= 128;
                if ok {
                    Ok(())
                } else {
                    Err(format!("\"{name}\" is not a valid environment variable name."))
                }
            })?;
        }
        Transport::Url { url, headers } => {
            check_url(url)?;
            check_vars(headers, |name| {
                let lower = name.to_ascii_lowercase();
                if axum::http::HeaderName::from_bytes(name.as_bytes()).is_err() {
                    Err(format!("\"{name}\" is not a valid header name."))
                } else if RESERVED_HEADERS.contains(&lower.as_str()) || lower.starts_with("mcp-") {
                    Err(format!("The {name} header is set by the app itself."))
                } else {
                    Ok(())
                }
            })?;
            for h in headers.iter().filter(|h| !h.secret) {
                if axum::http::HeaderValue::from_str(&h.value).is_err() {
                    return Err(format!("The value of the {} header is not valid.", h.name));
                }
            }
        }
    }
    // Secret values never stay in the record.
    let secrets: Vec<(String, String)> = c
        .transport
        .vars()
        .iter()
        .filter(|v| v.secret && !v.value.is_empty())
        .map(|v| (v.name.clone(), v.value.clone()))
        .collect();
    c.transport = c.transport.without_secrets();
    Ok((c, secrets))
}

fn check_vars(vars: &[Var], check_name: impl Fn(&str) -> Result<(), String>) -> Result<(), String> {
    if vars.len() > MAX_VARS {
        return Err(format!("At most {MAX_VARS} variables or headers."));
    }
    let mut seen = std::collections::HashSet::new();
    for var in vars {
        check_name(&var.name)?;
        if !seen.insert(var.name.to_ascii_lowercase()) {
            return Err(format!("{} is given twice.", var.name));
        }
        if var.value.contains('\0') || var.value.len() > MAX_VALUE {
            return Err(format!("The value of {} is too long or has a null character.", var.name));
        }
    }
    Ok(())
}

/// https anywhere; plain http only on this computer, so a token never
/// crosses the network unencrypted.
pub fn check_url(url: &str) -> Result<(), String> {
    let uri: axum::http::Uri = url.parse().map_err(|_| "The URL is not valid.".to_string())?;
    let host = uri.host().unwrap_or("").trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return Err("The URL needs a host.".into());
    }
    match uri.scheme_str() {
        Some("https") => Ok(()),
        Some("http") if is_loopback(host) => Ok(()),
        Some("http") => Err("Use https: plain http is only allowed for servers on this computer.".into()),
        _ => Err("The URL must start with https://.".into()),
    }
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// The keychain name of one of a connector's secrets.
pub fn secret_name(connector_id: &str, var: &str) -> String {
    format!("connector:{connector_id}:{var}")
}

/// Ids the core gives, or the interface's own for a new connector.
pub fn check_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err("The connector id is not valid.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(env: Vec<Var>) -> Connector {
        Connector {
            id: String::new(),
            slug: "github".into(),
            name: "GitHub".into(),
            template: None,
            created: 0,
            transport: Transport::Command { command: "npx".into(), args: vec!["-y".into(), "server".into()], env },
            approved_hash: None,
            trust: Trust::Ok,
        }
    }

    fn var(name: &str, value: &str, secret: bool) -> Var {
        Var { name: name.into(), value: value.into(), secret, is_set: None }
    }

    #[test]
    fn slugs_survive_claude_codes_naming() {
        for ok in ["github", "a", "my-server-2", "x23456789012345678901234"] {
            assert!(check_slug(ok).is_ok(), "{ok}");
        }
        for bad in [
            "", "GitHub", "2fa", "-x", "my_server", "a__b", "with space", "ümlaut", "x234567890123456789012345", "blixel",
            "workspace", "computer-use", "claude-ai-x", "claude",
        ] {
            assert!(check_slug(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn secrets_leave_the_record() {
        let (saved, secrets) =
            check(command(vec![var("TOKEN", "s3cret", true), var("MODE", "fast", false), var("EMPTY", "", true)])).unwrap();
        assert_eq!(secrets, vec![("TOKEN".to_string(), "s3cret".to_string())]);
        let text = serde_json::to_string(&saved).unwrap();
        assert!(!text.contains("s3cret"), "{text}");
        assert!(text.contains("fast"));
    }

    #[test]
    fn transports_are_checked() {
        assert!(check(command(vec![var("1BAD", "", false)])).is_err());
        assert!(check(command(vec![var("A", "", false), var("A", "", false)])).is_err(), "twice");
        let mut c = command(vec![]);
        c.name = "  Git\u{202E}Hub \n ".into();
        assert_eq!(check(c).unwrap().0.name, "GitHub", "one clean line");

        let url = |u: &str, headers: Vec<Var>| Connector { transport: Transport::Url { url: u.into(), headers }, ..command(vec![]) };
        assert!(check(url("https://mcp.example.com/mcp", vec![var("Authorization", "", true)])).is_ok());
        assert!(check(url("http://127.0.0.1:8080/mcp", vec![])).is_ok());
        assert!(check(url("http://localhost/mcp", vec![])).is_ok());
        assert!(check(url("http://[::1]:9/mcp", vec![])).is_ok());
        assert!(check(url("http://example.com/mcp", vec![])).is_err(), "plain http over the network");
        assert!(check(url("ftp://example.com", vec![])).is_err());
        assert!(check(url("not a url", vec![])).is_err());
        assert!(check(url("https://x.dev", vec![var("Mcp-Session-Id", "1", false)])).is_err());
        assert!(check(url("https://x.dev", vec![var("Accept", "*/*", false)])).is_err());
        assert!(check(url("https://x.dev", vec![var("X-Key", "a\nb", false)])).is_err());
        assert!(check(url("https://x.dev", vec![var("Bad Header", "1", false)])).is_err());
    }

    #[test]
    fn states_match_the_interface() {
        let failed = State::Failed { reason: "no".into(), retries_left: 2 };
        assert_eq!(serde_json::to_value(&failed).unwrap(), serde_json::json!({ "kind": "failed", "reason": "no", "retriesLeft": 2 }));
        assert_eq!(serde_json::to_value(State::SignIn { reason: "x".into() }).unwrap()["kind"], "sign-in");
        assert_eq!(serde_json::to_value(State::Unchecked).unwrap(), serde_json::json!({ "kind": "unchecked" }));
        let c: Connector = serde_json::from_value(serde_json::json!({
            "id": "c1", "slug": "s", "name": "S", "template": null, "created": 5,
            "transport": { "kind": "url", "url": "https://x.dev", "headers": [{ "name": "X", "value": "", "secret": true, "isSet": true }] },
            "approvedHash": null, "trust": "changed-outside"
        }))
        .unwrap();
        assert_eq!(c.trust, Trust::ChangedOutside);
        assert_eq!(c.transport.vars()[0].is_set, Some(true));
    }
}
