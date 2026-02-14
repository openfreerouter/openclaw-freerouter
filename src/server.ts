/**
 * FreeRouter Proxy Server — OpenClaw Plugin Edition
 *
 * Exports startServer()/stopServer() for plugin lifecycle management
 * instead of auto-starting on import.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { route } from "./router/index.js";
import { getRoutingConfig } from "./router/config.js";
import { buildPricingMap } from "./models.js";
import { forwardRequest, TimeoutError, type ChatRequest } from "./provider.js";
import { reloadAuth } from "./auth.js";
import { loadConfig, loadConfigFromPlugin, getConfig, reloadConfig, getSanitizedConfig, getConfigPath } from "./config.js";
import { logger, setLogLevel } from "./logger.js";

// Build pricing map once at startup
let modelPricing = buildPricingMap();

// Stats
const stats = {
  started: new Date().toISOString(),
  requests: 0,
  errors: 0,
  timeouts: 0,
  byTier: { SIMPLE: 0, MEDIUM: 0, COMPLEX: 0, REASONING: 0 } as Record<string, number>,
  byModel: {} as Record<string, number>,
};

// Server instance
let _server: Server | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendError(res: ServerResponse, status: number, message: string, type = "server_error") {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message, type, code: status } }));
}

function extractPromptForClassification(messages: ChatRequest["messages"]): {
  prompt: string;
  systemPrompt: string | undefined;
} {
  let systemPrompt: string | undefined;
  const contextWindow = 3;
  const conversationMsgs: Array<{ role: string; text: string }> = [];

  for (const msg of messages) {
    const text = typeof msg.content === "string"
      ? msg.content
      : (msg.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("\n");

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
    if (msg.text !== lastUserMsg) contextParts.push(msg.text.slice(0, 500));
  }

  const prompt = contextParts.length > 0
    ? contextParts.join("\n") + "\n" + lastUserMsg
    : lastUserMsg;

  return { prompt, systemPrompt };
}

function detectModeOverride(prompt: string): { tier: string; cleanedPrompt: string } | null {
  const modeMap: Record<string, string> = {
    simple: "SIMPLE", basic: "SIMPLE", cheap: "SIMPLE",
    medium: "MEDIUM", balanced: "MEDIUM",
    complex: "COMPLEX", advanced: "COMPLEX",
    max: "REASONING", reasoning: "REASONING", think: "REASONING", deep: "REASONING",
  };

  const slashMatch = prompt.match(/^\/([a-z]+)\s+/i);
  if (slashMatch) {
    const mode = slashMatch[1].toLowerCase();
    if (modeMap[mode]) return { tier: modeMap[mode], cleanedPrompt: prompt.slice(slashMatch[0].length).trim() };
  }

  const prefixMatch = prompt.match(/^([a-z]+)\s+mode[:\s,]+/i);
  if (prefixMatch) {
    const mode = prefixMatch[1].toLowerCase();
    if (modeMap[mode]) return { tier: modeMap[mode], cleanedPrompt: prompt.slice(prefixMatch[0].length).trim() };
  }

  const bracketMatch = prompt.match(/^\[([a-z]+)\]\s*/i);
  if (bracketMatch) {
    const mode = bracketMatch[1].toLowerCase();
    if (modeMap[mode]) return { tier: modeMap[mode], cleanedPrompt: prompt.slice(bracketMatch[0].length).trim() };
  }

  return null;
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse) {
  const bodyStr = await readBody(req);
  let chatReq: ChatRequest;

  try {
    chatReq = JSON.parse(bodyStr);
  } catch {
    return sendError(res, 400, "Invalid JSON body");
  }

  if (!chatReq.model) return sendError(res, 400, "model field is required");
  if (!chatReq.messages || !Array.isArray(chatReq.messages) || chatReq.messages.length === 0) {
    return sendError(res, 400, "messages array is required");
  }

  const stream = chatReq.stream ?? false;
  const maxTokens = chatReq.max_tokens ?? 4096;
  const { prompt, systemPrompt } = extractPromptForClassification(chatReq.messages);
  if (!prompt) return sendError(res, 400, "No user message found");

  const requestedModel = chatReq.model ?? "auto";
  let routedModel: string;
  let tier: string;
  let reasoning: string;

  if (requestedModel === "auto" || requestedModel === "freerouter/auto" || requestedModel === "clawrouter/auto" || requestedModel === "blockrun/auto") {
    const modeOverride = detectModeOverride(prompt);

    if (modeOverride) {
      const routingCfg = getRoutingConfig();
      const tierConfig = routingCfg.tiers[modeOverride.tier as keyof typeof routingCfg.tiers];
      routedModel = tierConfig?.primary ?? "anthropic/claude-opus-4-6";
      tier = modeOverride.tier;
      reasoning = `user-mode: ${modeOverride.tier.toLowerCase()}`;
      logger.info(`[${stats.requests + 1}] Mode override: tier=${tier} model=${routedModel} | ${reasoning}`);
    } else {
      const decision = route(prompt, systemPrompt, maxTokens, {
        config: getRoutingConfig(),
        modelPricing,
      });
      routedModel = decision.model;
      tier = decision.tier;
      reasoning = decision.reasoning;
      logger.info(`[${stats.requests + 1}] Classified: tier=${tier} model=${routedModel} confidence=${decision.confidence.toFixed(2)} | ${reasoning}`);
    }
  } else {
    routedModel = requestedModel;
    tier = "EXPLICIT";
    reasoning = `explicit model: ${requestedModel}`;
    logger.info(`[${stats.requests + 1}] Passthrough: model=${routedModel}`);
  }

  stats.requests++;
  stats.byTier[tier] = (stats.byTier[tier] ?? 0) + 1;
  stats.byModel[routedModel] = (stats.byModel[routedModel] ?? 0) + 1;

  res.setHeader("X-FreeRouter-Model", routedModel);
  res.setHeader("X-FreeRouter-Tier", tier);
  res.setHeader("X-FreeRouter-Reasoning", reasoning.slice(0, 200));

  const modelsToTry: string[] = [routedModel];
  if (tier !== "EXPLICIT") {
    const routingCfg = getRoutingConfig();
    const tierConfig = routingCfg.tiers[tier as keyof typeof routingCfg.tiers];
    if (tierConfig?.fallback) {
      for (const fb of tierConfig.fallback) {
        if (fb !== routedModel) modelsToTry.push(fb);
      }
    }
  }

  let lastError: string = "";
  for (const modelToTry of modelsToTry) {
    try {
      if (modelToTry !== routedModel) {
        logger.info(`[${stats.requests}] Falling back to ${modelToTry}`);
        res.setHeader("X-FreeRouter-Model", modelToTry);
      }
      await forwardRequest(chatReq, modelToTry, tier, res, stream);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof TimeoutError) {
        stats.timeouts++;
        logger.error(`⏱ TIMEOUT (${modelToTry}): ${lastError}`);
      } else {
        logger.error(`Forward error (${modelToTry}): ${lastError}`);
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
  const models = [
    { id: "auto", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "freerouter" },
    { id: "anthropic/claude-opus-4-6", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "anthropic" },
    { id: "anthropic/claude-sonnet-4-5", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "anthropic" },
    { id: "anthropic/claude-haiku-4-5", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "anthropic" },
    { id: "kimi-coding/kimi-for-coding", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "kimi-coding" },
  ];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ object: "list", data: models }));
}

function handleHealth(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", version: "1.3.0", uptime: process.uptime(), stats }));
}

function handleStats(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(stats, null, 2));
}

function handleConfig(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ configPath: getConfigPath(), config: getSanitizedConfig() }, null, 2));
}

function handleReloadConfig(_req: IncomingMessage, res: ServerResponse) {
  reloadConfig();
  reloadAuth();
  modelPricing = buildPricingMap();
  const cfg = getConfig();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "reloaded", providers: Object.keys(cfg.providers), tiers: Object.keys(cfg.tiers) }));
}

function handleReload(_req: IncomingMessage, res: ServerResponse) {
  reloadConfig();
  reloadAuth();
  modelPricing = buildPricingMap();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "reloaded" }));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    if (method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      await handleChatCompletions(req, res);
    } else if (method === "GET" && (url === "/v1/models" || url === "/models")) {
      handleListModels(req, res);
    } else if (method === "GET" && url === "/health") {
      handleHealth(req, res);
    } else if (method === "GET" && url === "/stats") {
      handleStats(req, res);
    } else if (method === "POST" && url === "/reload") {
      handleReload(req, res);
    } else if (method === "GET" && url === "/config") {
      handleConfig(req, res);
    } else if (method === "POST" && url === "/reload-config") {
      handleReloadConfig(req, res);
    } else {
      sendError(res, 404, `Not found: ${method} ${url}`, "not_found");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Unhandled error: ${msg}`);
    if (!res.headersSent) sendError(res, 500, msg);
  }
}

// ═══ Plugin Lifecycle ═══

export type ServerOptions = {
  port?: number;
  host?: string;
  pluginConfig?: Record<string, unknown>;
  debug?: boolean;
};

/**
 * Start the FreeRouter proxy server.
 * Returns a promise that resolves when the server is listening.
 */
export function startServer(options: ServerOptions = {}): Promise<Server> {
  if (_server) {
    return Promise.resolve(_server);
  }

  // Load config
  if (options.pluginConfig) {
    loadConfigFromPlugin(options.pluginConfig);
  } else {
    loadConfig();
  }

  if (options.debug) setLogLevel("debug");

  const cfg = getConfig();
  const port = options.port ?? cfg.port;
  const host = options.host ?? cfg.host ?? "127.0.0.1";

  modelPricing = buildPricingMap();

  return new Promise((resolve, reject) => {
    const server = createServer(handleRequest);

    server.on("error", (err) => {
      logger.error(`Server error: ${err.message}`);
      reject(err);
    });

    server.listen(port, host, () => {
      _server = server;
      logger.info(`🚀 FreeRouter proxy listening on http://${host}:${port} (config: ${getConfigPath() ?? "built-in defaults"})`);
      logger.info(`   POST /v1/chat/completions  — route & forward`);
      logger.info(`   GET  /v1/models            — list models`);
      logger.info(`   GET  /health               — health check`);
      logger.info(`   GET  /stats                — request statistics`);
      logger.info(`   POST /reload               — reload auth keys`);
      logger.info(`   GET  /config               — show config (sanitized)`);
      logger.info(`   POST /reload-config        — reload config + auth`);
      resolve(server);
    });
  });
}

/**
 * Stop the FreeRouter proxy server.
 */
export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!_server) { resolve(); return; }
    logger.info("Shutting down FreeRouter proxy...");
    _server.close(() => {
      _server = null;
      resolve();
    });
  });
}

/**
 * Get the running server instance (or null).
 */
export function getServer(): Server | null {
  return _server;
}

// ═══ Standalone mode (when run directly) ═══
const isDirectRun = process.argv[1]?.includes("server") && !process.argv.includes("--no-auto");
if (isDirectRun) {
  const debug = process.argv.includes("--debug");
  const port = parseInt(process.env.FREEROUTER_PORT ?? "18800", 10);
  const host = process.env.FREEROUTER_HOST ?? "127.0.0.1";
  startServer({ port, host, debug }).catch((err) => {
    logger.error(`Failed to start: ${err.message}`);
    process.exit(1);
  });

  process.on("SIGINT", () => { stopServer().then(() => process.exit(0)); });
  process.on("SIGTERM", () => { stopServer().then(() => process.exit(0)); });
}