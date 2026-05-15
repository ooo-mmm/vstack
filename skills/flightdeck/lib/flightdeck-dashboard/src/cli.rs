use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(name = "flightdeck-dashboard")]
#[command(about = "Standalone terminal dashboard for Flightdeck sessions")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Render the dashboard TUI.
    Tui(TuiArgs),
    /// Manage the read-only dashboard daemon.
    Daemon(DaemonArgs),
    /// Print dashboard daemon status.
    Status(SessionArgs),
    /// Back-compat alias: start daemon detached for the session.
    Supervise(SuperviseArgs),
    /// Launch the dashboard window from Flightdeck startup.
    Launch(StubArgs),
}

#[derive(Debug, Args)]
pub struct TuiArgs {
    /// Render a compiled-in demo fixture. Optional NAME defaults to mixed.
    #[arg(long, value_name = "NAME", num_args = 0..=1, default_missing_value = "mixed")]
    pub demo: Option<String>,
    /// Read a concrete Flightdeck master-state JSON file.
    #[arg(long, value_name = "PATH")]
    pub state_file: Option<PathBuf>,
    /// Read state for a Flightdeck tmux session.
    #[arg(long, value_name = "NAME")]
    pub session: Option<String>,
    /// Subscribe to a dashboard daemon Unix socket.
    #[arg(long, value_name = "PATH")]
    pub socket: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct DaemonArgs {
    #[command(subcommand)]
    pub action: DaemonAction,
}

#[derive(Debug, Subcommand)]
pub enum DaemonAction {
    /// Start the read-only dashboard daemon.
    Start(DaemonStartArgs),
    /// Back-compat alias: start the daemon in the foreground.
    Foreground(DaemonStartArgs),
    /// Stop the daemon for a session.
    Stop(SessionArgs),
    /// Print daemon status JSON.
    Status(SessionArgs),
    /// Print health summary.
    Health(SessionArgs),
    /// Drain queued daemon events.
    Events(SessionArgs),
    /// Acknowledge queued daemon events and clear wake-pending markers.
    Ack(SessionArgs),
    /// Tail daemon output streams.
    Tail(DaemonTailArgs),
}

#[derive(Debug, Args, Clone)]
pub struct DaemonStartArgs {
    /// Detach into a background process.
    #[arg(long)]
    pub detach: bool,
    /// Flightdeck tmux session name/id/key.
    #[arg(long, value_name = "NAME")]
    pub session: Option<String>,
    /// Read a concrete Flightdeck master-state JSON file.
    #[arg(long, value_name = "PATH")]
    pub state_file: Option<PathBuf>,
}

#[derive(Debug, Args, Clone)]
pub struct SessionArgs {
    /// Flightdeck tmux session name/id/key.
    #[arg(long, value_name = "NAME")]
    pub session: Option<String>,
}

#[derive(Debug, Args, Clone)]
pub struct SuperviseArgs {
    /// Flightdeck tmux session name/id/key.
    #[arg(long, value_name = "NAME")]
    pub session: Option<String>,
}

#[derive(Debug, Args)]
pub struct DaemonTailArgs {
    /// Flightdeck tmux session name/id/key.
    #[arg(long, value_name = "NAME")]
    pub session: Option<String>,
    /// Stream to tail.
    #[arg(long, value_enum, default_value_t = DaemonTailSource::State)]
    pub source: DaemonTailSource,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum DaemonTailSource {
    State,
    Events,
    Wake,
}

#[derive(Debug, Args)]
pub struct StubArgs {}

impl TuiArgs {
    #[must_use]
    pub fn demo_name(&self) -> &str {
        self.demo.as_deref().unwrap_or("mixed")
    }

    #[must_use]
    pub fn wants_live_state(&self) -> bool {
        self.socket.is_some()
            || self.state_file.is_some()
            || self.session.is_some()
            || std::env::var_os("TMUX").is_some()
    }
}
