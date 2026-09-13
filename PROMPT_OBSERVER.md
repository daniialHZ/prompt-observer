# Prompt Observer Contract

Follow this contract after every user-requested task. Complete the task first, then create and persist one observation event.

## Non-negotiable rules

1. Use only information visible in the conversation, tool results, file changes, and verification output.
2. Never store the full user prompt, the full assistant response, system instructions, private reasoning, chain-of-thought, credentials, access tokens, or other secrets.
3. `prompt_summary` must be a short, redacted description of the request, not a quotation or close reproduction.
4. Prefer platform-reported usage. When it is unavailable, estimate token counts only from the visible user input and final response with the deterministic heuristic below. Never guess a model name. The logger calculates estimated cost only for an exact model match in `.prompt-observer/pricing.json`.
5. Base execution signals only on observed results. Do not claim a file changed or a test passed without evidence.
6. Use schema version `1.1` and conform to `.prompt-observer/event.schema.json`.
7. Do not manufacture criticism. If the prompt is clear and sufficient for the task, keep `weaknesses` and `improvement_suggestions` empty.
8. Evaluate against objective task requirements, not personal preferences about wording, tone, verbosity, formatting, workflow, or technology choices.

## Required workflow

After completing a task:

1. Evaluate the prompt on each 0–10 dimension in the event schema.
2. Create a unique event ID and an ISO-8601 UTC timestamp.
3. Write the event temporarily to `.prompt-observer/pending/<event_id>.json`.
4. Run:

   ```text
   node .prompt-observer/prompt-observer.mjs log .prompt-observer/pending/<event_id>.json
   ```

5. After a successful log, remove only the temporary event file you created.
6. End the user-facing answer with exactly three concise English lines:

   ```text
   Prompt Insight: <average>/10 — <short strength>
   Main weakness: <highest-impact weakness, or "No material weakness detected">
   Next time: <one actionable improvement, or "No change needed">
   ```

Do not paste the complete JSON event into the user-facing response when persistence succeeds.

## No-filesystem fallback

If writing files or running the logger is unavailable, do not pretend the event was saved. Return the same three-line insight, followed by one fenced `json` block containing the complete valid event. This is the only fallback; do not retry with unsafe shell commands or external services.

## Scoring guidance

- `intent_clarity`: Is the desired outcome explicit and understandable?
- `context_sufficiency`: Is enough relevant background provided for the task?
- `scope_definition`: Are boundaries, affected areas, and exclusions clear?
- `constraints_quality`: Are technical, safety, compatibility, and style constraints usable?
- `acceptance_criteria`: Is completion objectively recognizable?
- `verification_plan`: Are tests or other verification expectations stated or clearly inferable?
- `ambiguity_risk`: Estimate the risk that a capable agent would choose the wrong interpretation.

Score only prompt quality. Do not lower a score because implementation was difficult when the request itself was clear.

## Structured insights

In schema `1.1`, every strength and improvement suggestion is an object with:

- `category`: one of `intent_clarity`, `context_sufficiency`, `scope_definition`, `constraints_quality`, `acceptance_criteria`, `verification_plan`, `output_format`, or `other`
- `message`: one concise, evidence-based observation

Legacy schema `1.0` events with string arrays remain readable, but all new events must use the structured `1.1` form.

## Usage precedence and estimation

1. If the platform reports any model, token, or cost metrics, record only those reported metrics, keep unreported metrics `null`, use `source: "platform_reported"`, and keep `estimation_method: null`.
2. Otherwise, if the Agent can inspect the complete visible user input and its final response, estimate each side independently using `agent_text_heuristic_v1`:
   - Ignore whitespace.
   - Count ASCII letters and digits as `characters / 4`.
   - Count non-ASCII letters, digits, and combining marks as `characters / 2`.
   - Count punctuation and symbols as `characters / 2`.
   - Add the three values and round up to the next integer.
3. Store the two counts with `source: "estimated"` and `estimation_method: "agent_text_heuristic_v1"`.
4. Set `model` only when the runtime explicitly identifies it. Never infer a model from the product name.
5. Leave `cost_usd: null`. During `log`, the CLI fills it only when both token counts exist and `model` exactly matches `.prompt-observer/pricing.json`; the pricing snapshot identifier is then appended to `estimation_method`.
6. If neither reported nor safely estimated usage is available, keep all metrics `null`, use `source: "unavailable"`, and keep `estimation_method: null`.

Estimated usage is directional, not billing data. Never include hidden system instructions, tool payloads, cached-token adjustments, subscription fees, or guessed reasoning tokens in the estimate.

## Evidence threshold and neutrality

- Record a weakness only when a concrete omission, ambiguity, contradiction, or constraint creates a meaningful risk of wrong execution, wasted work, or unverifiable completion.
- Do not require context, constraints, acceptance criteria, output formatting, or tests when they are unnecessary for the specific task.
- Do not criticize a prompt merely because it could be longer, more formal, more structured, or written in a style you prefer.
- Do not turn optional enhancements into weaknesses.
- When no material weakness exists, use an empty `weaknesses` array, an empty `improvement_suggestions` array, `Main weakness: No material weakness detected`, and `Next time: No change needed`.
- Positive scores must reflect the prompt as written; do not lower them just to create variation or appear critical.

## Event example

```json
{
  "schema_version": "1.1",
  "event_id": "evt-20260901-7f3a92c1",
  "timestamp": "2026-09-01T12:00:00.000Z",
  "task_type": "coding",
  "prompt_summary": "Implement a dependency-free prompt observation kit with structured local logging.",
  "intent_clarity": 10,
  "context_sufficiency": 10,
  "scope_definition": 10,
  "constraints_quality": 10,
  "acceptance_criteria": 9,
  "verification_plan": 9,
  "ambiguity_risk": "low",
  "strengths": [
    {
      "category": "constraints_quality",
      "message": "The requested deliverables and runtime constraints are explicit."
    }
  ],
  "weaknesses": [],
  "improvement_suggestions": [],
  "execution_signals": {
    "result_status": "completed",
    "files_changed": [
      "PROMPT_OBSERVER.md"
    ],
    "tests_run": [
      {
        "name": "node --test",
        "status": "passed"
      }
    ]
  },
  "usage": {
    "model": null,
    "input_tokens": 280,
    "output_tokens": 640,
    "cost_usd": null,
    "source": "estimated",
    "estimation_method": "agent_text_heuristic_v1"
  }
}
```
