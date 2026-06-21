#!/usr/bin/env node
/**
 * BackgroundReview.js — Stop-event background memory reviewer for Claude Code
 *
 * Per-turn lightweight check: did this turn produce a moment worth saving
 * to memory? Spawns a detached worker that calls a model classifier in the
 * background; hook returns ~30-40ms so turn-end isn't blocked. Worker writes
 * recommendation to a JSONL queue for human review at session start. Pure
 * Node, no external deps beyond `claude` on PATH.
 *
 * Drop at: $HOME/.claude/hooks/BackgroundReview.js
 * Worker at: $HOME/.claude/hooks/lib/background-review-worker.js
 * Register in $HOME/.claude/settings.json under hooks.Stop:
 *   { "hooks": [{"type": "command", "command": "$HOME/.claude/hooks/BackgroundReview.js"}] }
 *
 * Function-allocation framing (Lisanne Bainbridge, 1983 — Ironies of Automation):
 *   - ACQUIRE: high automation (hook fires every Stop event)
 *   - ANALYZE: high automation (Haiku classifies the turn)
 *   - DECIDE:  HUMAN judgment (review JSONL queue at session start)
 *   - ACT (memory mutation): MANUAL — queue, don't act
 *
 * The discipline this enforces: AI proposes memory-worthy moments; the
 * operator decides whether to write them. The system never mutates the
 * memory tree on its own. Buckminster Fuller's "I could not be judge of
 * what was valid to put in or not" rule, instantiated structurally —
 * suggestion is cheap, decision stays human.
 *
 * Modes (env var BACKGROUND_REVIEW_MODE):
 *   off    — skip entirely (cost-free disable)
 *   shadow — runs, logs, never decides
 *   active — runs, logs (DEFAULT)
 *
 * Config:
 *   BACKGROUND_REVIEW_LOG    override log path (default ~/.claude/review-recommendations.jsonl)
 *   BACKGROUND_REVIEW_MODEL  override model (default claude-haiku-4-5-20251001)
 */

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOOK_VERSION = '0.1.0-portable';

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(data); } };
    const t = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c) => { data += c.toString('utf-8'); });
    process.stdin.on('end', () => { clearTimeout(t); finish(); });
    process.stdin.on('error', () => { clearTimeout(t); finish(); });
  });
}

function readEnvMode() {
  const raw = (process.env.BACKGROUND_REVIEW_MODE || 'active').toLowerCase();
  if (raw === 'off') return 'off';
  if (raw === 'shadow') return 'shadow';
  return 'active';
}

function defaultLogPath() {
  if (process.env.BACKGROUND_REVIEW_LOG) return process.env.BACKGROUND_REVIEW_LOG;
  return path.join(process.env.HOME || os.homedir(), '.claude', 'review-recommendations.jsonl');
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function shouldSkipTurn(userMsg, assistantMsg) {
  if (!assistantMsg || assistantMsg.trim().length < 30) return true;
  if (!userMsg || userMsg.trim().length < 5) return true;
  const lower = assistantMsg.trim().toLowerCase();
  if (lower.length < 80 && (
    lower.startsWith('ok') || lower.startsWith('done') ||
    lower.startsWith('confirmed') || lower.startsWith('acknowledged') ||
    lower === 'stopped.'
  )) return true;
  return false;
}

function extractLastTurn(transcriptPath, fallbackAssistant) {
  let user = '';
  let assistant = fallbackAssistant || '';
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return { user, assistant };
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter((l) => l.trim());
    let foundUser = false;
    let foundAssistant = !!assistant;
    for (let i = lines.length - 1; i >= 0 && (!foundUser || !foundAssistant); i--) {
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (!foundAssistant && e.type === 'assistant' && Array.isArray(e.message?.content)) {
        const blocks = e.message.content.filter((b) => b?.type === 'text');
        if (blocks.length) {
          assistant = blocks.map((b) => b.text || '').join('\n');
          foundAssistant = true;
        }
      }
      if (!foundUser && e.type === 'user' && e.message?.role === 'user') {
        const content = e.message.content;
        if (typeof content === 'string') { user = content; foundUser = true; }
        else if (Array.isArray(content)) {
          if (!content.some((c) => c?.type === 'tool_result')) {
            const blocks = content.filter((b) => b?.type === 'text');
            if (blocks.length) { user = blocks.map((b) => b.text || '').join('\n'); foundUser = true; }
          }
        }
      }
    }
  } catch { /* ignore */ }
  return { user, assistant };
}

async function main() {
  const raw = await readStdin(500);
  if (!raw || !raw.trim()) process.exit(0);

  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (input?.stop_hook_active) process.exit(0);

  const mode = readEnvMode();
  if (mode === 'off') process.exit(0);

  const { user, assistant } = extractLastTurn(input.transcript_path, input.last_assistant_message || '');
  if (shouldSkipTurn(user, assistant)) process.exit(0);

  // Write the messages to temp files (ARG_MAX safety) and spawn detached worker
  const tmpDir = os.tmpdir();
  const stamp = Date.now();
  const userFile = path.join(tmpDir, `bgreview-user-${stamp}-${process.pid}.txt`);
  const assistantFile = path.join(tmpDir, `bgreview-asst-${stamp}-${process.pid}.txt`);
  fs.writeFileSync(userFile, user.slice(0, 4000), 'utf-8');
  fs.writeFileSync(assistantFile, assistant.slice(0, 8000), 'utf-8');

  const workerScript = path.join(process.env.HOME || os.homedir(), '.claude', 'hooks', 'lib', 'background-review-worker.portable.js');
  const logPath = defaultLogPath();
  const instance = process.env.PAI_INSTANCE || process.env.USER || ('unknown@' + (os.hostname() || 'host'));
  const model = process.env.BACKGROUND_REVIEW_MODEL || 'claude-haiku-4-5-20251001';

  // Single-flight guard — prevent worker stacking on fast sessions (turns closing < worker runtime)
  const safeInstance = instance.replace(/[^a-z0-9]/gi, '_');
  const pidfile = path.join(tmpDir, `portable-classifier-${safeInstance}.pid`);
  if (fs.existsSync(pidfile)) {
    try {
      const oldPid = parseInt(fs.readFileSync(pidfile, 'utf-8').trim(), 10);
      if (oldPid && processIsAlive(oldPid)) {
        try { fs.unlinkSync(userFile); fs.unlinkSync(assistantFile); } catch {}
        process.exit(0);
      }
    } catch { /* stale or unreadable; overwrite below */ }
  }

  // Subshell writes its $$ to pidfile, traps EXIT to clean up, runs worker in foreground inside backgrounded subshell.
  // Outer `&` returns control to bash -c immediately so the hook return stays ~30-40ms.
  const shellCmd =
    `( echo $$ > ${JSON.stringify(pidfile)}; ` +
    `trap "rm -f ${JSON.stringify(pidfile)}" EXIT; ` +
    `nohup node ${JSON.stringify(workerScript)}` +
    ` --session-id ${JSON.stringify(input.session_id || 'unknown')}` +
    ` --instance ${JSON.stringify(instance)}` +
    ` --mode ${mode}` +
    ` --model ${JSON.stringify(model)}` +
    ` --log ${JSON.stringify(logPath)}` +
    ` --user-msg-file ${JSON.stringify(userFile)}` +
    ` --assistant-msg-file ${JSON.stringify(assistantFile)}` +
    ` ) > /dev/null 2>&1 &`;

  try {
    spawnSync('bash', ['-c', shellCmd], {
      stdio: 'ignore',
      env: process.env,
      timeout: 2000,
    });
  } catch (err) {
    console.error('[BackgroundReview] spawn failed:', err && err.message);
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
