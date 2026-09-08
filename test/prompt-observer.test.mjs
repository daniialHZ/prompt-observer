import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildReport,
  generateReport,
  initProject,
  logEvent,
  validateEvent,
} from "../bin/prompt-observer.mjs";

function validEvent(overrides = {}) {
  return {
    schema_version: "1.0",
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
    strengths: ["The intended outcome is clear."],
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

test("accepts a valid event", () => {
  assert.deepEqual(validateEvent(validEvent()), []);
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

test("rejects missing, unknown, and raw-content fields", () => {
  const event = validEvent({ prompt: "full user prompt" });
  delete event.intent_clarity;
  const errors = validateEvent(event);
  assert.ok(errors.some((error) => error.includes("$.prompt is not allowed")));
  assert.ok(errors.some((error) => error.includes("$.prompt is prohibited")));
  assert.ok(errors.some((error) => error.includes("$.intent_clarity is required")));
});

test("rejects likely secrets", () => {
  const event = validEvent({
    prompt_summary: "Configure credential sk-abcdefghijklmnopqrstuvwxyz123456 for the workflow.",
  });
  assert.ok(validateEvent(event).some((error) => error.includes("API key")));
});

test("rejects invented usage shapes", () => {
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
});

test("initializes a portable project and keeps existing files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "prompt-observer-init-"));
  const first = await initProject(workspace);
  const observer = first.observerDirectory;
  assert.match(await readFile(join(observer, "PROMPT_OBSERVER.md"), "utf8"), /No-filesystem fallback/);
  assert.match(await readFile(join(observer, "event.schema.json"), "utf8"), /Prompt Observer Event/);
  assert.match(await readFile(join(observer, "prompt-observer.mjs"), "utf8"), /buildReport/);

  await writeFile(join(observer, "PROMPT_OBSERVER.md"), "custom contract", "utf8");
  await initProject(workspace);
  assert.equal(await readFile(join(observer, "PROMPT_OBSERVER.md"), "utf8"), "custom contract");
});

test("logs valid events and rejects duplicate IDs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "prompt-observer-log-"));
  await initProject(workspace);
  const eventPath = join(workspace, "event.json");
  await writeFile(eventPath, JSON.stringify(validEvent()), "utf8");

  await logEvent(eventPath, workspace);
  const logged = await readFile(join(workspace, ".prompt-observer", "events.jsonl"), "utf8");
  assert.equal(logged.trim().split(/\r?\n/).length, 1);
  await assert.rejects(() => logEvent(eventPath, workspace), /already exists/);
});

test("builds and writes an aggregate Markdown report", async () => {
  const first = validEvent({
    weaknesses: [
      {
        category: "missing_verification",
        severity: "medium",
        message: "The exact verification command is not specified.",
      },
    ],
    improvement_suggestions: ["Name the command that must pass."],
  });
  const second = validEvent({
    event_id: "evt-test-00000002",
    intent_clarity: 5,
    ambiguity_risk: "high",
    weaknesses: [
      {
        category: "missing_verification",
        severity: "high",
        message: "No verification expectation was provided.",
      },
      {
        category: "undefined_scope",
        severity: "medium",
        message: "The affected modules were not identified.",
      },
    ],
    execution_signals: {
      result_status: "partial",
      files_changed: [],
      tests_run: [{ name: "node --test", status: "failed" }],
    },
  });

  const reportText = buildReport([first, second]);
  assert.match(reportText, /\| missing_verification \| 2 \|/);
  assert.match(reportText, /\| undefined_scope \| 1 \|/);
  assert.match(reportText, /\| high \| 1 \|/);
  assert.match(reportText, /\| partial \| 1 \|/);

  const workspace = await mkdtemp(join(tmpdir(), "prompt-observer-report-"));
  await initProject(workspace);
  for (const [index, event] of [first, second].entries()) {
    const eventPath = join(workspace, `event-${index}.json`);
    await writeFile(eventPath, JSON.stringify(event), "utf8");
    await logEvent(eventPath, workspace);
  }
  const result = await generateReport(workspace);
  assert.equal(result.eventCount, 2);
  assert.match(await readFile(result.reportPath, "utf8"), /Events: 2/);
});

test("contract defines the no-filesystem JSON fallback", async () => {
  const contract = await readFile(new URL("../PROMPT_OBSERVER.md", import.meta.url), "utf8");
  assert.match(contract, /If writing files or running the logger is unavailable/);
  assert.match(contract, /fenced `json` block/);
  assert.match(contract, /do not pretend the event was saved/i);
});
