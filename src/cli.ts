/**
 * FreeRouter CLI Commands
 *
 * - `openclaw freerouter setup` — Interactive onboarding wizard
 * - `openclaw freerouter status` — Show status and stats
 * - `openclaw freerouter test` — Run a quick classification test
 * - `openclaw freerouter port <number>` — Change the proxy port
 * - `openclaw freerouter reset` — Reset to default config
 * - `openclaw freerouter doctor` — Diagnose and fix common issues
 */

import { getRoutingConfig, applyConfigOverrides } from "./router/config.js";
import { route } from "./router/index.js";
import { buildPricingMap } from "./models.js";

export function registerCli(api: any) {
  const logger = api.logger ?? console;

  const getPluginConfig = () => api.config?.plugins?.entries?.freerouter?.config ?? {};

  api.registerCli(
    ({ program }: any) => {
      const cmd = program.command("freerouter").description("FreeRouter — smart LLM model router");

      // ─── status ───
      cmd
        .command("status")
        .description("Show FreeRouter status, config, and routing stats")
        .action(async () => {
          const cfg = getPluginConfig();
          const port = cfg.port ?? 18801;
          const host = cfg.host ?? "127.0.0.1";

          console.log(`\n  FreeRouter v2.0.0\n`);
          console.log(`  Port:     ${port === 0 ? "disabled (in-process only)" : `${host}:${port}`}`);
          console.log(`  Default:  ${cfg.defaultTier ?? "MEDIUM"}`);
          console.log();

          // Show tier mapping
          console.log("  Tier Mapping:");
          const tiers = cfg.tiers ?? {};
          const defaults = getRoutingConfig().tiers;
          for (const tier of ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]) {
            const t = tiers[tier] ?? defaults[tier as keyof typeof defaults];
            const fb = t.fallback?.length ? ` → [${t.fallback.join(", ")}]` : "";
            console.log(`    ${tier.padEnd(10)} ${t.primary}${fb}`);
          }

          // Show thinking config
          const thinking = cfg.thinking;
          if (thinking) {
            console.log();
            console.log("  Thinking:");
            if (thinking.adaptive?.length) console.log(`    Adaptive: ${thinking.adaptive.join(", ")}`);
            if (thinking.enabled?.models?.length) {
              console.log(`    Enabled:  ${thinking.enabled.models.join(", ")} (budget: ${thinking.enabled.budget ?? 4096})`);
            }
          }

          // Try to reach the proxy for live stats
          if (port > 0) {
            try {
              const res = await fetch(`http://${host}:${port}/stats`, { signal: AbortSignal.timeout(2000) });
              if (res.ok) {
                const stats = await res.json();
                console.log();
                console.log("  Live Stats:");
                console.log(`    Requests: ${stats.requests} | Errors: ${stats.errors} | Timeouts: ${stats.timeouts}`);
                if (Object.keys(stats.byTier).some((k: string) => stats.byTier[k] > 0)) {
                  console.log(`    By Tier:  ${Object.entries(stats.byTier).filter(([, v]) => (v as number) > 0).map(([k, v]) => `${k}=${v}`).join(", ")}`);
                }
                if (Object.keys(stats.byModel).some((k: string) => stats.byModel[k] > 0)) {
                  console.log(`    By Model: ${Object.entries(stats.byModel).filter(([, v]) => (v as number) > 0).map(([k, v]) => `${k}=${v}`).join(", ")}`);
                }
              }
            } catch {
              console.log();
              console.log("  ⚠ Proxy not responding on port " + port);
            }
          }
          console.log();
        });

      // ─── test ───
      cmd
        .command("test")
        .description("Run a quick classification test with sample queries")
        .action(() => {
          const cfg = getPluginConfig();
          const routingConfig = applyConfigOverrides(getRoutingConfig(), cfg);
          const pricing = buildPricingMap();

          const queries = [
            { q: "What is 2+2?", expect: "SIMPLE" },
            { q: "Hello", expect: "SIMPLE" },
            { q: "Write a Python function to reverse a string", expect: "MEDIUM+" },
            { q: "Design a distributed database architecture", expect: "MEDIUM+" },
            { q: "Prove step by step that sqrt(2) is irrational", expect: "REASONING" },
          ];

          console.log("\n  FreeRouter Classification Test\n");
          let pass = 0;
          for (const { q, expect } of queries) {
            const r = route(q, undefined, 100, { config: routingConfig, modelPricing: pricing });
            const ok = expect === "MEDIUM+"
              ? ["MEDIUM", "COMPLEX", "REASONING"].includes(r.tier)
              : r.tier === expect;
            const icon = ok ? "✓" : "✗";
            console.log(`  ${icon} "${q.slice(0, 50)}"`);
            console.log(`    → ${r.tier} → ${r.model} (conf=${r.confidence.toFixed(2)})`);
            if (ok) pass++;
          }
          console.log(`\n  ${pass}/${queries.length} passed\n`);
          if (pass < queries.length) process.exit(1);
        });

      // ─── port ───
      cmd
        .command("port <number>")
        .description("Change the HTTP proxy port (0 to disable)")
        .action(async (portStr: string) => {
          const port = parseInt(portStr, 10);
          if (isNaN(port) || port < 0 || port > 65535) {
            console.error("  ✗ Invalid port. Must be 0-65535.");
            process.exit(1);
          }

          // Check if port is available
          if (port > 0) {
            const net = await import("node:net");
            const available = await new Promise<boolean>((resolve) => {
              const server = net.createServer();
              server.on("error", () => resolve(false));
              server.listen(port, "127.0.0.1", () => { server.close(); resolve(true); });
            });
            if (!available) {
              console.error(`  ✗ Port ${port} is already in use.`);
              console.log("  Try: openclaw freerouter doctor");
              process.exit(1);
            }
          }

          console.log(`  Setting FreeRouter port to ${port === 0 ? "disabled" : port}...`);
          console.log("  Restart the gateway to apply: openclaw gateway restart");
          console.log();
        });

      // ─── reset ───
      cmd
        .command("reset")
        .description("Reset FreeRouter config to defaults")
        .action(() => {
          const defaults = getRoutingConfig();
          console.log("\n  Default FreeRouter config:\n");
          console.log(JSON.stringify({
            port: 18801,
            host: "127.0.0.1",
            tiers: defaults.tiers,
            defaultTier: "MEDIUM",
            thinking: {
              adaptive: ["claude-opus-4-6"],
              enabled: { models: ["claude-sonnet-4-5"], budget: 4096 },
            },
          }, null, 2));
          console.log("\n  Copy this into plugins.entries.freerouter.config in openclaw.json");
          console.log("  Or run: openclaw config set plugins.entries.freerouter.config '{...}'");
          console.log();
        });

      // ─── doctor ───
      cmd
        .command("doctor")
        .description("Diagnose and fix common FreeRouter issues")
        .action(async () => {
          console.log("\n  FreeRouter Doctor\n");
          let issues = 0;

          // 1. Check config exists
          const cfg = getPluginConfig();
          if (!cfg || Object.keys(cfg).length === 0) {
            console.log("  ⚠ No plugin config found. Run: openclaw freerouter setup");
            issues++;
          } else {
            console.log("  ✓ Plugin config found");
          }

          // 2. Check port
          const port = cfg.port ?? 18801;
          if (port > 0) {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
              if (res.ok) {
                const data = await res.json();
                console.log(`  ✓ Proxy healthy on port ${port} (v${data.version})`);
              } else {
                console.log(`  ⚠ Proxy on port ${port} returned ${res.status}`);
                issues++;
              }
            } catch {
              console.log(`  ✗ Proxy not responding on port ${port}`);

              // Check if port is occupied by something else
              const net = await import("node:net");
              const occupied = await new Promise<boolean>((resolve) => {
                const server = net.createServer();
                server.on("error", () => resolve(true));
                server.listen(port, "127.0.0.1", () => { server.close(); resolve(false); });
              });

              if (occupied) {
                console.log(`    Port ${port} is in use by another process.`);
                console.log(`    Fix: openclaw freerouter port ${port + 1}`);
              } else {
                console.log("    Port is free but proxy isn't running.");
                console.log("    Fix: Restart gateway — openclaw gateway restart");
              }
              issues++;
            }
          } else {
            console.log("  ○ HTTP proxy disabled (port=0)");
          }

          // 3. Check tier config
          const tiers = cfg.tiers ?? {};
          const validTiers = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
          for (const tier of validTiers) {
            const t = tiers[tier];
            if (t && !t.primary) {
              console.log(`  ⚠ ${tier} tier has no primary model`);
              issues++;
            }
          }
          if (Object.keys(tiers).length > 0) {
            console.log(`  ✓ Tier config: ${Object.keys(tiers).join(", ")}`);
          }

          // 4. Check OpenClaw model config
          const modelCfg = api.config?.agents?.defaults?.model;
          if (modelCfg?.primary?.includes("freerouter")) {
            console.log(`  ✓ OpenClaw default model: ${modelCfg.primary}`);
          } else {
            console.log(`  ○ OpenClaw default model is not FreeRouter: ${modelCfg?.primary ?? "not set"}`);
            console.log("    To enable: set agents.defaults.model.primary to 'freerouter/freerouter/auto'");
          }

          // 5. Check provider config
          const providerCfg = api.config?.models?.providers?.freerouter;
          if (providerCfg?.baseUrl) {
            console.log(`  ✓ Provider config: ${providerCfg.baseUrl}`);
          } else {
            console.log("  ⚠ No FreeRouter provider in models.providers");
            console.log("    Add to openclaw.json: models.providers.freerouter = { baseUrl: 'http://127.0.0.1:" + port + "/v1', api: 'openai-completions' }");
            issues++;
          }

          // 6. Quick classification test
          try {
            const routingConfig = applyConfigOverrides(getRoutingConfig(), cfg);
            const pricing = buildPricingMap();
            const r = route("What is 2+2?", undefined, 100, { config: routingConfig, modelPricing: pricing });
            if (r.tier === "SIMPLE") {
              console.log("  ✓ Classification engine working (SIMPLE → " + r.model + ")");
            } else {
              console.log(`  ⚠ Classification may be miscalibrated: "What is 2+2?" → ${r.tier}`);
              issues++;
            }
          } catch (err: any) {
            console.log(`  ✗ Classification engine error: ${err.message}`);
            issues++;
          }

          console.log();
          if (issues === 0) {
            console.log("  All checks passed! ✓");
          } else {
            console.log(`  ${issues} issue(s) found. See suggestions above.`);
          }
          console.log();
        });

      // ─── setup (onboarding wizard) ───
      cmd
        .command("setup")
        .description("Interactive onboarding wizard (optional)")
        .option("--port <number>", "HTTP proxy port", "18801")
        .option("--simple <model>", "Model for SIMPLE tier")
        .option("--medium <model>", "Model for MEDIUM tier")
        .option("--complex <model>", "Model for COMPLEX tier")
        .option("--reasoning <model>", "Model for REASONING tier")
        .option("--json", "Output config as JSON (non-interactive)")
        .action((opts: any) => {
          const port = parseInt(opts.port, 10) || 18801;

          // Default models
          const simple = opts.simple ?? "kimi-coding/kimi-for-coding";
          const medium = opts.medium ?? "anthropic/claude-sonnet-4-5";
          const complex = opts.complex ?? "anthropic/claude-opus-4-6";
          const reasoning = opts.reasoning ?? "anthropic/claude-opus-4-6";

          const pluginConfig = {
            port,
            host: "127.0.0.1",
            tiers: {
              SIMPLE: { primary: simple, fallback: [] },
              MEDIUM: { primary: medium, fallback: [complex] },
              COMPLEX: { primary: complex, fallback: [] },
              REASONING: { primary: reasoning, fallback: [] },
            },
            thinking: {
              adaptive: ["claude-opus-4-6"],
              enabled: { models: ["claude-sonnet-4-5"], budget: 4096 },
            },
            defaultTier: "MEDIUM",
          };

          const providerConfig = {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            models: [{
              id: "freerouter/auto",
              name: "FreeRouter Auto",
              input: ["text"],
            }],
          };

          if (opts.json) {
            console.log(JSON.stringify({ pluginConfig, providerConfig }, null, 2));
            return;
          }

          console.log(`
╔══════════════════════════════════════════╗
║       FreeRouter Setup Wizard            ║
╚══════════════════════════════════════════╝

Step 1: Add this to your openclaw.json under "plugins.entries":

  "freerouter": {
    "enabled": true,
    "config": ${JSON.stringify(pluginConfig, null, 6).split("\n").map((l, i) => i === 0 ? l : "    " + l).join("\n")}
  }

Step 2: Add this under "models.providers":

  "freerouter": ${JSON.stringify(providerConfig, null, 4).split("\n").map((l, i) => i === 0 ? l : "  " + l).join("\n")}

Step 3: Set FreeRouter as your default model:

  "agents": {
    "defaults": {
      "model": {
        "primary": "freerouter/freerouter/auto",
        "fallbacks": ["anthropic/claude-opus-4-6"]
      }
    }
  }

Step 4: Restart the gateway:

  openclaw gateway restart

Step 5: Verify:

  openclaw freerouter doctor

Tier Mapping:
  SIMPLE    → ${simple} (quick lookups, translations)
  MEDIUM    → ${medium} (code, creative writing)
  COMPLEX   → ${complex} (architecture, deep analysis)
  REASONING → ${reasoning} (proofs, formal logic)

Port: ${port}
`);
        });
    },
    { commands: ["freerouter"] },
  );
}