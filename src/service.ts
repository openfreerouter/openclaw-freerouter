/**
 * FreeRouter Proxy Service
 *
 * OpenAI-compatible HTTP proxy that classifies and routes requests.
 * Returns the REAL model name in responses so OpenClaw displays it correctly.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { route } from "./router/index.js";
import { getRoutingConfig, applyConfigOverrides } from "./router/config.js";
import { buildPricingMap } from "./models.js";
import { createForwarder } from "./provider.js";

export type ProxyStats = {
  started: string;
  requests: number;
  errors: number;
  timeouts: number;
  byTier: Record<string, number>;
  byModel: Record<string, number>;
};

type ProxyOptions = {
  port: number;
  host: string;
  pluginConfig: Record<string, unknown>;
  openclawConfig: Record<string, unknown>;
  logger: any;
};

/**
 * Extract the user's prompt text from messages for classification.
 * Only classifies the USER's message, not the full system prompt.
 */
function extractPromptForClassification(messages: any[]): {
  prompt: string;
  systemPrompt: string | undefined;
} {
  let systemPrompt: string | undefined;
  const contextWindow = 3;

  const conversationMsgs: Array<{ role: string; text: string }> = [];
  for (const msg of messages) {
    const text = typeof msg.content === "string"
      ? msg.content
      : (msg.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("\n");

    if (msg.role === "system" || msg.role === "developer") {
      systemPrompt = (systemPrompt ? systemPrompt + "\n" : "") + text;
    } else {
      conversationMsgs.push({ role: msg.role, text });
    }
  }

  const recentMsgs = conversationMsgs.slice(-contextWindow);
  const lastUserMsg = recentMsgs.filter(m => m.role === "user").pop()?.text ?? "";
  const contextParts: string[] = [];
  for (const msg of recentMsgs) {
    if (msg.text !== lastUserMsg) {
      contextParts.push(msg.text.slice(0, 500));
    }
  }

  const prompt = contextParts.length > 0
    ? contextParts.join("\n") + "\n" + lastUserMsg
    : lastUserMsg;

  return { prompt, systemPrompt };
}

/**
 * Model aliases — maps short names to full provider/model IDs.
 * Users can type `/opus Do X` instead of the full model path.
 */
const MODEL_ALIASES: Record<string, string> = {
  // Anthropic
  opus: "anthropic/claude-opus-4-6",
  "opus-4": "anthropic/claude-opus-4-6",
  "opus-4.6": "anthropic/claude-opus-4-6",
  sonnet: "anthropic/claude-sonnet-4-5",
  "sonnet-4": "anthropic/claude-sonnet-4-5",
  "sonnet-4.5": "anthropic/claude-sonnet-4-5",
  "sonnet-4.6": "anthropic/claude-sonnet-4-6",
  haiku: "anthropic/claude-haiku-4-5",
  "haiku-4": "anthropic/claude-haiku-4-5",
  "haiku-4.5": "anthropic/claude-haiku-4-5",
  // Kimi
  kimi: "kimi-coding/kimi-for-coding",
  "kimi-k2": "kimi-coding/kimi-for-coding",
  "k2.5": "kimi-coding/kimi-for-coding",
  // Tier shortcuts
  auto: "__AUTO__",
};

/**
 * Tier aliases — maps short names to tier overrides.
 */
const TIER_ALIASES: Record<string, string> = {
  simple: "SIMPLE", basic: "SIMPLE", cheap: "SIMPLE",
  medium: "MEDIUM", balanced: "MEDIUM",
  complex: "COMPLEX", advanced: "COMPLEX",
  max: "REASONING", reasoning: "REASONING", think: "REASONING", deep: "REASONING",
};

/**
 * Session locks — keyed by session fingerprint.
 * Maps to a model ID or "__AUTO__" for unlocked.
 */
const sessionLocks = new Map<string, { model: string; lockedAt: number }>();

// Clean up old session locks every 30 minutes
setInterval(() => {
  const maxAge = 4 * 60 * 60 * 1000; // 4 hours
  const now = Date.now();
  for (const [key, val] of sessionLocks) {
    if (now - val.lockedAt > maxAge) sessionLocks.delete(key);
  }
}, 30 * 60 * 1000);

/**
 * Generate a stable session fingerprint from messages.
 * Uses the system prompt hash — stable within an OpenClaw session.
 */
function getSessionFingerprint(messages: any[]): string {
  let systemText = "";
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = typeof msg.content === "string"
        ? msg.content
        : (msg.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("");
      // Use first 200 chars as fingerprint (stable across messages in same session)
      systemText += text.slice(0, 200);
    }
  }
  // Simple hash
  let hash = 0;
  for (let i = 0; i < systemText.length; i++) {
    hash = ((hash << 5) - hash + systemText.charCodeAt(i)) | 0;
  }
  return `session_${hash}`;
}

type PromptOverride = {
  type: "model" | "tier" | "lock" | "unlock" | "status";
  value: string; // model ID, tier name, or ""
  cleanedPrompt: string;
};

/**
 * Detect all override types in prompt text:
 * - /opus <prompt>       → per-prompt model override
 * - /simple <prompt>     → per-prompt tier override
 * - /lock opus           → session lock to model
 * - /lock simple         → session lock to tier
 * - /unlock              → remove session lock
 * - /lock auto           → remove session lock
 * - /lock status         → show current lock status
 */
function detectOverride(prompt: string): PromptOverride | null {
  // Match /command [arg] [rest...]
  const slashMatch = prompt.match(/^\/([a-z0-9._-]+)(?:\s+(.*))?$/is);
  if (!slashMatch) {
    // Also support [model] prefix and "model mode:" prefix
    const bracketMatch = prompt.match(/^\[([a-z0-9._-]+)\]\s*(.*)/is);
    if (bracketMatch) {
      const key = bracketMatch[1].toLowerCase();
      const rest = bracketMatch[2].trim();
      if (MODEL_ALIASES[key] && MODEL_ALIASES[key] !== "__AUTO__") {
        return { type: "model", value: MODEL_ALIASES[key], cleanedPrompt: rest };
      }
      if (TIER_ALIASES[key]) {
        return { type: "tier", value: TIER_ALIASES[key], cleanedPrompt: rest };
      }
    }
    return null;
  }

  const cmd = slashMatch[1].toLowerCase();
  const rest = (slashMatch[2] ?? "").trim();

  // /lock <model|tier|auto|status>
  if (cmd === "lock") {
    if (!rest || rest.toLowerCase() === "auto") {
      return { type: "unlock", value: "", cleanedPrompt: "" };
    }
    if (rest.toLowerCase() === "status") {
      return { type: "status", value: "", cleanedPrompt: "" };
    }
    const modelKey = rest.toLowerCase();
    if (MODEL_ALIASES[modelKey]) {
      return { type: "lock", value: MODEL_ALIASES[modelKey], cleanedPrompt: "" };
    }
    if (TIER_ALIASES[modelKey]) {
      // Lock to a tier's primary model
      return { type: "lock", value: `__TIER__:${TIER_ALIASES[modelKey]}`, cleanedPrompt: "" };
    }
    // Try as full model ID (e.g., /lock anthropic/claude-opus-4-6)
    if (rest.includes("/")) {
      return { type: "lock", value: rest, cleanedPrompt: "" };
    }
    return null;
  }

  // /unlock
  if (cmd === "unlock") {
    return { type: "unlock", value: "", cleanedPrompt: "" };
  }

  // /model-alias <prompt> → per-prompt model override
  if (MODEL_ALIASES[cmd] && MODEL_ALIASES[cmd] !== "__AUTO__") {
    return { type: "model", value: MODEL_ALIASES[cmd], cleanedPrompt: rest };
  }

  // /tier-alias <prompt> → per-prompt tier override
  if (TIER_ALIASES[cmd]) {
    return { type: "tier", value: TIER_ALIASES[cmd], cleanedPrompt: rest };
  }

  return null;
}

/**
 * Pending confirmations — keyed by session fingerprint.
 * When FreeRouter detects an ambiguous model switch request,
 * it stores the intent here and asks the user to confirm.
 */
const pendingConfirmations = new Map<string, {
  type: "model" | "lock";
  value: string;
  askedAt: number;
}>();

// Clean up old confirmations every 5 minutes
setInterval(() => {
  const maxAge = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();
  for (const [key, val] of pendingConfirmations) {
    if (now - val.askedAt > maxAge) pendingConfirmations.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * Detect natural language model/session override in prompt text.
 *
 * High confidence (apply immediately):
 *   "use opus", "switch to sonnet", "change to kimi"
 *   "use opus for this session", "lock to opus"
 *
 * Medium confidence (apply immediately, benefit of doubt):
 *   "try opus", "let's use sonnet", "go with opus"
 *
 * Low confidence (ask to confirm):
 *   "maybe use opus?", "should we use opus?", "opus might be better"
 *
 * Returns null if no model-switch intent detected.
 */
function detectNaturalLanguageOverride(prompt: string): PromptOverride | null {
  const lower = prompt.toLowerCase().trim();

  // Check for confirmation response first (/yes, /no, yes, no)
  if (/^\/?(yes|y|yeah|yep|confirm|ok|sure|do it)\s*$/i.test(lower)) {
    return { type: "model", value: "__CONFIRM__", cleanedPrompt: "" };
  }
  if (/^\/?(no|n|nah|nope|cancel|nevermind)\s*$/i.test(lower)) {
    return { type: "model", value: "__CANCEL__", cleanedPrompt: "" };
  }

  // Build regex for all model names
  const allAliases = Object.keys(MODEL_ALIASES).filter(k => MODEL_ALIASES[k] !== "__AUTO__");
  const modelPattern = allAliases
    .sort((a, b) => b.length - a.length) // longest first
    .map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  // Also match full model IDs like "anthropic/claude-opus-4-6"
  const fullIdPattern = "[a-z][-a-z0-9]*/[a-z][-a-z0-9.]*";

  const modelRegex = new RegExp(`(${modelPattern}|${fullIdPattern})`, "i");

  // ─── Session-level patterns (high confidence → lock) ───
  const sessionPatterns = [
    /(?:use|switch to|change to|set|lock(?: to)?)\s+(\S+)\s+(?:for (?:this|the) session|for (?:all|everything)|from now on|going forward)/i,
    /(?:lock|stick with|keep using)\s+(\S+)\s*(?:for now|please|$)/i,
    /(?:this session|from now on|going forward),?\s*(?:use|switch to)\s+(\S+)/i,
  ];

  for (const pattern of sessionPatterns) {
    const match = lower.match(pattern);
    if (match) {
      const modelKey = match[1]?.toLowerCase();
      if (MODEL_ALIASES[modelKey]) {
        return { type: "lock", value: MODEL_ALIASES[modelKey], cleanedPrompt: "" };
      }
      if (TIER_ALIASES[modelKey]) {
        return { type: "lock", value: `__TIER__:${TIER_ALIASES[modelKey]}`, cleanedPrompt: "" };
      }
      if (modelKey?.includes("/")) {
        return { type: "lock", value: modelKey, cleanedPrompt: "" };
      }
    }
  }

  // ─── Per-prompt patterns (high confidence → immediate) ───
  const immediatePatterns = [
    // "use opus", "use opus for this"
    /^(?:use|switch to|change to|go with|try)\s+(\S+)\s*$/i,
    // "use opus: <prompt>" or "use opus, <prompt>"
    /^(?:use|switch to|change to)\s+(\S+)[,:]\s*(.+)$/is,
    // "let's use opus"
    /^let'?s\s+(?:use|try|go with)\s+(\S+)\s*$/i,
    // "can you use opus" / "please use opus"
    /^(?:can you|could you|please)\s+(?:use|switch to|change to)\s+(\S+)\s*$/i,
    // "go back to auto" / "back to auto routing"
    /^(?:go )?back to\s+(?:auto|automatic|auto[- ]?routing)\s*$/i,
  ];

  for (const pattern of immediatePatterns) {
    const match = lower.match(pattern);
    if (match) {
      // Check "back to auto"
      if (/back to\s+auto/i.test(lower)) {
        return { type: "unlock", value: "", cleanedPrompt: "" };
      }

      const modelKey = match[1]?.toLowerCase();
      const remaining = match[2]?.trim() ?? "";

      if (MODEL_ALIASES[modelKey]) {
        return { type: "model", value: MODEL_ALIASES[modelKey], cleanedPrompt: remaining };
      }
      if (TIER_ALIASES[modelKey]) {
        return { type: "tier", value: TIER_ALIASES[modelKey], cleanedPrompt: remaining };
      }
      if (modelKey?.includes("/")) {
        return { type: "model", value: modelKey, cleanedPrompt: remaining };
      }
    }
  }

  // ─── Ambiguous patterns (low confidence → ask to confirm) ───
  // Only trigger if the prompt is SHORT and primarily about switching models
  if (lower.length < 100) {
    const ambiguousPatterns = [
      // "maybe use opus?" / "should we use opus?"
      /(?:maybe|should (?:we|i|you)|how about|what about)\s+(?:use|using|try|trying|switch(?:ing)? to)\s+(\S+?)[\s?!.,]*$/i,
      // "opus might be better" / "opus would work better"
      /^(\S+)\s+(?:might|would|could|should)\s+(?:be|work)\s+better/i,
      // "I think opus" / "I want opus"
      /^i\s+(?:think|want|prefer|need)\s+(\S+)\s*$/i,
      // "opus please" / "sonnet please"
      /^(\S+)\s+please\s*$/i,
    ];

    for (const pattern of ambiguousPatterns) {
      const match = lower.match(pattern);
      if (match) {
        const modelKey = match[1]?.toLowerCase();
        if (MODEL_ALIASES[modelKey]) {
          return { type: "model", value: `__ASK__:${MODEL_ALIASES[modelKey]}`, cleanedPrompt: "" };
        }
        if (TIER_ALIASES[modelKey]) {
          return { type: "tier", value: `__ASK__:${TIER_ALIASES[modelKey]}`, cleanedPrompt: "" };
        }
      }
    }
  }

  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendError(res: ServerResponse, status: number, message: string, type = "server_error") {
  if (!res.headersSent) {
    res.writeHead(status, { "Content-Type": "application/json" });
  }
  if (!res.writableEnded) {
    res.end(JSON.stringify({ error: { message, type, code: status } }));
  }
}

export function createProxyServer(options: ProxyOptions): { server: Server; stats: ProxyStats } {
  const { port, host, pluginConfig, openclawConfig, logger } = options;

  // Apply user config overrides to default routing config
  const routingConfig = applyConfigOverrides(getRoutingConfig(), pluginConfig);
  const modelPricing = buildPricingMap();
  const forwarder = createForwarder(openclawConfig, logger);

  const stats: ProxyStats = {
    started: new Date().toISOString(),
    requests: 0,
    errors: 0,
    timeouts: 0,
    byTier: { SIMPLE: 0, MEDIUM: 0, COMPLEX: 0, REASONING: 0 },
    byModel: {},
  };

  function preflightHealth() {
    const modelSet = new Set<string>(["freerouter/auto"]);
    for (const tier of Object.values(routingConfig.tiers)) {
      if (tier?.primary) modelSet.add(tier.primary);
      for (const fb of tier?.fallback ?? []) {
        modelSet.add(fb);
      }
    }
    return forwarder.preflight(Array.from(modelSet));
  }

  async function handleChatCompletions(req: IncomingMessage, res: ServerResponse) {
    const bodyStr = await readBody(req);
    let chatReq: any;
    try {
      chatReq = JSON.parse(bodyStr);
    } catch {
      return sendError(res, 400, "Invalid JSON body");
    }

    if (!chatReq.messages?.length) {
      return sendError(res, 400, "messages array is required");
    }

    const stream = chatReq.stream ?? false;
    const maxTokens = chatReq.max_tokens ?? 4096;
    const { prompt, systemPrompt } = extractPromptForClassification(chatReq.messages);

    if (!prompt) {
      return sendError(res, 400, "No user message found");
    }

    const requestedModel = chatReq.model ?? "auto";
    let routedModel: string;
    let tier: string;
    let reasoning: string;
    let thinkingMode: string = "off";

    const sessionId = getSessionFingerprint(chatReq.messages);
    const reqNum = stats.requests + 1;

    if (requestedModel === "auto" || requestedModel === "freerouter/auto") {
      // Priority order:
      // 1. Per-prompt override (/opus, /simple, [sonnet])
      // 2. Session lock (/lock opus)
      // 3. Auto-classification

      // Try slash/bracket override first, then natural language
      let override = detectOverride(prompt);
      if (!override) {
        override = detectNaturalLanguageOverride(prompt);
      }

      // Handle confirmation responses
      if (override?.value === "__CONFIRM__") {
        const pending = pendingConfirmations.get(sessionId);
        if (pending) {
          pendingConfirmations.delete(sessionId);
          if (pending.type === "lock") {
            sessionLocks.set(sessionId, { model: pending.value, lockedAt: Date.now() });
            const msg = `🔒 Confirmed! Session locked to **${pending.value}**.`;
            const synth = {
              id: `chatcmpl-confirm-${Date.now()}`, object: "chat.completion",
              created: Math.floor(Date.now() / 1000), model: pending.value,
              choices: [{ index: 0, message: { role: "assistant", content: msg }, finish_reason: "stop" }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(synth));
            stats.requests++;
            return;
          } else {
            // Per-prompt confirm — route with the pending model
            override = { type: "model", value: pending.value, cleanedPrompt: "" };
          }
        }
        // No pending confirmation — treat as normal prompt, fall through
        if (!override || override.value === "__CONFIRM__") override = null;
      }

      if (override?.value === "__CANCEL__") {
        const pending = pendingConfirmations.get(sessionId);
        pendingConfirmations.delete(sessionId);
        if (pending) {
          const msg = `👍 Cancelled. Continuing with auto-routing.`;
          const synth = {
            id: `chatcmpl-cancel-${Date.now()}`, object: "chat.completion",
            created: Math.floor(Date.now() / 1000), model: "freerouter/auto",
            choices: [{ index: 0, message: { role: "assistant", content: msg }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(synth));
          stats.requests++;
          return;
        }
        override = null; // No pending, treat "no" as normal
      }

      // Handle __ASK__ (ambiguous — need confirmation)
      if (override?.value?.startsWith("__ASK__:")) {
        const targetModel = override.value.slice(8);
        const askType = override.type === "model" ? "model" : "lock";
        pendingConfirmations.set(sessionId, { type: askType, value: targetModel, askedAt: Date.now() });
        const msg = `🤔 Did you want to switch to **${targetModel}**?\n\nReply **yes** to confirm or **no** to cancel.`;
        const synth = {
          id: `chatcmpl-ask-${Date.now()}`, object: "chat.completion",
          created: Math.floor(Date.now() / 1000), model: "freerouter/auto",
          choices: [{ index: 0, message: { role: "assistant", content: msg }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(synth));
        stats.requests++;
        return;
      }

      if (override?.type === "lock") {
        // Lock session to a model or tier
        let lockModel = override.value;
        if (lockModel.startsWith("__TIER__:")) {
          const lockTier = lockModel.slice(9) as keyof typeof routingConfig.tiers;
          lockModel = routingConfig.tiers[lockTier]?.primary ?? "anthropic/claude-opus-4-6";
        }
        sessionLocks.set(sessionId, { model: lockModel, lockedAt: Date.now() });
        logger.info(`[freerouter] [${reqNum}] Session locked to ${lockModel}`);
        // Return a synthetic response confirming the lock
        res.setHeader("X-FreeRouter-Model", lockModel);
        res.setHeader("X-FreeRouter-Tier", "LOCKED");
        res.setHeader("X-FreeRouter-Session", "locked");
        // Don't forward — the lock command itself isn't a real prompt
        // But if there's remaining text, process it
        if (!override.cleanedPrompt) {
          const lockMsg = `🔒 Session locked to **${lockModel}**. All messages will use this model until you send \`/unlock\`.`;
          const synth = {
            id: `chatcmpl-lock-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: lockModel,
            choices: [{ index: 0, message: { role: "assistant", content: lockMsg }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(synth));
          stats.requests++;
          return;
        }
        // If there's a prompt after the lock, process it with the locked model
        routedModel = lockModel;
        tier = "LOCKED";
        reasoning = `session-lock: ${lockModel}`;

      } else if (override?.type === "unlock") {
        sessionLocks.delete(sessionId);
        logger.info(`[freerouter] [${reqNum}] Session unlocked → auto-routing`);
        const unlockMsg = `🔓 Session unlocked. Back to auto-routing.`;
        const synth = {
          id: `chatcmpl-unlock-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "freerouter/auto",
          choices: [{ index: 0, message: { role: "assistant", content: unlockMsg }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(synth));
        stats.requests++;
        return;

      } else if (override?.type === "status") {
        const lock = sessionLocks.get(sessionId);
        const statusMsg = lock
          ? `🔒 Session is locked to **${lock.model}** (since ${new Date(lock.lockedAt).toLocaleTimeString()}). Send \`/unlock\` to return to auto-routing.`
          : `🔓 Session is in auto-routing mode. Use \`/lock <model>\` to lock.`;
        const synth = {
          id: `chatcmpl-status-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: lock?.model ?? "freerouter/auto",
          choices: [{ index: 0, message: { role: "assistant", content: statusMsg }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(synth));
        stats.requests++;
        return;

      } else if (override?.type === "model") {
        // Per-prompt model override: /opus What is 2+2?
        routedModel = override.value;
        tier = "OVERRIDE";
        reasoning = `prompt-override: ${routedModel}`;
        logger.info(`[freerouter] [${reqNum}] Model override: ${routedModel}`);

      } else if (override?.type === "tier") {
        // Per-prompt tier override: /simple What is 2+2?
        const tierKey = override.value as keyof typeof routingConfig.tiers;
        const tierConfig = routingConfig.tiers[tierKey];
        routedModel = tierConfig?.primary ?? "anthropic/claude-opus-4-6";
        tier = override.value;
        reasoning = `tier-override: ${override.value}`;
        logger.info(`[freerouter] [${reqNum}] Tier override: ${tier} → ${routedModel}`);

      } else {
        // Check session lock
        const lock = sessionLocks.get(sessionId);
        if (lock) {
          routedModel = lock.model;
          tier = "LOCKED";
          reasoning = `session-lock: ${lock.model}`;
          logger.info(`[freerouter] [${reqNum}] Session locked → ${routedModel}`);

        } else {
          // Auto-classify
          const decision = route(prompt, systemPrompt, maxTokens, {
            config: routingConfig,
            modelPricing,
          });
          routedModel = decision.model;
          tier = decision.tier;
          reasoning = decision.reasoning;
          logger.info(`[freerouter] [${reqNum}] Classified: tier=${tier} model=${routedModel} confidence=${decision.confidence.toFixed(2)} | ${reasoning}`);
        }
      }
    } else {
      routedModel = requestedModel;
      tier = "EXPLICIT";
      reasoning = `explicit: ${requestedModel}`;
      logger.info(`[freerouter] [${reqNum}] Passthrough: model=${routedModel}`);
    }

    // Determine thinking mode
    // Opus 4.6 REQUIRES adaptive thinking — manual mode is deprecated by Anthropic
    // Other models can use enabled(budget) for explicit thinking control
    const thinkingCfg = pluginConfig.thinking as any;
    const adaptivePatterns = thinkingCfg?.adaptive ?? ["claude-opus-4-6"];
    const enabledCfg = thinkingCfg?.enabled;

    if (adaptivePatterns.some((p: string) => routedModel.includes(p))) {
      // Adaptive thinking models (e.g., Opus 4.6) — always use adaptive
      // Anthropic deprecated manual thinking for Opus 4.6
      thinkingMode = "adaptive";
    } else if (enabledCfg?.models?.some((p: string) => routedModel.includes(p))) {
      thinkingMode = `enabled(${enabledCfg.budget ?? 4096})`;
    }

    // Update stats
    stats.requests++;
    stats.byTier[tier] = (stats.byTier[tier] ?? 0) + 1;
    stats.byModel[routedModel] = (stats.byModel[routedModel] ?? 0) + 1;

    // Set routing info headers — OpenClaw can read these
    res.setHeader("X-FreeRouter-Model", routedModel);
    res.setHeader("X-FreeRouter-Tier", tier);
    res.setHeader("X-FreeRouter-Thinking", thinkingMode);
    res.setHeader("X-FreeRouter-Reasoning", reasoning.slice(0, 200));

    // Build fallback chain
    const modelsToTry: string[] = [routedModel];
    if (tier !== "EXPLICIT") {
      const tierConfig = routingConfig.tiers[tier as keyof typeof routingConfig.tiers];
      if (tierConfig?.fallback) {
        for (const fb of tierConfig.fallback) {
          if (fb !== routedModel) modelsToTry.push(fb);
        }
      }
    }

    // Preflight check: ensure auth/config for every provider we might hit.
    const preflightModels = [requestedModel, ...modelsToTry];
    const preflight = forwarder.preflight(preflightModels);
    if (!preflight.ok) {
      const issue = preflight.issues[0];
      if (!issue) {
        sendError(res, 503, "Freerouter preflight failed", "auth_error");
      } else {
        const details = preflight.issues
          .map((i) => `${i.provider}: ${i.reason}`)
          .join("; ");
        sendError(res, 503, `Freerouter preflight failed: ${details}`, "auth_error");
      }
      return;
    }

    let lastError = "";
    for (const modelToTry of modelsToTry) {
      try {
        if (modelToTry !== routedModel) {
          logger.info(`[freerouter] [${stats.requests}] Falling back to ${modelToTry}`);
          res.setHeader("X-FreeRouter-Model", modelToTry);
        }

        // KEY FIX: Forward with the REAL model name — not "freerouter/X"
        // Inject model identity into messages so the agent knows which model it's running on
        const injectedMessages = [...chatReq.messages];
        const modelHint = `[FreeRouter] You are running on model: ${modelToTry} | Tier: ${tier} | Thinking: ${thinkingMode}`;
        // Insert as a developer message right after system prompts (before user messages)
        const lastSystemIdx = injectedMessages.reduce((acc: number, m: any, i: number) =>
          (m.role === "system" || m.role === "developer") ? i : acc, -1);
        injectedMessages.splice(lastSystemIdx + 1, 0, { role: "developer", content: modelHint });
        const injectedReq = { ...chatReq, messages: injectedMessages };
        await forwarder.forward(injectedReq, modelToTry, tier, thinkingMode, res, stream);
        return;
      } catch (err: any) {
        lastError = err.message ?? String(err);
        if (err.name === "TimeoutError") {
          stats.timeouts++;
          logger.error(`[freerouter] TIMEOUT (${modelToTry}): ${lastError}`);
        } else {
          logger.error(`[freerouter] Forward error (${modelToTry}): ${lastError}`);
        }
        if (res.headersSent) break;
      }
    }

    stats.errors++;
    if (!res.headersSent) {
      sendError(res, 502, `Backend error: ${lastError}`, "upstream_error");
    } else if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: lastError } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }

  function handleListModels(_req: IncomingMessage, res: ServerResponse) {
    const models = Object.values(routingConfig.tiers).flatMap(t => [t.primary, ...t.fallback]);
    const unique = [...new Set(models)];

    const data = [
      { id: "auto", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "freerouter" },
      ...unique.map(m => ({
        id: m,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: m.split("/")[0],
      })),
    ];

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data }));
  }

  function handleHealth(_req: IncomingMessage, res: ServerResponse) {
    const pf = preflightHealth();
    const status = pf.ok ? "ok" : "degraded";
    const payload: Record<string, unknown> = {
      status,
      version: "2.0.0",
      uptime: process.uptime(),
      stats,
    };

    if (!pf.ok) {
      payload.issues = pf.issues;
    }

    res.writeHead(pf.ok ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  function handleStats(_req: IncomingMessage, res: ServerResponse) {
    const lockInfo: Record<string, { model: string; lockedAt: string }> = {};
    for (const [key, val] of sessionLocks) {
      lockInfo[key] = { model: val.model, lockedAt: new Date(val.lockedAt).toISOString() };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...stats, activeLocks: sessionLocks.size, locks: lockInfo }, null, 2));
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
        await handleChatCompletions(req, res);
      } else if (method === "GET" && (url === "/v1/models" || url === "/models")) {
        handleListModels(req, res);
      } else if (method === "GET" && url === "/health") {
        handleHealth(req, res);
      } else if (method === "GET" && url === "/stats") {
        handleStats(req, res);
      } else if (method === "DELETE" && url === "/sessions/locks") {
        // Clear all session locks
        const count = sessionLocks.size;
        sessionLocks.clear();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cleared: count }));
      } else if (method === "GET" && url === "/sessions/locks") {
        const locks: Record<string, any> = {};
        for (const [key, val] of sessionLocks) {
          locks[key] = { model: val.model, lockedAt: new Date(val.lockedAt).toISOString() };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ count: sessionLocks.size, locks }));
      } else {
        sendError(res, 404, `Not found: ${method} ${url}`, "not_found");
      }
    } catch (err: any) {
      logger.error(`[freerouter] Unhandled: ${err.message}`);
      if (!res.headersSent) sendError(res, 500, err.message);
    }
  }

  const server = createServer(handleRequest);
  server.listen(port, host);

  return { server, stats };
}
