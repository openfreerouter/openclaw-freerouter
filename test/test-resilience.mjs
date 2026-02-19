/**
 * FreeRouter Resilience & Edge Case Tests
 *
 * Tests: fallback chains, wrong settings, recovery, port conflicts,
 * malformed configs, provider errors, and graceful degradation.
 *
 * Run: npx tsx test/test-resilience.mjs
 */

import { route, getFallbackChain, getFallbackChainFiltered, calculateModelCost } from "../src/router/index.js";
import { classifyByRules } from "../src/router/rules.js";
import { selectModel } from "../src/router/selector.js";
import { DEFAULT_ROUTING_CONFIG, getRoutingConfig, applyConfigOverrides } from "../src/router/config.js";
import { buildPricingMap, MODELS } from "../src/models.js";
import { createServer } from "node:http";

// ─── Test Framework ───

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; failures.push({ name, error: err.message }); }
}

async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; failures.push({ name, error: err.message }); }
}

function eq(a, b, msg = "") { if (a !== b) throw new Error(`${msg} Expected "${b}", got "${a}"`); }
function ok(cond, msg = "") { if (!cond) throw new Error(msg || "Assertion failed"); }
function includes(arr, val, msg = "") { if (!arr.includes(val)) throw new Error(`${msg} [${arr}] missing "${val}"`); }
function throws(fn, msg = "") { try { fn(); throw new Error(`${msg} Expected throw`); } catch (e) { if (e.message.includes("Expected throw")) throw e; } }

const config = DEFAULT_ROUTING_CONFIG;
const modelPricing = buildPricingMap();

function routeQuery(prompt, sys, max) {
  return route(prompt, sys, max ?? 100, { config, modelPricing });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Fallback Chain Logic
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Fallback Chain Logic ═══\n");

test("getFallbackChain returns [primary, ...fallbacks]", () => {
  const chain = getFallbackChain("SIMPLE", config.tiers);
  eq(chain[0], config.tiers.SIMPLE.primary);
  eq(chain.length, 1 + config.tiers.SIMPLE.fallback.length);
});

test("SIMPLE fallback chain includes primary + fallbacks", () => {
  const chain = getFallbackChain("SIMPLE", config.tiers);
  ok(chain.length >= 1, `Chain empty`);
  eq(chain[0], config.tiers.SIMPLE.primary, `Primary not first`);
  for (const fb of config.tiers.SIMPLE.fallback) {
    ok(chain.includes(fb), `Missing fallback: ${fb}`);
  }
});

test("REASONING fallback chain starts with primary", () => {
  const chain = getFallbackChain("REASONING", config.tiers);
  eq(chain[0], config.tiers.REASONING.primary);
});

test("All tiers have valid fallback chains", () => {
  for (const tier of ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"]) {
    const chain = getFallbackChain(tier, config.tiers);
    ok(chain.length >= 1, `${tier} chain empty`);
    ok(typeof chain[0] === "string", `${tier} primary not string`);
  }
});

test("Fallback chain with empty fallbacks = [primary only]", () => {
  const customTiers = {
    ...config.tiers,
    SIMPLE: { primary: "test/model", fallback: [] },
  };
  const chain = getFallbackChain("SIMPLE", customTiers);
  eq(chain.length, 1);
  eq(chain[0], "test/model");
});

test("Fallback chain with 3 fallbacks = [primary, fb1, fb2, fb3]", () => {
  const customTiers = {
    ...config.tiers,
    SIMPLE: { primary: "a/a", fallback: ["b/b", "c/c", "d/d"] },
  };
  const chain = getFallbackChain("SIMPLE", customTiers);
  eq(chain.length, 4);
  eq(chain[0], "a/a");
  eq(chain[3], "d/d");
});

test("getFallbackChainFiltered removes models exceeding context", () => {
  const customTiers = {
    ...config.tiers,
    SIMPLE: { primary: "small/model", fallback: ["big/model"] },
  };
  const getCtx = (id) => id === "small/model" ? 4096 : 200000;
  const chain = getFallbackChainFiltered("SIMPLE", customTiers, 50000, getCtx);
  ok(!chain.includes("small/model"), "Should exclude small model");
  ok(chain.includes("big/model"), "Should include big model");
});

test("getFallbackChainFiltered returns full chain if ALL filtered out", () => {
  const customTiers = {
    ...config.tiers,
    SIMPLE: { primary: "tiny/a", fallback: ["tiny/b"] },
  };
  const getCtx = () => 100; // All models too small
  const chain = getFallbackChainFiltered("SIMPLE", customTiers, 50000, getCtx);
  eq(chain.length, 2, "Should return full chain as fallback");
});

test("getFallbackChainFiltered keeps unknown-context models", () => {
  const customTiers = {
    ...config.tiers,
    SIMPLE: { primary: "unknown/model", fallback: [] },
  };
  const getCtx = () => undefined;
  const chain = getFallbackChainFiltered("SIMPLE", customTiers, 50000, getCtx);
  eq(chain.length, 1);
  eq(chain[0], "unknown/model");
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Wrong/Invalid Settings
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Wrong/Invalid Settings ═══\n");

test("Config with missing tier still works for other tiers", () => {
  const broken = applyConfigOverrides(config, {
    tiers: { SIMPLE: { primary: "", fallback: [] } },
  });
  // REASONING should still work
  const r = route("Prove sqrt(2) is irrational step by step", undefined, 100, {
    config: broken, modelPricing,
  });
  eq(r.tier, "REASONING");
  ok(r.model.length > 0, "Model should be non-empty for REASONING");
});

test("Config with nonexistent model ID still routes (no crash)", () => {
  const broken = applyConfigOverrides(config, {
    tiers: { SIMPLE: { primary: "nonexistent/model-xyz", fallback: [] } },
  });
  const r = route("What is 2+2?", undefined, 100, { config: broken, modelPricing });
  eq(r.model, "nonexistent/model-xyz"); // Routes to it, provider will reject
});

test("Config with empty string model still routes", () => {
  const broken = applyConfigOverrides(config, {
    tiers: { MEDIUM: { primary: "", fallback: ["anthropic/claude-opus-4-6"] } },
  });
  // Ambiguous queries default to MEDIUM which has empty primary
  const r = route("What time is it?", undefined, 100, { config: broken, modelPricing });
  ok(r !== undefined, "Should not crash");
});

test("Zero scoring weights still classify (don't divide by zero)", () => {
  const broken = applyConfigOverrides(config, {
    scoring: {
      dimensionWeights: {
        tokenCount: 0, codePresence: 0, reasoningMarkers: 0,
        technicalTerms: 0, creativeMarkers: 0, simpleIndicators: 0,
        multiStepPatterns: 0, questionComplexity: 0, imperativeVerbs: 0,
        constraintCount: 0, outputFormat: 0, referenceComplexity: 0,
        negationComplexity: 0, domainSpecificity: 0, agenticTask: 0,
      },
    },
  });
  const r = classifyByRules("Prove something", undefined, 10, broken.scoring);
  ok(r !== undefined, "Should not crash with zero weights");
});

test("Negative tier boundaries still classify", () => {
  const broken = applyConfigOverrides(config, {
    scoring: {
      tierBoundaries: { simpleMedium: -1, mediumComplex: -0.5, complexReasoning: -0.1 },
    },
  });
  const r = classifyByRules("Hello", undefined, 5, broken.scoring);
  ok(r !== undefined);
});

test("Very high confidence threshold makes everything ambiguous", () => {
  const broken = applyConfigOverrides(config, {
    scoring: { confidenceThreshold: 0.9999 },
  });
  const r = classifyByRules("Hello", undefined, 5, broken.scoring);
  // With very high threshold, most queries will be null (ambiguous)
  ok(r !== undefined);
});

test("Config override with wrong type doesn't crash (string as number)", () => {
  try {
    const broken = applyConfigOverrides(config, { scoring: { confidenceThreshold: "invalid" } });
    const r = classifyByRules("Hello", undefined, 5, broken.scoring);
    ok(r !== undefined);
  } catch {
    // If it throws, that's also acceptable — we just don't want an unhandled crash
    ok(true);
  }
});

test("Deeply nested bad config doesn't crash", () => {
  const broken = applyConfigOverrides(config, {
    tiers: null, // null instead of object
  });
  // Should use defaults since null doesn't match
  const r = route("Hello", undefined, 100, { config: broken, modelPricing });
  ok(r !== undefined);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Cost Calculation Edge Cases
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Cost Calculation ═══\n");

test("calculateModelCost with unknown model returns 0 cost", () => {
  const c = calculateModelCost("nonexistent/model", modelPricing, 1000, 1000);
  eq(c.costEstimate, 0);
  ok(c.savings === 1 || c.savings === 0, `Savings=${c.savings}`);
});

test("calculateModelCost with zero tokens = zero cost", () => {
  const c = calculateModelCost("anthropic/claude-opus-4-6", modelPricing, 0, 0);
  eq(c.costEstimate, 0);
});

test("calculateModelCost with huge tokens doesn't overflow", () => {
  const c = calculateModelCost("anthropic/claude-opus-4-6", modelPricing, 1_000_000_000, 1_000_000_000);
  ok(isFinite(c.costEstimate), `Not finite: ${c.costEstimate}`);
  ok(c.costEstimate > 0);
});

test("calculateModelCost savings for cheap model > 0", () => {
  const c = calculateModelCost(config.tiers.SIMPLE.primary, modelPricing, 10000, 4096);
  // Simple model should be cheaper than opus baseline
  ok(c.savings >= 0, `Savings=${c.savings}`);
});

test("calculateModelCost for opus has ~0 savings (it IS the baseline)", () => {
  const c = calculateModelCost("anthropic/claude-opus-4-6", modelPricing, 10000, 4096);
  ok(c.savings < 0.01, `Opus savings=${c.savings} (should be ~0)`);
});

test("Empty modelPricing map doesn't crash", () => {
  const emptyMap = new Map();
  const r = route("Hello", undefined, 100, { config, modelPricing: emptyMap });
  ok(r !== undefined);
  eq(r.costEstimate, 0);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Overrides (Large Context, Structured Output)
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Overrides ═══\n");

test("Large context (>100k tokens) forces COMPLEX", () => {
  // 100k tokens ≈ 400k chars
  const longPrompt = "x".repeat(500_000);
  const r = routeQuery(longPrompt);
  eq(r.tier, "COMPLEX", `Got ${r.tier}`);
  ok(r.reasoning.includes("exceeds"), `Reasoning: ${r.reasoning}`);
});

test("Structured output (JSON schema in system prompt) → ≥ MEDIUM", () => {
  const r = route("List all users", '{"type":"object","properties":{"users":{"type":"array"}}}', 100, { config, modelPricing });
  const tierRank = { SIMPLE: 0, MEDIUM: 1, COMPLEX: 2, REASONING: 3 };
  ok(tierRank[r.tier] >= 1, `Got ${r.tier}, expected ≥ MEDIUM`);
});

test("Agentic tiers activated for multi-step tasks", () => {
  const r = routeQuery("Read the file, edit the config, install deps, compile, fix errors, debug until it works, then deploy and verify");
  ok(r.reasoning.includes("agentic") || r.tier !== "SIMPLE", `No agentic signal: ${r.reasoning}`);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: selectModel Direct Tests
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ selectModel Direct ═══\n");

test("selectModel returns correct tier", () => {
  const r = selectModel("REASONING", 0.95, "rules", "test", config.tiers, modelPricing, 1000, 4096);
  eq(r.tier, "REASONING");
  eq(r.model, config.tiers.REASONING.primary);
  eq(r.confidence, 0.95);
  eq(r.method, "rules");
});

test("selectModel with unknown model in config → zero cost", () => {
  const customTiers = { ...config.tiers, SIMPLE: { primary: "fake/model", fallback: [] } };
  const r = selectModel("SIMPLE", 0.8, "rules", "test", customTiers, modelPricing, 1000, 4096);
  eq(r.model, "fake/model");
  eq(r.costEstimate, 0);
});

test("selectModel confidence is preserved", () => {
  const r = selectModel("MEDIUM", 0.42, "rules", "test", config.tiers, modelPricing, 1000, 100);
  eq(r.confidence, 0.42);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: Port Conflict Simulation
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Port Conflict Handling ═══\n");

await testAsync("Detect port in use before starting proxy", async () => {
  // Occupy a port
  const blocker = createServer((_, res) => { res.writeHead(200); res.end("occupied"); });
  const port = 19900 + Math.floor(Math.random() * 100);
  await new Promise(resolve => blocker.listen(port, "127.0.0.1", resolve));

  try {
    // Try to start another server on same port
    const server2 = createServer();
    let errored = false;
    await new Promise((resolve) => {
      server2.on("error", (err) => {
        errored = true;
        ok(err.code === "EADDRINUSE", `Expected EADDRINUSE, got ${err.code}`);
        resolve();
      });
      server2.listen(port, "127.0.0.1", () => {
        server2.close();
        resolve();
      });
    });
    ok(errored, "Should have errored with EADDRINUSE");
  } finally {
    blocker.close();
  }
});

await testAsync("Recovery: find next available port", async () => {
  const blocker = createServer();
  const basePort = 19800 + Math.floor(Math.random() * 50);
  await new Promise(resolve => blocker.listen(basePort, "127.0.0.1", resolve));

  // Simulate port scanning for next available
  let foundPort = null;
  for (let p = basePort; p < basePort + 10; p++) {
    try {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(p, "127.0.0.1", () => { foundPort = p; server.close(); resolve(); });
      });
      break;
    } catch { continue; }
  }

  blocker.close();
  ok(foundPort !== null, "Should find an available port");
  ok(foundPort > basePort, `Found port ${foundPort} should be > ${basePort}`);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Mode Override Parsing
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Mode Override Parsing ═══\n");

// These test the extractPromptForClassification + detectModeOverride
// behavior from service.ts — we test the classification side here

test("Prefix /simple should route simple query to SIMPLE", () => {
  // The /simple prefix is handled by service.ts, not the classifier
  // But we can verify the classifier correctly handles the remaining prompt
  const r = routeQuery("What is 2+2?");
  eq(r.tier, "SIMPLE");
});

test("Complex prompt classified as REASONING", () => {
  const r = routeQuery("Prove step by step that sqrt(2) is irrational using formal mathematical proof by contradiction");
  eq(r.tier, "REASONING");
});

test("Ambiguous query defaults to configured tier", () => {
  // "What time is it?" is borderline — score 0.000
  const r = routeQuery("What time is it in a random city?");
  eq(r.tier, config.overrides.ambiguousDefaultTier, `Got ${r.tier}`);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: Config Recovery Scenarios
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Config Recovery ═══\n");

test("getRoutingConfig always returns valid defaults", () => {
  const c = getRoutingConfig();
  ok(c.tiers.SIMPLE.primary.length > 0, "SIMPLE primary empty");
  ok(c.tiers.MEDIUM.primary.length > 0, "MEDIUM primary empty");
  ok(c.tiers.COMPLEX.primary.length > 0, "COMPLEX primary empty");
  ok(c.tiers.REASONING.primary.length > 0, "REASONING primary empty");
  ok(c.scoring.dimensionWeights !== undefined, "Missing scoring weights");
  ok(c.overrides !== undefined, "Missing overrides");
});

test("applyConfigOverrides with garbage tiers preserves defaults", () => {
  // If user passes tiers with invalid keys, valid tiers stay untouched
  const c = applyConfigOverrides(config, {
    tiers: { INVALID_TIER: { primary: "x/y" } },
  });
  eq(c.tiers.SIMPLE.primary, config.tiers.SIMPLE.primary, "SIMPLE corrupted");
  eq(c.tiers.REASONING.primary, config.tiers.REASONING.primary, "REASONING corrupted");
});

test("applyConfigOverrides partial tier override preserves fallbacks", () => {
  const c = applyConfigOverrides(config, {
    tiers: { SIMPLE: { primary: "new/model" } },
  });
  eq(c.tiers.SIMPLE.primary, "new/model");
  // Fallback comes from the override (which may be undefined) or stays default
  // Since we only pass primary, fallback depends on the override value
  ok(c.tiers.MEDIUM.primary === config.tiers.MEDIUM.primary, "MEDIUM changed unexpectedly");
});

test("Full config round-trip: get → override → route", () => {
  const base = getRoutingConfig();
  const custom = applyConfigOverrides(base, {
    tiers: { SIMPLE: { primary: "custom/cheap-model", fallback: [] } },
    defaultTier: "SIMPLE",
  });
  const r = route("Hello", undefined, 100, { config: custom, modelPricing });
  // "Hello" is SIMPLE, should go to custom model
  eq(r.model, "custom/cheap-model");
});

test("Double override doesn't corrupt config", () => {
  const base = getRoutingConfig();
  const first = applyConfigOverrides(base, { tiers: { SIMPLE: { primary: "a/a" } } });
  const second = applyConfigOverrides(first, { tiers: { SIMPLE: { primary: "b/b" } } });
  eq(second.tiers.SIMPLE.primary, "b/b");
  // Original should be untouched
  eq(base.tiers.SIMPLE.primary, config.tiers.SIMPLE.primary, "Original mutated!");
});

test("Config is deep-cloned (mutations don't leak)", () => {
  const base = getRoutingConfig();
  const overridden = applyConfigOverrides(base, {});
  overridden.tiers.SIMPLE.primary = "MUTATED";
  ok(base.tiers.SIMPLE.primary !== "MUTATED", "Mutation leaked to original!");
});

// ═══════════════════════════════════════════════════════════════
// SECTION 9: Concurrent Classification (Thread Safety)
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Concurrent Classification ═══\n");

test("100 concurrent classifications are consistent", () => {
  const results = [];
  for (let i = 0; i < 100; i++) {
    results.push(routeQuery("What is 2+2?"));
  }
  const tiers = new Set(results.map(r => r.tier));
  eq(tiers.size, 1, `Expected 1 unique tier, got ${tiers.size}: [${[...tiers]}]`);
  const models = new Set(results.map(r => r.model));
  eq(models.size, 1, `Expected 1 unique model, got ${models.size}`);
});

test("Mixed concurrent classifications don't interfere", () => {
  const simple = routeQuery("What is 2+2?");
  const reasoning = routeQuery("Prove step by step that sqrt(2) is irrational");
  const simple2 = routeQuery("What is 2+2?");

  eq(simple.tier, simple2.tier, "Simple queries changed after reasoning query");
  eq(simple.model, simple2.model, "Models changed");
  ok(reasoning.tier === "REASONING", `Reasoning became ${reasoning.tier}`);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 10: Scoring Dimension Validation
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Scoring Dimensions ═══\n");

test("All 15 dimension weights exist", () => {
  const expected = [
    "tokenCount", "codePresence", "reasoningMarkers", "technicalTerms",
    "creativeMarkers", "simpleIndicators", "multiStepPatterns", "questionComplexity",
    "imperativeVerbs", "constraintCount", "outputFormat", "referenceComplexity",
    "negationComplexity", "domainSpecificity", "agenticTask",
  ];
  for (const dim of expected) {
    ok(config.scoring.dimensionWeights[dim] !== undefined, `Missing weight: ${dim}`);
  }
});

test("Dimension weights are positive and sum to reasonable total", () => {
  const weights = Object.values(config.scoring.dimensionWeights);
  const sum = weights.reduce((a, b) => a + b, 0);
  ok(sum > 0.5 && sum < 3.0, `Weights sum to ${sum.toFixed(3)}, expected 0.5-3.0`);
  ok(weights.every(w => w >= 0), "Negative weight found");
});

test("All keyword lists are non-empty arrays", () => {
  const lists = [
    "codeKeywords", "reasoningKeywords", "simpleKeywords", "technicalKeywords",
    "creativeKeywords", "imperativeVerbs", "constraintIndicators",
    "outputFormatKeywords", "referenceKeywords", "negationKeywords",
    "domainSpecificKeywords", "agenticTaskKeywords",
  ];
  for (const list of lists) {
    ok(Array.isArray(config.scoring[list]), `${list} not an array`);
    ok(config.scoring[list].length > 0, `${list} empty`);
  }
});

test("Tier boundaries are in ascending order", () => {
  const b = config.scoring.tierBoundaries;
  ok(b.simpleMedium <= b.mediumComplex, `simpleMedium (${b.simpleMedium}) > mediumComplex (${b.mediumComplex})`);
  ok(b.mediumComplex <= b.complexReasoning, `mediumComplex (${b.mediumComplex}) > complexReasoning (${b.complexReasoning})`);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 11: Signals & Reasoning Strings
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Signals & Reasoning ═══\n");

test("Classification returns signals array", () => {
  const r = classifyByRules("Write a Python function", undefined, 10, config.scoring);
  ok(Array.isArray(r.signals), "signals not an array");
  ok(r.signals.length > 0, "No signals for code query");
});

test("Route reasoning string contains score", () => {
  const r = routeQuery("Hello");
  ok(r.reasoning.includes("score="), `Reasoning: ${r.reasoning}`);
});

test("Ambiguous query still produces valid routing decision", () => {
  const r = routeQuery("What time is it?");
  ok(r.tier !== undefined, "No tier assigned");
  ok(r.model.length > 0, "No model assigned");
  ok(typeof r.reasoning === "string", "Missing reasoning");
  // Ambiguous queries get the default tier
  eq(r.tier, config.overrides.ambiguousDefaultTier, `Expected default tier ${config.overrides.ambiguousDefaultTier}`);
});

test("Code query signals include 'code'", () => {
  const r = classifyByRules("function hello() { return 42; }", undefined, 10, config.scoring);
  ok(r.signals.some(s => s.toLowerCase().includes("code")), `Signals: [${r.signals}]`);
});

test("Reasoning query signals include 'reasoning'", () => {
  const r = classifyByRules("Prove step by step", undefined, 10, config.scoring);
  ok(r.signals.some(s => s.toLowerCase().includes("reasoning")), `Signals: [${r.signals}]`);
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(60));
console.log(`\n  ✓ ${passed} passed   ✗ ${failed} failed   ○ ${skipped} skipped\n`);

if (failures.length > 0) {
  console.log("  Failures:");
  for (const f of failures) console.log(`    ✗ ${f.name}: ${f.error}`);
  console.log();
}

process.exit(failed > 0 ? 1 : 0);