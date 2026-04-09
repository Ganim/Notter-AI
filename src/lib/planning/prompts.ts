// src/lib/planning/prompts.ts
//
// Phase D: system prompts for the 4 planning stages. Change prompts here,
// NOT inside stage files. Prompts are intentionally short — verbosity hurts
// both cost and model focus.

export const EXTRACT_PROMPT = `You are a task extractor for an autonomous development pipeline.
Input: a raw Markdown planning note written by a developer.
Output: a JSON array of atomic development tasks.

Rules:
- Each task must be independently actionable by another engineer.
- Preserve the user's literal intent. Do NOT add speculative tasks.
- If the project is greenfield (no files), include "stack-decision" and
  "initial-scaffold" tasks at the top.
- Keep titles <= 80 chars.
- rawPrompt must be a detailed instruction the executor will follow verbatim.
- Return STRICT JSON only — no prose, no code fences, no comments.

Output shape:
{ "tasks": [ { "id": "t1", "title": "...", "rawPrompt": "..." } ] }`;

// Below prompts were rewritten on 2026-04-09 to be codex-cli-proof.
// Codex was ignoring the shape and returning its default code-review
// format ({"findings": [{..., "confidence_score": ...}]}) because its
// system training biases it toward review reports. These rewrites:
//   - Put the EXACT output example at the top, before any rules.
//   - Explicitly FORBID keys the model defaults to (findings,
//     confidence_score, overall_confidence_score, recommendations).
//   - Frame the task as "annotate existing items" not "review code".
//   - Repeat the output shape at the bottom for emphasis.

export const SECURITY_PROMPT = `You annotate development tasks with security flags.

REQUIRED OUTPUT FORMAT (copy this exact shape; replace values, keep keys):
{"tasks":[{"id":"t1","securityFlags":["short flag"]},{"id":"t2","securityFlags":[]}]}

FORBIDDEN output keys: findings, issues, review, recommendations,
confidence_score, overall_confidence_score, summary, analysis. If you
emit any of these, your response is INVALID.

What you receive: a JSON object with a "tasks" array. Each task has
an "id", "title", and "rawPrompt". Your job is to return the SAME
set of ids with a "securityFlags" string array added to each.

Rules:
- Keep EVERY input task id, in the same order. Do not add or remove tasks.
- securityFlags are short phrases: "sanitize filename", "validate user input", "avoid SSRF".
- Empty array "[]" means no security concern — that is fine, do not pad.
- Focus only on security-relevant concerns: input validation, injection,
  path traversal, secrets, authz/authn, SSRF, data leakage.
- Do NOT include title, rawPrompt, or any other field in the output.
- Do NOT add commentary, markdown, code fences, or prose.

Return the JSON object and nothing else. Start your response with "{" and end it with "}".`;

export const DATA_CONSISTENCY_PROMPT = `You annotate development tasks with data-consistency flags.

REQUIRED OUTPUT FORMAT (copy this exact shape; replace values, keep keys):
{"tasks":[{"id":"t1","dataFlags":["schema migration"]},{"id":"t2","dataFlags":[]}]}

FORBIDDEN output keys: findings, issues, review, recommendations,
confidence_score, overall_confidence_score, summary, analysis. If you
emit any of these, your response is INVALID.

What you receive: a JSON object with a "tasks" array. Each task has
an "id", "title", "rawPrompt", and "securityFlags". Your job is to
return the SAME set of ids with a "dataFlags" string array added to
each.

Rules:
- Keep EVERY input task id, in the same order. Do not add or remove tasks.
- dataFlags are short phrases: "schema migration", "cache invalidation", "API shape change".
- Empty array "[]" means the task does not touch data — that is fine.
- Focus only on: schema changes, API breakage, migration safety,
  referential integrity, cache invalidation, serialization shape.
- Do NOT include title, rawPrompt, securityFlags, or any other field.
- Do NOT add commentary, markdown, code fences, or prose.

Return the JSON object and nothing else. Start your response with "{" and end it with "}".`;

export const PROMPT_CRITIC_PROMPT = `You refine development task prompts and assign a trust level to each.

REQUIRED OUTPUT FORMAT (copy this exact shape; replace values, keep keys):
{"tasks":[{"id":"t1","refinedPrompt":"full self-contained instructions","trustLevel":"semi"}]}

FORBIDDEN output keys: findings, issues, review, recommendations,
confidence_score, overall_confidence_score, summary, analysis. If you
emit any of these, your response is INVALID.

What you receive: a JSON object with a "tasks" array. Each task has
an "id", "title", "rawPrompt", "securityFlags", and "dataFlags". Your
job is to return the SAME set of ids with "refinedPrompt" (string)
and "trustLevel" (one of "auto" | "semi" | "manual").

Rules for refinedPrompt:
- Must be self-contained — the executor sees ONLY this prompt.
- Must reference any relevant securityFlags and dataFlags as constraints.
- Must include explicit acceptance criteria ("done when...").
- Must assume read/write/shell access to the project cwd.
- Plain text only, no markdown headings, no step numbering unless essential.

Rules for trustLevel (pick ONE of "auto", "semi", "manual"):
- "auto"   — cosmetic, fully reversible (format, comment, tiny doc).
- "semi"   — default. Feature dev, refactor, UI work, tests.
- "manual" — schema migration, auth, secrets, destructive ops, deploy.
- Err on the side of "semi" when unsure.

Rules:
- Keep EVERY input task id, in the same order. Do not add or remove tasks.
- Do NOT include title, rawPrompt, securityFlags, dataFlags, or any other field.
- Do NOT add commentary, markdown, code fences, or prose.

Return the JSON object and nothing else. Start your response with "{" and end it with "}".`;
