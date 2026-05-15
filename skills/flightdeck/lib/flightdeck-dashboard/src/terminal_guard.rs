use std::io::{self, Stdout};

use color_eyre::eyre::{eyre, Result};
use crossterm::cursor::Show;
use crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

#[derive(Default)]
pub struct TerminalGuard {
    terminal: Option<Terminal<CrosstermBackend<Stdout>>>,
    raw_enabled: bool,
    alt_screen: bool,
    mouse_capture: bool,
}

impl TerminalGuard {
    pub fn enter() -> Result<Self> {
        let mut guard = Self::default();
        if let Err(error) = guard.enter_inner() {
            guard.cleanup();
            return Err(error);
        }
        Ok(guard)
    }

    pub fn terminal_mut(&mut self) -> Result<&mut Terminal<CrosstermBackend<Stdout>>> {
        self.terminal
            .as_mut()
            .ok_or_else(|| eyre!("terminal not initialized"))
    }

    fn enter_inner(&mut self) -> Result<()> {
        if let Err(error) = enable_raw_mode() {
            return Err(error.into());
        }
        self.raw_enabled = true;

        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen) {
            return Err(error.into());
        }
        self.alt_screen = true;

        if let Err(error) = execute!(stdout, EnableMouseCapture) {
            return Err(error.into());
        }
        self.mouse_capture = true;

        let backend = CrosstermBackend::new(stdout);
        let mut terminal = Terminal::new(backend)?;
        terminal.clear()?;
        self.terminal = Some(terminal);
        Ok(())
    }

    fn cleanup(&mut self) {
        if self.raw_enabled {
            if let Err(error) = disable_raw_mode() {
                tracing::warn!(%error, "failed to disable raw mode");
            }
            self.raw_enabled = false;
        }

        if let Some(terminal) = self.terminal.as_mut() {
            cleanup_terminal_backend(
                terminal.backend_mut(),
                &mut self.alt_screen,
                &mut self.mouse_capture,
            );
        } else {
            let mut stdout = io::stdout();
            cleanup_terminal_backend(&mut stdout, &mut self.alt_screen, &mut self.mouse_capture);
        }

        self.terminal = None;
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        self.cleanup();
    }
}

fn cleanup_terminal_backend<W: io::Write>(
    writer: &mut W,
    alt_screen: &mut bool,
    mouse_capture: &mut bool,
) {
    if *alt_screen {
        if let Err(error) = execute!(writer, LeaveAlternateScreen) {
            tracing::warn!(%error, "failed to leave alternate screen");
        }
        *alt_screen = false;
    }
    if *mouse_capture {
        if let Err(error) = execute!(writer, DisableMouseCapture) {
            tracing::warn!(%error, "failed to disable mouse capture");
        }
        *mouse_capture = false;
    }
    if let Err(error) = execute!(writer, Show) {
        tracing::warn!(%error, "failed to show cursor");
    }
}
