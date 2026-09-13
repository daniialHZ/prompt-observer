#!/usr/bin/env node

import { createReadStream } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "1.1";
const SUPPORTED_SCHEMA_VERSIONS = new Set(["1.0", "1.1"]);
const DEFAULT_REPORT_LIMIT = 50;
const SCORE_FIELDS = [
  "intent_clarity",
  "context_sufficiency",
  "scope_definition",
  "constraints_quality",
  "acceptance_criteria",
  "verification_plan",
];
const INSIGHT_CATEGORIES = new Set([...SCORE_FIELDS, "output_format", "other"]);
const TASK_TYPES = new Set(["coding", "debugging", "planning", "review", "testing", "documentation", "refactoring", "other"]);
const RISK_LEVELS = new Set(["low", "medium", "high"]);
const WEAKNESS_CATEGORIES = new Set([
  "missing_context",
  "ambiguous_goal",
  "undefined_scope",
  "missing_constraints",
  "missing_acceptance_criteria",
  "missing_verification",
  "missing_output_format",
  "conflicting_requirements",
  "other",
]);
const SEVERITIES = new Set(["low", "medium", "high"]);
const RESULT_STATUSES = new Set(["completed", "partial", "blocked"]);
const TEST_STATUSES = new Set(["passed", "failed", "not_run", "unknown"]);
const USAGE_SOURCES = new Set(["platform_reported", "estimated", "unavailable"]);
const ROOT_KEYS = new Set([
  "schema_version", "event_id", "timestamp", "task_type", "prompt_summary",
  ...SCORE_FIELDS, "ambiguity_risk", "strengths", "weaknesses",
  "improvement_suggestions", "execution_signals", "usage",
]);
const BANNED_KEYS = new Set([
  "prompt", "raw_prompt", "full_prompt", "user_prompt", "response",
  "raw_response", "full_response", "assistant_response", "reasoning",
  "chain_of_thought", "system_prompt",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function loadPricingSnapshot() {
  const selfDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(selfDirectory, "pricing.json"),
    join(selfDirectory, "..", "pricing", "models.json"),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return JSON.parse(await readFile(candidate, "utf8"));
  }
  return {
    schema_version: "1.0",
    updated_at: null,
    currency: "USD",
    unit_tokens: 1000000,
    source_url: null,
    models: {},
  };
}

const PRICING = await loadPricingSnapshot();

function addUnknownKeyErrors(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(path + "." + key + " is not allowed");
  }
}

function validateShortText(value, path, errors, options = {}) {
  const max = options.max ?? 500;
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(path + " must be a non-empty string");
  } else if (value.length > max) {
    errors.push(path + " must be at most " + max + " characters");
  }
}

function validateTextArray(value, path, errors, maxItems = 10) {
  if (!Array.isArray(value)) {
    errors.push(path + " must be an array");
    return;
  }
  if (value.length > maxItems) errors.push(path + " must contain at most " + maxItems + " items");
  value.forEach((item, index) => validateShortText(item, path + "[" + index + "]", errors));
}

function validateInsightArray(value, path, errors, schemaVersion) {
  if (schemaVersion === "1.0") {
    validateTextArray(value, path, errors);
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(path + " must be an array");
    return;
  }
  if (value.length > 10) errors.push(path + " must contain at most 10 items");
  value.forEach((item, index) => {
    const itemPath = path + "[" + index + "]";
    if (!isObject(item)) {
      errors.push(itemPath + " must be an object in schema 1.1");
      return;
    }
    addUnknownKeyErrors(item, new Set(["category", "message"]), itemPath, errors);
    if (!INSIGHT_CATEGORIES.has(item.category)) errors.push(itemPath + ".category is invalid");
    validateShortText(item.message, itemPath + ".message", errors);
  });
}

function findBannedKeys(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findBannedKeys(item, path + "[" + index + "]", errors));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (BANNED_KEYS.has(normalized)) {
      errors.push(path + "." + key + " is prohibited because raw prompt, response, or private reasoning must not be stored");
    }
    findBannedKeys(child, path + "." + key, errors);
  }
}

function findLikelySecrets(value, errors) {
  const serialized = JSON.stringify(value);
  const patterns = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/i, "private key material"],
    [/\bsk-[A-Za-z0-9_-]{16,}\b/, "an API key"],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "a GitHub token"],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i, "a bearer token"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(serialized)) errors.push("event appears to contain " + label + "; redact it before logging");
  }
}

export function calculateEstimatedCost(usage, pricing = PRICING) {
  if (!usage || !usage.model || usage.input_tokens === null || usage.output_tokens === null) return null;
  const rate = pricing.models?.[usage.model];
  if (!rate) return null;
  const unit = pricing.unit_tokens || 1000000;
  return (usage.input_tokens * rate.input_usd + usage.output_tokens * rate.output_usd) / unit;
}

export function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let latin = 0;
  let nonLatin = 0;
  let symbols = 0;
  for (const character of text) {
    if (/\s/u.test(character)) continue;
    if (/[A-Za-z0-9]/u.test(character)) latin += 1;
    else if (/[\p{L}\p{N}\p{M}]/u.test(character)) nonLatin += 1;
    else symbols += 1;
  }
  return Math.ceil(latin / 4 + nonLatin / 2 + symbols / 2);
}

export function validateEvent(event) {
  const errors = [];
  if (!isObject(event)) return ["event must be a JSON object"];
  addUnknownKeyErrors(event, ROOT_KEYS, "$", errors);
  findBannedKeys(event, "$", errors);
  findLikelySecrets(event, errors);
  for (const key of ROOT_KEYS) {
    if (!(key in event)) errors.push("$." + key + " is required");
  }
  if (errors.some((error) => error.endsWith(" is required"))) return errors;

  if (!SUPPORTED_SCHEMA_VERSIONS.has(event.schema_version)) {
    errors.push("$.schema_version must equal 1.0 or 1.1");
  }
  if (typeof event.event_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(event.event_id)) {
    errors.push("$.event_id must be 8-128 safe identifier characters");
  }
  if (typeof event.timestamp !== "string" || !event.timestamp.includes("T") || Number.isNaN(Date.parse(event.timestamp))) {
    errors.push("$.timestamp must be a valid ISO-8601 date-time");
  }
  if (!TASK_TYPES.has(event.task_type)) errors.push("$.task_type is invalid");
  validateShortText(event.prompt_summary, "$.prompt_summary", errors);
  for (const field of SCORE_FIELDS) {
    if (!Number.isInteger(event[field]) || event[field] < 0 || event[field] > 10) {
      errors.push("$." + field + " must be an integer from 0 to 10");
    }
  }
  if (!RISK_LEVELS.has(event.ambiguity_risk)) errors.push("$.ambiguity_risk is invalid");
  validateInsightArray(event.strengths, "$.strengths", errors, event.schema_version);
  validateInsightArray(event.improvement_suggestions, "$.improvement_suggestions", errors, event.schema_version);

  if (!Array.isArray(event.weaknesses)) {
    errors.push("$.weaknesses must be an array");
  } else {
    if (event.weaknesses.length > 10) errors.push("$.weaknesses must contain at most 10 items");
    event.weaknesses.forEach((weakness, index) => {
      const path = "$.weaknesses[" + index + "]";
      if (!isObject(weakness)) {
        errors.push(path + " must be an object");
        return;
      }
      addUnknownKeyErrors(weakness, new Set(["category", "severity", "message"]), path, errors);
      if (!WEAKNESS_CATEGORIES.has(weakness.category)) errors.push(path + ".category is invalid");
      if (!SEVERITIES.has(weakness.severity)) errors.push(path + ".severity is invalid");
      validateShortText(weakness.message, path + ".message", errors);
    });
  }

  const signals = event.execution_signals;
  if (!isObject(signals)) {
    errors.push("$.execution_signals must be an object");
  } else {
    addUnknownKeyErrors(signals, new Set(["result_status", "files_changed", "tests_run"]), "$.execution_signals", errors);
    if (!RESULT_STATUSES.has(signals.result_status)) errors.push("$.execution_signals.result_status is invalid");
    validateTextArray(signals.files_changed, "$.execution_signals.files_changed", errors, 500);
    if (!Array.isArray(signals.tests_run)) {
      errors.push("$.execution_signals.tests_run must be an array");
    } else {
      if (signals.tests_run.length > 100) errors.push("$.execution_signals.tests_run must contain at most 100 items");
      signals.tests_run.forEach((test, index) => {
        const path = "$.execution_signals.tests_run[" + index + "]";
        if (!isObject(test)) {
          errors.push(path + " must be an object");
          return;
        }
        addUnknownKeyErrors(test, new Set(["name", "status"]), path, errors);
        validateShortText(test.name, path + ".name", errors);
        if (!TEST_STATUSES.has(test.status)) errors.push(path + ".status is invalid");
      });
    }
  }

  const usage = event.usage;
  if (!isObject(usage)) {
    errors.push("$.usage must be an object");
  } else {
    const usageKeys = new Set(["model", "input_tokens", "output_tokens", "cost_usd", "source", "estimation_method"]);
    addUnknownKeyErrors(usage, usageKeys, "$.usage", errors);
    for (const key of usageKeys) {
      if (!(key in usage)) errors.push("$.usage." + key + " is required");
    }
    if (usage.model !== null && (typeof usage.model !== "string" || usage.model.length > 200)) {
      errors.push("$.usage.model must be null or a string up to 200 characters");
    }
    for (const field of ["input_tokens", "output_tokens"]) {
      if (usage[field] !== null && (!Number.isInteger(usage[field]) || usage[field] < 0)) {
        errors.push("$.usage." + field + " must be null or a non-negative integer");
      }
    }
    if (usage.cost_usd !== null && (typeof usage.cost_usd !== "number" || usage.cost_usd < 0)) {
      errors.push("$.usage.cost_usd must be null or a non-negative number");
    }
    if (!USAGE_SOURCES.has(usage.source)) errors.push("$.usage.source is invalid");
    if (usage.estimation_method !== null && (typeof usage.estimation_method !== "string" || usage.estimation_method.trim() === "" || usage.estimation_method.length > 300)) {
      errors.push("$.usage.estimation_method must be null or a non-empty string up to 300 characters");
    }
    const metrics = [usage.model, usage.input_tokens, usage.output_tokens, usage.cost_usd];
    if (usage.source === "unavailable" && metrics.some((value) => value !== null)) {
      errors.push("$.usage metrics must all be null when source is unavailable");
    }
    if (usage.source === "unavailable" && usage.estimation_method !== null) {
      errors.push("$.usage.estimation_method must be null when source is unavailable");
    }
    if (usage.source === "estimated") {
      if (typeof usage.estimation_method !== "string" || usage.estimation_method.trim() === "") {
        errors.push("$.usage.estimation_method is required when source is estimated");
      }
      if (usage.input_tokens === null && usage.output_tokens === null && usage.cost_usd === null) {
        errors.push("$.usage estimated source requires at least one estimated numeric metric");
      }
      if (event.schema_version === "1.1" && usage.cost_usd !== null) {
        const expected = calculateEstimatedCost(usage);
        if (expected === null) {
          errors.push("$.usage.cost_usd requires both token counts and an exact model match in pricing.json");
        } else if (Math.abs(expected - usage.cost_usd) > Math.max(1e-9, expected * 0.000001)) {
          errors.push("$.usage.cost_usd does not match the versioned pricing snapshot");
        }
      }
    }
    if (usage.source === "platform_reported" && usage.estimation_method !== null) {
      errors.push("$.usage.estimation_method must be null when source is platform_reported");
    }
    if (usage.source === "platform_reported" && metrics.every((value) => value === null)) {
      errors.push("$.usage platform_reported source requires at least one reported metric");
    }
  }
  return errors;
}

async function findResourceRoot() {
  const selfDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(selfDirectory, ".."), selfDirectory];
  for (const candidate of candidates) {
    const contract = join(candidate, "PROMPT_OBSERVER.md");
    const schema = (await exists(join(candidate, "schema", "event.schema.json")))
      ? join(candidate, "schema", "event.schema.json")
      : join(candidate, "event.schema.json");
    const pricing = (await exists(join(candidate, "pricing", "models.json")))
      ? join(candidate, "pricing", "models.json")
      : join(candidate, "pricing.json");
    if ((await exists(contract)) && (await exists(schema)) && (await exists(pricing))) {
      return { root: candidate, contract, schema, pricing };
    }
  }
  throw new Error("Could not locate the Prompt Observer contract, schema, and pricing snapshot next to the CLI.");
}

async function copyUnlessPresent(source, destination, actions) {
  if (await exists(destination)) {
    actions.push("kept " + destination);
    return;
  }
  await copyFile(source, destination);
  actions.push("created " + destination);
}

async function writeUnlessPresent(destination, content, actions) {
  if (await exists(destination)) {
    actions.push("kept " + destination);
    return;
  }
  await writeFile(destination, content, "utf8");
  actions.push("created " + destination);
}

export async function initProject(targetPath) {
  const target = resolve(targetPath ?? ".");
  const observerDirectory = join(target, ".prompt-observer");
  const resources = await findResourceRoot();
  const selfPath = fileURLToPath(import.meta.url);
  const actions = [];
  await mkdir(observerDirectory, { recursive: true });
  await mkdir(join(observerDirectory, "pending"), { recursive: true });
  await copyUnlessPresent(resources.contract, join(observerDirectory, "PROMPT_OBSERVER.md"), actions);
  await copyUnlessPresent(resources.schema, join(observerDirectory, "event.schema.json"), actions);
  await copyUnlessPresent(resources.pricing, join(observerDirectory, "pricing.json"), actions);
  await copyUnlessPresent(selfPath, join(observerDirectory, "prompt-observer.mjs"), actions);
  await writeUnlessPresent(
    join(observerDirectory, ".gitignore"),
    ["events.jsonl", "report.md", "report.html", "pending/", "*.tmp", ""].join("\n"),
    actions,
  );
  const eventsFile = join(observerDirectory, "events.jsonl");
  const file = await open(eventsFile, "a");
  await file.close();
  actions.push((await stat(eventsFile)).size === 0 ? "ready " + eventsFile : "kept " + eventsFile);
  return { target, observerDirectory, actions };
}

async function resolveObserverDirectory(targetPath) {
  if (targetPath) {
    const resolved = resolve(targetPath);
    const candidate = basename(resolved) === ".prompt-observer" ? resolved : join(resolved, ".prompt-observer");
    if (await exists(candidate)) return candidate;
    throw new Error("Prompt Observer is not initialized at " + resolved + ". Run init first.");
  }
  let current = resolve(".");
  while (true) {
    const candidate = join(current, ".prompt-observer");
    if (await exists(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("No .prompt-observer directory found from the current directory upward. Run init first.");
}

async function* streamEvents(eventsPath) {
  if (!(await exists(eventsPath))) return;
  const input = createReadStream(eventsPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim() === "") continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        throw new Error("Invalid JSON in " + eventsPath + " at line " + lineNumber + ": " + error.message);
      }
      const validationErrors = validateEvent(event);
      if (validationErrors.length > 0) {
        throw new Error("Invalid event in " + eventsPath + " at line " + lineNumber + ":\n- " + validationErrors.join("\n- "));
      }
      yield event;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function selectReportWindow(eventsPath, options = {}) {
  const all = options.all === true;
  const limit = options.limit ?? DEFAULT_REPORT_LIMIT;
  const retained = [];
  let totalEventCount = 0;
  for await (const event of streamEvents(eventsPath)) {
    totalEventCount += 1;
    retained.push(event);
    if (!all && retained.length > limit * 2) retained.shift();
  }
  if (all) return { current: retained, previous: [], totalEventCount };
  const currentStart = Math.max(0, retained.length - limit);
  const previousStart = Math.max(0, currentStart - limit);
  return {
    current: retained.slice(currentStart),
    previous: retained.slice(previousStart, currentStart),
    totalEventCount,
  };
}

function enrichEstimatedUsage(event) {
  if (event.schema_version !== "1.1" || event.usage.source !== "estimated" || event.usage.cost_usd !== null) return event;
  const calculated = calculateEstimatedCost(event.usage);
  if (calculated === null) return event;
  const enriched = structuredClone(event);
  enriched.usage.cost_usd = calculated;
  const marker = "pricing_snapshot:" + PRICING.updated_at;
  if (!enriched.usage.estimation_method.includes(marker)) {
    enriched.usage.estimation_method += "; " + marker;
  }
  return enriched;
}

export async function logEvent(eventFile, targetPath) {
  if (!eventFile) throw new Error("An event JSON file is required.");
  const eventPath = resolve(eventFile);
  let event;
  try {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  } catch (error) {
    throw new Error("Could not read event JSON from " + eventPath + ": " + error.message);
  }
  let validationErrors = validateEvent(event);
  if (validationErrors.length > 0) throw new Error("Event validation failed:\n- " + validationErrors.join("\n- "));
  event = enrichEstimatedUsage(event);
  validationErrors = validateEvent(event);
  if (validationErrors.length > 0) throw new Error("Enriched event validation failed:\n- " + validationErrors.join("\n- "));

  const observerDirectory = await resolveObserverDirectory(targetPath);
  const eventsPath = join(observerDirectory, "events.jsonl");
  for await (const existing of streamEvents(eventsPath)) {
    if (existing.event_id === event.event_id) {
      throw new Error("Event ID " + event.event_id + " already exists; refusing to create a duplicate.");
    }
  }
  await appendFile(eventsPath, JSON.stringify(event) + "\n", "utf8");
  return { eventId: event.event_id, eventsPath };
}

function average(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function eventHealth(event) {
  return average(SCORE_FIELDS.map((field) => event[field]));
}

function normalizeInsight(item) {
  return typeof item === "string" ? { category: "other", message: item } : item;
}

function normalizeEvent(event) {
  return {
    ...event,
    strengths: event.strengths.map(normalizeInsight),
    improvement_suggestions: event.improvement_suggestions.map(normalizeInsight),
  };
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function summarizeInsights(events, field) {
  const counts = new Map();
  const examples = [];
  const seen = new Set();
  for (const event of [...events].reverse()) {
    for (const insight of event[field]) {
      increment(counts, insight.category);
      const signature = insight.category + "\n" + insight.message.toLowerCase();
      if (examples.length < 5 && !seen.has(signature)) {
        seen.add(signature);
        examples.push({ category: insight.category, message: insight.message });
      }
    }
  }
  return { counts, examples };
}

function sortedCounts(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function analyzeEvents(inputEvents) {
  const events = inputEvents.map(normalizeEvent);
  const dimensions = new Map();
  for (const field of SCORE_FIELDS) dimensions.set(field, average(events.map((event) => event[field])));
  const riskCounts = new Map();
  const resultCounts = new Map();
  const testCounts = new Map();
  const severityCounts = new Map();
  const weaknessCounts = new Map();
  const weaknessExamples = [];
  const weaknessSeen = new Set();
  const usage = new Map();
  for (const source of USAGE_SOURCES) {
    usage.set(source, { events: 0, inputTokens: 0, outputTokens: 0, cost: 0, hasInput: false, hasOutput: false, hasCost: false });
  }
  let eventsWithTests = 0;
  for (const event of events) {
    increment(riskCounts, event.ambiguity_risk);
    increment(resultCounts, event.execution_signals.result_status);
    if (event.execution_signals.tests_run.length > 0) eventsWithTests += 1;
    for (const test of event.execution_signals.tests_run) increment(testCounts, test.status);
    for (const weakness of event.weaknesses) {
      increment(weaknessCounts, weakness.category);
      increment(severityCounts, weakness.severity);
    }
    const bucket = usage.get(event.usage.source);
    bucket.events += 1;
    if (event.usage.input_tokens !== null) {
      bucket.inputTokens += event.usage.input_tokens;
      bucket.hasInput = true;
    }
    if (event.usage.output_tokens !== null) {
      bucket.outputTokens += event.usage.output_tokens;
      bucket.hasOutput = true;
    }
    if (event.usage.cost_usd !== null) {
      bucket.cost += event.usage.cost_usd;
      bucket.hasCost = true;
    }
  }
  for (const event of [...events].reverse()) {
    for (const weakness of event.weaknesses) {
      const signature = weakness.category + "\n" + weakness.message.toLowerCase();
      if (weaknessExamples.length < 5 && !weaknessSeen.has(signature)) {
        weaknessSeen.add(signature);
        weaknessExamples.push(weakness);
      }
    }
  }
  const totalTests = [...testCounts.values()].reduce((sum, count) => sum + count, 0);
  const reportedOrEstimated = (usage.get("platform_reported")?.events ?? 0) + (usage.get("estimated")?.events ?? 0);
  return {
    events,
    count: events.length,
    overallAverage: average(events.map(eventHealth)),
    dimensions,
    riskCounts,
    resultCounts,
    testCounts,
    severityCounts,
    weaknessCounts,
    weaknessExamples,
    strengths: summarizeInsights(events, "strengths"),
    suggestions: summarizeInsights(events, "improvement_suggestions"),
    eventsWithTests,
    totalTests,
    usage,
    completionRate: events.length ? (resultCounts.get("completed") ?? 0) / events.length : 0,
    lowRiskRate: events.length ? (riskCounts.get("low") ?? 0) / events.length : 0,
    verificationCoverage: events.length ? eventsWithTests / events.length : 0,
    usageCoverage: events.length ? reportedOrEstimated / events.length : 0,
  };
}

function formatAverage(value) {
  return value === null ? "N/A" : value.toFixed(2);
}

function formatPercent(value) {
  return (value * 100).toFixed(0) + "%";
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function progressBar(value, max = 10) {
  if (value === null) return "N/A";
  const filled = Math.max(0, Math.min(10, Math.round((value / max) * 10)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function markdownText(value) {
  return String(value).replaceAll("|", "\\|").replace(/\r?\n/g, " ").trim();
}

function deltaLabel(current, previous) {
  if (current === null || previous === null) return "N/A";
  const delta = current - previous;
  if (Math.abs(delta) < 0.005) return "→ 0.00";
  return (delta > 0 ? "↑ +" : "↓ ") + delta.toFixed(2);
}

function countRows(map, order) {
  return order.map((key) => "| " + key + " | " + (map.get(key) ?? 0) + " |").join("\n");
}

function insightMarkdown(title, summary, emptyMessage) {
  const categories = sortedCounts(summary.counts);
  const categoryRows = categories.length
    ? categories.map(([category, count]) => "| " + category + " | " + count + " |").join("\n")
    : "| None | 0 |";
  const examples = summary.examples.length
    ? summary.examples.map((item) => "- **" + item.category + ":** " + markdownText(item.message)).join("\n")
    : "- " + emptyMessage;
  return "## " + title + "\n\n| Category | Count |\n| --- | ---: |\n" + categoryRows + "\n\n### Recent examples\n\n" + examples;
}

export function buildReport(inputEvents, options = {}) {
  const current = analyzeEvents(inputEvents);
  const previous = analyzeEvents(options.previousEvents ?? []);
  const totalEventCount = options.totalEventCount ?? current.count;
  const selectedLabel = options.all ? "all events" : "latest " + current.count + " events";
  const usageRows = ["platform_reported", "estimated", "unavailable"].map((source) => {
    const bucket = current.usage.get(source);
    return "| " + source + " | " + bucket.events + " | " +
      (bucket.hasInput ? formatNumber(bucket.inputTokens) : "N/A") + " | " +
      (bucket.hasOutput ? formatNumber(bucket.outputTokens) : "N/A") + " | " +
      (bucket.hasCost ? "$" + bucket.cost.toFixed(6) : "N/A") + " |";
  }).join("\n");
  const dimensionRows = SCORE_FIELDS.map((field) => {
    const value = current.dimensions.get(field);
    const prior = previous.dimensions.get(field);
    return "| " + field + " | " + progressBar(value) + " | " + formatAverage(value) + " | " + deltaLabel(value, prior) + " |";
  }).join("\n");
  const weaknessSummary = { counts: current.weaknessCounts, examples: current.weaknessExamples };
  const generatedAt = new Date().toISOString();
  return [
    "# Prompt Observer Report",
    "",
    "> Window: **" + selectedLabel + "** of " + totalEventCount + " stored events · Generated " + generatedAt,
    "",
    "## Health snapshot",
    "",
    "| Events | Prompt health | vs previous window | Completed | Low ambiguity | Verified tasks | Usage coverage |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    "| " + current.count + " | **" + formatAverage(current.overallAverage) + "/10** | " + deltaLabel(current.overallAverage, previous.overallAverage) + " | " + formatPercent(current.completionRate) + " | " + formatPercent(current.lowRiskRate) + " | " + formatPercent(current.verificationCoverage) + " | " + formatPercent(current.usageCoverage) + " |",
    "",
    "## Quality dimensions",
    "",
    "| Dimension | Health | Average | Trend |",
    "| --- | --- | ---: | ---: |",
    dimensionRows,
    "",
    insightMarkdown("Strengths", current.strengths, "No strengths recorded in this window."),
    "",
    insightMarkdown("Weaknesses", weaknessSummary, "No material weaknesses detected."),
    "",
    insightMarkdown("Improvement suggestions", current.suggestions, "No change needed."),
    "",
    "## Execution and verification",
    "",
    "| Result | Count |",
    "| --- | ---: |",
    countRows(current.resultCounts, ["completed", "partial", "blocked"]),
    "",
    "| Test status | Count |",
    "| --- | ---: |",
    countRows(current.testCounts, ["passed", "failed", "not_run", "unknown"]),
    "",
    "| Weakness severity | Count |",
    "| --- | ---: |",
    countRows(current.severityCounts, ["high", "medium", "low"]),
    "",
    "| Ambiguity risk | Count |",
    "| --- | ---: |",
    countRows(current.riskCounts, ["high", "medium", "low"]),
    "",
    "## Usage",
    "",
    "| Source | Events | Input tokens | Output tokens | Cost (USD) |",
    "| --- | ---: | ---: | ---: | ---: |",
    usageRows,
    "",
    "Usage coverage is " + formatPercent(current.usageCoverage) + ". Exact and estimated values are intentionally kept separate; unavailable values are never invented.",
    "",
    PRICING.updated_at
      ? "Estimated costs use pricing snapshot **" + PRICING.updated_at + "** ([source](" + PRICING.source_url + ")). Cached tokens, tools, subscriptions, discounts, and other provider charges are excluded."
      : "No pricing snapshot was available, so estimated costs were not calculated.",
    "",
  ].join("\n");
}

function dashboardApp(payload) {
  const scoreFields = payload.scoreFields;
  let range = payload.defaultRange;
  const filters = { task: "all", status: "all", risk: "all" };
  const byId = (id) => document.getElementById(id);
  const pct = (value) => Math.round(value * 100) + "%";
  const avg = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const health = (event) => avg(scoreFields.map((field) => event[field]));
  const number = (value) => new Intl.NumberFormat("en-US").format(value);
  const addOption = (select, value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  };
  const unique = (field) => [...new Set(payload.events.map(field))].sort();
  unique((event) => event.task_type).forEach((value) => addOption(byId("task-filter"), value));
  unique((event) => event.execution_signals.result_status).forEach((value) => addOption(byId("status-filter"), value));
  unique((event) => event.ambiguity_risk).forEach((value) => addOption(byId("risk-filter"), value));

  function selectedEvents() {
    return payload.events.slice(-range).filter((event) =>
      (filters.task === "all" || event.task_type === filters.task) &&
      (filters.status === "all" || event.execution_signals.result_status === filters.status) &&
      (filters.risk === "all" || event.ambiguity_risk === filters.risk)
    );
  }

  function setCard(id, value, note) {
    byId(id).querySelector(".value").textContent = value;
    byId(id).querySelector(".note").textContent = note;
  }

  function renderDimensions(events) {
    const container = byId("dimensions");
    container.replaceChildren();
    scoreFields.forEach((field) => {
      const value = avg(events.map((event) => event[field]));
      const row = document.createElement("div");
      row.className = "bar-row";
      const label = document.createElement("span");
      label.textContent = field;
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.width = (value === null ? 0 : value * 10) + "%";
      const score = document.createElement("strong");
      score.textContent = value === null ? "N/A" : value.toFixed(2);
      track.append(fill);
      row.append(label, track, score);
      container.append(row);
    });
  }

  function renderTrend(events) {
    const svg = byId("trend");
    svg.replaceChildren();
    const values = events.map(health);
    if (values.length < 2) {
      const message = document.createElementNS("http://www.w3.org/2000/svg", "text");
      message.setAttribute("x", "20");
      message.setAttribute("y", "55");
      message.textContent = values.length ? "Add another event to see a trend." : "No matching events.";
      svg.append(message);
      return;
    }
    const width = 600;
    const height = 120;
    const points = values.map((value, index) => {
      const x = 10 + index * (width - 20) / (values.length - 1);
      const y = height - 10 - value / 10 * (height - 20);
      return x + "," + y;
    }).join(" ");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", points);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#7c5cff");
    line.setAttribute("stroke-width", "4");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-linejoin", "round");
    svg.append(line);
  }

  function renderDistribution(id, values, order) {
    const container = byId(id);
    container.replaceChildren();
    const total = values.length;
    order.forEach((name) => {
      const count = values.filter((value) => value === name).length;
      const row = document.createElement("div");
      row.className = "bar-row";
      const label = document.createElement("span");
      label.textContent = name;
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.width = (total ? count / total * 100 : 0) + "%";
      const score = document.createElement("strong");
      score.textContent = String(count);
      track.append(fill);
      row.append(label, track, score);
      container.append(row);
    });
  }

  function insightItems(events, field, weakness) {
    const counts = new Map();
    const examples = [];
    const seen = new Set();
    [...events].reverse().forEach((event) => {
      event[field].forEach((raw) => {
        const item = typeof raw === "string" ? { category: "other", message: raw } : raw;
        counts.set(item.category, (counts.get(item.category) || 0) + 1);
        const key = item.category + "\n" + item.message.toLowerCase();
        if (examples.length < 5 && !seen.has(key)) {
          seen.add(key);
          examples.push({ ...item, severity: weakness ? item.severity : null });
        }
      });
    });
    return { counts: [...counts.entries()].sort((a, b) => b[1] - a[1]), examples };
  }

  function renderInsights(id, title, data, empty) {
    const root = byId(id);
    root.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "insight-heading";
    const name = document.createElement("h3");
    name.textContent = title;
    heading.append(name);
    data.counts.slice(0, 4).forEach(([category, count]) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = category + " · " + count;
      heading.append(chip);
    });
    root.append(heading);
    if (!data.examples.length) {
      const blank = document.createElement("p");
      blank.className = "empty";
      blank.textContent = empty;
      root.append(blank);
      return;
    }
    const list = document.createElement("ul");
    data.examples.forEach((item) => {
      const entry = document.createElement("li");
      const category = document.createElement("strong");
      category.textContent = item.category + ": ";
      entry.append(category, document.createTextNode(item.message));
      list.append(entry);
    });
    root.append(list);
  }

  function renderUsage(events) {
    const sources = ["platform_reported", "estimated", "unavailable"];
    const body = byId("usage-body");
    body.replaceChildren();
    sources.forEach((source) => {
      const matching = events.filter((event) => event.usage.source === source);
      const sum = (field) => matching.reduce((total, event) => total + (event.usage[field] ?? 0), 0);
      const has = (field) => matching.some((event) => event.usage[field] !== null);
      const row = document.createElement("tr");
      [source, matching.length, has("input_tokens") ? number(sum("input_tokens")) : "N/A", has("output_tokens") ? number(sum("output_tokens")) : "N/A", has("cost_usd") ? "$" + sum("cost_usd").toFixed(6) : "N/A"].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      });
      body.append(row);
    });
  }

  function render() {
    const events = selectedEvents();
    const healthValue = avg(events.map(health));
    const completed = events.filter((event) => event.execution_signals.result_status === "completed").length;
    const lowRisk = events.filter((event) => event.ambiguity_risk === "low").length;
    const verified = events.filter((event) => event.execution_signals.tests_run.length > 0).length;
    const covered = events.filter((event) => event.usage.source !== "unavailable").length;
    setCard("health-card", healthValue === null ? "N/A" : healthValue.toFixed(2), "out of 10");
    setCard("completion-card", events.length ? pct(completed / events.length) : "N/A", completed + " completed");
    setCard("ambiguity-card", events.length ? pct(lowRisk / events.length) : "N/A", lowRisk + " low-risk");
    setCard("verification-card", events.length ? pct(verified / events.length) : "N/A", verified + " with tests");
    setCard("usage-card", events.length ? pct(covered / events.length) : "N/A", covered + " exact or estimated");
    byId("event-count").textContent = events.length + " matching event" + (events.length === 1 ? "" : "s");
    renderDimensions(events);
    renderTrend(events);
    renderDistribution("outcomes", events.map((event) => event.execution_signals.result_status), ["completed", "partial", "blocked"]);
    renderDistribution("risks", events.map((event) => event.ambiguity_risk), ["low", "medium", "high"]);
    renderDistribution("tests", events.flatMap((event) => event.execution_signals.tests_run.map((test) => test.status)), ["passed", "failed", "not_run", "unknown"]);
    renderInsights("strengths", "Strengths", insightItems(events, "strengths", false), "No strengths recorded in this window.");
    renderInsights("weaknesses", "Weaknesses", insightItems(events, "weaknesses", true), "No material weaknesses detected.");
    renderInsights("suggestions", "Improvement suggestions", insightItems(events, "improvement_suggestions", false), "No change needed.");
    renderUsage(events);
    document.querySelectorAll("[data-range]").forEach((button) => button.classList.toggle("active", Number(button.dataset.range) === range));
  }

  document.querySelectorAll("[data-range]").forEach((button) => button.addEventListener("click", () => {
    range = Number(button.dataset.range);
    render();
  }));
  [["task-filter", "task"], ["status-filter", "status"], ["risk-filter", "risk"]].forEach(([id, key]) => {
    byId(id).addEventListener("change", (event) => {
      filters[key] = event.target.value;
      render();
    });
  });
  render();
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function buildHtmlReport(inputEvents, options = {}) {
  const events = inputEvents.map(normalizeEvent).map((event) => ({
    timestamp: event.timestamp,
    task_type: event.task_type,
    ambiguity_risk: event.ambiguity_risk,
    ...Object.fromEntries(SCORE_FIELDS.map((field) => [field, event[field]])),
    strengths: event.strengths,
    weaknesses: event.weaknesses,
    improvement_suggestions: event.improvement_suggestions,
    execution_signals: {
      result_status: event.execution_signals.result_status,
      tests_run: event.execution_signals.tests_run.map((test) => ({ status: test.status })),
    },
    usage: event.usage,
  }));
  const defaultRange = options.all ? events.length : 50;
  const payload = JSON.stringify({ events, scoreFields: SCORE_FIELDS, defaultRange }).replaceAll("<", "\\u003c");
  const generatedAt = new Date().toISOString();
  const totalEventCount = options.totalEventCount ?? events.length;
  const windowLabel = options.all ? "All events" : "Latest " + events.length + " events";
  const styles = [
    ":root{color-scheme:dark;--bg:#0b1020;--panel:#141a2e;--panel2:#1b2340;--text:#eef1ff;--muted:#9ca8c7;--accent:#7c5cff;--accent2:#36d1a0;--danger:#ff6b82;--border:#293251}",
    "*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#24205a 0,transparent 35%),var(--bg);color:var(--text);font:14px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}",
    "main{max-width:1180px;margin:auto;padding:44px 24px 80px}header{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:28px}h1{font-size:34px;margin:0 0 6px}h2,h3{margin:0}.sub,.note,.empty{color:var(--muted)}",
    ".toolbar{display:flex;flex-wrap:wrap;gap:10px;padding:14px;background:rgba(20,26,46,.85);border:1px solid var(--border);border-radius:16px;margin-bottom:18px;position:sticky;top:10px;z-index:3;backdrop-filter:blur(12px)}",
    "button,select{background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:9px;padding:8px 11px}button{cursor:pointer}button.active{background:var(--accent);border-color:var(--accent)}",
    ".cards{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin:18px 0}.card,.panel,.insight{background:linear-gradient(145deg,rgba(27,35,64,.95),rgba(20,26,46,.95));border:1px solid var(--border);border-radius:18px;padding:20px;box-shadow:0 14px 45px rgba(0,0,0,.18)}",
    ".card .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.card .value{font-size:28px;font-weight:750;margin:8px 0 2px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.panel h2{font-size:18px;margin-bottom:18px}",
    ".bar-row{display:grid;grid-template-columns:165px 1fr 42px;gap:12px;align-items:center;margin:12px 0}.bar-track{height:9px;background:#252d4c;border-radius:9px;overflow:hidden}.bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:9px}",
    "#trend{width:100%;height:140px;background:rgba(8,12,27,.35);border-radius:12px}#trend text{fill:var(--muted);font-size:13px}.insights{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:16px}.insight-heading{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-bottom:14px}.insight-heading h3{width:100%;font-size:18px}.chip{font-size:11px;background:#282f53;color:#cbd2ef;padding:4px 7px;border-radius:20px}",
    "ul{padding-left:20px;margin:8px 0}li{margin:9px 0;color:#dbe0f5}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--border)}th{color:var(--muted);font-size:12px;text-transform:uppercase}.usage{margin-top:16px}.footnote{margin-top:12px;color:var(--muted);font-size:12px}",
    "@media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}.grid,.insights{grid-template-columns:1fr}header{display:block}.bar-row{grid-template-columns:130px 1fr 38px}}@media(max-width:520px){main{padding:24px 14px}.cards{grid-template-columns:1fr}.toolbar{position:static}}",
  ].join("");
  return [
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<title>Prompt Observer Report</title><style>" + styles + "</style></head><body><main>",
    "<header><div><h1>Prompt Observer</h1><div class=\"sub\">" + escapeHtml(windowLabel) + " of " + totalEventCount + " stored · " + escapeHtml(generatedAt) + "</div></div><strong id=\"event-count\"></strong></header>",
    "<section class=\"toolbar\"><button data-range=\"10\">Last 10</button><button data-range=\"25\">Last 25</button><button data-range=\"50\">Last 50</button>" + (options.all ? "<button data-range=\"" + events.length + "\" class=\"active\">All loaded</button>" : "") + "<select id=\"task-filter\"><option value=\"all\">All task types</option></select><select id=\"status-filter\"><option value=\"all\">All outcomes</option></select><select id=\"risk-filter\"><option value=\"all\">All ambiguity levels</option></select></section>",
    "<section class=\"cards\"><article class=\"card\" id=\"health-card\"><div class=\"label\">Prompt health</div><div class=\"value\"></div><div class=\"note\"></div></article><article class=\"card\" id=\"completion-card\"><div class=\"label\">Completion</div><div class=\"value\"></div><div class=\"note\"></div></article><article class=\"card\" id=\"ambiguity-card\"><div class=\"label\">Low ambiguity</div><div class=\"value\"></div><div class=\"note\"></div></article><article class=\"card\" id=\"verification-card\"><div class=\"label\">Verification</div><div class=\"value\"></div><div class=\"note\"></div></article><article class=\"card\" id=\"usage-card\"><div class=\"label\">Usage coverage</div><div class=\"value\"></div><div class=\"note\"></div></article></section>",
    "<section class=\"grid\"><article class=\"panel\"><h2>Quality dimensions</h2><div id=\"dimensions\"></div></article><article class=\"panel\"><h2>Prompt-health trend</h2><svg id=\"trend\" viewBox=\"0 0 600 120\" preserveAspectRatio=\"none\"></svg></article></section>",
    "<section class=\"grid usage\"><article class=\"panel\"><h2>Execution outcomes</h2><div id=\"outcomes\"></div><h2>Ambiguity risk</h2><div id=\"risks\"></div></article><article class=\"panel\"><h2>Verification results</h2><div id=\"tests\"></div></article></section>",
    "<section class=\"insights\"><article class=\"insight\" id=\"strengths\"></article><article class=\"insight\" id=\"weaknesses\"></article><article class=\"insight\" id=\"suggestions\"></article></section>",
    "<section class=\"panel usage\"><h2>Usage by source</h2><table><thead><tr><th>Source</th><th>Events</th><th>Input tokens</th><th>Output tokens</th><th>Cost</th></tr></thead><tbody id=\"usage-body\"></tbody></table><p class=\"footnote\">Exact and estimated values are separated. Estimated costs use pricing snapshot " + escapeHtml(PRICING.updated_at ?? "unavailable") + " and exclude cached tokens, tools, subscriptions, discounts, and provider-specific charges.</p></section>",
    "</main><script>const reportData=" + payload + ";(" + dashboardApp.toString() + ")(reportData);</script></body></html>",
  ].join("");
}

export async function generateReport(targetPath, options = {}) {
  const observerDirectory = await resolveObserverDirectory(targetPath ?? ".");
  const eventsPath = join(observerDirectory, "events.jsonl");
  const selected = await selectReportWindow(eventsPath, options);
  const report = buildReport(selected.current, {
    previousEvents: selected.previous,
    totalEventCount: selected.totalEventCount,
    all: options.all,
  });
  const html = buildHtmlReport(selected.current, {
    totalEventCount: selected.totalEventCount,
    all: options.all,
  });
  const reportPath = join(observerDirectory, "report.md");
  const htmlPath = join(observerDirectory, "report.html");
  await Promise.all([writeFile(reportPath, report, "utf8"), writeFile(htmlPath, html, "utf8")]);
  return {
    eventCount: selected.current.length,
    totalEventCount: selected.totalEventCount,
    reportPath,
    htmlPath,
    report,
    html,
  };
}

function printHelp() {
  process.stdout.write([
    "Prompt Observer " + SCHEMA_VERSION,
    "",
    "Usage:",
    "  prompt-observer init <target-path>",
    "  prompt-observer log <event-file> [--target <target-path>]",
    "  prompt-observer report [target-path] [--limit <count> | --all]",
    "  prompt-observer validate <event-file>",
    "  prompt-observer help",
    "",
  ].join("\n"));
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(name + " requires a value.");
  return args[index + 1];
}

function positionalArgs(args, optionsWithValues = []) {
  const positions = [];
  for (let index = 0; index < args.length; index += 1) {
    if (optionsWithValues.includes(args[index])) {
      index += 1;
    } else if (!args[index].startsWith("--")) {
      positions.push(args[index]);
    }
  }
  return positions;
}

export async function runCli(args) {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "init") {
    const result = await initProject(rest[0] ?? ".");
    process.stdout.write("Initialized Prompt Observer at " + result.observerDirectory + "\n" + result.actions.join("\n") + "\n");
    return;
  }
  if (command === "validate") {
    if (!rest[0]) throw new Error("validate requires an event JSON file.");
    const event = JSON.parse(await readFile(resolve(rest[0]), "utf8"));
    const errors = validateEvent(event);
    if (errors.length > 0) throw new Error("Event validation failed:\n- " + errors.join("\n- "));
    process.stdout.write("Valid event: " + event.event_id + "\n");
    return;
  }
  if (command === "log") {
    const target = optionValue(rest, "--target");
    const positions = positionalArgs(rest, ["--target"]);
    const result = await logEvent(positions[0], target);
    process.stdout.write("Logged " + result.eventId + " to " + result.eventsPath + "\n");
    return;
  }
  if (command === "report") {
    const all = rest.includes("--all");
    const rawLimit = optionValue(rest, "--limit");
    if (all && rawLimit !== undefined) throw new Error("--all and --limit cannot be used together.");
    const limit = rawLimit === undefined ? DEFAULT_REPORT_LIMIT : Number(rawLimit);
    if (!all && (!Number.isInteger(limit) || limit < 1 || limit > 100000)) {
      throw new Error("--limit must be an integer from 1 to 100000.");
    }
    const positions = positionalArgs(rest, ["--limit"]);
    const result = await generateReport(positions[0] ?? ".", { all, limit });
    process.stdout.write("Generated " + result.reportPath + " and " + result.htmlPath + " from " + result.eventCount + " of " + result.totalEventCount + " event(s).\n");
    return;
  }
  throw new Error("Unknown command: " + command);
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write("Error: " + error.message + "\n");
    process.exitCode = 1;
  });
}
