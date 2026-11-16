#!/usr/bin/env node
/**
 * ClaimEvidenceGuard.js — Stop-event hook for Claude Code
 *
 * Catches confident root-cause / claim-without-evidence assertions and uses
 * an LLM-as-judge to verify same-turn tool output actually supports the claim.
 * Two-stage gate: regex pre-filter (cheap) + LLM judge (~7-15s, only on
 * regex-match turns). Pure Node, no external deps beyond `claude` on PATH.
 *
 * Drop at: $HOME/.claude/hooks/ClaimEvidenceGuard.js
 * Register in $HOME/.claude/settings.json under hooks.Stop:
 *   { "hooks": [{"type": "command", "command": "$HOME/.claude/hooks/ClaimEvidenceGuard.js"}] }
 *
 * Audit mode by default — logs verdicts, never blocks. Flip to block once
 * your audit data shows acceptable false-positive rate.
 *
 * Modes (env var CLAIM_EVIDENCE_MODE):
 *   off    — disabled
 *   audit  — log verdict, never block (DEFAULT)
 *   block  — block on DENY verdict
 *
 * Config:
 *   CLAIM_EVIDENCE_LOG    override log path (default ~/.claude/claim-evidence.jsonl)
 *   CLAIM_EVIDENCE_MODEL  override model (default claude-haiku-4-5-20251001)
 *
 * Lineage: composes Vannevar Bush's 1945 memex spec ("above all it must be
 * consulted"), Buckminster Fuller's capture rule ("I could not be judge of
 * what was valid to put in or not"), and Lisanne Bainbridge's 1983 function-
 * allocation framing (Ironies of Automation). Structural fix for the
 * confident-wrong outputs an agent's reward function pulls toward.
 *
 * Inspired by NousResearch/hermes-agent's approval pattern and OpenAI Codex's
 * Smart Approvals subagent.
 */

"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const HOOK_VERSION = "0.1.0-portable";

const CLAIM_PATTERNS = [
  {
    name: "found_it",
    re: /\b(found it|i found it|got it|i got it|aha|ah-ha|that's it|there it is)[\s.!,:]/i,
  },
  {
    name: "the_bug_is",
    re: /\bthe (bug|issue|problem|cause|error|failure|defect|root\s+cause) (is|was|must be|seems to be|appears to be)\b/i,
  },
  {
    name: "root_cause_is",
    re: /\b(root cause|the actual cause|real cause) (is|was) /i,
  },
  {
    name: "refactoring_against",
    re: /\b(i'm |i am |let me |going to )?refactor(ing)?\s+(against|to fix|to address|to handle)\b/i,
  },
  {
    name: "must_be",
    re: /\b(it|that|this|the) (must|has to|gotta) be\s+(the|a|an|because)\b/i,
  },
  {
    name: "i_think_problem",
    re: /\bi (think|believe|suspect|reckon) (the|that the) (problem|issue|bug|cause|failure)\b/i,
  },
  {
    name: "the_fix_is",
    re: /\bthe (fix|solution|answer|remedy) (is|will be) (to |a |an )/i,
  },
  {
    name: "i_see_what",
    re: /\bi see (what's happening|what's wrong|the issue|the problem|the bug)\b/i,
  },
];

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(data);
      }
    };
    const t = setTimeout(finish, timeoutMs);
    process.stdin.on("data", (c) => {
      data += c.toString("utf-8");
    });
    process.stdin.on("end", () => {
      clearTimeout(t);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(t);
      finish();
    });
  });
}

function readEnvMode() {
  const raw = (process.env.CLAIM_EVIDENCE_MODE || "audit").toLowerCase();
  if (raw === "off") return "off";
  if (raw === "block") return "block";
  return "audit";
}

function defaultLogPath() {
  if (process.env.CLAIM_EVIDENCE_LOG) return process.env.CLAIM_EVIDENCE_LOG;
  return path.join(
    process.env.HOME || os.homedir(),
    ".claude",
    "claim-evidence.jsonl",
  );
}

function detectClaim(text) {
  for (const p of CLAIM_PATTERNS) {
    const m = text.match(p.re);
    if (m) return { hit: true, pattern: p.name, phrase: m[0] };
  }
  return { hit: false };
}

function parseTranscriptLines(transcriptPath) {
  try {
    return fs
      .readFileSync(transcriptPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractCurrentTurn(transcriptPath, fallbackAssistant) {
  const ctx = {
    assistantText: fallbackAssistant || "",
    toolUses: [],
    toolResults: [],
  };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return ctx;
  const lines = parseTranscriptLines(transcriptPath);

  let boundaryIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = lines[i];
    if (e?.type === "user" && e.message?.role === "user") {
      const content = e.message?.content;
      const isToolResult =
        Array.isArray(content) &&
        content.some((c) => c?.type === "tool_result");
      if (!isToolResult) {
        boundaryIdx = i;
        break;
      }
    }
  }

  let collected = "";
  for (let i = boundaryIdx + 1; i < lines.length; i++) {
    const e = lines[i];
    if (!e) continue;
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block?.type === "text") collected += (block.text || "") + "\n";
        else if (block?.type === "tool_use")
          ctx.toolUses.push({
            name: block.name || "",
            input: block.input || {},
          });
      }
    } else if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block?.type === "tool_result") {
          let c = "";
          if (typeof block.content === "string") c = block.content;
          else if (Array.isArray(block.content))
            c = block.content
              .map((cc) => (typeof cc === "string" ? cc : cc?.text || ""))
              .join("");
          ctx.toolResults.push({
            tool_use_id: block.tool_use_id || "",
            content: c.slice(0, 4000),
          });
        }
      }
    }
  }
  if (collected.trim()) ctx.assistantText = collected.trim();
  return ctx;
}

function callLlmJudge(
  claimPhrase,
  assistantText,
  toolUses,
  toolResults,
  model,
) {
  const evidence = toolUses
    .map((tu, idx) => {
      const inputDesc = JSON.stringify(tu.input).slice(0, 800);
      const result = toolResults[idx];
      const resultDesc = result
        ? result.content.slice(0, 1500)
        : "(no result captured)";
      return `Tool call ${idx + 1}: ${tu.name}\nInput: ${inputDesc}\nOutput: ${resultDesc}`;
    })
    .join("\n\n");

  const systemPrompt = `You are a claim-evidence reviewer. A claim phrase was detected in the agent's outgoing message: ${JSON.stringify(claimPhrase)}.

Your job: read the assistant message and the tool calls/outputs from THIS SAME TURN. Decide whether the tool outputs actually support the claim.

Output STRICT JSON only:
{"verdict": "APPROVE" | "DENY" | "ESCALATE", "reason": "<one sentence>"}

Rules:
- APPROVE — tool outputs visibly support the claim. Agent cited specific evidence (file content, error output, test result, grep match) that justifies the root-cause assertion.
- DENY — claim asserted without evidence. Turn either has no tool calls, has unrelated tool calls, or has tool calls whose output does NOT actually demonstrate what the claim says.
- ESCALATE — genuinely uncertain. Evidence ambiguous or partial.

Default ESCALATE when uncertain. ESCALATE doesn't block; DENY does. Bias toward DENY only when evidence is clearly absent.`;

  const userPrompt = `CLAIM: ${claimPhrase}\n\nFULL ASSISTANT MESSAGE THIS TURN:\n${assistantText.slice(0, 6000)}\n\nTOOL CALLS AND OUTPUTS THIS TURN:\n${evidence.slice(0, 8000) || "(no tool calls in this turn)"}\n\nOutput JSON only.`;

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
      verdict: "ESCALATE",
      reason: `LLM call failed exit=${result.status}`,
      raw: (result.stderr || "").toString(),
    };
  }
  const stdout = (result.stdout || "").toString();
  let parsed = null;
  try {
    const m = stdout.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch {
    parsed = null;
  }
  if (!parsed || !["APPROVE", "DENY", "ESCALATE"].includes(parsed.verdict)) {
    return {
      verdict: "ESCALATE",
      reason: "unparseable LLM output",
      raw: stdout,
    };
  }
  return {
    verdict: parsed.verdict,
    reason: String(parsed.reason || "").slice(0, 500),
    raw: stdout,
  };
}

function appendLog(entry) {
  const logPath = defaultLogPath();
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error("[ClaimEvidenceGuard] log write failed:", err && err.message);
  }
}

async function main() {
  const raw = await readStdin(500);
  if (!raw || !raw.trim()) process.exit(0);
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  if (input?.stop_hook_active) process.exit(0);

  const mode = readEnvMode();
  if (mode === "off") process.exit(0);

  const fallbackAssistant = input.last_assistant_message || "";
  const turn = extractCurrentTurn(input.transcript_path, fallbackAssistant);
  if (!turn.assistantText || turn.assistantText.length < 30) process.exit(0);

  const claim = detectClaim(turn.assistantText);
  if (!claim.hit) process.exit(0);

  const model = process.env.CLAIM_EVIDENCE_MODEL || "claude-haiku-4-5-20251001";
  const verdict = callLlmJudge(
    claim.phrase || "",
    turn.assistantText,
    turn.toolUses,
    turn.toolResults,
    model,
  );

  const instance =
    process.env.PAI_INSTANCE ||
    process.env.USER ||
    "unknown@" + (os.hostname() || "host");
  const entry = {
    timestamp: new Date().toISOString(),
    session_id: input.session_id || "unknown",
    instance,
    hook_event: "Stop",
    claim_pattern: claim.pattern || "unknown",
    claim_phrase: claim.phrase || "",
    claim_excerpt: turn.assistantText.slice(0, 400),
    tool_use_count: turn.toolUses.length,
    tool_use_names: turn.toolUses.map((t) => t.name).slice(0, 10),
    verdict: verdict.verdict,
    verdict_reason: verdict.reason,
    mode,
    blocking: mode === "block" && verdict.verdict === "DENY",
    hook_version: HOOK_VERSION,
  };
  appendLog(entry);

  if (mode === "audit") process.exit(0);
  if (verdict.verdict === "DENY") {
    const reason =
      `Claim "${claim.phrase}" detected without sufficient evidence in this turn. ` +
      `LLM judge: ${verdict.reason}. ` +
      `Cite the specific tool output, test result, or instrumentation that proves the claim, ` +
      `OR rephrase as a hypothesis ("I suspect X because Y") before asserting root cause.`;
    console.error(JSON.stringify({ decision: "block", reason }));
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[ClaimEvidenceGuard] fatal:", err && err.message);
  process.exit(0);
});
