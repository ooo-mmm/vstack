use serde::Deserialize;
use std::collections::HashMap;
use std::path::Path;

/// Project-level agent customization config.
///
/// Loaded from `vstack.toml` at the project root. These sections are
/// independent of the source repo's mapping sections and survive updates.
///
/// `[agent-skills]` is the single source of truth for which skills appear
/// in each agent's frontmatter. Users can add or remove entries and run
/// `vstack refresh` to apply.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ProjectConfig {
    /// Skills attached to each agent's frontmatter.  This is the
    /// authoritative list — editing it and running `vstack refresh`
    /// updates the generated agent files.
    #[serde(rename = "agent-skills")]
    pub agent_skills: HashMap<String, Vec<String>>,
    #[serde(rename = "agent-skills-optional")]
    pub agent_skills_optional: HashMap<String, Vec<crate::mapping::OptionalSkill>>,
    #[serde(rename = "agent-guidance")]
    pub agent_guidance: HashMap<String, String>,
    #[serde(rename = "agent-instructions")]
    pub agent_instructions: HashMap<String, String>,
    #[serde(rename = "skill-instructions")]
    pub skill_instructions: HashMap<String, String>,
    #[serde(rename = "custom-hooks", default)]
    pub custom_hooks: Vec<CustomHook>,
}

/// A user-defined hook from project config
#[derive(Debug, Clone, Deserialize)]
pub struct CustomHook {
    pub event: String,
    #[serde(default)]
    pub matcher: Option<String>,
    pub command: String,
    /// What this hook does — inlined as instruction text in harnesses
    /// that can't run scripts (Cursor, OpenCode, Codex).
    #[serde(default)]
    pub description: Option<String>,
    /// Which agents to apply to: "all", a role name ("engineer"),
    /// or a list of agent names (["rust", "iced"])
    #[serde(default = "default_hook_agents")]
    pub agents: CustomHookTarget,
}

fn default_hook_agents() -> CustomHookTarget {
    CustomHookTarget::All("all".into())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum CustomHookTarget {
    All(String),
    List(Vec<String>),
}

impl ProjectConfig {
    /// Load project config from a directory's `vstack.toml`.
    /// Returns default (empty) if the file is missing or unparseable.
    pub fn load(project_root: &Path) -> Self {
        let path = project_root.join("vstack.toml");
        if !path.exists() {
            return Self::default();
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        toml::from_str(&content).unwrap_or_default()
    }

    /// Get the project-level skill list for an agent, if one exists.
    /// Returns `None` when the agent has no `[agent-skills]` entry,
    /// which tells callers to fall back to source mapping.
    pub fn agent_skills_for(&self, agent_name: &str) -> Option<&Vec<String>> {
        self.agent_skills.get(agent_name)
    }

    /// Get guidance text for an agent
    pub fn guidance_for(&self, agent_name: &str) -> Option<&str> {
        self.agent_guidance.get(agent_name).map(|s| s.as_str())
    }

    /// Get additional instructions for an agent
    pub fn instructions_for(&self, agent_name: &str) -> Option<&str> {
        self.agent_instructions.get(agent_name).map(|s| s.as_str())
    }

    /// Get project-specific instructions for a skill
    pub fn skill_instructions_for(&self, skill_name: &str) -> Option<&str> {
        self.skill_instructions
            .get(skill_name)
            .map(|s| s.as_str())
            .filter(|s| !s.is_empty())
    }

    /// Get custom hooks that apply to a specific agent, as CustomHookEntry for agent frontmatter
    pub fn custom_hooks_for(
        &self,
        agent_name: &str,
        agent_role: &crate::agent::AgentRole,
    ) -> Vec<crate::agent::CustomHookEntry> {
        let role_str = agent_role.as_str();
        self.custom_hooks
            .iter()
            .filter(|h| match &h.agents {
                CustomHookTarget::All(s) => s == "all",
                CustomHookTarget::List(names) => {
                    names.iter().any(|n| n == agent_name || n == role_str)
                }
            })
            .map(|h| crate::agent::CustomHookEntry {
                event: h.event.clone(),
                matcher: h.matcher.clone(),
                command: h.command.clone(),
                description: h.description.clone(),
            })
            .collect()
    }

    /// Merge extracted agent sections into vstack.toml, preserving existing entries.
    /// Only writes new entries — never overwrites user-set values.
    pub fn save_extracted(
        &mut self,
        project_root: &Path,
        agent_name: &str,
        extracted: &crate::agent::AgentExtras,
    ) {
        let needs_guidance =
            extracted.guidance.is_some() && self.guidance_for(agent_name).is_none();
        let needs_instructions =
            extracted.instructions.is_some() && self.instructions_for(agent_name).is_none();

        if !needs_guidance && !needs_instructions {
            return;
        }

        if let Some(ref text) = extracted.guidance {
            if needs_guidance {
                self.agent_guidance
                    .insert(agent_name.to_string(), text.clone());
            }
        }
        if let Some(ref text) = extracted.instructions {
            if needs_instructions {
                self.agent_instructions
                    .insert(agent_name.to_string(), text.clone());
            }
        }

        // Write back to vstack.toml surgically — preserve comments and structure
        let path = project_root.join("vstack.toml");
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let mut out = existing.clone();

        if needs_guidance {
            if let Some(ref text) = extracted.guidance {
                let entry = format!("{} = \"\"\n", agent_name);
                let value = format!("{} = \"{}\"\n", agent_name, text.replace('"', "\\\""));
                // Try replacing the empty placeholder, else append to section
                if out.contains(&entry) {
                    out = out.replace(&entry, &value);
                } else {
                    let new_entry = format!("{} = \"{}\"\n", agent_name, text.replace('"', "\\\""));
                    out = insert_entries_into_section(&out, "[agent-guidance]", &new_entry);
                }
            }
        }

        if needs_instructions {
            if let Some(ref text) = extracted.instructions {
                let entry = format!("{} = \"\"\n", agent_name);
                let value = format!("{} = \"{}\"\n", agent_name, text.replace('"', "\\\""));
                if out.contains(&entry) {
                    out = out.replace(&entry, &value);
                } else {
                    let new_entry =
                        format!("{} = \"{}\"\n", agent_name, text.replace('"', "\\\""));
                    out = insert_entries_into_section(&out, "[agent-instructions]", &new_entry);
                }
            }
        }

        if out != existing {
            let _ = std::fs::write(&path, out);
        }
    }
}

/// Write computed agent→skill mappings into the project vstack.toml.
///
/// For each agent: if the project toml already has an `[agent-skills]` entry,
/// preserve it (the user may have added or removed skills).  For agents that
/// have NO entry yet, write the computed list from source mapping.
///
/// This must be called AFTER `ensure_project_config` and AFTER the skill
/// mapping is computed.
pub fn write_agent_skills(
    project_root: &Path,
    agent_skill_map: &HashMap<String, Vec<String>>,
) {
    let path = project_root.join("vstack.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    // Parse the existing file to discover which agents already have entries.
    // We only ADD agents that are missing — never clobber user edits.
    let parsed: ProjectConfig = toml::from_str(&existing).unwrap_or_default();

    // Sort agents for deterministic output
    let mut agents: Vec<&String> = agent_skill_map.keys().collect();
    agents.sort();

    let mut new_entries = String::new();
    for agent in agents {
        if parsed.agent_skills.contains_key(agent.as_str()) {
            continue; // User's list is authoritative — don't overwrite
        }
        let skills = &agent_skill_map[agent];
        new_entries.push_str(&format!("{} = [", agent));
        if skills.is_empty() {
            new_entries.push_str("]\n");
        } else {
            new_entries.push('\n');
            for s in skills {
                new_entries.push_str(&format!("    \"{}\",\n", s));
            }
            new_entries.push_str("]\n");
        }
    }

    if new_entries.is_empty() {
        return;
    }

    // Insert the new entries into the [agent-skills] section
    let out = insert_entries_into_section(&existing, "[agent-skills]", &new_entries);
    if out != existing {
        let _ = std::fs::write(&path, out);
    }
}

/// Write `[agent-skills-optional]` entries to the project's vstack.toml.
/// Only adds agents that don't already have an entry — never overwrites user edits.
pub fn write_agent_skills_optional(
    project_root: &Path,
    agent_optional_map: &HashMap<String, Vec<crate::mapping::OptionalSkill>>,
) {
    if agent_optional_map.is_empty() {
        return;
    }
    let path = project_root.join("vstack.toml");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    let parsed: ProjectConfig = toml::from_str(&existing).unwrap_or_default();

    // Ensure the section header exists
    let mut content = existing.clone();
    if !content.contains("[agent-skills-optional]") {
        content.push_str("\n\n# ── Optional Skills ──────────────────────────────────\n");
        content.push_str("# Specialist skills loaded on demand. The agent gets a\n");
        content.push_str("# \"Load When Needed\" table. Edit `when` descriptions\n");
        content.push_str("# or remove entries, then run `vstack refresh`.\n");
        content.push_str("#\n");
        content.push_str("[agent-skills-optional]\n");
    }

    let mut agents: Vec<&String> = agent_optional_map.keys().collect();
    agents.sort();

    let mut new_entries = String::new();
    for agent in agents {
        if parsed.agent_skills_optional.contains_key(agent.as_str()) {
            continue;
        }
        let skills = &agent_optional_map[agent];
        if skills.is_empty() {
            continue;
        }
        new_entries.push_str(&format!("{} = [\n", agent));
        for s in skills {
            let when = s.when.replace('"', "\\\"");
            new_entries.push_str(&format!(
                "    {{ skill = \"{}\", when = \"{}\" }},\n",
                s.skill, when
            ));
        }
        new_entries.push_str("]\n");
    }

    if new_entries.is_empty() {
        return;
    }

    let out = insert_entries_into_section(&content, "[agent-skills-optional]", &new_entries);
    if out != existing {
        let _ = std::fs::write(&path, out);
    }
}

/// Create or update vstack.toml at the project root.
///
/// - If the file doesn't exist, generates a full template with commented placeholders.
/// - If the file exists, appends commented placeholders for any new agents/skills
///   not already mentioned, and updates the installed-skills reference block.
///   Never modifies existing user content.
pub fn ensure_project_config(project_root: &Path, agents: &[String], skills: &[String]) {
    let path = project_root.join("vstack.toml");

    if path.exists() {
        update_project_config(&path, agents, skills);
    } else {
        create_project_config(&path, agents, skills);
    }
}

fn create_project_config(path: &Path, agents: &[String], skills: &[String]) {
    let mut out = String::new();

    out.push_str("# ─────────────────────────────────────────────────────\n");
    out.push_str("# vstack.toml — project-level agent customization\n");
    out.push_str("#\n");
    out.push_str("# Customize agent behavior for this project. These\n");
    out.push_str("# settings are merged into generated agent files on\n");
    out.push_str("# every install and refresh.\n");
    out.push_str("#\n");
    out.push_str("# After editing, run:  vstack refresh\n");
    out.push_str("# ─────────────────────────────────────────────────────\n");
    out.push('\n');

    // ── agent-guidance ──
    out.push_str("\n# ── Execute on Launch ─────────────────────────────────\n");
    out.push_str("# Adds a \"## Execute on Launch\" section near the top\n");
    out.push_str("# of each agent file. Defines what the agent should\n");
    out.push_str("# do when it is first invoked in your project.\n");
    out.push_str("#\n");
    out.push_str("# For multi-line values, use triple quotes:\n");
    out.push_str("#   agent = \"\"\"\n");
    out.push_str("#   First line.\n");
    out.push_str("#   Second line.\n");
    out.push_str("#   \"\"\"\n");
    out.push_str("#\n");
    out.push_str("[agent-guidance]\n\n");
    for (i, name) in agents.iter().enumerate() {
        out.push_str(&format!("{} = \"\"\n", name));
        if i + 1 < agents.len() {
            out.push('\n');
        }
    }

    // ── agent-instructions ──
    out.push_str("\n\n# ── Additional Instructions ──────────────────────────\n");
    out.push_str("# Adds a \"## Additional Instructions\" section at the\n");
    out.push_str("# bottom of each agent file. Project-specific rules,\n");
    out.push_str("# conventions, or reminders for this agent.\n");
    out.push_str("#\n");
    out.push_str("[agent-instructions]\n\n");
    for (i, name) in agents.iter().enumerate() {
        out.push_str(&format!("{} = \"\"\n", name));
        if i + 1 < agents.len() {
            out.push('\n');
        }
    }

    // ── skill-instructions ──
    out.push_str("\n\n# ── Skill Instructions ────────────────────────────────\n");
    out.push_str("# Adds a \"## Project Instructions\" section at the\n");
    out.push_str("# bottom of each skill's SKILL.md. Project-specific\n");
    out.push_str("# context for how this skill applies to your codebase.\n");
    out.push_str("# Won't overwrite the skill author's own instructions.\n");
    out.push_str("#\n");
    out.push_str("[skill-instructions]\n\n");
    for (i, name) in skills.iter().enumerate() {
        out.push_str(&format!("{} = \"\"\n", name));
        if i + 1 < skills.len() {
            out.push('\n');
        }
    }

    // ── agent-skills ──
    out.push_str("\n\n# ── Agent Skills ─────────────────────────────────────\n");
    out.push_str("# Skills attached to each agent's frontmatter.\n");
    out.push_str("# This is the single source of truth — add or remove\n");
    out.push_str("# skills here and run `vstack refresh` to apply.\n");
    out.push_str("#\n");
    out.push_str("# Populated automatically at install time from source\n");
    out.push_str("# mappings. You can freely add your own skills to any\n");
    out.push_str("# agent's list (they don't need to be in the vstack\n");
    out.push_str("# repo — local skill directories work too).\n");
    out.push_str("#\n");
    out.push_str("[agent-skills]\n");
    // Actual skill lists are written by write_agent_skills() after
    // the mapping is computed, so we just emit the section header here.

    // ── agent-skills-optional ──
    out.push_str("\n\n# ── Optional Skills ──────────────────────────────────\n");
    out.push_str("# Specialist skills loaded on demand. The agent gets a\n");
    out.push_str("# \"Load When Needed\" table. Edit `when` descriptions\n");
    out.push_str("# or remove entries, then run `vstack refresh`.\n");
    out.push_str("#\n");
    out.push_str("[agent-skills-optional]\n");
    // Actual entries are written by write_agent_skills_optional().

    // ── custom-hooks ──
    out.push_str("\n\n# ── Custom Hooks ─────────────────────────────────────\n");
    out.push_str("# Project-local hooks not from the vstack source repo.\n");
    out.push_str("# Each hook needs: event, command, and optional matcher.\n");
    out.push_str("#\n");
    out.push_str("# [[custom-hooks]]\n");
    out.push_str("# event = \"PreToolUse\"      # PreToolUse | PostToolUse | PostCompact | TaskCompleted\n");
    out.push_str("# matcher = \"Bash\"           # optional: Bash | Edit|Write | (omit for all)\n");
    out.push_str("# command = \"./scripts/my-hook.sh\"\n");
    out.push_str("# description = \"What this hook does\"     # inlined as instructions in non-Claude-Code harnesses\n");
    out.push_str("# agents = \"all\"             # \"all\", a role (\"engineer\"), or a list [\"rust\", \"iced\"]\n");

    append_skills_reference(&mut out, skills);
    let _ = std::fs::write(path, out);
}

fn update_project_config(path: &Path, agents: &[String], skills: &[String]) {
    let Ok(existing) = std::fs::read_to_string(path) else {
        return;
    };

    // Find agents not already mentioned as a TOML key (commented or active).
    let new_agents: Vec<&String> = agents
        .iter()
        .filter(|name| is_new_key(&existing, name))
        .collect();

    // Find skills not already mentioned
    let new_skills: Vec<&String> = skills
        .iter()
        .filter(|name| is_new_key(&existing, name))
        .collect();

    // Strip old skills reference block and re-append with current list
    let content = strip_skills_reference(&existing);
    let mut out = content.trim_end().to_string();
    out.push('\n');

    let mut all_new_keys: Vec<(&str, Vec<&String>)> = Vec::new();
    if !new_agents.is_empty() {
        all_new_keys.push(("[agent-guidance]", new_agents.clone()));
        all_new_keys.push(("[agent-instructions]", new_agents));
    }
    if !new_skills.is_empty() {
        all_new_keys.push(("[skill-instructions]", new_skills));
    }

    for (section, keys) in all_new_keys {
        out = insert_keys_into_section(&out, section, &keys);
    }

    append_skills_reference(&mut out, skills);
    // Only write if content actually changed to avoid bumping mtime,
    // which would make staleness checks flag everything as outdated.
    if out != existing {
        let _ = std::fs::write(path, out);
    }
}

/// Returns true if a name does NOT appear as a TOML key in the file.
fn is_new_key(content: &str, name: &str) -> bool {
    let patterns = [
        format!("{} =", name),
        format!("{}=", name),
        format!("# {} =", name),
        format!("# {}=", name),
    ];
    !patterns.iter().any(|p| content.contains(p))
}

fn append_skills_reference(out: &mut String, skills: &[String]) {
    if !skills.is_empty() {
        out.push_str("\n\n# ── Installed skills (reference) ─────────────────────\n");
        for name in skills {
            out.push_str(&format!("#   {}\n", name));
        }
    }
}

/// Insert new keys into a specific TOML section, preserving all other content.
fn insert_keys_into_section(content: &str, section_header: &str, new_keys: &[&String]) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut result: Vec<String> = Vec::new();
    let mut i = 0;
    let mut found = false;

    while i < lines.len() {
        let trimmed = lines[i].trim();
        result.push(lines[i].to_string());

        if trimmed == section_header {
            found = true;
            // Scan forward past existing keys in this section
            i += 1;
            while i < lines.len() {
                let next = lines[i].trim();
                let is_key_line = next.contains(" = ") || next.contains("= ");
                let is_comment = next.starts_with('#');

                if next.starts_with('[') && !next.starts_with("# [") {
                    break;
                }
                if next.is_empty() || (is_comment && next.starts_with("# ──")) {
                    break;
                }

                result.push(lines[i].to_string());

                if !is_key_line && !is_comment {
                    i += 1;
                    break;
                }
                i += 1;
            }

            for name in new_keys {
                result.push(format!("{} = \"\"", name));
            }
            continue;
        }

        i += 1;
    }

    // If the section didn't exist, create it at the end
    if !found {
        result.push(String::new());
        result.push(section_header.to_string());
        for name in new_keys {
            result.push(format!("{} = \"\"", name));
        }
    }

    result.join("\n")
}

/// Insert raw TOML text after existing keys in a `[section]`, preserving all
/// comments and surrounding content.  If the section doesn't exist, appends it.
fn insert_entries_into_section(content: &str, section_header: &str, entries: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut result: Vec<String> = Vec::new();
    let mut i = 0;
    let mut inserted = false;

    while i < lines.len() {
        let trimmed = lines[i].trim();
        result.push(lines[i].to_string());

        if trimmed == section_header {
            // Scan forward past existing keys/values (including multi-line arrays)
            i += 1;
            while i < lines.len() {
                let next = lines[i].trim();
                // Stop at next section header or section-separator comment
                if next.starts_with('[') && !next.starts_with("# [") {
                    break;
                }
                if next.starts_with("# ──") {
                    break;
                }
                // Stop at blank line that isn't inside a multi-line array
                if next.is_empty() {
                    break;
                }
                result.push(lines[i].to_string());
                i += 1;
            }
            // Insert new entries here, right after existing keys
            for line in entries.lines() {
                result.push(line.to_string());
            }
            inserted = true;
            continue;
        }

        i += 1;
    }

    if !inserted {
        result.push(String::new());
        result.push(section_header.to_string());
        for line in entries.lines() {
            result.push(line.to_string());
        }
    }

    result.join("\n")
}

fn strip_skills_reference(content: &str) -> String {
    // Remove the skills reference block — try both old and new header formats.
    for marker in [
        "# ── Installed skills (reference)",
        "# Installed skills (for reference",
    ] {
        if let Some(pos) = content.find(marker) {
            let after = &content[pos..];
            let all_comments = after
                .lines()
                .all(|line| line.starts_with('#') || line.trim().is_empty());
            if all_comments {
                return content[..pos].to_string();
            }
        }
    }
    content.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_config_parses_all_sections() {
        let toml = r#"
[agent-skills]
rust = ["rust-arch", "rust-async", "my-custom-skill"]

[agent-guidance]
rust = "Use when working on backend Rust services."

[agent-instructions]
rust = "Always run clippy before committing."
"#;
        let config: ProjectConfig = toml::from_str(toml).unwrap();
        let skills = config.agent_skills_for("rust").unwrap();
        assert_eq!(skills.len(), 3);
        assert_eq!(skills[0], "rust-arch");
        assert_eq!(skills[2], "my-custom-skill");

        assert_eq!(
            config.guidance_for("rust"),
            Some("Use when working on backend Rust services.")
        );
        assert_eq!(
            config.instructions_for("rust"),
            Some("Always run clippy before committing.")
        );

        // Unknown agent returns None
        assert!(config.agent_skills_for("unknown").is_none());
        assert!(config.guidance_for("unknown").is_none());
        assert!(config.instructions_for("unknown").is_none());
    }

    #[test]
    fn project_config_missing_file_returns_default() {
        let config = ProjectConfig::load(std::path::Path::new("/nonexistent/path"));
        assert!(config.agent_skills.is_empty());
        assert!(config.agent_guidance.is_empty());
        assert!(config.agent_instructions.is_empty());
    }

    #[test]
    fn project_config_agent_skills_authoritative() {
        // Project [agent-skills] is the single source of truth
        let toml = r#"
[agent-skills]
iced = ["iced-rs", "trading-design", "my-custom"]

[agent-guidance]
rust = "Use for Rust work."
"#;
        let config: ProjectConfig = toml::from_str(toml).unwrap();
        assert_eq!(config.guidance_for("rust"), Some("Use for Rust work."));
        let iced_skills = config.agent_skills_for("iced").unwrap();
        assert_eq!(iced_skills, &["iced-rs", "trading-design", "my-custom"]);
        // Agent without entry → None (falls back to source mapping)
        assert!(config.agent_skills_for("rust").is_none());
    }

    #[test]
    fn update_project_config_appends_new_agents() {
        let dir = std::env::temp_dir().join(format!(
            "vstack_test_update_config_{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("vstack.toml");

        // Create initial config with "rust" agent
        create_project_config(&path, &["rust".into()], &["rust-arch".into()]);
        let initial = std::fs::read_to_string(&path).unwrap();
        assert!(initial.contains("rust = \"\""));
        assert!(initial.contains("#   rust-arch"));

        // Update with "rust" + new "iced" agent and new skill
        update_project_config(
            &path,
            &["rust".into(), "iced".into()],
            &["rust-arch".into(), "trading-design".into()],
        );
        let updated = std::fs::read_to_string(&path).unwrap();

        // Original rust placeholders preserved
        assert!(updated.contains("rust = \"\""));
        // New iced agent added (uncommented, empty value)
        assert!(updated.contains("iced = \"\""));
        // Skills reference updated
        assert!(updated.contains("#   trading-design"));
        // Old skills still listed
        assert!(updated.contains("#   rust-arch"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_project_config_preserves_user_edits() {
        let dir = std::env::temp_dir().join(format!(
            "vstack_test_preserve_edits_{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("vstack.toml");

        // Simulate user-edited file with active (uncommented) config
        let user_content = r#"[agent-guidance]
rust = "Use for my backend services."

[agent-instructions]
rust = "Always use thiserror for errors."
"#;
        std::fs::write(&path, user_content).unwrap();

        // Update with rust (already present) + new iced
        update_project_config(
            &path,
            &["rust".into(), "iced".into()],
            &["trading-design".into()],
        );
        let updated = std::fs::read_to_string(&path).unwrap();

        // User content preserved
        assert!(updated.contains("rust = \"Use for my backend services.\""));
        assert!(updated.contains("rust = \"Always use thiserror for errors.\""));
        // New agent added (uncommented, empty value)
        assert!(updated.contains("iced = \"\""));
        // Rust not duplicated
        let iced_section = updated.find("iced = \"\"").unwrap();
        assert!(
            !updated[iced_section..].contains("rust = \"\""),
            "rust should not appear in new agents section"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_project_config_no_change_when_all_present() {
        let dir = std::env::temp_dir().join(format!(
            "vstack_test_no_change_{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("vstack.toml");

        create_project_config(&path, &["rust".into()], &["rust-arch".into()]);
        let before = std::fs::read_to_string(&path).unwrap();

        // Same agents/skills — should not add "New agents" section
        update_project_config(&path, &["rust".into()], &["rust-arch".into()]);
        let after = std::fs::read_to_string(&path).unwrap();

        assert!(!after.contains("── New agents"));
        // Content should be essentially the same (skills ref regenerated but identical)
        assert_eq!(before.trim(), after.trim());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
