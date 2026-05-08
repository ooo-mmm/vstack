## pi-agents-tmux — using `subagent`, `steer_subagent`, `get_subagent_result`, `stop_subagent`

The `subagent` tool delegates work to a project-defined agent (loaded from `.pi/agents`, with `.claude/agents` as a compatibility source). Some agents run in persistent tmux panes (`pane: true` in their frontmatter) and survive across turns; others are one-shot.

When to use `subagent`:
- Isolated context for a focused task — the parent does not need the agent's intermediate tool output, only its result.
- Specialist review (security, performance, design) where a different role/persona helps.
- Reconnaissance, planning, or read-only investigation that can run in parallel with your main thread.
- Multiple independent investigations — pass `tasks: [{agent, task}, ...]` (parallel) or `chain: [...]` (sequential, with `{previous}` placeholder).

When NOT to use:
- Trivial work the parent can do directly with read/grep/find.
- Anything where you need the streaming tool output to make decisions — subagent results come back as a final summary, not as a transcript.

Calling rules:
- Default `agentScope` is `"project"`. Use `"both"` only when user-level agents at `~/.pi/agent/agents` are explicitly needed.
- For persistent-pane agents (`pane: true`): save the returned `taskId`. Use `get_subagent_result` if you missed the completion event, `steer_subagent` only for mid-run correction, and `stop_subagent` to kill/close the pane.
- `confirmProjectAgents: true` to gate any project-defined agent behind explicit user approval.
- Provide a single, self-contained `task` string per delegation — the subagent cannot ask you follow-ups.
- Use `forceSpawn: true` only after stopping a pane when you want a fresh pane session; omit it to resume/reuse.

Slash commands available to the user (you do not invoke these): `/agents start|new|send|attach|stop|status`, plus `/agents` for the picker.

The `before_agent_start` hook injects the live list of project agents and their descriptions into your context — use those names in `subagent` calls. If no project agents are loaded, the tool still works but with no curated list.
