//! Where an agent may edit. Patterns follow .gitignore: a line names files or
//! folders, `!` excludes, and the last matching line wins. No patterns means
//! the whole project. Agent settings and instruction files always need the
//! user's approval, whatever the area says. Rule packs from mods use the same
//! patterns for their own areas and for paths they protect.

use std::path::Path;
use std::sync::OnceLock;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Deserialize;

pub struct EditArea {
    matcher: Option<Gitignore>,
    /// False when every line is an exclusion: then everything else is allowed.
    has_includes: bool,
}

/// Builds a matcher from pattern lines, skipping blanks and comments. Also
/// says whether any line names paths rather than excluding them.
fn build<'a>(lines: impl Iterator<Item = &'a str>) -> (Option<Gitignore>, bool) {
    let mut builder = GitignoreBuilder::new("");
    let mut has_includes = false;
    let mut any = false;
    for line in lines.map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        has_includes |= !line.starts_with('!');
        any |= builder.add_line(None, line).is_ok();
    }
    let matcher = if any { builder.build().ok() } else { None };
    (matcher, has_includes)
}

impl EditArea {
    pub fn parse(patterns: &str) -> Self {
        let (matcher, has_includes) = build(patterns.lines());
        Self { matcher, has_includes }
    }

    /// `rel` is relative to the project root, with `/` separators.
    pub fn allows(&self, rel: &Path) -> bool {
        let Some(matcher) = &self.matcher else { return true };
        let m = matcher.matched_path_or_any_parents(rel, false);
        if m.is_whitelist() {
            false
        } else if m.is_ignore() {
            true
        } else {
            !self.has_includes
        }
    }
}

/// Paths a rule pack protects: every change to one asks the user first.
/// Unlike an area, no patterns (or only exclusions) protect nothing.
pub struct Protected {
    matcher: Option<Gitignore>,
}

impl Protected {
    pub fn parse(patterns: &[String]) -> Self {
        let (matcher, _) = build(patterns.iter().flat_map(|p| p.lines()));
        Self { matcher }
    }

    /// `rel` is relative to the project root, with `/` separators.
    pub fn covers(&self, rel: &Path) -> bool {
        let Some(matcher) = &self.matcher else { return false };
        matcher.matched_path_or_any_parents(rel, false).is_ignore()
    }
}

/// Folders and file names whose changes always go to the user first. The
/// interface reads the same list (src/model/paths.ts) and matches it the same way.
#[derive(Deserialize)]
struct ProtectedList {
    folders: Vec<String>,
    files: Vec<String>,
}

fn protected() -> &'static ProtectedList {
    static LIST: OnceLock<ProtectedList> = OnceLock::new();
    LIST.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/model/protected-paths.json")).expect("protected-paths.json is valid")
    })
}

/// Files that configure or instruct agents, and git's own folder, whose hooks
/// and config run code. Changing one could widen what an agent may do, so
/// every change goes to the user first.
pub fn is_protected(rel: &Path) -> bool {
    let list = protected();
    let mut parts = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).peekable();
    while let Some(part) = parts.next() {
        let names = if parts.peek().is_none() { &list.files } else { &list.folders };
        if names.contains(&part) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allows(patterns: &str, path: &str) -> bool {
        EditArea::parse(patterns).allows(Path::new(path))
    }

    #[test]
    fn no_patterns_allow_everything() {
        assert!(allows("", "src/main.rs"));
        assert!(allows("# just a comment\n", "docs/a.md"));
    }

    #[test]
    fn includes_limit_the_area() {
        assert!(allows("docs/**", "docs/permissions.md"));
        assert!(allows("docs/", "docs/deep/nested.md"));
        assert!(!allows("docs/**", "src/router.ts"));
        assert!(allows("*.md", "src/notes.md"));
        assert!(!allows("*.md", "src/router.ts"));
    }

    #[test]
    fn exclusions_win_when_last() {
        let p = "src/**\n!src/generated/**";
        assert!(allows(p, "src/router.ts"));
        assert!(!allows(p, "src/generated/types.ts"));
        assert!(!allows("!migrations/**", "migrations/001.sql"));
        assert!(allows("!migrations/**", "src/app.ts"));
    }

    fn covers(patterns: &[&str], path: &str) -> bool {
        Protected::parse(&patterns.iter().map(|p| p.to_string()).collect::<Vec<_>>()).covers(Path::new(path))
    }

    #[test]
    fn rule_pack_protection_covers_only_what_it_names() {
        assert!(!covers(&[], "src/main.rs"), "no patterns protect nothing");
        assert!(!covers(&["!src/**"], "src/main.rs"), "only exclusions protect nothing");
        assert!(covers(&["migrations/"], "migrations/001.sql"));
        assert!(covers(&["*.lock"], "deep/Cargo.lock"));
        assert!(!covers(&["*.lock"], "src/lock.rs"));
        let p = ["db/**", "!db/seeds/**"];
        assert!(covers(&p, "db/schema.sql"));
        assert!(!covers(&p, "db/seeds/users.sql"));
        assert!(covers(&["# comment\npackage.json"], "package.json"), "an entry may hold several lines");
    }

    #[test]
    fn agent_files_are_protected() {
        assert!(is_protected(Path::new("CLAUDE.md")));
        assert!(is_protected(Path::new("packages/web/AGENTS.md")));
        assert!(is_protected(Path::new(".claude/settings.json")));
        assert!(is_protected(Path::new("app/.codex/config.toml")));
        assert!(is_protected(Path::new(".git/hooks/pre-commit")));
        assert!(is_protected(Path::new(".mcp.json")));
        assert!(is_protected(Path::new("CLAUDE.local.md")));
        assert!(!is_protected(Path::new(".github/workflows/ci.yml")));
        assert!(!is_protected(Path::new("docs/claude.md.txt")));
        assert!(!is_protected(Path::new("src/router.ts")));
    }
}
