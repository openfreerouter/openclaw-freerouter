# FreeRouter — Smart LLM Router for OpenClaw

**Stop overpaying for AI.** Every message to your AI assistant costs money — a simple "hello" shouldn't cost the same as "prove the Riemann hypothesis." FreeRouter automatically routes each request to the right model based on complexity.

## The Problem

- 🔥 **Wasted money** — Running Claude Opus ($15/$75 per 1M tokens) for every message, even "what's 2+2?"
- 🤷 **No control** — Can't switch models mid-conversation without editing config files and restarting
- 📊 **Blind routing** — Your AI shows "freerouter/auto" instead of telling you which model actually answered
- 🧠 **No adaptive thinking** — OpenClaw's built-in thinking levels (`/think low`, `/think high`) are just prompt hints. Anthropic deprecated manual thinking for Opus 4.6 — it now requires the native `thinking: { type: "adaptive" }` API parameter, which OpenClaw doesn't send
- 🔧 **Complex setup** — Existing routers need separate servers, Docker, complex infra

## The Solution

FreeRouter is an OpenClaw plugin that:
- **Classifies every request in <1ms** using a 14-dimension weighted scorer (no LLM needed for classification)
- **Routes to the cheapest model that can handle it** — Kimi for "hello", Opus for architecture design
- **Sends native adaptive thinking** — Automatically passes `thinking: { type: "adaptive" }` to Anthropic's API for Opus 4.6, and `thinking: { type: "enabled", budget_tokens: N }` for Sonnet. No prompt hacks — real API-level thinking control that OpenClaw doesn't support natively
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

## Adaptive Thinking (Native API-Level)

This is a key reason FreeRouter exists.

**The problem:** OpenClaw's built-in `/think low|medium|high` commands are prompt-level hints — they add text like "think harder" to your prompt. This is unreliable and doesn't use Anthropic's actual thinking API. Worse, **Anthropic deprecated manual thinking (`type: "enabled"`) for Opus 4.6** — it now only supports `type: "adaptive"`, where the model decides how much to think based on the task.

**What FreeRouter does:** Sends the real `thinking` parameter directly to Anthropic's API:

| Model | Thinking Mode | What's Sent |
|---|---|---|
| Claude Opus 4.6 | **Adaptive** (always) | `thinking: { type: "adaptive" }` |
| Claude Sonnet 4.5 | Enabled with budget | `thinking: { type: "enabled", budget_tokens: 4096 }` |
| Others (Kimi, Haiku) | Off | No thinking parameter |

**Why this matters:**
- Adaptive thinking lets Opus 4.6 decide how much reasoning it needs — simple questions get quick answers, complex proofs get deep thinking chains
- You get the full benefit of Claude's extended thinking without managing budgets
- The `X-FreeRouter-Thinking` response header tells you exactly which thinking mode was used

Configure in your plugin config:
```json5
"thinking": {
  "adaptive": ["claude-opus-4-6"],           // Models that use adaptive (always-on)
  "enabled": {
    "models": ["claude-sonnet-4-5"],          // Models that get explicit thinking
    "budget": 4096                             // Token budget for thinking
  }
}
```

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
      "openclaw-freerouter": {
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
{ "plugins": { "entries": { "openclaw-freerouter": { "config": { "port": 18802 } } } } }
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
