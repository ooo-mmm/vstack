# pi-web-tools

First-party Pi package for web access tools.

Implemented in this package:

- `web_search` with provider selection (`auto`, `exa`, `openai-native`, `perplexity`, `gemini`). Direct execution is implemented for Exa; OpenAI-native is handled by a `before_provider_request` rewrite on supported OpenAI/Codex models.
- `web_research` using Exa Deep Search with `researchMode: lite|standard|full` plus low-level overrides (`type`, `numResults`, `textMaxCharacters`, domains, dates, additional queries). It accepts inline `query` or `queryFile`, plus `contextFiles`/`contextGlob`.
- `web_research.outputPath` findings report writing with Pi's file mutation queue. Clean reports default to a raw metadata sidecar (`findings.raw.json`) instead of embedding raw JSON in `findings.md`.
- `web_fetch` with research-focused extraction for GitHub URLs, PDF text, HTML/text/JSON, and Exa `contents` fallback/override.
- `web_answer`, `web_find_similar`, `code_search` Exa-first tools.
- `get_web_content` retrieval for stored full content.
- `/web-tools doctor` and `/web-tools provider ...` guidance.

Staged for follow-up parity with `pi-web-access`:

- Perplexity/Gemini direct search execution.
- Full Readability/Jina/Gemini fallback extraction chain for difficult pages.
- OCR-grade/scanned PDF extraction.
- GitHub clone cache for very large repository workflows.
- YouTube/local video understanding.
- Browser curator UI and activity monitor.

## Settings

Settings are read from the vstack extension-manager namespace:

```json
{
  "vstack": {
    "extensionManager": {
      "config": {
        "pi-web-tools": {
          "defaultProvider": "auto",
          "enabledProviders": "exa,openai-native,perplexity,gemini"
        }
      }
    }
  }
}
```

Secrets should be supplied with environment variables, project `.env.local`/`.env` files, or a private config file. Process environment variables win over values loaded from files:

- `EXA_API_KEY`
- `PERPLEXITY_API_KEY`
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `PI_WEB_TOOLS_CONFIG_FILE=/path/to/private.json`

Shared Pi settings keys such as `exaApiKey` are loaded for compatibility but emit a warning.

API key values may be direct keys or 1Password references such as `op://Private/Exa API Key/credential` when the `op` CLI is installed and signed in.

## Deep research modes

| Mode | Exa type | Default results | Text cap | Highlight cap | Notes |
|---|---|---:|---:|---:|---|
| `lite` | `deep-lite` | 15 | 10k chars/result | 600 chars/source | Fast, lower-cost spikes; no default structured output schema. |
| `standard` | `deep-reasoning` | 50 | 16k chars/result | 900 chars/source | Default for normal findings reports; requests Exa summaries and structured output. |
| `full` | `deep-reasoning` | 150 | 24k chars/result | 1200 chars/source | Runs the primary query plus each `additionalQueries` entry, then dedupes URLs; requests richer summaries/structured output. |

`web_research` uses Exa `/search` with deep search types, `systemPrompt`, text extraction, highlights, and (for `standard`/`full`) source summaries plus structured `outputSchema`. Clean Markdown reports use Exa `output.content` when present and keep raw provider payloads in sidecars. `lite` intentionally avoids the default output schema because live Exa `deep-lite` tests returned empty result sets when structured output was requested.

Explicit tool arguments override mode defaults: `type`, `numResults`, `textMaxCharacters`, `highlightsMaxCharacters`, `highlightNumSentences`, `highlightsPerUrl`, `summaryQuery`, `maxAgeHours`, `category`, and `outputSchema`.

You can override mode defaults globally or per-project with `pi-web-tools.exaResearchModes` in Pi settings. The extension-manager UI stores this as a JSON string, while settings files may use either a JSON string or object:

```json
{
  "lite": { "numResults": 8, "textMaxCharacters": 6000 },
  "standard": {
    "numResults": 30,
    "highlightsMaxCharacters": 700,
    "highlightsPerUrl": 2,
    "summaryQuery": "Summarize evidence relevant to the research question."
  },
  "full": { "numResults": 80, "maxAgeHours": 168 }
}
```

## Migration

`web_search` moved here from `pi-codex-minimal-tools`. Install both updated packages together; `pi-codex-minimal-tools` now owns only `image_generation`, `view_image`, and `apply_patch`.

## Attribution

This implementation was designed after reviewing the MIT-licensed Pi web-access and Exa extension patterns referenced in the project implementation plan. No source code was copied verbatim.
