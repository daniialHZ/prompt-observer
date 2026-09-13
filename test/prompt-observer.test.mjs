import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildHtmlReport,
  buildReport,
  calculateEstimatedCost,
  estimateTextTokens,
  generateReport,
  initProject,
  logEvent,
  upgradeProject,
  validateEvent,
} from "../bin/prompt-observer.mjs";

function validEvent(overrides = {}) {
  return {
    schema_version: "1.1",
    event_id: "evt-test-00000001",
    timestamp: "2026-09-01T12:00:00.000Z",
    task_type: "coding",
    prompt_summary: "Implement structured prompt observation for a coding workflow.",
    intent_clarity: 9,
    context_sufficiency: 8,
    scope_definition: 8,
    constraints_quality: 9,
    acceptance_criteria: 7,
    verification_plan: 6,
    ambiguity_risk: "low",
    strengths: [{ category: "intent_clarity", message: "The intended outcome is clear." }],
    weaknesses: [],
    improvement_suggestions: [],
    execution_signals: {
      result_status: "completed",
      files_changed: ["README.md"],
      tests_run: [{ name: "node --test", status: "passed" }],
    },
    usage: {
      model: null,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      source: "unavailable",
      estimation_method: null,
    },
    ...overrides,
  };
}

function legacyEvent(overrides = {}) {
  return validEvent({
    schema_version: "1.0",
    strengths: ["The intended outcome is clear."],
    improvement_suggestions: [],
    ...overrides,
  });
}

test("accepts both structured 1.1 and legacy 1.0 events", () => {
  assert.deepEqual(validateEvent(validEvent()), []);
  assert.deepEqual(validateEvent(legacyEvent()), []);
});

test("enforces each schema version's insight shape", () => {
  const legacyWithObject = legacyEvent({
    strengths: [{ category: "intent_clarity", message: "Clear request." }],
  });
  assert.ok(validateEvent(legacyWithObject).some((error) => error.includes("must be a non-empty string")));
  const structuredWithString = validEvent({ strengths: ["Clear request."] });
  assert.ok(validateEvent(structuredWithString).some((error) => error.includes("must be an object")));
});

test("accepts a strong prompt without forced weaknesses or suggestions", () => {
  const event = validEvent({
    intent_clarity: 10,
    context_sufficiency: 10,
    scope_definition: 10,
    constraints_quality: 10,
    acceptance_criteria: 10,
    verification_plan: 10,
    weaknesses: [],
    improvement_suggestions: [],
  });
  assert.deepEqual(validateEvent(event), []);
});

test("rejects missing, unknown, raw-content, and secret fields", () => {
  const event = validEvent({ prompt: "full user prompt" });
  delete event.intent_clarity;
  const errors = validateEvent(event);
  assert.ok(errors.some((error) => error.includes("$.prompt is not allowed")));
  assert.ok(errors.some((error) => error.includes("$.prompt is prohibited")));
  assert.ok(errors.some((error) => error.includes("$.intent_clarity is required")));
  const secret = validEvent({
    prompt_summary: "Configure credential sk-abcdefghijklmnopqrstuvwxyz123456 for the workflow.",
  });
  assert.ok(validateEvent(secret).some((error) => error.includes("API key")));
});

test("estimates multilingual text deterministically", () => {
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("سلام"), 2);
  assert.equal(estimateTextTokens(""), 0);
});

test("validates usage provenance and versioned estimated cost", () => {
  const unavailableWithTokens = validEvent({
    usage: {
      model: null,
      input_tokens: 100,
      output_tokens: null,
      cost_usd: null,
      source: "unavailable",
      estimation_method: null,
    },
  });
  assert.ok(validateEvent(unavailableWithTokens).some((error) => error.includes("must all be null")));
  const estimateWithoutMethod = validEvent({
    usage: {
      model: null,
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: null,
      source: "estimated",
      estimation_method: null,
    },
  });
  assert.ok(validateEvent(estimateWithoutMethod).some((error) => error.includes("is required when source is estimated")));
  const usage = {
    model: "gpt-5.6-luna",
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 0.0008,
    source: "estimated",
    estimation_method: "agent_text_heuristic_v1; pricing_snapshot:2026-09-13",
  };
  assert.equal(calculateEstimatedCost(usage), 0.0008);
  assert.deepEqual(validateEvent(validEvent({ usage })), []);
  const unknownModel = { ...usage, model: "unknown-model" };
  assert.ok(validateEvent(validEvent({ usage: unknownModel })).some((error) => error.includes("exact model match")));
  const wrongCost = { ...usage, cost_usd: 1 };
  assert.ok(validateEvent(validEvent({ usage: wrongCost })).some((error) => error.includes("does not match")));
});

test("initializes a portable project with dashboard and pricing resources", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "prompt-observer-init-"));
  const first = await initProject(workspace);
  const observer = first.observerDirectory;
  assert.match(await readFile(join(observer, "PROMPT_OBSERVER.md"), "utf8"), /No-filesystem fallback/);
  assert.match(await readFile(join(observer, "event.schema.json"), "utf8"), /structured 1\.1/);
  assert.match(await readFile(join(observer, "pricing.json"), "utf8"), /gpt-5\.6-luna/);
  assert.match(await readFile(join(observer, "prompt-observer.mjs"), "utf8"), /buildHtmlReport/);
  assert.match(await readFile(join(observer, ".gitignore"), "utf8"), /report\.html/);
  await writeFile(join(observer, "PROMPT_OBSERVER.md"), "custom contract", "utf8");
  await initProject(workspace);
  assert.equal(await readFile(join(observer, "PROMPT_OBSERVER.md"), "utf8"), "custom contract");
});

test("upgrades managed files with one command while preserving events and backing up a custom contract", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "prompt-observer-upgrade-"));
  const initialized = await initProject(workspace);
  const observer = initialized.observerDirectory;
  const eventsPath = join(observer, "events.jsonl");
  await writeFile(eventsPath, "preserve-this-event-log\n", "utf8");
  await writeFile(join(observer, "PROMPT_OBSERVER.md"), "custom project contract", "utf8");
  await writeFile(join(observer, "event.schema.json"), "{\"old\":true}", "utf8");
  await writeFile(join(observer, "pricing.json"), "{\"old\":true}", "utf8");
  await writeFile(join(observer, "prompt-observer.mjs"), "// old runtime", "utf8");

  const result = await upgradeProject(workspace);
  assert.ok(result.actions.some((action) => action.includes("backed up custom contract")));
  assert.equal(await readFile(eventsPath, "utf8"), "preserve-this-event-log\n");
  assert.match(await readFile(join(observer, "PROMPT_OBSERVER.md"), "utf8"), /schema `1\.1`/);
  assert.match(await readFile(join(observer, "event.schema.json"), "utf8"), /structured 1\.1/);
  assert.match(await readFile(join(observer, "pricing.json"), "utf8"), /gpt-5\.6-luna/);
  assert.match(await readFile(join(observer, "prompt-observer.mjs"), "utf8"), /upgradeProject/);
  assert.match(await readFile(join(observer, ".gitignore"), "utf8"), /backups\//);
  const backupFolders = await readdir(join(observer, "backups"));
  assert.equal(backupFolders.length, 1);
  assert.equal(
    await readFile(join(observer, "backups", backupFolders[0], "PROMPT_OBSERVER.md"), "utf8"),
    "custom project contract",
  );
});

test("logs events, enriches model-matched estimated cost, and rejects duplicates", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "prompt-observer-log-"));
  await initProject(workspace);
  const eventPath = join(workspace, "event.json");
  const usage = {
    model: "gpt-5.6-luna",
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: null,
    source: "estimated",
    estimation_method: "agent_text_heuristic_v1",
  };
  await writeFile(eventPath, JSON.stringify(validEvent({ usage })), "utf8");
  await logEvent(eventPath, workspace);
  const loggedText = await readFile(join(workspace, ".prompt-observer", "events.jsonl"), "utf8");
  const logged = JSON.parse(loggedText.trim());
  assert.equal(logged.usage.cost_usd, 0.0008);
  assert.match(logged.usage.estimation_method, /pricing_snapshot:2026-09-13/);
  await assert.rejects(() => logEvent(eventPath, workspace), /already exists/);
});

test("renders bounded strengths, weaknesses, suggestions, trends, and separated usage", () => {
  const first = validEvent({
    strengths: [{ category: "constraints_quality", message: "The runtime constraint is explicit." }],
    weaknesses: [{
      category: "missing_verification",
      severity: "medium",
      message: "The exact verification command is not specified.",
    }],
    improvement_suggestions: [{
      category: "verification_plan",
      message: "Name the command that must pass.",
    }],
    usage: {
      model: "gpt-5.6-luna",
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.0008,
      source: "estimated",
      estimation_method: "agent_text_heuristic_v1; pricing_snapshot:2026-09-13",
    },
  });
  const second = validEvent({
    event_id: "evt-test-00000002",
    intent_clarity: 5,
    ambiguity_risk: "high",
    weaknesses: [
      { category: "missing_verification", severity: "high", message: "No verification expectation was provided." },
      { category: "undefined_scope", severity: "medium", message: "The affected modules were not identified." },
    ],
    execution_signals: {
      result_status: "partial",
      files_changed: [],
      tests_run: [{ name: "node --test", status: "failed" }],
    },
    usage: {
      model: "gpt-5.6-luna",
      input_tokens: 900,
      output_tokens: 400,
      cost_usd: 0.00066,
      source: "platform_reported",
      estimation_method: null,
    },
  });
  const previous = validEvent({ event_id: "evt-test-previous1", intent_clarity: 2 });
  const report = buildReport([first, second], { previousEvents: [previous], totalEventCount: 3 });
  assert.match(report, /## Strengths/);
  assert.match(report, /The runtime constraint is explicit/);
  assert.match(report, /\| missing_verification \| 2 \|/);
  assert.match(report, /Name the command that must pass/);
  assert.match(report, /\| high \| 1 \|/);
  assert.match(report, /\| platform_reported \| 1 \| 900 \| 400 \| \$0\.000660 \|/);
  assert.match(report, /\| estimated \| 1 \| 1,000 \| 500 \| \$0\.000800 \|/);
  assert.match(report, /↑/);
});

test("limits each insight section to five recent examples", () => {
  const events = Array.from({ length: 8 }, (_, index) => validEvent({
    event_id: "evt-limit-" + String(index).padStart(8, "0"),
    strengths: [{ category: "other", message: "Strength " + index }],
    weaknesses: [{ category: "other", severity: "low", message: "Weakness " + index }],
    improvement_suggestions: [{ category: "other", message: "Suggestion " + index }],
  }));
  const report = buildReport(events);
  assert.doesNotMatch(report, /Strength 2/);
  assert.match(report, /Strength 3/);
  assert.doesNotMatch(report, /Weakness 2/);
  assert.match(report, /Suggestion 7/);
});

test("builds a self-contained HTML dashboard and safely embeds event text", () => {
  const event = validEvent({
    strengths: [{ category: "other", message: "</script><script>alert(1)</script>" }],
  });
  const html = buildHtmlReport([event]);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Prompt-health trend/);
  assert.match(html, /All task types/);
  assert.match(html, /dashboardApp/);
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.doesNotMatch(html, /https:\/\/cdn\./);
  const scriptStart = html.indexOf("<script>") + "<script>".length;
  const scriptEnd = html.lastIndexOf("</script>");
  assert.doesNotThrow(() => new Function(html.slice(scriptStart, scriptEnd)));
});

test("streams a default 50-event window, compares the prior 50, and supports all events", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "prompt-observer-report-"));
  await initProject(workspace);
  const events = Array.from({ length: 120 }, (_, index) => validEvent({
    event_id: "evt-window-" + String(index).padStart(8, "0"),
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    intent_clarity: index < 70 ? 4 : 9,
  }));
  const eventsPath = join(workspace, ".prompt-observer", "events.jsonl");
  await writeFile(eventsPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  const bounded = await generateReport(workspace);
  assert.equal(bounded.eventCount, 50);
  assert.equal(bounded.totalEventCount, 120);
  assert.match(await readFile(bounded.reportPath, "utf8"), /latest 50 events/);
  assert.match(await readFile(bounded.reportPath, "utf8"), /↑/);
  assert.match(await readFile(bounded.htmlPath, "utf8"), /Latest 50 events/);
  const all = await generateReport(workspace, { all: true });
  assert.equal(all.eventCount, 120);
  assert.match(all.html, /All loaded/);
});

test("contract documents fallback, structured events, and deterministic estimates", async () => {
  const contract = await readFile(new URL("../PROMPT_OBSERVER.md", import.meta.url), "utf8");
  assert.match(contract, /If writing files or running the logger is unavailable/);
  assert.match(contract, /fenced `json` block/);
  assert.match(contract, /do not pretend the event was saved/i);
  assert.match(contract, /schema `1\.1`/);
  assert.match(contract, /agent_text_heuristic_v1/);
  assert.match(contract, /Never infer a model/);
});
