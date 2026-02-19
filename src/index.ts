/**
 * FreeRouter — OpenClaw Plugin
 *
 * Smart LLM router that classifies requests across 14 weighted dimensions
 * and routes to the best model from your configured providers.
 *
 * Runs an in-process OpenAI-compatible HTTP proxy on a configurable port.
 * OpenClaw sends requests with model "freerouter/auto" → FreeRouter classifies
 * and forwards to the real provider, returning the actual model name.
 */

import { createProxyServer, type ProxyStats } from "./service.js";
import { registerCli } from "./cli.js";
import type { Server } from "node:http";

// Plugin state
let server: Server | null = null;
let stats: ProxyStats | null = null;

export const id = "freerouter";

export default function register(api: any) {
  const logger = api.logger ?? console;
  const getPluginConfig = () => {
    const cfg = api.config?.plugins?.entries?.freerouter?.config ?? {};
    return cfg;
  };

  // ─── Background Service: HTTP Proxy ───
  api.registerService({
    id: "freerouter-proxy",
    start: () => {
      const cfg = getPluginConfig();
      const port = cfg.port ?? 18801;
      const host = cfg.host ?? "127.0.0.1";

      if (port === 0) {
        logger.info("[freerouter] HTTP proxy disabled (port=0)");
        return;
      }

      try {
        const result = createProxyServer({
          port,
          host,
          pluginConfig: cfg,
          openclawConfig: api.config,
          logger,
        });

        server = result.server;
        stats = result.stats;

        // Handle port conflicts gracefully
        server.on("error", (err: any) => {
          if (err.code === "EADDRINUSE") {
            logger.error(`[freerouter] Port ${port} is already in use. Run: openclaw freerouter doctor`);
            logger.error(`[freerouter] To change port: set plugins.entries.freerouter.config.port in openclaw.json`);
          } else {
            logger.error(`[freerouter] Server error: ${err.message}`);
          }
          server = null;
          stats = null;
        });

        logger.info(`[freerouter] Proxy listening on http://${host}:${port}`);
      } catch (err: any) {
        logger.error(`[freerouter] Failed to start proxy: ${err.message}`);
        logger.error(`[freerouter] Run: openclaw freerouter doctor`);
      }
    },
    stop: () => {
      if (server) {
        server.close();
        server = null;
        logger.info("[freerouter] Proxy stopped");
      }
    },
  });

  // ─── CLI Commands (status, test, port, reset, doctor, setup) ───
  registerCli(api);

  // ─── Auto-Reply Command: /freerouter ───
  api.registerCommand({
    name: "freerouter",
    description: "Show FreeRouter routing stats",
    handler: () => {
      if (!stats) {
        return { text: "🔌 FreeRouter is not running. Enable it in plugins config." };
      }
      const cfg = getPluginConfig();
      const lines = [
        "📊 **FreeRouter Stats**",
        `Port: ${cfg.port ?? 18801} | Requests: ${stats.requests} | Errors: ${stats.errors} | Timeouts: ${stats.timeouts}`,
        "",
        "**By Tier:**",
        ...Object.entries(stats.byTier)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `  ${k}: ${v}`),
        "",
        "**By Model:**",
        ...Object.entries(stats.byModel)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `  ${k}: ${v}`),
      ];
      return { text: lines.join("\n") };
    },
  });

  // ─── Auto-Reply Command: /freerouter-doctor ───
  api.registerCommand({
    name: "freerouter-doctor",
    description: "Quick health check of FreeRouter",
    handler: () => {
      const cfg = getPluginConfig();
      const port = cfg.port ?? 18801;
      const issues: string[] = [];
      const ok: string[] = [];

      if (!cfg || Object.keys(cfg).length === 0) {
        issues.push("No plugin config found");
      } else {
        ok.push("Config loaded");
      }

      if (server && stats) {
        ok.push(`Proxy running on :${port} (${stats.requests} requests)`);
      } else if (port > 0) {
        issues.push(`Proxy not running (expected on :${port})`);
      } else {
        ok.push("Proxy disabled (port=0)");
      }

      const lines = ["🩺 **FreeRouter Doctor**", ""];
      for (const o of ok) lines.push(`✓ ${o}`);
      for (const i of issues) lines.push(`⚠ ${i}`);
      if (issues.length === 0) lines.push("", "All good! ✓");
      else lines.push("", `${issues.length} issue(s). Run \`openclaw freerouter doctor\` for details.`);

      return { text: lines.join("\n") };
    },
  });
}
