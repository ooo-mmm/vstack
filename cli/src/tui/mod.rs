mod install_flow;
mod multiselect;
mod render;
mod state;
mod summary;

pub use multiselect::{ItemGroup, RepoOption, SelectItem, Tab};

pub use install_flow::run_install_flow;
pub use summary::run_summary_screen;

use crate::agent::Agent;
use crate::config::InstallMethod;
use crate::harness::Harness;
use crate::hook::Hook;
use crate::skill::Skill;

#[derive(PartialEq)]
pub enum SummaryAction {
    Exit,
    InstallMore,
}

pub struct SummaryData {
    pub agents: Vec<String>,
    pub skills: Vec<String>,
    pub hooks: Vec<(String, String)>,
    pub updated: Vec<String>,
    pub harnesses: Vec<String>,
    pub notes: Vec<String>,
    pub method: String,
    pub scope: String,
}

pub struct DiscoveredItems {
    pub agents: Vec<Agent>,
    pub skills: Vec<Skill>,
    pub hooks: Vec<Hook>,
}

pub struct InstallSelections {
    pub agents: Vec<Agent>,
    pub skills: Vec<Skill>,
    pub hooks: Vec<Hook>,
    pub harnesses: Vec<Harness>,
    pub skipped_harnesses: Vec<String>,
    pub global: bool,
    pub method: InstallMethod,
    pub update_cli: bool,
}

pub struct SourceSelectorData {
    pub current_label: String,
    pub options: Vec<RepoOption>,
}

pub enum InstallFlowResult {
    Cancelled,
    Install(InstallSelections),
    SwitchSource(String),
}
