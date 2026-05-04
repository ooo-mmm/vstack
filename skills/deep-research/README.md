# deep-research skill

Portable Exa Deep Search skill for producing evidence-backed findings reports in any harness.

Run `scripts/deep-research doctor` to verify Node/fetch availability and whether `EXA_API_KEY` is configured.

Report mode defaults:

| Mode | Exa type | Results | Text cap | Timeout |
|---|---|---:|---:|---:|
| `lite` | `deep-lite` | 15 | 10k chars/result | 5 min |
| `standard` | `deep-reasoning` | 50 | 16k chars/result | 10 min |
| `full` | `deep-reasoning` | 150 | 24k chars/result | 30 min |

`report --output findings.md` writes clean Markdown and defaults raw metadata to `findings.raw.json`.

The findings format is mode-adaptive: `lite`, `standard`, and `full` use the same required sections, while mode/source/query counts are recorded in `## Research Metadata`. This avoids separate templates drifting over time.

Format references:

- `templates/findings.md` — Markdown findings template.
- `templates/findings-report-format.md` — section checklist/format guide (not a JSON schema).

Raw Exa/provider payloads belong in the sidecar JSON only. Do not embed raw JSON or fenced raw metadata blocks in `findings.md`.

Pi `web_research` uses Exa highlights and, for `standard`/`full`, structured output (`outputSchema`) plus source summaries when available. `lite` avoids the default output schema after live Exa testing showed empty result sets with `deep-lite` + structured output. Evidence excerpts are sanitized before rendering so Markdown headings from source pages do not become giant quoted headings in reports.
