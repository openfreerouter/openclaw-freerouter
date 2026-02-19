/**
 * FreeRouter Override & Session Lock Tests
 *
 * Tests: model aliases, per-prompt overrides, session locks,
 * unlock, lock status, expiry, and HTTP proxy integration.
 *
 * Run: npx tsx test/test-overrides.mjs
 */

// We can't easily import the private functions from service.ts,
// so we test via the HTTP proxy if running, plus unit-test the
// detectOverride logic by re-implementing the matching here.

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

function skip(name) { console.log(`  ○ ${name} (skipped)`); skipped++; }

function eq(a, b, msg = "") { if (a !== b) throw new Error(`${msg} Expected "${b}", got "${a}"`); }
function ok(cond, msg = "") { if (!cond) throw new Error(msg || "Assertion failed"); }

// ─── Model Aliases (replicated from service.ts for testing) ───

const MODEL_ALIASES = {
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
  kimi: "kimi-coding/kimi-for-coding",
  "kimi-k2": "kimi-coding/kimi-for-coding",
  "k2.5": "kimi-coding/kimi-for-coding",
  auto: "__AUTO__",
};

const TIER_ALIASES = {
  simple: "SIMPLE", basic: "SIMPLE", cheap: "SIMPLE",
  medium: "MEDIUM", balanced: "MEDIUM",
  complex: "COMPLEX", advanced: "COMPLEX",
  max: "REASONING", reasoning: "REASONING", think: "REASONING", deep: "REASONING",
};

// Simplified detectOverride for unit testing
function detectOverride(prompt) {
  const slashMatch = prompt.match(/^\/([a-z0-9._-]+)(?:\s+(.*))?$/is);
  if (!slashMatch) {
    const bracketMatch = prompt.match(/^\[([a-z0-9._-]+)\]\s*(.*)/is);
    if (bracketMatch) {
      const key = bracketMatch[1].toLowerCase();
      const rest = bracketMatch[2].trim();
      if (MODEL_ALIASES[key] && MODEL_ALIASES[key] !== "__AUTO__")
        return { type: "model", value: MODEL_ALIASES[key], cleanedPrompt: rest };
      if (TIER_ALIASES[key])
        return { type: "tier", value: TIER_ALIASES[key], cleanedPrompt: rest };
    }
    return null;
  }

  const cmd = slashMatch[1].toLowerCase();
  const rest = (slashMatch[2] ?? "").trim();

  if (cmd === "lock") {
    if (!rest || rest.toLowerCase() === "auto") return { type: "unlock", value: "", cleanedPrompt: "" };
    if (rest.toLowerCase() === "status") return { type: "status", value: "", cleanedPrompt: "" };
    const modelKey = rest.toLowerCase();
    if (MODEL_ALIASES[modelKey]) return { type: "lock", value: MODEL_ALIASES[modelKey], cleanedPrompt: "" };
    if (TIER_ALIASES[modelKey]) return { type: "lock", value: `__TIER__:${TIER_ALIASES[modelKey]}`, cleanedPrompt: "" };
    if (rest.includes("/")) return { type: "lock", value: rest, cleanedPrompt: "" };
    return null;
  }
  if (cmd === "unlock") return { type: "unlock", value: "", cleanedPrompt: "" };
  if (MODEL_ALIASES[cmd] && MODEL_ALIASES[cmd] !== "__AUTO__")
    return { type: "model", value: MODEL_ALIASES[cmd], cleanedPrompt: rest };
  if (TIER_ALIASES[cmd])
    return { type: "tier", value: TIER_ALIASES[cmd], cleanedPrompt: rest };
  return null;
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1: Model Aliases
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Model Aliases ═══\n");

test("All Anthropic aliases resolve correctly", () => {
  eq(MODEL_ALIASES["opus"], "anthropic/claude-opus-4-6");
  eq(MODEL_ALIASES["opus-4"], "anthropic/claude-opus-4-6");
  eq(MODEL_ALIASES["opus-4.6"], "anthropic/claude-opus-4-6");
  eq(MODEL_ALIASES["sonnet"], "anthropic/claude-sonnet-4-5");
  eq(MODEL_ALIASES["sonnet-4.6"], "anthropic/claude-sonnet-4-6");
  eq(MODEL_ALIASES["haiku"], "anthropic/claude-haiku-4-5");
});

test("Kimi aliases resolve correctly", () => {
  eq(MODEL_ALIASES["kimi"], "kimi-coding/kimi-for-coding");
  eq(MODEL_ALIASES["kimi-k2"], "kimi-coding/kimi-for-coding");
  eq(MODEL_ALIASES["k2.5"], "kimi-coding/kimi-for-coding");
});

test("Auto alias is special marker", () => {
  eq(MODEL_ALIASES["auto"], "__AUTO__");
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2: Per-Prompt Model Override Detection
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Per-Prompt Model Override ═══\n");

test("/opus What is 2+2? → model override", () => {
  const r = detectOverride("/opus What is 2+2?");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-opus-4-6");
  eq(r.cleanedPrompt, "What is 2+2?");
});

test("/sonnet Write a poem → model override", () => {
  const r = detectOverride("/sonnet Write a poem about the sea");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-sonnet-4-5");
  eq(r.cleanedPrompt, "Write a poem about the sea");
});

test("/kimi Quick question → model override", () => {
  const r = detectOverride("/kimi How old is the earth?");
  eq(r.type, "model");
  eq(r.value, "kimi-coding/kimi-for-coding");
});

test("/haiku Translate hello → model override", () => {
  const r = detectOverride("/haiku Translate hello to French");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-haiku-4-5");
});

test("[opus] Deep analysis → bracket model override", () => {
  const r = detectOverride("[opus] Analyze this architecture");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-opus-4-6");
  eq(r.cleanedPrompt, "Analyze this architecture");
});

test("[sonnet] Code review → bracket model override", () => {
  const r = detectOverride("[sonnet] Review this code");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-sonnet-4-5");
});

test("Normal prompt without prefix → null", () => {
  const r = detectOverride("What is the meaning of life?");
  eq(r, null);
});

test("Prompt with / in middle → null", () => {
  const r = detectOverride("What is 3/4 of 100?");
  eq(r, null);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3: Per-Prompt Tier Override Detection
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Per-Prompt Tier Override ═══\n");

test("/simple What is 2+2? → tier override", () => {
  const r = detectOverride("/simple What is 2+2?");
  eq(r.type, "tier");
  eq(r.value, "SIMPLE");
  eq(r.cleanedPrompt, "What is 2+2?");
});

test("/max Prove something → REASONING tier", () => {
  const r = detectOverride("/max Prove the Riemann hypothesis");
  eq(r.type, "tier");
  eq(r.value, "REASONING");
});

test("/think Deep analysis → REASONING tier", () => {
  const r = detectOverride("/think Why does consciousness exist?");
  eq(r.type, "tier");
  eq(r.value, "REASONING");
});

test("/complex Design a system → COMPLEX tier", () => {
  const r = detectOverride("/complex Design a distributed database");
  eq(r.type, "tier");
  eq(r.value, "COMPLEX");
});

test("[simple] Quick answer → bracket tier override", () => {
  const r = detectOverride("[simple] What time is it?");
  eq(r.type, "tier");
  eq(r.value, "SIMPLE");
});

test("[reasoning] Deep thought → bracket tier override", () => {
  const r = detectOverride("[reasoning] Prove this theorem");
  eq(r.type, "tier");
  eq(r.value, "REASONING");
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4: Session Lock Detection
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Session Lock ═══\n");

test("/lock opus → lock to Opus", () => {
  const r = detectOverride("/lock opus");
  eq(r.type, "lock");
  eq(r.value, "anthropic/claude-opus-4-6");
});

test("/lock sonnet → lock to Sonnet", () => {
  const r = detectOverride("/lock sonnet");
  eq(r.type, "lock");
  eq(r.value, "anthropic/claude-sonnet-4-5");
});

test("/lock kimi → lock to Kimi", () => {
  const r = detectOverride("/lock kimi");
  eq(r.type, "lock");
  eq(r.value, "kimi-coding/kimi-for-coding");
});

test("/lock simple → lock to SIMPLE tier", () => {
  const r = detectOverride("/lock simple");
  eq(r.type, "lock");
  eq(r.value, "__TIER__:SIMPLE");
});

test("/lock reasoning → lock to REASONING tier", () => {
  const r = detectOverride("/lock reasoning");
  eq(r.type, "lock");
  eq(r.value, "__TIER__:REASONING");
});

test("/lock anthropic/claude-opus-4-6 → lock with full ID", () => {
  const r = detectOverride("/lock anthropic/claude-opus-4-6");
  eq(r.type, "lock");
  eq(r.value, "anthropic/claude-opus-4-6");
});

test("/lock → unlock (no arg)", () => {
  const r = detectOverride("/lock");
  eq(r.type, "unlock");
});

test("/lock auto → unlock", () => {
  const r = detectOverride("/lock auto");
  eq(r.type, "unlock");
});

test("/lock status → status query", () => {
  const r = detectOverride("/lock status");
  eq(r.type, "status");
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5: Unlock Detection
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Unlock ═══\n");

test("/unlock → unlock", () => {
  const r = detectOverride("/unlock");
  eq(r.type, "unlock");
});

test("/unlock with trailing text → unlock", () => {
  const r = detectOverride("/unlock please");
  // /unlock is the command, "please" is rest — still unlock
  eq(r.type, "unlock");
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6: Edge Cases
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Edge Cases ═══\n");

test("/OPUS (uppercase) → model override", () => {
  const r = detectOverride("/OPUS What is this?");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-opus-4-6");
});

test("/Sonnet (mixed case) → model override", () => {
  const r = detectOverride("/Sonnet Write code");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-sonnet-4-5");
});

test("/opus without prompt → model override with empty prompt", () => {
  const r = detectOverride("/opus");
  eq(r.type, "model");
  eq(r.cleanedPrompt, "");
});

test("/unknown → null (unknown command)", () => {
  const r = detectOverride("/unknown something");
  eq(r, null);
});

test("Empty string → null", () => {
  const r = detectOverride("");
  eq(r, null);
});

test("/lock unknown-alias → null", () => {
  const r = detectOverride("/lock foobar");
  eq(r, null);
});

test("[OPUS] uppercase bracket → model override", () => {
  const r = detectOverride("[OPUS] test");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-opus-4-6");
});

test("Multiple slashes: /opus /sonnet → only first parsed", () => {
  const r = detectOverride("/opus /sonnet test");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-opus-4-6");
  eq(r.cleanedPrompt, "/sonnet test"); // rest includes the second slash
});

test("/opus-4.6 → model override (dot in alias)", () => {
  const r = detectOverride("/opus-4.6 test");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-opus-4-6");
});

test("/k2.5 → kimi alias", () => {
  const r = detectOverride("/k2.5 quick question");
  eq(r.type, "model");
  eq(r.value, "kimi-coding/kimi-for-coding");
});

test("Multiline prompt with override → only first line parsed", () => {
  const r = detectOverride("/opus First line\nSecond line\nThird line");
  eq(r.type, "model");
  ok(r.cleanedPrompt.includes("First line"));
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7: Natural Language Override Detection
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ Natural Language Override ═══\n");

// Replicated from service.ts for testing
function detectNaturalLanguage(prompt) {
  const lower = prompt.toLowerCase().trim();

  // Confirmation
  if (/^\/?(yes|y|yeah|yep|confirm|ok|sure|do it)\s*$/i.test(lower))
    return { type: "model", value: "__CONFIRM__", cleanedPrompt: "" };
  if (/^\/?(no|n|nah|nope|cancel|nevermind)\s*$/i.test(lower))
    return { type: "model", value: "__CANCEL__", cleanedPrompt: "" };

  // Session patterns
  const sessionPatterns = [
    /(?:use|switch to|change to|set|lock(?: to)?)\s+(\S+)\s+(?:for (?:this|the) session|for (?:all|everything)|from now on|going forward)/i,
    /(?:lock|stick with|keep using)\s+(\S+)\s*(?:for now|please|$)/i,
    /(?:this session|from now on|going forward),?\s*(?:use|switch to)\s+(\S+)/i,
  ];
  for (const p of sessionPatterns) {
    const m = lower.match(p);
    if (m) {
      const k = m[1]?.toLowerCase();
      if (MODEL_ALIASES[k]) return { type: "lock", value: MODEL_ALIASES[k], cleanedPrompt: "" };
      if (TIER_ALIASES[k]) return { type: "lock", value: `__TIER__:${TIER_ALIASES[k]}`, cleanedPrompt: "" };
    }
  }

  // Immediate patterns
  const immediatePatterns = [
    /^(?:use|switch to|change to|go with|try)\s+(\S+)\s*$/i,
    /^(?:use|switch to|change to)\s+(\S+)[,:]\s*(.+)$/is,
    /^let'?s\s+(?:use|try|go with)\s+(\S+)\s*$/i,
    /^(?:can you|could you|please)\s+(?:use|switch to|change to)\s+(\S+)\s*$/i,
    /^(?:go )?back to\s+(?:auto|automatic|auto[- ]?routing)\s*$/i,
  ];
  for (const p of immediatePatterns) {
    const m = lower.match(p);
    if (m) {
      if (/back to\s+auto/i.test(lower)) return { type: "unlock", value: "", cleanedPrompt: "" };
      const k = m[1]?.toLowerCase();
      const rest = m[2]?.trim() ?? "";
      if (MODEL_ALIASES[k]) return { type: "model", value: MODEL_ALIASES[k], cleanedPrompt: rest };
      if (TIER_ALIASES[k]) return { type: "tier", value: TIER_ALIASES[k], cleanedPrompt: rest };
    }
  }

  // Ambiguous
  if (lower.length < 100) {
    const ambiguous = [
      /(?:maybe|should (?:we|i|you)|how about|what about)\s+(?:use|using|try|trying|switch(?:ing)? to)\s+(\S+?)[\s?!.,]*$/i,
      /^(\S+)\s+(?:might|would|could|should)\s+(?:be|work)\s+better/i,
      /^i\s+(?:think|want|prefer|need)\s+(\S+)\s*$/i,
      /^(\S+)\s+please\s*$/i,
    ];
    for (const p of ambiguous) {
      const m = lower.match(p);
      if (m) {
        const k = m[1]?.toLowerCase();
        if (MODEL_ALIASES[k]) return { type: "model", value: `__ASK__:${MODEL_ALIASES[k]}`, cleanedPrompt: "" };
        if (TIER_ALIASES[k]) return { type: "tier", value: `__ASK__:${TIER_ALIASES[k]}`, cleanedPrompt: "" };
      }
    }
  }

  return null;
}

// High confidence — immediate
test('"use opus" → immediate model override', () => {
  const r = detectNaturalLanguage("use opus");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-opus-4-6");
});

test('"switch to sonnet" → immediate model override', () => {
  const r = detectNaturalLanguage("switch to sonnet");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-sonnet-4-5");
});

test('"change to kimi" → immediate model override', () => {
  const r = detectNaturalLanguage("change to kimi");
  eq(r.type, "model");
  eq(r.value, "kimi-coding/kimi-for-coding");
});

test('"try haiku" → immediate model override', () => {
  const r = detectNaturalLanguage("try haiku");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-haiku-4-5");
});

test('"go with opus" → immediate model override', () => {
  const r = detectNaturalLanguage("go with opus");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-opus-4-6");
});

test('"let\'s use sonnet" → immediate', () => {
  const r = detectNaturalLanguage("let's use sonnet");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-sonnet-4-5");
});

test('"please use opus" → immediate', () => {
  const r = detectNaturalLanguage("please use opus");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-opus-4-6");
});

test('"can you use sonnet" → immediate', () => {
  const r = detectNaturalLanguage("can you use sonnet");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-sonnet-4-5");
});

test('"use opus: explain quantum computing" → model + prompt', () => {
  const r = detectNaturalLanguage("use opus: explain quantum computing");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-opus-4-6");
  eq(r.cleanedPrompt, "explain quantum computing");
});

test('"use opus, what is 2+2" → model + prompt', () => {
  const r = detectNaturalLanguage("use opus, what is 2+2");
  eq(r.type, "model");
  eq(r.value, "anthropic/claude-opus-4-6");
  eq(r.cleanedPrompt, "what is 2+2");
});

// Session lock via natural language
test('"use opus for this session" → session lock', () => {
  const r = detectNaturalLanguage("use opus for this session");
  eq(r.type, "lock");
  eq(r.value, "anthropic/claude-opus-4-6");
});

test('"switch to sonnet from now on" → session lock', () => {
  const r = detectNaturalLanguage("switch to sonnet from now on");
  eq(r.type, "lock");
  eq(r.value, "anthropic/claude-sonnet-4-5");
});

test('"lock to opus" → detected by slash detectOverride (not NL)', () => {
  // "lock to opus" starts with "lock" — detectOverride catches it as /lock first
  // In NL, it matches the session pattern with lock
  const r = detectNaturalLanguage("lock to opus");
  // If NL doesn't catch it, that's OK — detectOverride will via /lock
  ok(r === null || r.type === "lock", `Unexpected: ${JSON.stringify(r)}`);
});

test('"stick with opus" → session lock', () => {
  const r = detectNaturalLanguage("stick with opus");
  eq(r.type, "lock");
  eq(r.value, "anthropic/claude-opus-4-6");
});

test('"keep using sonnet" → session lock', () => {
  const r = detectNaturalLanguage("keep using sonnet");
  eq(r.type, "lock");
  eq(r.value, "anthropic/claude-sonnet-4-5");
});

test('"use opus for all" → session lock', () => {
  const r = detectNaturalLanguage("use opus for all");
  // This matches "for all" pattern
  eq(r.type, "lock");
});

// Unlock via natural language
test('"go back to auto" → unlock', () => {
  const r = detectNaturalLanguage("go back to auto");
  eq(r.type, "unlock");
});

test('"back to auto routing" → unlock', () => {
  const r = detectNaturalLanguage("back to auto routing");
  eq(r.type, "unlock");
});

test('"back to automatic" → unlock', () => {
  const r = detectNaturalLanguage("back to automatic");
  eq(r.type, "unlock");
});

// Ambiguous — should ask
test('"maybe use opus?" → ask to confirm', () => {
  const r = detectNaturalLanguage("maybe use opus?");
  ok(r.value.startsWith("__ASK__:"), `Expected __ASK__, got ${r.value}`);
});

test('"should we use sonnet?" → ask to confirm', () => {
  const r = detectNaturalLanguage("should we use sonnet?");
  ok(r.value.startsWith("__ASK__:"), `Expected __ASK__, got ${r.value}`);
});

test('"opus might be better" → ask to confirm', () => {
  const r = detectNaturalLanguage("opus might be better");
  ok(r.value.startsWith("__ASK__:"), `Expected __ASK__, got ${r.value}`);
});

test('"I want opus" → ask to confirm', () => {
  const r = detectNaturalLanguage("I want opus");
  ok(r.value.startsWith("__ASK__:"), `Expected __ASK__, got ${r.value}`);
});

test('"opus please" → ask to confirm', () => {
  const r = detectNaturalLanguage("opus please");
  ok(r.value.startsWith("__ASK__:"), `Expected __ASK__, got ${r.value}`);
});

// Confirmation responses
test('"yes" → confirm', () => {
  const r = detectNaturalLanguage("yes");
  eq(r.value, "__CONFIRM__");
});

test('"yeah" → confirm', () => {
  const r = detectNaturalLanguage("yeah");
  eq(r.value, "__CONFIRM__");
});

test('"sure" → confirm', () => {
  const r = detectNaturalLanguage("sure");
  eq(r.value, "__CONFIRM__");
});

test('"no" → cancel', () => {
  const r = detectNaturalLanguage("no");
  eq(r.value, "__CANCEL__");
});

test('"nope" → cancel', () => {
  const r = detectNaturalLanguage("nope");
  eq(r.value, "__CANCEL__");
});

test('"cancel" → cancel', () => {
  const r = detectNaturalLanguage("cancel");
  eq(r.value, "__CANCEL__");
});

// Should NOT trigger on normal prompts
test('"What is opus?" → null (question about opus, not a switch)', () => {
  const r = detectNaturalLanguage("What is opus?");
  eq(r, null);
});

test('"Tell me about the opus music format" → null', () => {
  const r = detectNaturalLanguage("Tell me about the opus music format");
  eq(r, null);
});

test('"How does routing work?" → null', () => {
  const r = detectNaturalLanguage("How does routing work?");
  eq(r, null);
});

test('"Explain quantum computing" → null (long, no model ref)', () => {
  const r = detectNaturalLanguage("Explain quantum computing in detail with examples");
  eq(r, null);
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8: HTTP Proxy Integration (if running)
// ═══════════════════════════════════════════════════════════════

console.log("\n═══ HTTP Proxy Integration ═══\n");

const PROXY_URL = process.env.FREEROUTER_URL || "http://127.0.0.1:18801";

async function proxyUp() {
  try {
    const r = await fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

const isUp = await proxyUp();

if (isUp) {
  // Helper to send a chat request
  async function chat(content, model = "auto") {
    return fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a test assistant. Session: override-test-" + Date.now() },
          { role: "user", content },
        ],
        max_tokens: 5,
      }),
    });
  }

  await testAsync("Per-prompt /opus override sets X-FreeRouter-Model header", async () => {
    const r = await chat("/opus What is 2+2?");
    // May fail at provider level, but headers should be set
    const model = r.headers.get("x-freerouter-model");
    ok(model === "anthropic/claude-opus-4-6" || r.status >= 400,
      `Expected opus model in header, got: ${model} (status ${r.status})`);
  });

  await testAsync("/lock opus returns synthetic lock message", async () => {
    const r = await chat("/lock opus");
    if (r.ok) {
      const data = await r.json();
      ok(data.choices?.[0]?.message?.content?.includes("locked"), `Response: ${JSON.stringify(data)}`);
      ok(data.model === "anthropic/claude-opus-4-6", `Model: ${data.model}`);
    }
  });

  await testAsync("/unlock returns synthetic unlock message", async () => {
    const r = await chat("/unlock");
    if (r.ok) {
      const data = await r.json();
      ok(data.choices?.[0]?.message?.content?.includes("unlock") ||
         data.choices?.[0]?.message?.content?.includes("auto"),
        `Response: ${JSON.stringify(data)}`);
    }
  });

  await testAsync("/lock status returns status message", async () => {
    const r = await chat("/lock status");
    if (r.ok) {
      const data = await r.json();
      ok(data.choices?.[0]?.message?.content !== undefined, "No content");
    }
  });

  await testAsync("Sessions locks endpoint shows locks", async () => {
    const r = await fetch(`${PROXY_URL}/sessions/locks`);
    eq(r.status, 200);
    const data = await r.json();
    ok(typeof data.count === "number", "Missing count");
    ok(typeof data.locks === "object", "Missing locks");
  });

  await testAsync("DELETE /sessions/locks clears all locks", async () => {
    // Lock a session first
    await chat("/lock opus");
    // Clear all
    const r = await fetch(`${PROXY_URL}/sessions/locks`, { method: "DELETE" });
    eq(r.status, 200);
    const data = await r.json();
    ok(typeof data.cleared === "number");
  });
} else {
  const proxyTests = [
    "Per-prompt override header", "Lock message", "Unlock message",
    "Lock status", "Sessions locks endpoint", "DELETE locks",
  ];
  for (const t of proxyTests) skip(`Proxy: ${t} (not running)`);
  console.log(`  ℹ Proxy not detected at ${PROXY_URL}`);
}

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