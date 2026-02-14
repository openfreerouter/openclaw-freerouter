# Changelog

## 1.3.0 (2026-02-14)

Initial release as OpenClaw plugin.

### Features
- 14-dimension weighted classifier for smart model routing
- Auto-classify requests → route to cheapest capable model
- Tier system: SIMPLE → MEDIUM → COMPLEX → REASONING
- Agentic task detection with separate tier configs
- Mode overrides (`/max`, `[simple]`, `reasoning mode:`)
- Adaptive thinking for Opus 4.6+
- Configurable providers, tiers, and boundaries via plugin config
- Fallback chains per tier
- Timeout + stall detection per tier
- OpenAI-compatible API (Anthropic Messages ↔ OpenAI translation)
- Tool call support (OpenAI ↔ Anthropic conversion)
- Streaming with SSE format translation
- Zero external dependencies

### Plugin Integration
- Starts/stops with OpenClaw gateway lifecycle
- Config via `plugins.entries.freerouter.config` in openclaw.json
- Auto-registers as `freerouter` provider
- Reads auth from OpenClaw's auth-profiles.json
