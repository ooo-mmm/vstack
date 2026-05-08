use crate::agent::{self, Agent, AgentRole};
use crate::hook::Hook;
use anyhow::Result;
use std::path::{Path, PathBuf};

/// Generate a Pi agent file (`<scope>/agents/<name>.md`).
///
/// Pi has no built-in subagents; agent files only act as agent definitions when
/// a Pi package that loads `agents/*.md` is also installed. Even then, the
/// markdown body is the canonical place for vstack-managed prose, so we emit
/// the same "Required Skills" / hook prose / additional instructions sections
/// that other harnesses use.
///
/// Frontmatter format:
/// ```yaml
/// ---
/// name: rust
/// description: "..."
/// deny-tools: subagent, get_subagent_result, steer_subagent, stop_subagent, question
/// model: claude-opus-4-5
/// color: green
/// pane: true
/// ---
/// ```
pub fn generate_agent(
    agent: &Agent,
    dir: &Path,
    skills: &[(String, String)],
    optional_skills: &[(String, String)],
    _hooks: &[Hook],
    extras: &agent::AgentExtras,
) -> Result<PathBuf> {
    std::fs::create_dir_all(dir)?;

    let path = dir.join(format!("{}.md", agent.name));

    let frontmatter = extras.frontmatter_for("pi");
    let model = frontmatter
        .model
        .clone()
        .unwrap_or_else(|| pi_model_for(&agent.model));
    let deny_tools = pi_deny_tools_for(agent, &frontmatter);
    let tools = pi_tools_frontmatter_override(&frontmatter, &deny_tools);

    let mut output = String::new();
    output.push_str("---\n");
    output.push_str(&format!("name: {}\n", agent.name));

    let desc = agent.description.replace('\\', "\\\\").replace('"', "\\\"");
    output.push_str(&format!("description: \"{}\"\n", desc));
    if let Some(tools) = tools.as_ref().filter(|tools| !tools.is_empty()) {
        output.push_str(&format!("tools: {}\n", tools.join(", ")));
    }
    if !deny_tools.is_empty() {
        output.push_str(&format!("deny-tools: {}\n", deny_tools.join(", ")));
    }
    output.push_str(&format!("model: {}\n", model));
    if let Some(color) = frontmatter
        .color
        .as_ref()
        .or(extras.color.as_ref())
        .or(agent.color.as_ref())
    {
        output.push_str(&format!("color: {}\n", color));
    }
    let pane = frontmatter.pane.unwrap_or_else(|| {
        matches!(agent.role, AgentRole::Engineer) || agent.name.eq_ignore_ascii_case("planner")
    });
    if pane {
        output.push_str("pane: true\n");
    }
    output.push_str("---\n\n");

    output.push_str("> **Never edit this file directly.** To make additions or modifications, edit the appropriate section in `./vstack.toml`. Then run `vstack refresh`.\n\n");

    let guidance = agent::guidance_section(extras.guidance.as_deref());
    let skills_section = agent::load_skills_section(skills, optional_skills);
    let combined = format!("{}{}", guidance, skills_section);
    let body = agent::insert_after_intro(&agent.body, &combined);
    let hooks_prose = agent::custom_hooks_section(&extras.custom_hooks);
    let instructions = agent::instructions_section(extras.instructions.as_deref());
    let body = agent::append_section(&body, &hooks_prose);
    let body = agent::append_section(&body, &instructions);
    output.push_str(&body);

    if !output.ends_with('\n') {
        output.push('\n');
    }

    std::fs::write(&path, &output)?;
    Ok(path)
}

/// Map vstack canonical model names to Pi model identifiers.
///
/// Pi defaults to OpenAI models for vstack-managed agents. Pi accepts
/// `provider/model` and an optional `:thinking` shorthand (per the Pi
/// `--model` flag), so we encode the canonical effort level alongside
/// the model id. Users can still override per-agent in source frontmatter.
pub fn pi_model_for(model: &str) -> String {
    match model.to_lowercase().as_str() {
        "opus" => "openai-codex/gpt-5.5:xhigh".into(),
        "sonnet" => "openai-codex/gpt-5.5:high".into(),
        "haiku" => "openai-codex/gpt-5.5:medium".into(),
        other => other.into(),
    }
}

/// Pi tool list for an agent role.
///
/// All agents get broad read/discovery, batching, and web research tools so
/// they can gather current context across project and external sources.
/// All agents get write/edit tools so they can produce report artifacts.
/// Agent prompts still constrain reviewer/manager agents to report-only work.
pub fn pi_tools_for(agent: &Agent, skills: &[(String, String)]) -> Vec<String> {
    let mut tools = match agent.role {
        AgentRole::Engineer | AgentRole::Analyst | AgentRole::Reviewer | AgentRole::Manager => {
            vec!["read", "grep", "find", "ls", "bash", "edit", "write"]
        }
    };

    tools.extend([
        "tool_batch",
        "web_search",
        "web_fetch",
        "web_research",
        "web_answer",
        "code_search",
        "get_web_content",
    ]);

    let skill_names: std::collections::HashSet<&str> =
        skills.iter().map(|(name, _)| name.as_str()).collect();

    if skill_names.contains("project-management")
        || skill_names.contains("orchestration")
        || skill_names.contains("flightdeck")
        || skill_names.contains("issue-lifecycle")
        || skill_names.contains("second-opinion")
    {
        tools.extend(["tasks_write", "bg_task", "bg_status"]);
    }

    if matches!(agent.role, AgentRole::Engineer) {
        tools.extend(["tool_batch", "apply_patch"]);
    }

    dedupe_tools(tools)
}

fn pi_tools_frontmatter_override(
    frontmatter: &agent::AgentFrontmatterOverrides,
    deny_tools: &[String],
) -> Option<Vec<String>> {
    // Default Pi child sessions inherit the parent's active tools and subtract
    // deny-tools, so generated agents do not need a noisy tools allowlist.
    // Keep explicit tools overrides for rare strict allowlists and compatibility
    // with subagentToolAccess=frontmatter.
    frontmatter
        .tools
        .clone()
        .map(|tools| subtract_denied_pi_tools(tools, deny_tools))
}

fn pi_deny_tools_for(agent: &Agent, frontmatter: &agent::AgentFrontmatterOverrides) -> Vec<String> {
    let tools = frontmatter
        .deny_tools
        .clone()
        .unwrap_or_else(|| pi_default_deny_tools_for(agent));
    dedupe_pi_tool_names(tools)
}

fn pi_default_deny_tools_for(agent: &Agent) -> Vec<String> {
    let mut tools = vec![
        "subagent".into(),
        "get_subagent_result".into(),
        "steer_subagent".into(),
        "stop_subagent".into(),
    ];
    if !agent.name.eq_ignore_ascii_case("planner") {
        tools.push("question".into());
    }
    tools
}

fn dedupe_pi_tool_names(tools: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    tools
        .into_iter()
        .filter(|tool| !tool.trim().is_empty())
        .filter(|tool| seen.insert(normalize_pi_tool_name(tool)))
        .collect()
}

fn subtract_denied_pi_tools(tools: Vec<String>, deny_tools: &[String]) -> Vec<String> {
    if deny_tools.is_empty() {
        return tools;
    }
    let denied: std::collections::HashSet<String> = deny_tools
        .iter()
        .map(|tool| normalize_pi_tool_name(tool))
        .filter(|tool| !tool.is_empty())
        .collect();
    tools
        .into_iter()
        .filter(|tool| !denied.contains(&normalize_pi_tool_name(tool)))
        .collect()
}

fn normalize_pi_tool_name(tool: &str) -> String {
    tool.trim().to_ascii_lowercase().replace('-', "_")
}

fn dedupe_tools(tools: Vec<&str>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for tool in tools {
        if seen.insert(tool) {
            out.push(tool.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{Agent, AgentExtras, AgentRole};

    fn agent_fixture(name: &str, role: AgentRole, model: &str) -> Agent {
        Agent {
            name: name.into(),
            description: "Pi test agent".into(),
            model: model.into(),
            role,
            color: Some("green".into()),
            body: format!("# {name}\n\nIntro.\n\n## Capabilities\n\nDoes work.\n"),
            source_path: PathBuf::new(),
        }
    }

    #[test]
    fn pi_model_mapping() {
        assert_eq!(pi_model_for("opus"), "openai-codex/gpt-5.5:xhigh");
        assert_eq!(pi_model_for("sonnet"), "openai-codex/gpt-5.5:high");
        assert_eq!(pi_model_for("haiku"), "openai-codex/gpt-5.5:medium");
        assert_eq!(pi_model_for("custom-id"), "custom-id");
    }

    #[test]
    fn pi_tools_engineer_gets_write_tools() {
        let agent = agent_fixture("rust", AgentRole::Engineer, "opus");
        let tools = pi_tools_for(&agent, &[]);
        assert!(tools.iter().any(|tool| tool == "write"));
        assert!(tools.iter().any(|tool| tool == "edit"));
        assert!(tools.iter().any(|tool| tool == "bash"));
    }

    #[test]
    fn pi_tools_reviewer_can_write_reports() {
        let agent = agent_fixture("reviewer-arch", AgentRole::Reviewer, "sonnet");
        let tools = pi_tools_for(&agent, &[]);
        assert!(tools.iter().any(|tool| tool == "write"));
        assert!(tools.iter().any(|tool| tool == "edit"));
        assert!(tools.iter().any(|tool| tool == "read"));
        assert!(tools.iter().any(|tool| tool == "web_search"));
        assert!(tools.iter().any(|tool| tool == "web_research"));
        assert!(tools.iter().any(|tool| tool == "code_search"));
    }

    #[test]
    fn pi_tools_all_agents_get_web_research() {
        let agent = agent_fixture("scout", AgentRole::Reviewer, "haiku");
        let tools = pi_tools_for(&agent, &[]);
        assert!(tools.iter().any(|tool| tool == "web_research"));
        assert!(tools.iter().any(|tool| tool == "web_search"));
        assert!(tools.iter().any(|tool| tool == "web_fetch"));
        assert!(tools.iter().any(|tool| tool == "web_answer"));
        assert!(tools.iter().any(|tool| tool == "code_search"));
        assert!(tools.iter().any(|tool| tool == "get_web_content"));
    }

    #[test]
    fn pi_tools_do_not_include_recursive_or_prompt_tools() {
        let agent = agent_fixture("generalist", AgentRole::Engineer, "opus");
        let skills = vec![
            ("orchestration".into(), "delegation".into()),
            ("flightdeck".into(), "workflow".into()),
        ];
        let tools = pi_tools_for(&agent, &skills);
        assert!(!tools.iter().any(|tool| tool == "subagent"));
        assert!(!tools.iter().any(|tool| tool == "get_subagent_result"));
        assert!(!tools.iter().any(|tool| tool == "steer_subagent"));
        assert!(!tools.iter().any(|tool| tool == "question"));
        assert!(tools.iter().any(|tool| tool == "tasks_write"));
    }

    #[test]
    fn generate_agent_writes_pi_frontmatter_and_body() {
        let dir = std::env::temp_dir().join(format!("vstack_pi_agent_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let agent = agent_fixture("rust", AgentRole::Engineer, "opus");
        let extras = AgentExtras {
            color: Some("magenta".into()),
            guidance: Some("Read open issues and start.".into()),
            instructions: Some("Run clippy before commits.".into()),
            ..AgentExtras::default()
        };
        let skills = vec![(
            "rust-arch".into(),
            "Architecture patterns for Rust: more details.".into(),
        )];
        let path = generate_agent(&agent, &dir, &skills, &[], &[], &extras).expect("generate ok");

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("name: rust"));
        assert!(content.contains("model: openai-codex/gpt-5.5:xhigh"));
        assert!(content.contains("color: magenta"));
        assert!(!content.lines().any(|line| line.starts_with("tools:")));
        assert!(content.contains(
            "deny-tools: subagent, get_subagent_result, steer_subagent, stop_subagent, question"
        ));
        assert!(content.contains("pane: true"));
        assert!(content.contains("## Launch Instructions"));
        assert!(content.contains("Read open issues and start."));
        assert!(content.contains("## Required Skills"));
        assert!(content.contains("rust-arch"));
        assert!(content.contains("## Additional Instructions"));
        assert!(content.contains("Never edit this file directly"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generate_planner_runs_in_pane_and_keeps_question_available() {
        let dir =
            std::env::temp_dir().join(format!("vstack_pi_agent_planner_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let agent = agent_fixture("planner", AgentRole::Engineer, "sonnet");
        let extras = AgentExtras::default();
        let path = generate_agent(&agent, &dir, &[], &[], &[], &extras).expect("generate ok");

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("pane: true"));
        let deny_line = content
            .lines()
            .find(|line| line.starts_with("deny-tools:"))
            .expect("deny-tools line");
        assert!(deny_line.contains("subagent"));
        assert!(deny_line.contains("get_subagent_result"));
        assert!(deny_line.contains("steer_subagent"));
        assert!(deny_line.contains("stop_subagent"));
        assert!(!deny_line.contains("question"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generate_agent_emits_explicit_tools_override_and_applies_deny_tools() {
        let dir =
            std::env::temp_dir().join(format!("vstack_pi_agent_deny_tools_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let agent = agent_fixture("rust", AgentRole::Engineer, "opus");
        let extras = AgentExtras {
            frontmatter: agent::AgentFrontmatterOverrides {
                tools: Some(vec![
                    "read".into(),
                    "bash".into(),
                    "write".into(),
                    "apply_patch".into(),
                ]),
                deny_tools: Some(vec!["bash".into(), "apply-patch".into()]),
                ..Default::default()
            },
            ..AgentExtras::default()
        };
        let path = generate_agent(&agent, &dir, &[], &[], &[], &extras).expect("generate ok");
        let content = std::fs::read_to_string(&path).unwrap();
        let tools_line = content
            .lines()
            .find(|line| line.starts_with("tools:"))
            .unwrap();
        assert!(!tools_line.contains("bash"));
        assert!(!tools_line.contains("apply_patch"));
        assert!(content.contains("deny-tools: bash, apply-patch"));
        assert!(tools_line.contains("read"));
        assert!(tools_line.contains("write"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generate_agent_reviewer_omits_pane_and_can_write_reports() {
        let dir =
            std::env::temp_dir().join(format!("vstack_pi_agent_reviewer_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let agent = agent_fixture("reviewer-arch", AgentRole::Reviewer, "sonnet");
        let extras = AgentExtras::default();
        let path = generate_agent(&agent, &dir, &[], &[], &[], &extras).expect("generate ok");

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("model: openai-codex/gpt-5.5:high"));
        assert!(!content.lines().any(|line| line.starts_with("tools:")));
        assert!(content.contains(
            "deny-tools: subagent, get_subagent_result, steer_subagent, stop_subagent, question"
        ));
        assert!(!content.contains("pane: true"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
