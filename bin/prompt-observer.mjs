#!/usr/bin/env node

import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = "1.0";
const SCORE_FIELDS = [
  "intent_clarity",
  "context_sufficiency",
  "scope_definition",
  "constraints_quality",
  "acceptance_criteria",
  "verification_plan",
];
const TASK_TYPES = new Set([
  "coding",
  "debugging",
  "planning",
  "review",
  "testing",
  "documentation",
  "refactoring",
  "other",
]);
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
  "schema_version",
  "event_id",
  "timestamp",
  "task_type",
  "prompt_summary",
  ...SCORE_FIELDS,
  "ambiguity_risk",
  "strengths",
  "weaknesses",
  "improvement_suggestions",
  "execution_signals",
  "usage",
]);
const BANNED_KEYS = new Set([
  "prompt",
  "raw_prompt",
  "full_prompt",
  "user_prompt",
  "response",
  "raw_response",
  "full_response",
  "assistant_response",
  "reasoning",
  "chain_of_thought",
  "system_prompt",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addUnknownKeyErrors(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
}

function validateShortText(value, path, errors, { max = 500 } = {}) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
  } else if (value.length > max) {
    errors.push(`${path} must be at most ${max} characters`);
  }
}

function validateTextArray(value, path, errors, maxItems = 10) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (value.length > maxItems) errors.push(`${path} must contain at most ${maxItems} items`);
  value.forEach((item, index) => validateShortText(item, `${path}[${index}]`, errors));
}

function findBannedKeys(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findBannedKeys(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (BANNED_KEYS.has(normalized)) {
      errors.push(`${path}.${key} is prohibited because raw prompt, response, or private reasoning must not be stored`);
    }
    findBannedKeys(child, `${path}.${key}`, errors);
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
    if (pattern.test(serialized)) errors.push(`event appears to contain ${label}; redact it before logging`);
  }
}

export function validateEvent(event) {
  const errors = [];
  if (!isObject(event)) return ["event must be a JSON object"];

  addUnknownKeyErrors(event, ROOT_KEYS, "$", errors);
  findBannedKeys(event, "$", errors);
  findLikelySecrets(event, errors);

  for (const key of ROOT_KEYS) {
    if (!(key in event)) errors.push(`$.${key} is required`);
  }
  if (errors.some((error) => error.endsWith(" is required"))) return errors;

  if (event.schema_version !== SCHEMA_VERSION) {
    errors.push(`$.schema_version must equal ${SCHEMA_VERSION}`);
  }
  if (
    typeof event.event_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(event.event_id)
  ) {
    errors.push("$.event_id must be 8-128 safe identifier characters");
  }
  if (
    typeof event.timestamp !== "string" ||
    !event.timestamp.includes("T") ||
    Number.isNaN(Date.parse(event.timestamp))
  ) {
    errors.push("$.timestamp must be a valid ISO-8601 date-time");
  }
  if (!TASK_TYPES.has(event.task_type)) errors.push("$.task_type is invalid");
  validateShortText(event.prompt_summary, "$.prompt_summary", errors);

  for (const field of SCORE_FIELDS) {
    if (!Number.isInteger(event[field]) || event[field] < 0 || event[field] > 10) {
      errors.push(`$.${field} must be an integer from 0 to 10`);
    }
  }
  if (!RISK_LEVELS.has(event.ambiguity_risk)) errors.push("$.ambiguity_risk is invalid");
  validateTextArray(event.strengths, "$.strengths", errors);
  validateTextArray(event.improvement_suggestions, "$.improvement_suggestions", errors);

  if (!Array.isArray(event.weaknesses)) {
    errors.push("$.weaknesses must be an array");
  } else {
    if (event.weaknesses.length > 10) errors.push("$.weaknesses must contain at most 10 items");
    event.weaknesses.forEach((weakness, index) => {
      const path = `$.weaknesses[${index}]`;
      if (!isObject(weakness)) {
        errors.push(`${path} must be an object`);
        return;
      }
      addUnknownKeyErrors(weakness, new Set(["category", "severity", "message"]), path, errors);
      if (!WEAKNESS_CATEGORIES.has(weakness.category)) errors.push(`${path}.category is invalid`);
      if (!SEVERITIES.has(weakness.severity)) errors.push(`${path}.severity is invalid`);
      validateShortText(weakness.message, `${path}.message`, errors);
    });
  }

  const signals = event.execution_signals;
  if (!isObject(signals)) {
    errors.push("$.execution_signals must be an object");
  } else {
    addUnknownKeyErrors(signals, new Set(["result_status", "files_changed", "tests_run"]), "$.execution_signals", errors);
    if (!RESULT_STATUSES.has(signals.result_status)) {
      errors.push("$.execution_signals.result_status is invalid");
    }
    validateTextArray(signals.files_changed, "$.execution_signals.files_changed", errors, 500);
    if (!Array.isArray(signals.tests_run)) {
      errors.push("$.execution_signals.tests_run must be an array");
    } else {
      if (signals.tests_run.length > 100) {
        errors.push("$.execution_signals.tests_run must contain at most 100 items");
      }
      signals.tests_run.forEach((test, index) => {
        const path = `$.execution_signals.tests_run[${index}]`;
        if (!isObject(test)) {
          errors.push(`${path} must be an object`);
          return;
        }
        addUnknownKeyErrors(test, new Set(["name", "status"]), path, errors);
        validateShortText(test.name, `${path}.name`, errors);
        if (!TEST_STATUSES.has(test.status)) errors.push(`${path}.status is invalid`);
      });
    }
  }

  const usage = event.usage;
  if (!isObject(usage)) {
    errors.push("$.usage must be an object");
  } else {
    const usageKeys = new Set([
      "model",
      "input_tokens",
      "output_tokens",
      "cost_usd",
      "source",
      "estimation_method",
    ]);
    addUnknownKeyErrors(usage, usageKeys, "$.usage", errors);
    for (const key of usageKeys) {
      if (!(key in usage)) errors.push(`$.usage.${key} is required`);
    }
    if (usage.model !== null && (typeof usage.model !== "string" || usage.model.length > 200)) {
      errors.push("$.usage.model must be null or a string up to 200 characters");
    }
    for (const field of ["input_tokens", "output_tokens"]) {
      if (usage[field] !== null && (!Number.isInteger(usage[field]) || usage[field] < 0)) {
        errors.push(`$.usage.${field} must be null or a non-negative integer`);
      }
    }
    if (usage.cost_usd !== null && (typeof usage.cost_usd !== "number" || usage.cost_usd < 0)) {
      errors.push("$.usage.cost_usd must be null or a non-negative number");
    }
    if (!USAGE_SOURCES.has(usage.source)) errors.push("$.usage.source is invalid");
    if (
      usage.estimation_method !== null &&
      (typeof usage.estimation_method !== "string" || usage.estimation_method.trim() === "" || usage.estimation_method.length > 300)
    ) {
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

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function findResourceRoot() {
  const selfDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(selfDirectory, ".."), selfDirectory];
  for (const candidate of candidates) {
    const contract = join(candidate, "PROMPT_OBSERVER.md");
    const schema = (await exists(join(candidate, "schema", "event.schema.json")))
      ? join(candidate, "schema", "event.schema.json")
      : join(candidate, "event.schema.json");
    if ((await exists(contract)) && (await exists(schema))) {
      return { root: candidate, contract, schema };
    }
  }
  throw new Error("Could not locate PROMPT_OBSERVER.md and event.schema.json next to the CLI.");
}

async function copyUnlessPresent(source, destination, actions) {
  if (await exists(destination)) {
    actions.push(`kept ${destination}`);
    return;
  }
  await copyFile(source, destination);
  actions.push(`created ${destination}`);
}

async function writeUnlessPresent(destination, content, actions) {
  if (await exists(destination)) {
    actions.push(`kept ${destination}`);
    return;
  }
  await writeFile(destination, content, "utf8");
  actions.push(`created ${destination}`);
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
  await copyUnlessPresent(selfPath, join(observerDirectory, "prompt-observer.mjs"), actions);
  await writeUnlessPresent(
    join(observerDirectory, ".gitignore"),
    ["events.jsonl", "report.md", "pending/", "*.tmp", ""].join("\n"),
    actions,
  );
  const eventsFile = join(observerDirectory, "events.jsonl");
  const file = await open(eventsFile, "a");
  await file.close();
  actions.push((await stat(eventsFile)).size === 0 ? `ready ${eventsFile}` : `kept ${eventsFile}`);

  return { target, observerDirectory, actions };
}

async function resolveObserverDirectory(targetPath) {
  if (targetPath) {
    const resolved = resolve(targetPath);
    const candidate = basename(resolved) === ".prompt-observer" ? resolved : join(resolved, ".prompt-observer");
    if (await exists(candidate)) return candidate;
    throw new Error(`Prompt Observer is not initialized at ${resolved}. Run init first.`);
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

async function readEvents(eventsPath) {
  if (!(await exists(eventsPath))) return [];
  const contents = await readFile(eventsPath, "utf8");
  const events = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON in ${eventsPath} at line ${index + 1}: ${error.message}`);
    }
    const validationErrors = validateEvent(event);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid event in ${eventsPath} at line ${index + 1}:\n- ${validationErrors.join("\n- ")}`);
    }
    events.push(event);
  }
  return events;
}

export async function logEvent(eventFile, targetPath) {
  if (!eventFile) throw new Error("An event JSON file is required.");
  const eventPath = resolve(eventFile);
  let event;
  try {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read event JSON from ${eventPath}: ${error.message}`);
  }

  const validationErrors = validateEvent(event);
  if (validationErrors.length > 0) {
    throw new Error(`Event validation failed:\n- ${validationErrors.join("\n- ")}`);
  }

  const observerDirectory = await resolveObserverDirectory(targetPath);
  const eventsPath = join(observerDirectory, "events.jsonl");
  const existingEvents = await readEvents(eventsPath);
  if (existingEvents.some((item) => item.event_id === event.event_id)) {
    throw new Error(`Event ID ${event.event_id} already exists; refusing to create a duplicate.`);
  }
  await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  return { eventId: event.event_id, eventsPath };
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatAverage(value) {
  return value === null ? "N/A" : value.toFixed(2);
}

function tableRows(counts, preferredOrder) {
  return preferredOrder.map((key) => `| ${key} | ${counts.get(key) ?? 0} |`).join("\n");
}

export function buildReport(events) {
  const dimensionAverages = new Map();
  for (const field of SCORE_FIELDS) {
    dimensionAverages.set(field, average(events.map((event) => event[field])));
  }
  const overallScores = events.map((event) => average(SCORE_FIELDS.map((field) => event[field])));
  const overallAverage = average(overallScores.filter((value) => value !== null));

  const weaknessCounts = new Map();
  const severityCounts = new Map();
  const riskCounts = new Map();
  const resultCounts = new Map();
  const testCounts = new Map();
  let eventsWithTests = 0;
  let unavailableUsage = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let hasInputTokens = false;
  let hasOutputTokens = false;
  let hasCost = false;

  for (const event of events) {
    riskCounts.set(event.ambiguity_risk, (riskCounts.get(event.ambiguity_risk) ?? 0) + 1);
    const status = event.execution_signals.result_status;
    resultCounts.set(status, (resultCounts.get(status) ?? 0) + 1);
    if (event.execution_signals.tests_run.length > 0) eventsWithTests += 1;
    for (const test of event.execution_signals.tests_run) {
      testCounts.set(test.status, (testCounts.get(test.status) ?? 0) + 1);
    }
    for (const weakness of event.weaknesses) {
      weaknessCounts.set(weakness.category, (weaknessCounts.get(weakness.category) ?? 0) + 1);
      severityCounts.set(weakness.severity, (severityCounts.get(weakness.severity) ?? 0) + 1);
    }
    if (event.usage.source === "unavailable") unavailableUsage += 1;
    if (event.usage.input_tokens !== null) {
      totalInputTokens += event.usage.input_tokens;
      hasInputTokens = true;
    }
    if (event.usage.output_tokens !== null) {
      totalOutputTokens += event.usage.output_tokens;
      hasOutputTokens = true;
    }
    if (event.usage.cost_usd !== null) {
      totalCost += event.usage.cost_usd;
      hasCost = true;
    }
  }

  const topWeaknesses = [...weaknessCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, count]) => `| ${category} | ${count} |`)
    .join("\n");
  const generatedAt = new Date().toISOString();

  return `# Prompt Observer Report

Generated: ${generatedAt}

## Overview

- Events: ${events.length}
- Average prompt health: ${formatAverage(overallAverage)}/10
- Events with tests: ${eventsWithTests}
- Events with unavailable usage: ${unavailableUsage}

## Quality dimensions

| Dimension | Average |
| --- | ---: |
${SCORE_FIELDS.map((field) => `| ${field} | ${formatAverage(dimensionAverages.get(field))} |`).join("\n")}

## Weaknesses

| Category | Count |
| --- | ---: |
${topWeaknesses || "| None recorded | 0 |"}

### Severity

| Severity | Count |
| --- | ---: |
${tableRows(severityCounts, ["high", "medium", "low"])}

## Ambiguity risk

| Risk | Count |
| --- | ---: |
${tableRows(riskCounts, ["high", "medium", "low"])}

## Execution outcomes

| Status | Count |
| --- | ---: |
${tableRows(resultCounts, ["completed", "partial", "blocked"])}

## Verification

| Test status | Count |
| --- | ---: |
${tableRows(testCounts, ["passed", "failed", "not_run", "unknown"])}

## Reported usage

- Input tokens: ${hasInputTokens ? totalInputTokens : "N/A"}
- Output tokens: ${hasOutputTokens ? totalOutputTokens : "N/A"}
- Cost (USD): ${hasCost ? totalCost.toFixed(6) : "N/A"}
`;
}

export async function generateReport(targetPath) {
  const observerDirectory = await resolveObserverDirectory(targetPath ?? ".");
  const eventsPath = join(observerDirectory, "events.jsonl");
  const events = await readEvents(eventsPath);
  const report = buildReport(events);
  const reportPath = join(observerDirectory, "report.md");
  await writeFile(reportPath, report, "utf8");
  return { eventCount: events.length, reportPath, report };
}

function printHelp() {
  process.stdout.write(`Prompt Observer ${SCHEMA_VERSION}

Usage:
  prompt-observer init <target-path>
  prompt-observer log <event-file> [--target <target-path>]
  prompt-observer report [target-path]
  prompt-observer validate <event-file>
  prompt-observer help
`);
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1]) throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

export async function runCli(args) {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "init") {
    const result = await initProject(rest[0] ?? ".");
    process.stdout.write(`Initialized Prompt Observer at ${result.observerDirectory}\n${result.actions.join("\n")}\n`);
    return;
  }
  if (command === "validate") {
    if (!rest[0]) throw new Error("validate requires an event JSON file.");
    const event = JSON.parse(await readFile(resolve(rest[0]), "utf8"));
    const errors = validateEvent(event);
    if (errors.length > 0) throw new Error(`Event validation failed:\n- ${errors.join("\n- ")}`);
    process.stdout.write(`Valid event: ${event.event_id}\n`);
    return;
  }
  if (command === "log") {
    const target = optionValue(rest, "--target");
    const result = await logEvent(rest[0], target);
    process.stdout.write(`Logged ${result.eventId} to ${result.eventsPath}\n`);
    return;
  }
  if (command === "report") {
    const result = await generateReport(rest[0] ?? ".");
    process.stdout.write(`Generated ${result.reportPath} from ${result.eventCount} event(s).\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectExecution) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
