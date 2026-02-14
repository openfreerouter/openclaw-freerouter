/**
 * FreeRouter — OpenClaw Plugin Entry Point
 *
 * Starts the FreeRouter proxy server as a background service
 * and registers it as a model provider.
 */

import { startServer, stopServer } from "./src/server.js";

export default {
  id: "freerouter",
  name: "FreeRouter",

  async register(api: any) {
    // Read plugin config
    const pluginConfig = api.config?.plugins?.entries?.freerouter?.config ?? {};
    const port = pluginConfig.port ?? 18800;
    const host = pluginConfig.host ?? "127.0.0.1";

    api.log?.info?.(`[FreeRouter] Starting proxy on ${host}:${port}...`);

    try {
      // Start the proxy server
      await startServer({
        port,
        host,
        pluginConfig,
      });

      api.log?.info?.(`[FreeRouter] Proxy running on http://${host}:${port}`);

      // Register as a provider if the API supports it
      if (api.registerProvider) {
        api.registerProvider({
          id: "freerouter",
          name: "FreeRouter",
          baseUrl: `http://${host}:${port}/v1`,
          api: "openai",
          models: [
            { id: "freerouter/auto", name: "FreeRouter Auto", description: "Auto-routes to best model" },
          ],
        });
        api.log?.info?.("[FreeRouter] Registered as provider 'freerouter'");
      }

      // Register shutdown handler
      if (api.onShutdown) {
        api.onShutdown(async () => {
          api.log?.info?.("[FreeRouter] Shutting down proxy...");
          await stopServer();
        });
      }
    } catch (err: any) {
      api.log?.error?.(`[FreeRouter] Failed to start: ${err.message}`);
      throw err;
    }
  },
};

// Re-export router for programmatic use
export { route, DEFAULT_ROUTING_CONFIG } from "./src/router/index.js";
export { startServer, stopServer } from "./src/server.js";
export type { RoutingDecision, Tier, RoutingConfig } from "./src/router/types.js";
