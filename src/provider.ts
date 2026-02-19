/**
 * FreeRouter Provider — forwards to backend APIs
 *
 * Reads auth from OpenClaw's auth-profiles.json.
 * Returns the REAL model name in responses (not "freerouter/X").
 *
 * Supports: Anthropic Messages API, OpenAI-compatible (Kimi, OpenAI, etc.)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ServerResponse } from "node:http";

// ─── Timeout Configuration ───
const TIER_TIMEOUTS: Record<string, number> = {
  SIMPLE: 30_000,
  MEDIUM: 60_000,
  COMPLEX: 120_000,
  REASONING: 120_000,
  EXPLICIT: 120_000,
};
const STREAM_STALL_TIMEOUT = 30_000;

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

// ─── Provider Config ───

type ProviderDef = {
  baseUrl: string;
  api: "anthropic" | "openai";
  headers?: Record<string, string>;
};

// Default provider definitions
const DEFAULT_PROVIDERS: Record<string, ProviderDef> = {
  anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic" },
  "kimi-coding": {
    baseUrl: "https://api.kimi.com/coding/v1",
    api: "openai",
    headers: { "User-Agent": "KimiCLI/0.77" },
  },
  openai: { baseUrl: "https://api.openai.com/v1", api: "openai" },
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", api: "openai" },
};

// ─── Auth ───

type AuthProfiles = {
  version: number;
  profiles: Record<string, { type: string; provider: string; token?: string; key?: string }>;
  lastGood?: Record<string, string>;
};

function loadAuthProfiles(): Map<string, { token?: string; apiKey?: string }> {
  const filePath = join(homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json");
  try {
    const data: AuthProfiles = JSON.parse(readFileSync(filePath, "utf-8"));
    const map = new Map<string, { token?: string; apiKey?: string }>();
    const lastGood = data.lastGood ?? {};

    for (const [name, profile] of Object.entries(data.profiles)) {
      const provider = profile.provider;
      const existing = map.has(provider);
      const isLastGood = lastGood[provider] === name;
      if (existing && !isLastGood) continue;

      map.set(provider, {
        token: profile.type === "token" ? profile.token : undefined,
        apiKey: profile.type === "api_key" ? profile.key : undefined,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

// ─── Forwarder ───

export function createForwarder(openclawConfig: any, logger: any) {
  let authCache: Map<string, { token?: string; apiKey?: string }> | null = null;

  function getAuth(provider: string) {
    if (!authCache) authCache = loadAuthProfiles();
    return authCache.get(provider);
  }

  function parseModelId(modelId: string): { provider: string; model: string } {
    const slash = modelId.indexOf("/");
    if (slash === -1) return { provider: "anthropic", model: modelId };
    return { provider: modelId.slice(0, slash), model: modelId.slice(slash + 1) };
  }

  function getProviderDef(provider: string): ProviderDef | undefined {
    // Check OpenClaw config for custom provider definitions
    const ocProviders = (openclawConfig as any)?.providers;
    if (ocProviders?.[provider]) {
      const p = ocProviders[provider];
      return {
        baseUrl: p.baseUrl ?? DEFAULT_PROVIDERS[provider]?.baseUrl,
        api: p.api === "anthropic-messages" ? "anthropic" : (p.api ?? DEFAULT_PROVIDERS[provider]?.api ?? "openai"),
        headers: p.headers,
      };
    }
    return DEFAULT_PROVIDERS[provider];
  }

  function getThinkingConfig(thinkingMode: string, _modelId: string): { type: string; budget_tokens?: number } | undefined {
    if (thinkingMode === "adaptive") return { type: "adaptive" };
    const budgetMatch = thinkingMode.match(/^enabled\((\d+)\)$/);
    if (budgetMatch) return { type: "enabled", budget_tokens: parseInt(budgetMatch[1]) };
    return undefined;
  }

  async function readStreamWithStallDetection(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onChunk: (value: Uint8Array) => void,
    abortController: AbortController,
  ): Promise<void> {
    while (true) {
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const stallPromise = new Promise<never>((_, reject) => {
        stallTimer = setTimeout(() => {
          abortController.abort();
          reject(new TimeoutError(`Stream stalled: no data for ${STREAM_STALL_TIMEOUT / 1000}s`));
        }, STREAM_STALL_TIMEOUT);
      });
      try {
        const result = await Promise.race([reader.read(), stallPromise]);
        clearTimeout(stallTimer);
        const { done, value } = result as ReadableStreamReadResult<Uint8Array>;
        if (done) break;
        if (value) onChunk(value);
      } catch (err) {
        clearTimeout(stallTimer);
        throw err;
      }
    }
  }

  // ─── Convert OpenAI format to Anthropic ───

  function convertToolsToAnthropic(tools: any[]): any[] {
    return tools.map((t: any) => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));
  }

  function convertToolChoiceToAnthropic(toolChoice: any): any {
    if (toolChoice === "none") return { type: "none" };
    if (toolChoice === "auto" || toolChoice === undefined) return { type: "auto" };
    if (toolChoice === "required") return { type: "any" };
    if (typeof toolChoice === "object" && toolChoice?.function?.name) return { type: "tool", name: toolChoice.function.name };
    return { type: "auto" };
  }

  function convertMessagesToAnthropic(openaiMessages: any[]): { system: string; messages: any[] } {
    let systemContent = "";
    const messages: any[] = [];

    for (const msg of openaiMessages) {
      const text = typeof msg.content === "string"
        ? msg.content
        : (msg.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");

      if (msg.role === "system" || msg.role === "developer") {
        systemContent += (systemContent ? "\n" : "") + text;
        continue;
      }

      if (msg.role === "tool") {
        const toolResult = {
          type: "tool_result",
          tool_use_id: msg.tool_call_id ?? "",
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
        };
        const last = messages[messages.length - 1];
        if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b: any) => b.type === "tool_result")) {
          last.content.push(toolResult);
        } else {
          messages.push({ role: "user", content: [toolResult] });
        }
        continue;
      }

      if (msg.role === "assistant" && msg.tool_calls?.length > 0) {
        const contentBlocks: any[] = [];
        if (msg.content) {
          const t = typeof msg.content === "string" ? msg.content
            : msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
          if (t) contentBlocks.push({ type: "text", text: t });
        }
        for (const tc of msg.tool_calls) {
          let input: unknown = {};
          try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
          contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
        messages.push({ role: "assistant", content: contentBlocks });
        continue;
      }

      messages.push({ role: msg.role === "assistant" ? "assistant" : "user", content: text || "" });
    }

    return { system: systemContent, messages };
  }

  // ─── Forward to Anthropic ───

  async function forwardToAnthropic(
    req: any, modelName: string, fullModelId: string, tier: string,
    thinkingMode: string, res: ServerResponse, stream: boolean,
  ) {
    const auth = getAuth("anthropic");
    if (!auth?.token && !auth?.apiKey) throw new Error("No Anthropic auth");

    const providerDef = getProviderDef("anthropic");
    if (!providerDef) throw new Error("Anthropic provider not configured");

    const { system, messages } = convertMessagesToAnthropic(req.messages);
    const token = auth.token ?? auth.apiKey!;
    const isOAuth = token.startsWith("sk-ant-oat");
    const thinkingConfig = getThinkingConfig(thinkingMode, modelName);
    const maxTokens = req.max_tokens ?? 4096;

    const body: Record<string, unknown> = {
      model: modelName,
      messages,
      max_tokens: (thinkingConfig?.type === "enabled" && thinkingConfig.budget_tokens)
        ? maxTokens + thinkingConfig.budget_tokens : maxTokens,
      stream,
    };

    if (req.tools?.length > 0) {
      body.tools = convertToolsToAnthropic(req.tools);
      if (req.tool_choice !== undefined) body.tool_choice = convertToolChoiceToAnthropic(req.tool_choice);
    }

    if (isOAuth) {
      body.system = [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
        ...(system ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : []),
      ];
    } else if (system) {
      body.system = system;
    }

    if (thinkingConfig) {
      body.thinking = thinkingConfig.type === "adaptive"
        ? { type: "adaptive" }
        : { type: "enabled", budget_tokens: thinkingConfig.budget_tokens };
    }

    if (req.temperature !== undefined && !thinkingConfig) body.temperature = req.temperature;

    const url = `${providerDef.baseUrl}/v1/messages`;
    const timeoutMs = TIER_TIMEOUTS[tier] ?? 60_000;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "accept": "application/json",
    };

    if (isOAuth) {
      headers["Authorization"] = `Bearer ${token}`;
      headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14";
      headers["user-agent"] = "claude-cli/2.1.2 (external, cli)";
      headers["x-app"] = "cli";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    } else {
      headers["x-api-key"] = token;
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST", headers, body: JSON.stringify(body), signal: abortController.signal,
      });
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err?.name === "AbortError") throw new TimeoutError(`Anthropic timeout after ${timeoutMs / 1000}s`);
      throw err;
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      const errText = await response.text();
      throw new Error(`Anthropic ${response.status}: ${errText}`);
    }

    if (!stream) {
      clearTimeout(timeoutId);
      const data = await response.json() as any;

      const textContent = data.content.filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("");
      const toolUseBlocks = data.content.filter((b: any) => b.type === "tool_use");
      const toolCalls = toolUseBlocks.map((b: any, idx: number) => ({
        id: b.id ?? `call_${Date.now()}_${idx}`,
        type: "function",
        function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
      }));

      const finishReason = data.stop_reason === "tool_use" ? "tool_calls"
        : data.stop_reason === "end_turn" ? "stop" : (data.stop_reason ?? "stop");

      const message: any = { role: "assistant", content: textContent || (toolCalls.length ? null : "") };
      if (toolCalls.length) message.tool_calls = toolCalls;

      // ★ KEY: Return the REAL model name, not "freerouter/X"
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: fullModelId,  // e.g. "anthropic/claude-opus-4-6"
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: {
          prompt_tokens: data.usage?.input_tokens ?? 0,
          completion_tokens: data.usage?.output_tokens ?? 0,
          total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
        },
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(openaiResponse));
      return;
    }

    // ─── Streaming ───
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    clearTimeout(timeoutId);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let insideThinking = false;
    let currentBlockType: string | null = null;
    let currentToolIndex = -1;
    let stopReason: string | null = null;

    const makeChunk = (delta: any, finish: string | null = null) => ({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: fullModelId,  // ★ REAL model name
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

    try {
      await readStreamWithStallDetection(reader, (value) => {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]" || !jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === "content_block_start") {
              const block = event.content_block;
              if (block?.type === "thinking") {
                insideThinking = true;
                currentBlockType = "thinking";
              } else if (block?.type === "tool_use") {
                insideThinking = false;
                currentBlockType = "tool_use";
                currentToolIndex++;
                const chunk = makeChunk({
                  tool_calls: [{
                    index: currentToolIndex,
                    id: block.id,
                    type: "function",
                    function: { name: block.name, arguments: "" },
                  }],
                });
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              } else {
                insideThinking = false;
                currentBlockType = block?.type ?? "text";
              }
              continue;
            }

            if (event.type === "content_block_stop") {
              insideThinking = false;
              currentBlockType = null;
              continue;
            }

            if (event.type === "content_block_delta") {
              if (insideThinking) continue;
              if (currentBlockType === "tool_use" && event.delta?.type === "input_json_delta") {
                const chunk = makeChunk({
                  tool_calls: [{ index: currentToolIndex, function: { arguments: event.delta.partial_json ?? "" } }],
                });
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                continue;
              }
              const text = event.delta?.text;
              if (text) res.write(`data: ${JSON.stringify(makeChunk({ content: text }))}\n\n`);
            }

            if (event.type === "message_delta") stopReason = event.delta?.stop_reason ?? null;
            if (event.type === "message_stop") {
              const finish = stopReason === "tool_use" ? "tool_calls" : "stop";
              res.write(`data: ${JSON.stringify(makeChunk({}, finish))}\n\n`);
            }
          } catch { /* skip unparseable */ }
        }
      }, abortController);
    } finally {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }

  // ─── Forward to OpenAI-compatible ───

  async function forwardToOpenAI(
    req: any, provider: string, modelName: string, fullModelId: string,
    tier: string, res: ServerResponse, stream: boolean,
  ) {
    const auth = getAuth(provider);
    if (!auth?.apiKey) throw new Error(`No API key for ${provider}`);

    const providerDef = getProviderDef(provider);
    if (!providerDef) throw new Error(`Unknown provider: ${provider}`);

    const body: Record<string, unknown> = {
      model: modelName,
      messages: req.messages,
      stream,
    };
    if (req.max_tokens) body.max_tokens = req.max_tokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;

    const url = `${providerDef.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${auth.apiKey}`,
      ...providerDef.headers,
    };

    const timeoutMs = TIER_TIMEOUTS[tier] ?? 60_000;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST", headers, body: JSON.stringify(body), signal: abortController.signal,
      });
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err?.name === "AbortError") throw new TimeoutError(`${provider} timeout after ${timeoutMs / 1000}s`);
      throw err;
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      const errText = await response.text();
      throw new Error(`${provider} ${response.status}: ${errText}`);
    }

    clearTimeout(timeoutId);

    if (!stream) {
      const data = await response.json() as any;
      // ★ Replace model with real model name
      data.model = fullModelId;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    // Streaming: pass through with model name rewrite
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let sbuffer = "";

    try {
      await readStreamWithStallDetection(reader, (value) => {
        sbuffer += decoder.decode(value, { stream: true });
        const lines = sbuffer.split("\n");
        sbuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const jsonStr = line.slice(6).trim();
            if (jsonStr === "[DONE]") {
              res.write("data: [DONE]\n\n");
              continue;
            }
            try {
              const chunk = JSON.parse(jsonStr);
              chunk.model = fullModelId;  // ★ REAL model name
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } catch {
              res.write(line + "\n");
            }
          } else if (line.trim()) {
            res.write(line + "\n");
          } else {
            res.write("\n");
          }
        }
      }, abortController);
    } finally {
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  }

  // ─── Main forward function ───

  return {
    forward: async (chatReq: any, routedModel: string, tier: string, thinkingMode: string, res: ServerResponse, stream: boolean) => {
      const { provider, model } = parseModelId(routedModel);
      const providerDef = getProviderDef(provider);
      if (!providerDef) throw new Error(`Unsupported provider: ${provider}`);

      logger.info(`[freerouter] -> ${provider}: ${model} (tier=${tier}, thinking=${thinkingMode}, stream=${stream})`);

      if (providerDef.api === "anthropic") {
        await forwardToAnthropic(chatReq, model, routedModel, tier, thinkingMode, res, stream);
      } else {
        await forwardToOpenAI(chatReq, provider, model, routedModel, tier, res, stream);
      }
    },
  };
}