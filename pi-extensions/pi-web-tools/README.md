# pi-web-tools
![Web Tools settings panel](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-web-tools/assets/settings-panel.png)
![Exa web_search results renderer](https://raw.githubusercontent.com/vanillagreencom/vstack/main/pi-extensions/pi-web-tools/assets/web-search.png)
First-party Pi package for web access tools.

For the Exa-specific API map and tool semantics, see [`EXA.md`](./EXA.md).

Implemented in this package:

- `web_search` with provider selection (`auto`, `exa`, `openai-native`, `perplexity`, `gemini`). Direct execution wired for Exa, Perplexity Sonar, Gemini API (Google Search grounding), and Gemini Web (browser-cookie auth). OpenAI-native is handled by a `before_provider_request` rewrite on supported OpenAI/Codex models.
- `web_research` using Exa Deep Search with `researchMode: lite|standard|full` plus low-level overrides (`type`, `numResults`, `textMaxCharacters`, domains, dates, additional queries). Accepts inline `query` or `queryFile`, plus `contextFiles`/`contextGlob`.
- `web_research.outputPath` findings report writing with Pi's file mutation queue. Clean reports default to a raw metadata sidecar (`findings.raw.json`) instead of embedding raw JSON in `findings.md`.
- `web_fetch` extraction chain: GitHub URLs (shallow clone cache + cached blob/tree/README), URL + local PDF text via `pdftotext` with vision OCR fallback for scanned PDFs (`pdftoppm` rasterization + ImageContent blocks for the host LLM), HTML/text/JSON with Wikipedia-style chrome stripping, Jina Reader auto-fallback on blocked/cookie-walled pages and 403/429/5xx, YouTube + local video understanding via Gemini Web/API (auto-applies `[HH:MM:SS]` directive when the prompt asks for transcripts/lyrics/captions), and Exa `contents` fallback/override for URLs.
- `web_answer`, `web_find_similar` Exa-first tools.
- `code_search` defaults to the Exa Code `/context` endpoint and falls back to classic Exa search with code-focused domain hints; renderer surfaces token + source counts and parsed source URLs (Ctrl+O to expand).
- `get_web_content` retrieval for stored full content.
- `/web-tools` opens the extension-manager settings popup (with `/web-tools:doctor` and `/web-tools:provider:<name>` for diagnostics and session-scoped provider switching).

## Commands

| Command | Action |
| --- | --- |
| `/web-tools` | Open the extension-manager settings popup (falls back to inline status when the manager is not installed). |
| `/web-tools:doctor` | Show Web Tools status and diagnostics. |
| `/web-tools:provider:<name>` | Set the active web-search provider for this session: `auto`, `exa`, `openai-native`, `perplexity`, or `gemini`. Persist via `pi-web-tools.defaultProvider` in extension-manager settings. |

## Fetch storage and truncation

`web_fetch` returns a compact preview and stores extracted content in the current Pi session under a generated content id such as `web-...`. Tool text and UI label preview output separately from stored full text; when a preview is truncated the renderer shows `preview <shown>/<full> chars`. Use `get_web_content` with that content id to retrieve the stored text; it does not fetch the URL again.

- GitHub blob, GitHub repo metadata/README, direct HTTP, and PDF extraction store the full extracted text before preview truncation. PDF extraction prefers local `pdftotext` when available, then falls back to a basic embedded-text parser; URL PDFs can fall back to Exa when local extraction fails.
- Local PDFs are supported with `filePath`/`filePaths`, `file://...`, or PDF-looking paths. They are extracted locally and are never sent to Exa fallback.
- Exa `contents` fallback/override stores the text returned by Exa; `textMaxCharacters` is the provider extraction cap for that path.
- `web_fetch.textMaxCharacters` caps the immediate preview shown to the model for direct/GitHub/PDF paths; default preview cap is 4k characters per stored item.
- `get_web_content.maxCharacters` caps the retrieval returned to the model; default is 50k characters. Omit it for normal full-context retrieval, lower it only for previews.
- Session storage is not a standalone project file. The durable handle shown in UI is the `content id`, and Pi persists it with the session history.

Staged for follow-up parity with `pi-web-access`:

- Browser curator UI and activity monitor.
- Gemini extraction fallback for HTML pages where Jina also fails (Jina is the current single fallback after the in-house extractor).
- ffmpeg/yt-dlp-driven frame extraction for video URLs (text understanding works without these binaries).

## Settings

Settings are read from the vstack extension-manager namespace:

```json
{
  "vstack": {
    "extensionManager": {
      "config": {
        "pi-web-tools": {
          "defaultProvider": "auto",
          "enabledProviders": "exa,openai-native,perplexity,gemini",
          "exaDeepResearchEnabled": true,
          "exaAdvancedEnabled": false,
          "htmlExtraction": { "jinaFallback": true },
          "pdfOcr": { "enabled": true, "maxPages": 5, "dpi": 150 },
          "githubClone": { "enabled": true, "maxRepoSizeMB": 350, "cloneTimeoutSeconds": 60, "cacheMaxAgeHours": 24 },
          "video": { "enabled": true },
          "browserCookieAccess": false,
          "browserCookies": { "preferredBrowser": "auto" }
        }
      }
    }
  }
}
```

Key toggles:

- `exaAdvancedEnabled` is required to expose `web_answer`, `web_find_similar`, and `code_search` to the active toolset (gated to keep the default surface small). Flip it on per-user or per-project to use them.
- `browserCookieAccess` opts in to Gemini Web cookie scraping. With `browserCookies.preferredBrowser` set to `auto` (default) / `firefox` / `zen` / `chrome` / `chromium`, the package reads cookies from Firefox/Zen unencrypted SQLite or Chromium-family DBs (libsecret on Linux, Keychain on macOS, DPAPI master key + AES-GCM on Windows).
- `pdfOcr.enabled` controls whether `pdftoppm` rasterizes scanned PDFs into ImageContent blocks for vision OCR. Defaults on; set to false to skip rasterization on scanned PDFs.
- `githubClone.enabled` toggles the GitHub clone cache (default on). Repos exceeding `maxRepoSizeMB` automatically fall back to API-based extraction.

Secrets should be supplied with environment variables, project `.env.local`/`.env` files, or a private config file. Process environment variables win over values loaded from files:

- `EXA_API_KEY`
- `PERPLEXITY_API_KEY`
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `JINA_API_KEY` (optional; anonymous Jina Reader works without it but may rate-limit on heavy use)
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
