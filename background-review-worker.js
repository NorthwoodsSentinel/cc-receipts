#!/usr/bin/env node
/**
 * background-review-worker.js — detached child of BackgroundReview.js
 *
 * Runs in the background after the Stop hook returns. Calls the classifier
 * via `claude --print` and writes the recommendation JSONL entry. Self-
 * contained because the parent hook has already exited.
 *
 * Invoked by BackgroundReview.js (detached):
 *   node background-review-worker.js \
 *     --session-id <id> --instance <name> --mode <mode> \
 *     --model <model-name> --log <path> \
 *     --user-msg-file <tmp> --assistant-msg-file <tmp>
 */

"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const HOOK_VERSION = "0.1.0-portable";
const CATEGORIES = [
  "NO_ACTION",
  "NEW_FEEDBACK_RULE",
  "NEW_PROJECT_DOC",
  "NEW_USER_FACT",
  "AMEND_EXISTING_FILE",
  "MISSED_OPPORTUNITY",
];

const SYSTEM_PROMPT = `You are a background memory reviewer for an AI agent.
After every Stop event you look at the just-finished turn (user message + assistant response) and classify whether this turn produced a moment worth saving to memory.

Output STRICT JSON only, no markdown fences, no commentary:

{
  "category": "<one of: NO_ACTION, NEW_FEEDBACK_RULE, NEW_PROJECT_DOC, NEW_USER_FACT, AMEND_EXISTING_FILE, MISSED_OPPORTUNITY>",
  "reason": "<one sentence>",
  "resonance_score": <float 0.0-1.0 — doctrine-shaped signal strength>,
  "themes": [<up to 5 kebab-case topic tags>],
  "proposed_slug": "<kebab-case slug if NEW_*; omit otherwise>",
  "amend_target": "<existing filename if AMEND_EXISTING_FILE; omit otherwise>"
}

Calibration:
- NO_ACTION — vast majority. Tactical, operational, retrieval, acknowledgments.
- NEW_FEEDBACK_RULE — user gave guidance that should govern future behavior.
- NEW_PROJECT_DOC — significant project/architectural context not yet in memory.
- NEW_USER_FACT — biographical/relational fact about user worth saving.
- AMEND_EXISTING_FILE — turn validated or updated something already in memory.
- MISSED_OPPORTUNITY — turn revealed an absent-from-memory pattern the agent should have caught.

Resonance: 0.0-0.2 tactical / 0.3-0.4 useful local / 0.5-0.6 cross-session / 0.7-0.8 load-bearing / 0.9-1.0 explicit rule.

Default NO_ACTION + low resonance when uncertain. Bias toward restraint on category; liberal with themes.`;

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length) {
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

function appendJsonl(logPath, entry) {
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error("[bg-review-worker] log write failed:", err && err.message);
  }
}

function callClaudeCLI(systemPrompt, userPrompt, model) {
  const result = spawnSync(
    "claude",
    ["--print", "--model", model, "--append-system-prompt", systemPrompt],
    {
      input: userPrompt,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      timeout: 60000,
      maxBuffer: 1024 * 1024 * 4,
    },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      error: `exit ${result.status}; stderr=${(result.stderr || "").toString().slice(0, 200)}`,
    };
  }
  return { ok: true, output: (result.stdout || "").toString() };
}

function main() {
  const args = parseArgs();
  const sessionId = args["session-id"] || "unknown";
  const instance = args["instance"] || "unknown";
  const mode = args["mode"] === "shadow" ? "shadow" : "active";
  const model = args["model"] || "claude-haiku-4-5-20251001";
  const logPath = args["log"];
  const userFile = args["user-msg-file"];
  const assistantFile = args["assistant-msg-file"];

  if (!logPath || !userFile || !assistantFile) {
    console.error("[bg-review-worker] missing required args");
    process.exit(1);
  }

  let userMsg = "",
    assistantMsg = "";
  try {
    userMsg = fs.readFileSync(userFile, "utf-8");
    assistantMsg = fs.readFileSync(assistantFile, "utf-8");
  } catch (err) {
    console.error("[bg-review-worker] read failed:", err && err.message);
    process.exit(1);
  } finally {
    try {
      fs.unlinkSync(userFile);
    } catch {
      /* best-effort cleanup */
    }
    try {
      fs.unlinkSync(assistantFile);
    } catch {
      /* best-effort cleanup */
    }
  }

  const userPrompt =
    `USER MESSAGE THIS TURN:\n${userMsg.slice(0, 4000)}\n\n` +
    `ASSISTANT RESPONSE THIS TURN:\n${assistantMsg.slice(0, 8000)}\n\n` +
    `Output strict JSON per the schema. Default NO_ACTION when uncertain.`;

  const r = callClaudeCLI(SYSTEM_PROMPT, userPrompt, model);
  const timestamp = new Date().toISOString();
  const base = {
    timestamp,
    session_id: sessionId,
    instance,
    hook_event: "Stop",
    user_message_excerpt: userMsg.slice(0, 300),
    assistant_message_excerpt: assistantMsg.slice(0, 300),
    hook_version: HOOK_VERSION,
    mode,
  };

  if (!r.ok) {
    appendJsonl(logPath, { ...base, category: "PARSE_ERROR", reason: r.error });
    return;
  }
  let parsed = null;
  try {
    const m = r.output.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch {
    parsed = null;
  }
  if (!parsed || !CATEGORIES.includes(parsed.category)) {
    appendJsonl(logPath, {
      ...base,
      category: "PARSE_ERROR",
      reason: `unparseable: ${r.output.slice(0, 300)}`,
    });
    return;
  }
  appendJsonl(logPath, {
    ...base,
    category: parsed.category,
    reason: String(parsed.reason || "").slice(0, 500),
    resonance_score:
      typeof parsed.resonance_score === "number"
        ? parsed.resonance_score
        : null,
    themes: Array.isArray(parsed.themes) ? parsed.themes.slice(0, 5) : [],
    proposed_slug: parsed.proposed_slug
      ? String(parsed.proposed_slug).slice(0, 100)
      : undefined,
    amend_target: parsed.amend_target
      ? String(parsed.amend_target).slice(0, 200)
      : undefined,
  });
}

try {
  main();
} catch (err) {
  console.error("[bg-review-worker] fatal:", err && err.message);
  process.exit(1);
}
