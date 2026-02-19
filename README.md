# FreeRouter — OpenClaw Plugin

Smart LLM router that classifies your requests and routes them to the best model automatically. Uses a 14-dimension weighted scorer (<1ms) with configurable tier→model mapping.

## Install

```bash
# From local directory
openclaw plugins install -l /path/to/freerouter-plugin

# Or copy to extensions
openclaw plugins install /path/to/freerouter-plugin
```

## Configure

After install, configure tiers in `openclaw.json`:

```json5
{
  // Set FreeRouter as your default model
  agents: {
    defaults: {
      model: { primary: "freerouter/auto" }
    }
  },

  // Add FreeRouter as a provider pointing to its HTTP proxy
  providers: {
    freerouter: {
      baseUrl: "http://127.0.0.1:18801/v1",
      api: "openai-completions"
    }
  },

  // Plugin config
  plugins: {
    entries: {
      freerouter: {
        enabled: true,
        config: {
          port: 18801,        // HTTP proxy port (0 = disabled)
          host: "127.0.0.1",  // Bind address

          // Customize which models handle each tier
          tiers: {
            SIMPLE:    { primary: "kimi-coding/kimi-for-coding", fallback: ["anthropic/claude-haiku-4-5"] },
            MEDIUM:    { primary: "anthropic/claude-sonnet-4-5", fallback: ["anthropic/claude-opus-4-6"] },
            COMPLEX:   { primary: "anthropic/claude-opus-4-6", fallback: [] },
            REASONING: { primary: "anthropic/claude-opus-4-6", fallback: [] }
          },

          // Thinking/reasoning config
          thinking: {
            adaptive: ["claude-opus-4-6"],
            enabled: { models: ["claude-sonnet-4-5"], budget: 4096 }
          },

          // Default tier for ambiguous requests
          defaultTier: "MEDIUM"
        }
      }
    }
  }
}
```

## How It Works

1. OpenClaw sends a request with model `freerouter/auto`
2. FreeRouter's HTTP proxy receives it
3. The 14-dimension classifier scores the request in <1ms
4. Routes to the best model for the task (e.g., Kimi for simple, Opus for reasoning)
5. Forwards to the real provider API
6. **Returns the actual model name** (e.g., `anthropic/claude-opus-4-6`) so OpenClaw displays what's really running

## Tiers

| Tier | Default Model | Use Case |
|------|--------------|----------|
| SIMPLE | kimi-coding/kimi-for-coding | Quick lookups, translations, simple Q&A |
| MEDIUM | anthropic/claude-sonnet-4-5 | Code generation, creative writing, moderate complexity |
| COMPLEX | anthropic/claude-opus-4-6 | Architecture design, multi-step reasoning |
| REASONING | anthropic/claude-opus-4-6 | Mathematical proofs, formal logic, deep analysis |

## Per-Prompt Model Override

Force a specific model for one message:

- `/opus Explain quantum computing` → Claude Opus 4.6
- `/sonnet Write a poem` → Claude Sonnet 4.5
- `/kimi What's 2+2?` → Kimi K2.5
- `/haiku Translate this` → Claude Haiku 4.5
- `[opus] Deep analysis...` → Claude Opus 4.6

## Per-Prompt Tier Override

Force a tier (uses that tier's primary model):

- `/simple What's 2+2?` → SIMPLE tier
- `/max Prove the Riemann hypothesis` → REASONING tier
- `[reasoning] Analyze this code...` → REASONING tier

## Session Lock

Lock an entire session to a specific model:

- `/lock opus` → 🔒 All messages use Opus until unlocked
- `/lock sonnet` → 🔒 All messages use Sonnet
- `/lock simple` → 🔒 Lock to SIMPLE tier's primary model
- `/lock anthropic/claude-opus-4-6` → 🔒 Full model ID
- `/unlock` → 🔓 Return to auto-routing
- `/lock auto` → 🔓 Same as unlock
- `/lock status` → Show current lock state

Session locks expire after 4 hours of inactivity.

### Supported Aliases

| Alias | Model |
|-------|-------|
| `opus`, `opus-4`, `opus-4.6` | anthropic/claude-opus-4-6 |
| `sonnet`, `sonnet-4`, `sonnet-4.5` | anthropic/claude-sonnet-4-5 |
| `sonnet-4.6` | anthropic/claude-sonnet-4-6 |
| `haiku`, `haiku-4`, `haiku-4.5` | anthropic/claude-haiku-4-5 |
| `kimi`, `kimi-k2`, `k2.5` | kimi-coding/kimi-for-coding |

## Scoring Dimensions

The classifier evaluates 14 weighted dimensions:
- Token count, code presence, reasoning markers, technical terms
- Creative markers, simple indicators, multi-step patterns
- Question complexity, imperative verbs, constraints
- Output format, references, negation, domain specificity
- Agentic task indicators

## Port Conflicts

If port 18801 is in use, change it in the plugin config:

```json5
{ plugins: { entries: { freerouter: { config: { port: 18802 } } } } }
```

Set `port: 0` to disable the HTTP proxy entirely.

## Commands

- `/freerouter` — Show routing stats in chat
- `openclaw freerouter status` — CLI status and stats

## Response Headers

Every proxied response includes:
- `X-FreeRouter-Model` — Actual model used
- `X-FreeRouter-Tier` — Classification tier
- `X-FreeRouter-Thinking` — Thinking mode (off/adaptive/enabled)
- `X-FreeRouter-Reasoning` — Classification reasoning

## License

MIT
