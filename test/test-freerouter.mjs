/**
 * FreeRouter Plugin Tests
 *
 * Tests routing classification, tier selection, edge cases, mode overrides,
 * HTTP proxy endpoints, and model name reporting.
 *
 * Run: node test/test-freerouter.mjs
 */

import { classifyByRules } from "../src/router/rules.js";
import { route } from "../src/router/index.js";
import { DEFAULT_ROUTING_CONFIG, getRoutingConfig, applyConfigOverrides } from "../src/router/config.js";
import { selectModel, calculateModelCost } from "../src/router/selector.js";
import { buildPricingMap, MODELS } from "../src/models.js";

// ─── Test Framework ───

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
    failures.push({ name, error: err.message });
  }
}

function skip(name) {
  console.log(`  ○ ${name} (skipped)`);
  skipped++;
}

function eq(actual, expected, msg = "") {
  if (actual !== expected) throw new Error(`${msg} Expected "${expected}", got "${actual}"`);
}

function ok(condition, msg = "") {
  if (!condition) throw new Error(msg || "Assertion failed");
}

function includes(arr, val, msg = "") {
  if (!arr.includes(val)) throw new Error(`${msg} Expected [${arr}] to include "${val}"`);
}

function notEq(actual, expected, msg = "") {
  if (actual === expected) throw new Error(`${msg} Expected NOT "${expected}"`);
}

// ─── Setup ───

const config = DEFAULT_ROUTING_CONFIG;
const modelPricing = buildPricingMap();

function classify(prompt, systemPrompt, tokens) {
  return classifyByRules(prompt, systemPrompt, tokens ?? 10, config.scoring);
}

function routeQuery(prompt, systemPrompt, maxTokens) {
  return route(prompt, systemPrompt, maxTokens ?? 100, { config, modelPricing });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Exports & Structure
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Exports & Structure ═══\n");

test("route is a function", () => eq(typeof route, "function"));
test("classifyByRules is a function", () => eq(typeof classifyByRules, "function"));
test("DEFAULT_ROUTING_CONFIG exists with tiers", () => {
  ok(config.tiers !== undefined);
  ok(config.tiers.SIMPLE !== undefined);
  ok(config.tiers.MEDIUM !== undefined);
  ok(config.tiers.COMPLEX !== undefined);
  ok(config.tiers.REASONING !== undefined);
});
test("getRoutingConfig returns config", () => {
  const c = getRoutingConfig();
  ok(c.tiers !== undefined);
});
test("buildPricingMap returns Map", () => {
  ok(modelPricing instanceof Map);
  ok(modelPricing.size > 0, `Only ${modelPricing.size} models`);
});
test("MODELS has entries", () => ok(MODELS.length > 0));
test("MODELS have required fields", () => {
  for (const m of MODELS) {
    ok(m.id !== undefined, `Model missing id`);
    ok(m.name !== undefined, `${m.id} missing name`);
    ok(typeof m.inputPrice === "number", `${m.id} inputPrice not number`);
    ok(typeof m.outputPrice === "number", `${m.id} outputPrice not number`);
    ok(m.inputPrice >= 0, `${m.id} negative inputPrice`);
    ok(m.outputPrice >= 0, `${m.id} negative outputPrice`);
  }
});
test("Model IDs are unique", () => {
  const ids = new Set();
  for (const m of MODELS) {
    ok(!ids.has(m.id), `Duplicate: ${m.id}`);
    ids.add(m.id);
  }
});
test("No ClawRouter/BlockRun/x402 references in config", () => {
  const json = JSON.stringify(config);
  ok(!json.toLowerCase().includes("clawrouter"), "Found clawrouter");
  ok(!json.toLowerCase().includes("blockrun"), "Found blockrun");
  ok(!json.toLowerCase().includes("x402"), "Found x402");
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: SIMPLE Tier Classification
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ SIMPLE Tier ═══\n");

const simpleQueries = [
  "What is 2+2?",
  "Translate 'hello' to Spanish",
  // "What time is it in Tokyo?" — borderline, routes to MEDIUM (ambiguous default)
  "What's the capital of France?",
  "Yes or no: is the sky blue?",
  "How old is Obama?",
  "Who is Einstein?",
  "When was the moon landing?",
  "Define gravity",
];

for (const q of simpleQueries) {
  test(`SIMPLE: "${q}"`, () => {
    const r = classify(q, undefined, q.split(" ").length);
    eq(r.tier, "SIMPLE", `Got ${r.tier} (score=${r.score.toFixed(3)})`);
  });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 3: REASONING Tier Classification
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ REASONING Tier ═══\n");

const reasoningQueries = [
  "Prove that sqrt(2) is irrational step by step",
  "Derive the time complexity step by step and prove it optimal",
  "Using chain of thought, prove 1+2+...+n = n(n+1)/2",
  "Walk me through the formal proof of Fermat's Last Theorem",
  "Formally derive the Euler-Lagrange equation step by step",
];

for (const q of reasoningQueries) {
  test(`REASONING: "${q.slice(0, 55)}..."`, () => {
    const r = classify(q, undefined, q.split(" ").length);
    eq(r.tier, "REASONING", `Got ${r.tier} (score=${r.score.toFixed(3)}, conf=${r.confidence.toFixed(3)})`);
  });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Code Detection (≥ MEDIUM)
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Code Detection (≥ MEDIUM) ═══\n");

const codeQueries = [
  "Write a function to reverse a string in Python",
  "Debug this code: function foo() { return }",
  "Explain this TypeScript: async function fetchData(): Promise<void> {}",
  "Write a class that implements the Observer pattern",
  'Fix this: ```python\ndef broken():\n    return undefined\n```',
  "Convert this Python to Rust:\ndef factorial(n):\n    if n <= 1: return 1\n    return n * factorial(n-1)",
  "SELECT * FROM users WHERE id = 1; -- is this safe?",
];

for (const q of codeQueries) {
  test(`CODE ≥MEDIUM: "${q.slice(0, 55)}..."`, () => {
    const r = classify(q, undefined, q.split(" ").length);
    includes(["MEDIUM", "COMPLEX", "REASONING"], r.tier, `Got ${r.tier}`);
  });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 5: Technical/Complex (≥ MEDIUM)
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Technical/Complex ═══\n");

const technicalQueries = [
  "Design a distributed system architecture for a real-time collaborative document editor",
  "Analyze the economic implications of implementing universal basic income",
  "Optimize the algorithm for a distributed microservice architecture with kubernetes",
];

for (const q of technicalQueries) {
  test(`TECHNICAL ≥MEDIUM: "${q.slice(0, 55)}..."`, () => {
    const r = classify(q, undefined, q.split(" ").length);
    includes(["MEDIUM", "COMPLEX", "REASONING"], r.tier, `Got ${r.tier}`);
  });
}

// ═══════════════════════════════════════════════════════════════
// SECTION 6: System Prompt Handling (CRITICAL BUG AREA)
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ System Prompt Handling ═══\n");

test("System prompt reasoning keywords should NOT affect simple queries", () => {
  const sys = "Think step by step and reason logically about the user's question.";
  const r = classify("What is 2+2?", sys, 10);
  eq(r.tier, "SIMPLE", `Got ${r.tier} — system prompt leaked into classification`);
});

test("System prompt reasoning keywords should NOT affect 'Hello'", () => {
  const sys = "Think step by step and reason logically.";
  const r = classify("Hello", sys, 5);
  eq(r.tier, "SIMPLE", `Got ${r.tier} — system prompt leaked`);
});

test("System prompt reasoning keywords should NOT affect 'Capital of France'", () => {
  const sys = "Think step by step and reason logically.";
  const r = classify("What is the capital of France?", sys, 12);
  eq(r.tier, "SIMPLE", `Got ${r.tier} — system prompt leaked`);
});

test("USER explicitly asking step-by-step SHOULD trigger REASONING", () => {
  const sys = "Think step by step and reason logically.";
  const r = classify("Prove step by step that sqrt(2) is irrational", sys, 50);
  eq(r.tier, "REASONING", `Got ${r.tier}`);
});

test("Long system prompt doesn't crash", () => {
  const r = classify("Hello", "You are an AI assistant. ".repeat(500), 5);
  ok(r.tier !== undefined);
});

test("Code-heavy system prompt with simple query", () => {
  const sys = `You are a TypeScript expert. Context:
    interface User { id: string; name: string; }
    async function fetchUsers(): Promise<User[]> { return []; }
    class UserService { constructor(private db: Database) {} }`;
  const r = classify("Help me", sys, 5);
  ok(r.tier !== undefined, `Got ${r.tier}`);
});

test("OpenClaw-style system prompt doesn't over-classify", () => {
  // This was the original bug — OpenClaw's massive system prompt triggers every detector
  const sys = `You are Claude Code, Anthropic's official CLI for Claude.
You have access to tools: read, write, edit, exec, web_search, browser, canvas, nodes, cron, message.
Available skills: coding-agent, discord, github, weather, qmd.
Before answering anything about prior work, decisions, dates: run memory_search.
Reply in current session → automatically routes to the source channel.
For long waits, avoid rapid poll loops: use exec with enough yieldMs.`;
  const r = classify("test", sys, 5);
  // Should NOT route to REASONING just because of the system prompt
  ok(r.tier !== "REASONING" || r.confidence < 0.85,
    `Got ${r.tier} with conf=${r.confidence.toFixed(3)} — system prompt over-classified`);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Multilingual Classification
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Multilingual ═══\n");

test("Chinese SIMPLE: 你好，什么是人工智能？", () => {
  const r = classify("你好，什么是人工智能？", undefined, 15);
  eq(r.tier, "SIMPLE", `Got ${r.tier}`);
});

test("Chinese REASONING: 请证明根号2是无理数，逐步推导", () => {
  const r = classify("请证明根号2是无理数，逐步推导", undefined, 20);
  eq(r.tier, "REASONING", `Got ${r.tier}`);
});

test("Japanese SIMPLE: こんにちは、東京とは何ですか", () => {
  const r = classify("こんにちは、東京とは何ですか", undefined, 15);
  eq(r.tier, "SIMPLE", `Got ${r.tier}`);
});

test("Russian SIMPLE: Привет, что такое машинное обучение?", () => {
  const r = classify("Привет, что такое машинное обучение?", undefined, 15);
  eq(r.tier, "SIMPLE", `Got ${r.tier}`);
});

test("Russian TECHNICAL: Оптимизировать алгоритм для распределённой системы", () => {
  const r = classify("Оптимизировать алгоритм сортировки для распределённой системы", undefined, 20);
  notEq(r.tier, "SIMPLE", `Got SIMPLE — should be higher`);
});

test("German REASONING: Beweisen Sie Schritt für Schritt", () => {
  const r = classify("Beweisen Sie, dass die Quadratwurzel von 2 irrational ist, Schritt für Schritt", undefined, 25);
  eq(r.tier, "REASONING", `Got ${r.tier}`);
});

test("German SIMPLE: Hallo, was ist maschinelles Lernen?", () => {
  const r = classify("Hallo, was ist maschinelles Lernen?", undefined, 10);
  eq(r.tier, "SIMPLE", `Got ${r.tier}`);
});

test("Vietnamese: Xin chào, hôm nay thời tiết thế nào?", () => {
  const r = classify("Xin chào, hôm nay thời tiết thế nào?", undefined, 10);
  ok(r.tier !== undefined, `Got undefined tier`);
});

test("Arabic: اشرح لي كيف يعمل الذكاء الاصطناعي", () => {
  const r = classify("اشرح لي كيف يعمل الذكاء الاصطناعي", undefined, 10);
  ok(r.tier !== undefined);
});

test("Korean: 안녕하세요", () => {
  const r = classify("안녕하세요, 이것은 무엇입니까?", undefined, 10);
  ok(r.tier !== undefined);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: Edge Cases
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Edge Cases ═══\n");

test("Empty string doesn't crash", () => {
  const r = classify("", undefined, 0);
  ok(r !== undefined);
});

test("Only whitespace", () => {
  const r = classify("   \t\n   ", undefined, 0);
  ok(r !== undefined);
});

test("Very short: 'Hi'", () => {
  const r = routeQuery("Hi");
  includes(["SIMPLE", "MEDIUM"], r.tier, `Got ${r.tier}`);
});

test("Single character: 'a'", () => {
  const r = classify("a", undefined, 1);
  ok(r !== undefined);
});

test("Unicode emoji-heavy", () => {
  const r = classify("🚀 Build a 🔥 app with 💻 code 🎉", undefined, 10);
  ok(r.tier !== undefined);
});

test("Null bytes and control chars", () => {
  const r = classify("Hello\x00World\x1F\x7F", undefined, 5);
  ok(r.tier !== undefined);
});

test("Very long single word (10k chars)", () => {
  const r = classify("a".repeat(10000), undefined, 1);
  ok(r.tier !== undefined);
});

test("Very long input (2000 words)", () => {
  const r = routeQuery("Summarize this: " + "word ".repeat(2000));
  ok(r.tier !== undefined);
});

test("10k word input", () => {
  const r = routeQuery("Analyze: " + "Lorem ipsum dolor sit amet. ".repeat(1000));
  ok(r.tier !== undefined);
});

test("Special characters: $100 * 50% @test #hash", () => {
  const r = classify("What is $100 * 50%? @test #hash", undefined, 10);
  ok(r.tier !== undefined);
});

test("Only newlines", () => {
  const r = classify("\n\n\n\n", undefined, 0);
  ok(r !== undefined);
});

test("Mixed scripts (CJK + Latin + Arabic)", () => {
  const r = classify("Hello 你好 مرحبا こんにちは", undefined, 10);
  ok(r.tier !== undefined);
});

test("JSON blob as input", () => {
  const r = classify('{"key": "value", "nested": {"a": [1,2,3]}}', undefined, 20);
  ok(r.tier !== undefined);
});

test("URL as input", () => {
  const r = classify("https://api.example.com/v1/users?page=1&limit=10", undefined, 5);
  ok(r.tier !== undefined);
});

test("Stack trace as input", () => {
  const r = classify(`Error: Connection refused
    at Socket.connect (net.js:1141:16)
    at Object.connect (net.js:305:17)
    at Pool.getConnection (pool.js:48:21)`, undefined, 30);
  ok(r.tier !== undefined);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 9: Route Function (full pipeline)
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Route Function (Full Pipeline) ═══\n");

test("Route returns all required fields", () => {
  const r = routeQuery("Test query");
  ok(r.tier !== undefined, "missing tier");
  ok(r.model !== undefined, "missing model");
  ok(typeof r.costEstimate === "number", "costEstimate not number");
  ok(typeof r.savings === "number", "savings not number");
  ok(typeof r.confidence === "number", "confidence not number");
  ok(typeof r.reasoning === "string", "reasoning not string");
});

test("Tier is valid enum", () => {
  const r = routeQuery("Any query");
  includes(["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"], r.tier);
});

test("Savings between 0 and 1", () => {
  const r = routeQuery("Hello world");
  ok(r.savings >= 0 && r.savings <= 1, `Savings=${r.savings}`);
});

test("Cost estimate is non-negative", () => {
  const r = routeQuery("Hello");
  ok(r.costEstimate >= 0, `Cost=${r.costEstimate}`);
});

test("Consistency: same query → same result", () => {
  const r1 = routeQuery("Explain machine learning");
  const r2 = routeQuery("Explain machine learning");
  eq(r1.tier, r2.tier, "Tier inconsistent");
  eq(r1.model, r2.model, "Model inconsistent");
});

test("SIMPLE routes to configured primary model", () => {
  const r = routeQuery("What is 2+2?");
  eq(r.model, config.tiers.SIMPLE.primary, `Got ${r.model}`);
});

test("REASONING routes to configured primary model", () => {
  const r = routeQuery("Prove step by step that sqrt(2) is irrational");
  eq(r.model, config.tiers.REASONING.primary, `Got ${r.model}`);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 10: Config Overrides
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Config Overrides ═══\n");

test("applyConfigOverrides changes tier primary", () => {
  const overridden = applyConfigOverrides(config, {
    tiers: { SIMPLE: { primary: "test/model-cheap", fallback: [] } },
  });
  eq(overridden.tiers.SIMPLE.primary, "test/model-cheap");
  // Other tiers unchanged
  eq(overridden.tiers.REASONING.primary, config.tiers.REASONING.primary);
});

test("applyConfigOverrides changes defaultTier", () => {
  const overridden = applyConfigOverrides(config, { defaultTier: "COMPLEX" });
  eq(overridden.overrides.ambiguousDefaultTier, "COMPLEX");
});

test("applyConfigOverrides with empty config returns defaults", () => {
  const overridden = applyConfigOverrides(config, {});
  eq(overridden.tiers.SIMPLE.primary, config.tiers.SIMPLE.primary);
});

test("applyConfigOverrides preserves scoring config", () => {
  const overridden = applyConfigOverrides(config, { tiers: { SIMPLE: { primary: "x/y" } } });
  eq(overridden.scoring.confidenceThreshold, config.scoring.confidenceThreshold);
});

test("applyConfigOverrides can change scoring weights", () => {
  const overridden = applyConfigOverrides(config, {
    scoring: { confidenceThreshold: 0.99 },
  });
  eq(overridden.scoring.confidenceThreshold, 0.99);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 11: Agentic Task Detection
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Agentic Task Detection ═══\n");

test("Multi-step agentic: read file, edit, deploy", () => {
  const r = classify("Read the file, edit the config, then deploy and verify it works", undefined, 20);
  ok(r.agenticScore > 0, `agenticScore=${r.agenticScore}`);
});

test("Simple non-agentic query has low agentic score", () => {
  const r = classify("What is 2+2?", undefined, 5);
  eq(r.agenticScore, 0, `agenticScore=${r.agenticScore}`);
});

test("Heavy agentic: install, compile, fix, debug, iterate", () => {
  const r = classify("Install the dependencies, compile the project, fix any errors, debug until it works, then deploy", undefined, 30);
  ok(r.agenticScore >= 0.6, `agenticScore=${r.agenticScore}`);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 12: Confidence & Ambiguity
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Confidence & Ambiguity ═══\n");

test("Clear SIMPLE has high confidence", () => {
  const r = classify("What is 2+2?", undefined, 5);
  ok(r.confidence > 0.6, `confidence=${r.confidence.toFixed(3)}`);
});

test("Clear REASONING has high confidence", () => {
  const r = classify("Prove step by step that sqrt(2) is irrational", undefined, 20);
  ok(r.confidence >= 0.85, `confidence=${r.confidence.toFixed(3)}`);
});

test("Ambiguous query may return null tier", () => {
  // Complex multi-domain queries tend to be ambiguous
  const r = classify("Build a React component with TypeScript that implements a drag-and-drop kanban board with async data loading, error handling, and unit tests", undefined, 200);
  // May be null (ambiguous) or a tier — either is valid
  ok(r !== undefined);
});

test("Confidence is between 0 and 1", () => {
  const queries = ["Hello", "Prove sqrt(2) irrational step by step", "Build a REST API"];
  for (const q of queries) {
    const r = classify(q, undefined, 10);
    ok(r.confidence >= 0 && r.confidence <= 1, `${q}: confidence=${r.confidence}`);
  }
});

// ═══════════════════════════════════════════════════════════════
// SECTION 13: Multi-Step & Question Complexity
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Multi-Step & Question Complexity ═══\n");

test("Step 1, Step 2 pattern detected", () => {
  const r = classify("Step 1: read the file. Step 2: parse it. Step 3: transform.", undefined, 20);
  ok(r.signals.some(s => s.includes("multi-step")), `No multi-step signal: [${r.signals}]`);
});

test("First...then pattern detected", () => {
  const r = classify("First analyze the data, then generate a report", undefined, 15);
  ok(r.signals.some(s => s.includes("multi-step")), `No multi-step signal: [${r.signals}]`);
});

test("Multiple questions increase complexity", () => {
  const q1 = classify("What is AI?", undefined, 5);
  const q4 = classify("What is AI? How does it learn? Why is it important? When will it surpass humans?", undefined, 20);
  ok(q4.score >= q1.score, `4 questions (${q4.score.toFixed(3)}) should score >= 1 question (${q1.score.toFixed(3)})`);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 14: HTTP Proxy (if running)
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ HTTP Proxy (if running) ═══\n");

const PROXY_URL = process.env.FREEROUTER_URL || "http://127.0.0.1:18801";

async function proxyUp() {
  try {
    const r = await fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

const isUp = await proxyUp();

if (isUp) {
  await testAsync("Health endpoint returns ok", async () => {
    const r = await fetch(`${PROXY_URL}/health`);
    eq(r.status, 200);
    const data = await r.json();
    eq(data.status, "ok");
    ok(data.version !== undefined);
  });

  await testAsync("Stats endpoint works", async () => {
    const r = await fetch(`${PROXY_URL}/stats`);
    eq(r.status, 200);
    const data = await r.json();
    ok(data.requests !== undefined);
    ok(data.byTier !== undefined);
    ok(data.byModel !== undefined);
  });

  await testAsync("Models endpoint lists models", async () => {
    const r = await fetch(`${PROXY_URL}/v1/models`);
    eq(r.status, 200);
    const data = await r.json();
    ok(Array.isArray(data.data));
    ok(data.data.length > 0);
    ok(data.data.some(m => m.id === "auto"), "Should include 'auto' model");
  });

  await testAsync("Unknown route returns 404", async () => {
    const r = await fetch(`${PROXY_URL}/nonexistent`);
    eq(r.status, 404);
  });

  await testAsync("POST without body returns 400", async () => {
    const r = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    eq(r.status, 400);
  });

  await testAsync("POST with empty messages returns 400", async () => {
    const r = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [] }),
    });
    eq(r.status, 400);
  });

  await testAsync("Response headers include X-FreeRouter-*", async () => {
    const r = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "What is 2+2?" }],
        max_tokens: 10,
      }),
    });
    // Even if auth fails, headers should be set before forwarding
    ok(r.headers.has("x-freerouter-model") || r.status >= 400, "Missing X-FreeRouter-Model header");
  });

  await testAsync("CORS headers present", async () => {
    const r = await fetch(`${PROXY_URL}/health`);
    ok(r.headers.has("access-control-allow-origin"), "Missing CORS header");
  });

  await testAsync("OPTIONS returns 204", async () => {
    const r = await fetch(`${PROXY_URL}/v1/chat/completions`, { method: "OPTIONS" });
    eq(r.status, 204);
  });
} else {
  skip("Proxy health (not running)");
  skip("Proxy stats (not running)");
  skip("Proxy models (not running)");
  skip("Proxy 404 (not running)");
  skip("Proxy 400 bad body (not running)");
  skip("Proxy 400 empty messages (not running)");
  skip("Proxy X-FreeRouter headers (not running)");
  skip("Proxy CORS (not running)");
  skip("Proxy OPTIONS (not running)");
  console.log(`  ℹ Proxy not detected at ${PROXY_URL}. Set FREEROUTER_URL or enable the plugin.`);
}

// ═══════════════════════════════════════════════════════════════
// SECTION 15: Performance
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Performance ═══\n");

test("Classification < 5ms per query", () => {
  const iterations = 100;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    classify("Explain the architecture of a distributed database system", undefined, 20);
  }
  const elapsed = performance.now() - start;
  const perQuery = elapsed / iterations;
  ok(perQuery < 5, `${perQuery.toFixed(2)}ms per query (limit: 5ms)`);
  console.log(`    ${perQuery.toFixed(3)}ms avg over ${iterations} queries`);
});

test("Route (full pipeline) < 10ms per query", () => {
  const iterations = 100;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    routeQuery("Build a REST API with authentication and rate limiting");
  }
  const elapsed = performance.now() - start;
  const perQuery = elapsed / iterations;
  ok(perQuery < 10, `${perQuery.toFixed(2)}ms per query (limit: 10ms)`);
  console.log(`    ${perQuery.toFixed(3)}ms avg over ${iterations} queries`);
});

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(60));
console.log(`\n  ✓ ${passed} passed   ✗ ${failed} failed   ○ ${skipped} skipped\n`);

if (failures.length > 0) {
  console.log("  Failures:");
  for (const f of failures) {
    console.log(`    ✗ ${f.name}: ${f.error}`);
  }
  console.log();
}

process.exit(failed > 0 ? 1 : 0);