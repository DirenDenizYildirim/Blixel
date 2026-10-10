//! An agent's settings as the user set them. The core holds the copy that is
//! enforced; only the interface (the user) changes it, except that answering
//! "Always allow" sets that tool to Allow.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::rules::{self, EditArea};

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Setting {
    Off,
    Ask,
    Allow,
}

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Read,
    Edit,
    Run,
    Commit,
    Push,
}

impl Tool {
    pub fn as_str(self) -> &'static str {
        match self {
            Tool::Read => "read",
            Tool::Edit => "edit",
            Tool::Run => "run",
            Tool::Commit => "commit",
            Tool::Push => "push",
        }
    }
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Permissions {
    pub read: Setting,
    pub edit: Setting,
    pub run: Setting,
    pub commit: Setting,
    pub push: Setting,
}

impl Permissions {
    pub fn get(&self, tool: Tool) -> Setting {
        match tool {
            Tool::Read => self.read,
            Tool::Edit => self.edit,
            Tool::Run => self.run,
            Tool::Commit => self.commit,
            Tool::Push => self.push,
        }
    }

    pub fn set(&mut self, tool: Tool, value: Setting) {
        match tool {
            Tool::Read => self.read = value,
            Tool::Edit => self.edit = value,
            Tool::Run => self.run = value,
            Tool::Commit => self.commit = value,
            Tool::Push => self.push = value,
        }
    }
}

/// What the interface sends when an agent is created or changed.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub read_notes: bool,
    pub permissions: Permissions,
    pub edit_paths: String,
    /// Rule packs from mods that the user attached. They only narrow: more
    /// instructions, a smaller edit area, more paths that always ask.
    #[serde(default)]
    pub rule_packs: Vec<RulePack>,
    /// Its access to each connector, by connector id; a connector not listed is Off.
    #[serde(default)]
    pub connectors: std::collections::HashMap<String, Setting>,
    /// The model id the program takes, e.g. "sonnet".
    pub model: String,
    /// Thinking effort: "low", "medium" or "high".
    pub effort: String,
}

/// A rule pack's label is cut to this many characters wherever it is shown.
const MAX_LABEL_CHARS: usize = 60;

/// One attached rule pack, as the interface sends it. Its text comes from a
/// mod, so it is shown to agents and the user only through `label()` and
/// `instructions()`.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RulePack {
    pub label: String,
    #[serde(default)]
    pub instructions: String,
    /// .gitignore-style patterns; empty means no further limit.
    #[serde(default)]
    pub edit_area: String,
    /// .gitignore-style patterns whose edits always ask the user.
    #[serde(default)]
    pub protect: Vec<String>,
}

impl RulePack {
    /// Its label as one plain line of at most 60 characters.
    pub fn label(&self) -> String {
        let spaced: String = self
            .label
            .chars()
            .filter_map(|c| match c {
                c if c.is_whitespace() => Some(' '),
                c if is_hidden(c) => None,
                c => Some(c),
            })
            .collect();
        let label = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
        if label.is_empty() {
            return "an unnamed rule pack".into();
        }
        if label.chars().count() <= MAX_LABEL_CHARS {
            return label;
        }
        let cut: String = label.chars().take(MAX_LABEL_CHARS - 1).collect();
        format!("{}…", cut.trim_end())
    }

    /// Its instructions, keeping lines and tabs but nothing hidden.
    pub fn instructions(&self) -> String {
        self.instructions.chars().filter(|c| matches!(c, '\n' | '\t') || !is_hidden(*c)).collect()
    }
}

/// Characters that do not show, or that change how the text around them
/// shows: controls, zero-width and invisible characters, direction overrides
/// and tags. Mod text could hide instructions to agents in them, or make a
/// label read differently from what it says.
fn is_hidden(c: char) -> bool {
    c.is_control() // C0, DEL and C1
        || matches!(c,
            '\u{00AD}' // soft hyphen
            | '\u{061C}' // Arabic letter mark
            | '\u{180E}' // Mongolian vowel separator
            | '\u{200B}'..='\u{200F}' // zero-width characters and direction marks
            | '\u{202A}'..='\u{202E}' // direction embeddings and overrides
            | '\u{2060}'..='\u{2064}' // word joiner and invisible operators
            | '\u{2066}'..='\u{2069}' // direction isolates
            | '\u{FE00}'..='\u{FE0F}' // variation selectors
            | '\u{FEFF}' // byte order mark
            | '\u{E0000}'..='\u{E007F}' // tags
            | '\u{E0100}'..='\u{E01EF}' // more variation selectors
        )
}

/// Where an edit stands before the Edit setting is applied.
#[derive(Debug, PartialEq, Eq)]
pub enum EditCheck {
    /// Outside the area: refused without asking. Names the rule pack whose
    /// area leaves it out, or None for the agent's own area.
    Outside(Option<String>),
    /// Inside, but every change asks the user, without "Always allow": an
    /// agent settings file (None) or a path a rule pack protects (its label).
    AlwaysAsk(Option<String>),
    /// Inside; the Edit setting decides.
    Setting,
}

impl AgentConfig {
    /// For settings whose saved record was changed outside the app: every
    /// tool's Allow becomes Ask, and every connector Off, since an entry
    /// there may have been added or widened and only the user knows which.
    pub fn lower_untrusted(&mut self) {
        for tool in [Tool::Read, Tool::Edit, Tool::Run, Tool::Commit, Tool::Push] {
            if self.permissions.get(tool) == Setting::Allow {
                self.permissions.set(tool, Setting::Ask);
            }
        }
        for setting in self.connectors.values_mut() {
            *setting = Setting::Off;
        }
    }

    /// Applies the agent's own area and every attached rule pack. Packs only
    /// narrow: an edit must be inside every area, and any protection asks.
    pub fn edit_check(&self, rel: &Path) -> EditCheck {
        if !EditArea::parse(&self.edit_paths).allows(rel) {
            return EditCheck::Outside(None);
        }
        for pack in &self.rule_packs {
            if !EditArea::parse(&pack.edit_area).allows(rel) {
                return EditCheck::Outside(Some(pack.label()));
            }
        }
        if rules::is_protected(rel) {
            return EditCheck::AlwaysAsk(None);
        }
        match self.rule_packs.iter().find(|p| rules::Protected::parse(&p.protect).covers(rel)) {
            Some(pack) => EditCheck::AlwaysAsk(Some(pack.label())),
            None => EditCheck::Setting,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(edit_paths: &str, rule_packs: Vec<RulePack>) -> AgentConfig {
        AgentConfig {
            id: "t".into(),
            name: "Tester".into(),
            instructions: String::new(),
            read_notes: false,
            permissions: Permissions {
                read: Setting::Allow,
                edit: Setting::Allow,
                run: Setting::Ask,
                commit: Setting::Off,
                push: Setting::Off,
            },
            edit_paths: edit_paths.into(),
            connectors: Default::default(),
            rule_packs,
            model: "test".into(),
            effort: "medium".into(),
        }
    }

    fn pack(label: &str, edit_area: &str, protect: &[&str]) -> RulePack {
        RulePack {
            label: label.into(),
            instructions: String::new(),
            edit_area: edit_area.into(),
            protect: protect.iter().map(|p| p.to_string()).collect(),
        }
    }

    fn check(c: &AgentConfig, path: &str) -> EditCheck {
        c.edit_check(Path::new(path))
    }

    #[test]
    fn pack_text_is_shown_without_hidden_characters() {
        let pack = |label: &str, instructions: &str| RulePack {
            label: label.into(),
            instructions: instructions.into(),
            ..Default::default()
        };
        assert_eq!(pack("Docs\nonly\r\n\t now", "").label(), "Docs only now", "one line");
        let hidden = "a\u{200B}b\u{202E}c\u{2066}d\u{FEFF}e\u{0007}f\u{009B}g\u{E0041}h\u{200F}i";
        assert_eq!(pack(hidden, "").label(), "abcdefghi");
        assert_eq!(pack("\u{202E}\u{200B} \n", "").label(), "an unnamed rule pack");

        let long = "x".repeat(100);
        let label = pack(&long, "").label();
        assert_eq!(label.chars().count(), 60);
        assert!(label.ends_with('…'));
        assert_eq!(pack(&"y".repeat(60), "").label(), "y".repeat(60), "60 fit");

        let text = pack("L", "Line one\n\tLine two\u{202E}\u{200B}\r\u{E0049}\u{0000} end").instructions();
        assert_eq!(text, "Line one\n\tLine two end", "newlines and tabs stay");

        // Questions and refusals name the pack by its shown label.
        let area = RulePack { edit_area: "docs/**".into(), ..pack("Area\u{200B}", "") };
        let c = config("", vec![pack("Evil\u{202E}\nlabel", ""), area]);
        assert_eq!(c.edit_check(Path::new("src/a.rs")), EditCheck::Outside(Some("Area".into())));
    }

    #[test]
    fn lowering_asks_for_every_tool_and_turns_connectors_off() {
        let mut c = config("", vec![]);
        c.connectors.insert("c1".into(), Setting::Allow);
        c.connectors.insert("c2".into(), Setting::Ask);
        c.connectors.insert("c3".into(), Setting::Off);
        c.lower_untrusted();
        assert_eq!((c.permissions.read, c.permissions.edit, c.permissions.run), (Setting::Ask, Setting::Ask, Setting::Ask));
        assert_eq!((c.permissions.commit, c.permissions.push), (Setting::Off, Setting::Off), "Off stays Off");
        assert!(c.connectors.values().all(|s| *s == Setting::Off), "{:?}", c.connectors);
    }

    #[test]
    fn without_packs_the_own_area_decides() {
        let c = config("docs/**", vec![]);
        assert_eq!(check(&c, "docs/a.md"), EditCheck::Setting);
        assert_eq!(check(&c, "src/a.ts"), EditCheck::Outside(None));
        assert_eq!(check(&c, "docs/CLAUDE.md"), EditCheck::AlwaysAsk(None));
    }

    #[test]
    fn a_pack_area_only_narrows() {
        let c = config("", vec![pack("Docs only", "docs/**", &[])]);
        assert_eq!(check(&c, "docs/a.md"), EditCheck::Setting);
        assert_eq!(check(&c, "src/a.ts"), EditCheck::Outside(Some("Docs only".into())));

        // Both areas must allow it: the pack cannot widen the agent's own.
        let c = config("docs/**", vec![pack("Source", "src/**", &[])]);
        assert_eq!(check(&c, "src/a.ts"), EditCheck::Outside(None));
        assert_eq!(check(&c, "docs/a.md"), EditCheck::Outside(Some("Source".into())));

        // An empty pack area adds no limit, and every pack counts.
        let c = config("", vec![pack("Free", "", &[]), pack("No vendor", "!vendor/**", &[])]);
        assert_eq!(check(&c, "src/a.ts"), EditCheck::Setting);
        assert_eq!(check(&c, "vendor/lib.js"), EditCheck::Outside(Some("No vendor".into())));
    }

    #[test]
    fn pack_protection_asks_but_never_widens() {
        let c = config("src/**", vec![pack("Careful with SQL", "", &["src/db/", "*.sql"])]);
        assert_eq!(check(&c, "src/db/schema.ts"), EditCheck::AlwaysAsk(Some("Careful with SQL".into())));
        assert_eq!(check(&c, "src/seed.sql"), EditCheck::AlwaysAsk(Some("Careful with SQL".into())));
        assert_eq!(check(&c, "src/app.ts"), EditCheck::Setting);
        // Outside the area stays refused, protected or not.
        assert_eq!(check(&c, "migrations/001.sql"), EditCheck::Outside(None));
        // Built-in protection is named first.
        assert_eq!(check(&c, "src/.claude/settings.json"), EditCheck::AlwaysAsk(None));
    }
}
