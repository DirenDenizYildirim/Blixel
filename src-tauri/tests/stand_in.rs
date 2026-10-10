//! The stand-in agent is the app's own binary started with `--stand-in-agent`
//! (debug builds only). Besides checking that, this test makes `cargo test`
//! build the app's binary, which the end-to-end tests in
//! `src/agents/end_to_end.rs` start as the stand-in.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[test]
fn the_app_binary_runs_as_the_stand_in_agent() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_blixel"))
        .arg("--stand-in-agent")
        .env("CLAUDE_CONFIG_DIR", std::env::temp_dir().join(format!("blixel-stand-in-bin-{}", std::process::id())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("the app binary starts");
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":1}}}}"#).unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let reply: serde_json::Value = serde_json::from_str(&line).expect(&line);
    assert_eq!(reply["result"]["protocolVersion"], 1, "{reply}");
    assert_eq!(reply["result"]["agentCapabilities"]["loadSession"], true, "{reply}");
    assert!(reply["result"]["agentCapabilities"]["sessionCapabilities"]["resume"].is_object(), "{reply}");
    // Closing its input ends it.
    drop(stdin);
    assert!(child.wait().unwrap().success());
}
