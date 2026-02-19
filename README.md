# FreeRouter — Smart LLM Router for OpenClaw

**Stop overpaying for AI.** Every message to your AI assistant costs money — a simple "hello" shouldn't cost the same as "prove the Riemann hypothesis." FreeRouter automatically routes each request to the right model based on complexity.

## The Problem

- 🔥 **Wasted money** — Running Claude Opus ($15/$75 per 1M tokens) for every message, even "what's 2+2?"
- 🤷 **No control** — Can't switch models mid-conversation without editing config files and restarting
- 📊 **Blind routing** — Your AI shows "freerouter/auto" instead of telling you which model actually answered
- 🔧 **Complex setup** — Existing routers need separate servers, Docker, complex infra

## The Solution

FreeRouter is an OpenClaw plugin that:
- **Classifies every request in <1ms** using a 14-dimension weighted scorer (no LLM needed for classification)
- **Routes to the cheapest model that can handle it** — Kimi for "hello", Opus for architecture design
- **Reports the real model name** — You see `anthropic/claude-opus-4-6`, not `freerouter/auto`
- **Lets you override anytime** — Just say "use opus" in plain English

## Install

```bash
openclaw plugins install openclaw-freerouter
```

Then run the setup wizard:

```bash
openclaw freerouter setup
```

Or configure manually — see [Configuration](#configure) below.

## Switch Models Anytime

The killer feature: **switch models using natural language, slash commands, or session locks.**

### Just Say It (Natural Language)

No slash commands needed. Just talk:

| What you say | What happens |
|---|---|
| `use opus` | Switches to Claude Opus for this message |
| `switch to sonnet` | Switches to Claude Sonnet |
| `try kimi` | Switches to Kimi |
| `let's use opus` | Switches to Opus |
| `please use sonnet` | Switches to Sonnet |
| `can you use haiku` | Switches to Haiku |
| `use opus: explain quantum computing` | Uses Opus for this specific prompt |
| `use opus, what is 2+2?` | Same — model + prompt in one message |
| `go back to auto` | Return to automatic routing |

### Lock a Model for the Whole Session

When you know the task is important and you want Opus (or any model) for everything:

| What you say | What happens |
|---|---|
| `use opus for this session` | 🔒 Locks ALL messages to Opus |
| `switch to sonnet from now on` | 🔒 Locks to Sonnet |
| `stick with opus` | 🔒 Locks to Opus |
| `keep using sonnet` | 🔒 Locks to Sonnet |
| `/lock opus` | 🔒 Same thing, slash command |
| `/unlock` | 🔓 Back to auto-routing |
| `/lock status` | Shows current lock state |

Session locks expire after 4 hours of inactivity.

### When FreeRouter Isn't Sure

If your request is ambiguous, FreeRouter asks before switching:

> **You:** "opus please"
> **FreeRouter:** 🤔 Did you want to switch to **anthropic/claude-opus-4-6**? Reply **yes** or **no**.
> **You:** "yes"
> **FreeRouter:** ✅ Confirmed!

This prevents accidental switches when you're just talking *about* a model.

### Slash Commands (Power Users)

| Command | Effect |
|---|---|
| `/opus What is 2+2?` | Per-prompt: Opus for this message only |
| `/sonnet Write a poem` | Per-prompt: Sonnet |
| `/kimi Quick answer` | Per-prompt: Kimi |
| `/haiku Translate this` | Per-prompt: Haiku |
| `/simple What is 2+2?` | Per-prompt: use SIMPLE tier model |
| `/max Prove this theorem` | Per-prompt: use REASONING tier model |
| `[opus] Deep analysis` | Bracket syntax (same as /opus) |

### Supported Model Aliases

| Alias | Model |
|-------|-------|
| `opus`, `opus-4`, `opus-4.6` | anthropic/claude-opus-4-6 |
| `sonnet`, `sonnet-4`, `sonnet-4.5` | anthropic/claude-sonnet-4-5 |
| `sonnet-4.6` | anthropic/claude-sonnet-4-6 |
| `haiku`, `haiku-4`, `haiku-4.5` | anthropic/claude-haiku-4-5 |
| `kimi`, `kimi-k2`, `k2.5` | kimi-coding/kimi-for-coding |

## How Routing Works

1. You send a message → OpenClaw forwards to FreeRouter
2. FreeRouter's 14-dimension classifier scores the request in **<1ms** (0.035ms average)
3. Based on the score, it picks the best tier:

| Tier | Default Model | Use Case | Cost |
|------|--------------|----------|------|
| SIMPLE | Kimi K2.5 | Quick lookups, translations, "hello" | $0.50/1M |
| MEDIUM | Claude Sonnet 4.5 | Code, creative writing, moderate tasks | $3/$15/1M |
| COMPLEX | Claude Opus 4.6 | Architecture, deep analysis | $15/$75/1M |
| REASONING | Claude Opus 4.6 | Proofs, formal logic, step-by-step | $15/$75/1M |

4. Forwards to the real provider API (Anthropic, Kimi, OpenAI, etc.)
5. Returns the response with the **actual model name** — not "freerouter/auto"

### Scoring Dimensions

The classifier evaluates 14 weighted dimensions without calling any LLM:
- Token count, code presence, reasoning markers, technical terms
- Creative markers, simple indicators, multi-step patterns
- Question complexity, imperative verbs, constraints
- Output format, references, negation, domain specificity
- Agentic task indicators (multi-tool, multi-step workflows)

Supports multilingual classification: English, Chinese, Japanese, Russian, German, Vietnamese, Arabic, Korean, and more.

## Configure

After install, add to your `openclaw.json`:

```json5
{
  // 1. Set FreeRouter as your default model
  "agents": {
    "defaults": {
      "model": {
        "primary": "freerouter/freerouter/auto",
        "fallbacks": ["anthropic/claude-opus-4-6"]
      }
    }
  },

  // 2. Add FreeRouter as a provider
  "providers": {
    "freerouter": {
      "baseUrl": "http://127.0.0.1:18801/v1",
      "api": "openai-completions"
    }
  },

  // 3. Plugin config
  "plugins": {
    "entries": {
      "freerouter": {
        "enabled": true,
        "config": {
          "port": 18801,
          "host": "127.0.0.1",
          "tiers": {
            "SIMPLE":    { "primary": "kimi-coding/kimi-for-coding", "fallback": ["anthropic/claude-haiku-4-5"] },
            "MEDIUM":    { "primary": "anthropic/claude-sonnet-4-5", "fallback": ["anthropic/claude-opus-4-6"] },
            "COMPLEX":   { "primary": "anthropic/claude-opus-4-6", "fallback": [] },
            "REASONING": { "primary": "anthropic/claude-opus-4-6", "fallback": [] }
          },
          "thinking": {
            "adaptive": ["claude-opus-4-6"],
            "enabled": { "models": ["claude-sonnet-4-5"], "budget": 4096 }
          },
          "defaultTier": "MEDIUM"
        }
      }
    }
  }
}
```

Then restart: `openclaw gateway restart`

## CLI Commands

| Command | Description |
|---|---|
| `openclaw freerouter status` | Show config, tier mapping, and live stats |
| `openclaw freerouter setup` | Interactive setup wizard |
| `openclaw freerouter test` | Quick 5-query classification smoke test |
| `openclaw freerouter doctor` | Diagnose issues (port conflicts, missing config, etc.) |
| `openclaw freerouter port <n>` | Change the proxy port |
| `openclaw freerouter reset` | Show default config for recovery |

### Chat Commands

| Command | Description |
|---|---|
| `/freerouter` | Show routing stats in chat |
| `/freerouter-doctor` | Quick health check |

## Port Conflicts

If port 18801 is in use, change it:

```json5
{ "plugins": { "entries": { "freerouter": { "config": { "port": 18802 } } } } }
```

Set `"port": 0` to disable the HTTP proxy entirely.

## Troubleshooting

```bash
# Check if everything is working
openclaw freerouter doctor

# Quick classification test
openclaw freerouter test

# Reset to defaults
openclaw freerouter reset
```

## Response Headers

Every proxied response includes metadata headers:
- `X-FreeRouter-Model` — Actual model used (e.g., `anthropic/claude-opus-4-6`)
- `X-FreeRouter-Tier` — Classification tier (SIMPLE/MEDIUM/COMPLEX/REASONING)
- `X-FreeRouter-Thinking` — Thinking mode (off/adaptive/enabled)
- `X-FreeRouter-Reasoning` — Why this model was chosen

## API Endpoints

The HTTP proxy exposes:
- `POST /v1/chat/completions` — OpenAI-compatible chat endpoint
- `GET /v1/models` — List available models
- `GET /health` — Health check
- `GET /stats` — Routing statistics
- `GET /sessions/locks` — Active session locks
- `DELETE /sessions/locks` — Clear all session locks

## Tests

```bash
npm test  # Runs all 212 tests
```

- `test-freerouter.mjs` — Classification, multilingual, edge cases, performance
- `test-resilience.mjs` — Fallback chains, bad configs, recovery, port conflicts
- `test-overrides.mjs` — Model overrides, session locks, natural language switching

## License

MIT
