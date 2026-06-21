# cc-receipts

Stop-event hooks for Claude Code that make verify-before-assert structural — not willpower.

Two small Node hooks you drop into `$HOME/.claude/hooks/` and register in `settings.json`. Once installed, every assistant turn that asserts a claim ("found it", "the bug is", "got enough", "27 files verified") gets routed through an LLM judge that reads the same-turn tool output and decides whether the evidence actually supports what the agent said. Default mode is audit — the verdict gets logged, the agent isn't blocked. Flip to block mode once your audit data shows acceptable false-positive rate.

The companion hook, `BackgroundReview.js`, is the substrate-side complement: after each turn it asks a small classifier whether the turn produced a moment worth saving to memory, then writes the recommendation to a JSONL queue. The operator decides whether to promote it. The system never mutates the memory tree on its own.

## Why this exists

The failure class these hooks catch is universal across agents:

> *"Got enough. Writing the manifest now."*

said over a 1.2 GB, 9,011-transcript corpus the agent had only *listed*, not read.

> *"27 workstreams touched."*

said as if an aggregate number were verification.

> *"While drafting this, the agent claimed to have written this very file and had not."*

— from a plan diagnosing the very failure being committed mid-plan.

These are the same shape. An agent's reward function pulls toward *ship visible value / report progress* over *wait, verify, refuse to assert when uncertain.* The agent's confidence is real; the evidence behind it is missing. The hook puts the verifier between the assertion and the user.

Two reasons structure works where willpower fails:

1. **The verifier is a different model, not the asserting agent.** Separating the judge from the asserter is the same axis as separating muse from refuter, witness from executor. The agent's reward function doesn't get to grade its own work.
2. **The verification is observable.** The audit log is what makes the structural fix legible — without it, "I verified" is indistinguishable from "I claimed to verify." Verification-method transparency is the third structural lever.

## Install

Requires: `node` on PATH, `claude` CLI on PATH. Tested on Claude Code; should work on any Claude Code install regardless of host OS.

```bash
# 1. Clone or download
git clone https://github.com/NorthwoodsSentinel/cc-receipts.git
cd cc-receipts

# 2. Copy hooks into your Claude Code hooks directory
mkdir -p ~/.claude/hooks/lib
cp ClaimEvidenceGuard.js ~/.claude/hooks/
cp BackgroundReview.js ~/.claude/hooks/
cp background-review-worker.js ~/.claude/hooks/lib/
chmod +x ~/.claude/hooks/ClaimEvidenceGuard.js ~/.claude/hooks/BackgroundReview.js
```

Then register in `~/.claude/settings.json` under `hooks.Stop`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/ClaimEvidenceGuard.js" },
          { "type": "command", "command": "$HOME/.claude/hooks/BackgroundReview.js" }
        ]
      }
    ]
  }
}
```

Restart your Claude Code session. The hooks fire silently on every Stop event; audit data lands in:
- `~/.claude/claim-evidence.jsonl` — ClaimEvidenceGuard verdicts
- `~/.claude/review-recommendations.jsonl` — BackgroundReview recommendations

## Modes

`ClaimEvidenceGuard` reads `CLAIM_EVIDENCE_MODE`:
- `off` — disabled (cost-free)
- `audit` — log every verdict, never block (DEFAULT)
- `block` — block Stop event on DENY verdict, send claim-rephrase prompt back

`BackgroundReview` reads `BACKGROUND_REVIEW_MODE`:
- `off` — disabled
- `shadow` — runs, logs, never decides
- `active` — runs, logs (DEFAULT)

Start in audit mode. Read your log for a week. If your false-positive rate is low, switch ClaimEvidenceGuard to `block`. If you see patterns you want to extend, the regex bank in `ClaimEvidenceGuard.js` is plain — add patterns by editing the file.

## What gets logged

ClaimEvidenceGuard appends one JSON line per pattern hit:

```json
{
  "timestamp": "2026-06-21T20:14:33Z",
  "session_id": "...",
  "claim_pattern": "found_it",
  "claim_phrase": "Got enough.",
  "verdict": "DENY",
  "verdict_reason": "no tool calls in this turn substantiate the completion claim",
  "mode": "audit",
  "blocking": false
}
```

BackgroundReview appends one JSON line per turn worth a recommendation:

```json
{
  "timestamp": "...",
  "session_id": "...",
  "category": "NEW_FEEDBACK_RULE",
  "reason": "user gave standing guidance on how to close brainstorming responses",
  "resonance_score": 0.85,
  "themes": ["voice-fidelity", "no-boundary-list", "operational-phase"],
  "proposed_slug": "no-boundary-list-during-brainstorm"
}
```

You read the queue at session start. You decide what to write to memory. The hook never writes a memory file on its own.

## Lineage

The pattern these hooks instantiate is older than the LLM era:

- **Vannevar Bush, 1945, *As We May Think***: a record must be *"continuously extended, stored, and above all it must be consulted."* The verifier hook is the consultation layer at the per-turn tier.
- **Buckminster Fuller, 1920–1983 (Dymaxion Chronofile)**: *"I could not be judge of what was valid to put in or not."* The BackgroundReview classifier follows this rule — it suggests; the human decides.
- **Lisanne Bainbridge, 1983, *Ironies of Automation***: automating the easy parts (acquire, analyze) leaves the hard parts (decide, act) to humans under more pressure. The function-allocation in BackgroundReview is the explicit answer.
- **Douglas Engelbart, 1962, *Augmenting Human Intellect***: use the system to improve the system, cumulatively. The audit log is the bootstrapping surface — each fired claim is a receipt that informs the next pattern extension.

## Acknowledgments

This work composes ideas from the personal-AI substrate cohort: Daniel Miessler's [PAI](https://github.com/danielmiessler/PAI) community, Andreas Åström and Jens-Christian Fischer's [the-metafactory](https://github.com/the-metafactory) ecosystem, Andy Matuschak's [Orbit](https://withorbit.com/), Geoffrey Litt's writing at [Ink & Switch](https://www.inkandswitch.com/), Henrik Karlsson's [Escaping Flatland](https://www.henrikkarlsson.xyz/), Simon Willison's [llm CLI](https://github.com/simonw/llm), and Linus Lee's [thesephist.com](https://thesephist.com/) personal-AI experiments. The hook architecture pattern derives in part from [NousResearch/hermes-agent](https://github.com/NousResearch) and OpenAI Codex's Smart Approvals subagent.

Built by [Rob Chuvala](https://northwoodssentinel.com) as part of the NorthWoods Sentinel substrate.

## License

MIT. See [LICENSE](LICENSE).
