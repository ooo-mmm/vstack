use anyhow::{Context, Result};
use std::path::Path;

struct Section {
    number: u32,
    name: String,
    prefix: String,
    impact: String,
}

struct RuleFile {
    title: String,
    body: String,
}

/// Check if a skill directory uses the rules pattern.
pub fn has_rules(skill_dir: &Path) -> bool {
    skill_dir.join("rules").join("_sections.md").exists()
}

/// Rebuild AGENTS.md from rule files + project-rules.
/// Returns Ok(true) if rebuilt, Ok(false) if no rules pattern.
pub fn rebuild_agents_md(skill_dir: &Path) -> Result<bool> {
    let sections_path = skill_dir.join("rules").join("_sections.md");
    if !sections_path.exists() {
        return Ok(false);
    }

    let sections = parse_sections(&sections_path)?;
    if sections.is_empty() {
        return Ok(false);
    }

    let rules_dir = skill_dir.join("rules");
    let mut section_rules: Vec<Vec<RuleFile>> = (0..sections.len()).map(|_| Vec::new()).collect();

    // Discover and assign rule files to sections
    for entry in std::fs::read_dir(&rules_dir)? {
        let entry = entry?;
        let fname = entry.file_name().to_string_lossy().to_string();
        if fname.starts_with('_') || !fname.ends_with(".md") {
            continue;
        }

        let rule = parse_rule_file(&entry.path())?;

        // Match to section by filename prefix
        let stem = fname.trim_end_matches(".md");
        if let Some(idx) = sections
            .iter()
            .position(|s| stem.starts_with(&format!("{}-", s.prefix)))
        {
            section_rules[idx].push(rule);
        }
    }

    // Sort rules within each section alphabetically by title
    for rules in &mut section_rules {
        rules.sort_by(|a, b| a.title.cmp(&b.title));
    }

    // Read existing AGENTS.md for header and footer
    let agents_path = skill_dir.join("AGENTS.md");
    let (header, footer) = if agents_path.exists() {
        let content = std::fs::read_to_string(&agents_path)?;
        extract_header_footer(&content, &sections)
    } else {
        (default_header(skill_dir), String::new())
    };

    // Discover project rules
    let project_rules_dir = skill_dir.join("project-rules");
    let project_rules = if project_rules_dir.is_dir() {
        discover_project_rules(&project_rules_dir)?
    } else {
        Vec::new()
    };

    // Assemble
    let mut out = String::new();

    // Header (everything before TOC)
    out.push_str(&header);
    if !header.ends_with('\n') {
        out.push('\n');
    }

    // Table of Contents
    out.push_str("\n## Table of Contents\n\n");
    for (i, section) in sections.iter().enumerate() {
        let anchor = slug(&format!("{}-{}", section.number, section.name));
        out.push_str(&format!(
            "{}. [{}](#{}) — **{}**\n",
            section.number, section.name, anchor, section.impact
        ));
        for rule in &section_rules[i] {
            let rule_anchor = slug(&rule.title);
            out.push_str(&format!("   - [{}](#{})\n", rule.title, rule_anchor));
        }
    }
    if !project_rules.is_empty() {
        let proj_num = sections.last().map(|s| s.number + 1).unwrap_or(1);
        out.push_str(&format!(
            "{}. [Project Rules](#{}) — **PROJECT**\n",
            proj_num,
            slug(&format!("{}-project-rules", proj_num))
        ));
    }
    // Footer TOC entries (detect from footer's ## headings)
    let footer_offset = sections.last().map(|s| s.number + 1).unwrap_or(1)
        + if project_rules.is_empty() { 0 } else { 1 };
    let mut footer_num = footer_offset;
    for line in footer.lines() {
        if line.starts_with("## ") {
            let title = line[3..].trim();
            let anchor = slug(title);
            out.push_str(&format!(
                "{}. [{}](#{})\n",
                footer_num, title, anchor
            ));
            footer_num += 1;
        }
    }
    out.push_str("\n---\n");

    // Rule sections
    for (i, section) in sections.iter().enumerate() {
        out.push_str(&format!(
            "\n## {}. {} ({})\n\n",
            section.number, section.name, section.impact
        ));
        for rule in &section_rules[i] {
            out.push_str(&format!("### {}\n\n", rule.title));
            out.push_str(&rule.body);
            if !rule.body.ends_with('\n') {
                out.push('\n');
            }
            out.push('\n');
        }
    }

    // Project rules section
    if !project_rules.is_empty() {
        let proj_num = sections.last().map(|s| s.number + 1).unwrap_or(1);
        out.push_str(&format!("\n## {}. Project Rules\n\n", proj_num));
        for rule in &project_rules {
            out.push_str(&format!("### {}\n\n", rule.title));
            out.push_str(&rule.body);
            if !rule.body.ends_with('\n') {
                out.push('\n');
            }
            out.push('\n');
        }
    }

    // Footer
    if !footer.is_empty() {
        out.push('\n');
        out.push_str(&footer);
        if !footer.ends_with('\n') {
            out.push('\n');
        }
    }

    std::fs::write(&agents_path, &out)?;
    Ok(true)
}

fn parse_sections(path: &Path) -> Result<Vec<Section>> {
    let content = std::fs::read_to_string(path).context("reading _sections.md")?;
    let mut sections = Vec::new();
    let mut lines = content.lines().peekable();

    while let Some(line) = lines.next() {
        // Match: ## N. Section Name (prefix-)
        let re = regex_lite::Regex::new(r"^## (\d+)\.\s+(.+?)\s+\((\w+)-?\)").unwrap();
        if let Some(caps) = re.captures(line) {
            let number: u32 = caps[1].parse().unwrap_or(0);
            let name = caps[2].to_string();
            let prefix = caps[3].to_string();
            let mut impact = String::new();

            // Read impact from next non-blank line
            while let Some(next) = lines.peek() {
                if next.starts_with("**Impact:**") {
                    impact = next
                        .trim_start_matches("**Impact:**")
                        .trim()
                        .to_string();
                    lines.next();
                    break;
                } else if next.trim().is_empty() {
                    lines.next();
                } else {
                    break;
                }
            }

            sections.push(Section {
                number,
                name,
                prefix,
                impact,
            });
        }
    }

    Ok(sections)
}

fn parse_rule_file(path: &Path) -> Result<RuleFile> {
    let content = std::fs::read_to_string(path)?;
    let (_, body) = crate::frontmatter::split_yaml_frontmatter(&content)
        .unwrap_or_else(|_| (String::new(), content.clone()));

    // Extract title from first ## heading
    let title = body
        .lines()
        .find(|l| l.starts_with("## "))
        .map(|l| l[3..].trim().to_string())
        .unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        });

    // Strip the ## heading line, keep everything after
    let body_after_heading = if let Some(pos) = body.find("\n") {
        let first_line = &body[..pos];
        if first_line.starts_with("## ") {
            body[pos..].trim_start_matches('\n').to_string()
        } else {
            body.to_string()
        }
    } else {
        body.to_string()
    };

    Ok(RuleFile {
        title,
        body: body_after_heading.trim().to_string(),
    })
}

fn discover_project_rules(dir: &Path) -> Result<Vec<RuleFile>> {
    let mut rules = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "md") {
            rules.push(parse_rule_file(&path)?);
        }
    }
    rules.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(rules)
}

/// Extract header (before first `## N.` section) and footer (after last rule section).
fn extract_header_footer(content: &str, sections: &[Section]) -> (String, String) {
    let lines: Vec<&str> = content.lines().collect();

    // Find header end: first line matching `## N. `
    let header_end = lines
        .iter()
        .position(|l| {
            l.starts_with("## ")
                && l.chars()
                    .nth(3)
                    .is_some_and(|c| c.is_ascii_digit())
        })
        .unwrap_or(lines.len());

    // Also strip TOC if present (it's auto-generated)
    let header_end = lines[..header_end]
        .iter()
        .position(|l| *l == "## Table of Contents")
        .unwrap_or(header_end);

    let header = lines[..header_end].join("\n").trim_end().to_string();

    // Find footer start: first `## ` heading AFTER the last known numbered
    // section that isn't itself a known section. We scan backwards from the end
    // to find where the last known section is, then scan forward from there.
    let max_section_num = sections.iter().map(|s| s.number).max().unwrap_or(0);
    let mut last_known_section_line = header_end;

    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("## ")
            && line.chars().nth(3).is_some_and(|c| c.is_ascii_digit())
        {
            let num_str: String = line[3..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(num) = num_str.parse::<u32>() {
                if num <= max_section_num {
                    last_known_section_line = i;
                }
            }
        }
    }

    // Scan forward from the last known section to find the footer
    let mut footer_start = lines.len();
    for (i, line) in lines.iter().enumerate().skip(last_known_section_line + 1) {
        if line.starts_with("## ") {
            if let Some(num_char) = line.chars().nth(3) {
                if num_char.is_ascii_digit() {
                    let num_str: String = line[3..]
                        .chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect();
                    if let Ok(num) = num_str.parse::<u32>() {
                        if num <= max_section_num {
                            continue; // still a known section (shouldn't happen but be safe)
                        }
                    }
                }
            }
            // Any ## heading after the last known section = footer
            footer_start = i;
            break;
        }
    }

    let footer = lines[footer_start..].join("\n").trim().to_string();

    (header, footer)
}

fn default_header(skill_dir: &Path) -> String {
    let name = skill_dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let title = name
        .split('-')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(first) => {
                    first.to_uppercase().to_string() + c.as_str()
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!("# {}\n", title)
}

fn slug(text: &str) -> String {
    let raw: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    // Collapse runs of hyphens
    let mut result = String::new();
    let mut prev_hyphen = false;
    for c in raw.chars() {
        if c == '-' {
            if !prev_hyphen {
                result.push(c);
            }
            prev_hyphen = true;
        } else {
            result.push(c);
            prev_hyphen = false;
        }
    }
    result.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sections_basic() {
        let dir = std::env::temp_dir().join(format!("vstack_rules_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("_sections.md");
        std::fs::write(
            &path,
            "## 1. Workflow (wf-)\n\n**Impact:** CRITICAL\n\n## 2. State (state-)\n\n**Impact:** HIGH\n",
        )
        .unwrap();

        let sections = parse_sections(&path).unwrap();
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].name, "Workflow");
        assert_eq!(sections[0].prefix, "wf");
        assert_eq!(sections[0].impact, "CRITICAL");
        assert_eq!(sections[1].name, "State");
        assert_eq!(sections[1].prefix, "state");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_rule_file_strips_heading() {
        let dir = std::env::temp_dir().join(format!("vstack_rule_parse_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("wf-test.md");
        std::fs::write(
            &path,
            "---\ntitle: Test Rule\nimpact: HIGH\n---\n\n## Test Rule\n\n**Impact: HIGH (bad stuff)**\n\nDo the thing.\n",
        )
        .unwrap();

        let rule = parse_rule_file(&path).unwrap();
        assert_eq!(rule.title, "Test Rule");
        assert!(rule.body.contains("**Impact: HIGH"));
        assert!(rule.body.contains("Do the thing."));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn slug_generation() {
        assert_eq!(slug("1. Workflow Execution"), "1-workflow-execution");
        assert_eq!(slug("Pre-Create All Tasks"), "pre-create-all-tasks");
    }

    #[test]
    fn full_rebuild() {
        let dir = std::env::temp_dir().join(format!("vstack_rebuild_{}", std::process::id()));
        let rules = dir.join("rules");
        let _ = std::fs::create_dir_all(&rules);

        // Create _sections.md
        std::fs::write(
            rules.join("_sections.md"),
            "## 1. Core (core-)\n\n**Impact:** CRITICAL\n",
        )
        .unwrap();

        // Create a rule file
        std::fs::write(
            rules.join("core-my-rule.md"),
            "---\ntitle: My Rule\nimpact: CRITICAL\n---\n\n## My Rule\n\nDo the thing.\n",
        )
        .unwrap();

        // Create existing AGENTS.md with header and footer
        std::fs::write(
            dir.join("AGENTS.md"),
            "# Test Skill\n\nAbstract here.\n\n## 1. Core (CRITICAL)\n\n### My Rule\n\nOld content.\n\n## Scripts\n\nSome scripts.\n",
        )
        .unwrap();

        let result = rebuild_agents_md(&dir).unwrap();
        assert!(result);

        let output = std::fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert!(output.contains("# Test Skill"));
        assert!(output.contains("Abstract here."));
        assert!(output.contains("## 1. Core (CRITICAL)"));
        assert!(output.contains("### My Rule"));
        assert!(output.contains("Do the thing."));
        assert!(output.contains("## Scripts"));
        assert!(output.contains("Some scripts."));
        // Old content replaced
        assert!(!output.contains("Old content."));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebuild_with_project_rules() {
        let dir = std::env::temp_dir().join(format!("vstack_projrules_{}", std::process::id()));
        let rules = dir.join("rules");
        let proj_rules = dir.join("project-rules");
        let _ = std::fs::create_dir_all(&rules);
        let _ = std::fs::create_dir_all(&proj_rules);

        std::fs::write(
            rules.join("_sections.md"),
            "## 1. Core (core-)\n\n**Impact:** CRITICAL\n",
        )
        .unwrap();

        std::fs::write(
            rules.join("core-base.md"),
            "---\ntitle: Base Rule\nimpact: HIGH\n---\n\n## Base Rule\n\nBase content.\n",
        )
        .unwrap();

        std::fs::write(
            proj_rules.join("my-custom.md"),
            "---\ntitle: My Custom Rule\nimpact: HIGH\n---\n\n## My Custom Rule\n\nCustom content.\n",
        )
        .unwrap();

        let result = rebuild_agents_md(&dir).unwrap();
        assert!(result);

        let output = std::fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert!(
            output.contains("## 2. Project Rules"),
            "Should have Project Rules section. Output:\n{}",
            &output[output.len().saturating_sub(500)..]
        );
        assert!(output.contains("### My Custom Rule"));
        assert!(output.contains("Custom content."));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
