# @openfreerouter/openclaw-freerouter

**FreeRouter** — Smart model router for OpenClaw. Auto-classifies requests using a 14-dimension weighted scorer and routes to the cheapest capable model using your own API keys.

## Install

```bash
openclaw plugins install @openfreerouter/openclaw-freerouter
```

Or install from local path:

```bash
openclaw plugins install ./openclaw-freerouter
```

## Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "freerouter": {
        "config": {
          "port": 18800,
          "host": "127.0.0.1",
          "providers": {
            "anthropic": {
              "baseUrl": "https://api.anthropic.com",
              "api": "anthropic"
            },
            "kimi-coding": {
              "baseUrl": "https://api.kimi.com/coding/v1",
              "api": "openai",
              "headers": { "User-Agent": "KimiCLI/0.77" }
            }
          },
          "tiers": {
            "SIMPLE":    { "primary": "kimi-coding/kimi-for-coding", "fallback": ["anthropic/claude-haiku-4-5"] },
            "MEDIUM":    { "primary": "anthropic/claude-sonnet-4-5", "fallback": ["anthropic/claude-opus-4-6"] },
            "COMPLEX":   { "primary": "anthropic/claude-opus-4-6", "fallback": ["anthropic/claude-haiku-4-5"] },
            "REASONING": { "primary": "anthropic/claude-opus-4-6", "fallback": ["anthropic/claude-haiku-4-5"] }
          }
        }
      }
    }
  }
}
```

All config fields are optional — sensible defaults are built in.

## How It Works

1. **Classify**: Each request is scored across 14 dimensions (code presence, reasoning markers, technical terms, creativity, etc.)
2. **Route**: Score maps to a tier (SIMPLE → MEDIUM → COMPLEX → REASONING)
3. **Forward**: Request is forwarded to the tier's primary model, with automatic fallback
4. **Translate**: Anthropic Messages API ↔ OpenAI format translation happens transparently

## Tiers

| Tier | Default Model | Use Case |
|------|--------------|----------|
| SIMPLE | Kimi K2.5 | Greetings, facts, translations |
| MEDIUM | Claude Sonnet 4.5 | Code, conversation, tool use |
| COMPLEX | Claude Opus 4.6 | Architecture, debugging, analysis |
| REASONING | Claude Opus 4.6 | Proofs, formal reasoning, deep analysis |

## Mode Overrides

Force a specific tier in your prompt:

- `/max prove that P ≠ NP` → REASONING
- `simple mode: what's 2+2` → SIMPLE
- `[complex] review this architecture` → COMPLEX

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | OpenAI-compatible chat |
| `/v1/models` | GET | List available models |
| `/health` | GET | Health check |
| `/stats` | GET | Request statistics |
| `/config` | GET | Show sanitized config |
| `/reload` | POST | Reload auth keys |
| `/reload-config` | POST | Reload config + auth |

## Use as Default Model

Set your default model to `freerouter/auto` in openclaw.json:

```json
{
  "model": "freerouter/auto"
}
```

## License

MIT
