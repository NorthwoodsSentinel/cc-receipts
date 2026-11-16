// Behaviour tests for the three hooks (NOR-381, added with the dev tooling).
//
// Each hook runs `main()` when loaded and ends in `process.exit`, so it cannot
// be imported into the test process. These tests run each one as it is, in a
// child Node process, and judge it by exit code, stderr and the files it
// writes. Every run gets a temporary HOME and TMPDIR, and a PATH whose only
// `claude` is a fake script that prints a canned answer, so no model is ever
// called and nothing outside the temporary directories is touched.
//
// V8 coverage in this process cannot measure a child process, so the three
// hooks are excluded from coverage by exact path (vitest.config.mts).

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sandbox(fakeClaudeOut: string | null, fakeExit = 0) {
  const base = mkdtempSync(join(tmpdir(), "cc-receipts-test-"));
  dirs.push(base);
  const bin = join(base, "bin");
  const home = join(base, "home");
  const tmp = join(base, "tmp");
  for (const d of [bin, home, tmp]) mkdirSync(d);
  if (fakeClaudeOut !== null) {
    const fake = join(bin, "claude");
    writeFileSync(
      fake,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${fakeClaudeOut}'\nexit ${fakeExit}\n`,
    );
    chmodSync(fake, 0o755);
  }
  const env: Record<string, string> = {
    HOME: home,
    TMPDIR: tmp,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    USER: "test-user",
  };
  return { base, home, tmp, env };
}

function run(
  script: string,
  input: string,
  env: Record<string, string>,
  args: string[] = [],
) {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    input,
    encoding: "utf8",
    env,
    timeout: 20_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function transcript(
  base: string,
  assistantText: string,
  toolUse = true,
): string {
  const p = join(base, "transcript.jsonl");
  const lines = [
    {
      type: "user",
      message: { role: "user", content: "why does the build fail?" },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: assistantText },
          ...(toolUse
            ? [{ type: "tool_use", name: "Read", input: { path: "a.txt" } }]
            : []),
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ text: "line 1" }, "line 2"],
          },
        ],
      },
    },
    "not json",
  ];
  writeFileSync(
    p,
    lines
      .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
      .join("\n"),
  );
  return p;
}

const CLAIM =
  "I looked at the logs and the bug is a missing semicolon in the parser config.";

describe("ClaimEvidenceGuard.js", () => {
  it("exits 0 on empty input, invalid JSON, an active stop hook and mode off", () => {
    const s = sandbox(null);
    expect(run("ClaimEvidenceGuard.js", "", s.env).code).toBe(0);
    expect(run("ClaimEvidenceGuard.js", "{not json", s.env).code).toBe(0);
    expect(
      run(
        "ClaimEvidenceGuard.js",
        JSON.stringify({ stop_hook_active: true }),
        s.env,
      ).code,
    ).toBe(0);
    const off = run(
      "ClaimEvidenceGuard.js",
      JSON.stringify({ last_assistant_message: CLAIM }),
      {
        ...s.env,
        CLAIM_EVIDENCE_MODE: "off",
      },
    );
    expect(off.code).toBe(0);
    expect(existsSync(join(s.home, ".claude", "claim-evidence.jsonl"))).toBe(
      false,
    );
  });

  it("exits 0 without logging when there is no claim or the text is short", () => {
    const s = sandbox(null);
    expect(
      run(
        "ClaimEvidenceGuard.js",
        JSON.stringify({ last_assistant_message: "short" }),
        s.env,
      ).code,
    ).toBe(0);
    const none = run(
      "ClaimEvidenceGuard.js",
      JSON.stringify({
        last_assistant_message:
          "Here is a summary of the files in the folder, nothing more.",
      }),
      s.env,
    );
    expect(none.code).toBe(0);
    expect(existsSync(join(s.home, ".claude", "claim-evidence.jsonl"))).toBe(
      false,
    );
  });

  it("audits a claim from the transcript: logs the judge's verdict and never blocks", () => {
    const s = sandbox('{"verdict":"DENY","reason":"no evidence"}');
    const t = transcript(s.base, CLAIM);
    const r = run(
      "ClaimEvidenceGuard.js",
      JSON.stringify({ transcript_path: t, session_id: "s1" }),
      s.env,
    );
    expect(r.code).toBe(0);
    const entry = JSON.parse(
      readFileSync(
        join(s.home, ".claude", "claim-evidence.jsonl"),
        "utf8",
      ).trim(),
    ) as Record<string, unknown>;
    expect(entry).toMatchObject({
      session_id: "s1",
      claim_pattern: "the_bug_is",
      verdict: "DENY",
      verdict_reason: "no evidence",
      mode: "audit",
      blocking: false,
      tool_use_count: 1,
      instance: "test-user",
    });
  });

  it("blocks a denied claim in block mode, with exit 2 and the reason on stderr", () => {
    const s = sandbox('{"verdict":"DENY","reason":"no evidence"}');
    const log = join(s.base, "custom", "log.jsonl");
    const r = run(
      "ClaimEvidenceGuard.js",
      JSON.stringify({ last_assistant_message: CLAIM }),
      {
        ...s.env,
        CLAIM_EVIDENCE_MODE: "block",
        CLAIM_EVIDENCE_LOG: log,
      },
    );
    expect(r.code).toBe(2);
    expect(JSON.parse(r.err.trim()) as { decision: string }).toMatchObject({
      decision: "block",
    });
    expect(
      JSON.parse(readFileSync(log, "utf8").trim()) as { blocking: boolean },
    ).toMatchObject({ blocking: true });
  });

  it("lets an approved claim through in block mode", () => {
    const s = sandbox('{"verdict":"APPROVE","reason":"cited"}');
    const r = run(
      "ClaimEvidenceGuard.js",
      JSON.stringify({ last_assistant_message: CLAIM }),
      {
        ...s.env,
        CLAIM_EVIDENCE_MODE: "block",
      },
    );
    expect(r.code).toBe(0);
  });

  it("escalates when the judge fails or answers garbage", () => {
    const failing = sandbox("", 3);
    run(
      "ClaimEvidenceGuard.js",
      JSON.stringify({ last_assistant_message: CLAIM }),
      failing.env,
    );
    const e1 = JSON.parse(
      readFileSync(
        join(failing.home, ".claude", "claim-evidence.jsonl"),
        "utf8",
      ).trim(),
    ) as {
      verdict: string;
      verdict_reason: string;
    };
    expect(e1.verdict).toBe("ESCALATE");
    expect(e1.verdict_reason).toBe("LLM call failed exit=3");

    const garbage = sandbox("no json here");
    run(
      "ClaimEvidenceGuard.js",
      JSON.stringify({ last_assistant_message: CLAIM }),
      garbage.env,
    );
    const e2 = JSON.parse(
      readFileSync(
        join(garbage.home, ".claude", "claim-evidence.jsonl"),
        "utf8",
      ).trim(),
    ) as {
      verdict_reason: string;
    };
    expect(e2.verdict_reason).toBe("unparseable LLM output");
  });
});

describe("BackgroundReview.js", () => {
  it("exits 0 on empty input, invalid JSON, an active stop hook, mode off and a trivial turn", () => {
    const s = sandbox(null);
    expect(run("BackgroundReview.js", "", s.env).code).toBe(0);
    expect(run("BackgroundReview.js", "{bad", s.env).code).toBe(0);
    expect(
      run(
        "BackgroundReview.js",
        JSON.stringify({ stop_hook_active: true }),
        s.env,
      ).code,
    ).toBe(0);
    expect(
      run(
        "BackgroundReview.js",
        JSON.stringify({ last_assistant_message: CLAIM }),
        {
          ...s.env,
          BACKGROUND_REVIEW_MODE: "off",
        },
      ).code,
    ).toBe(0);
    // No user message found: the turn is skipped, nothing is written.
    expect(
      run(
        "BackgroundReview.js",
        JSON.stringify({ last_assistant_message: CLAIM }),
        s.env,
      ).code,
    ).toBe(0);
    expect(readdirSync(s.tmp)).toEqual([]);
  });

  it("hands a real turn to the worker through two temp files", () => {
    const s = sandbox(null);
    const t = transcript(s.base, CLAIM, false);
    const r = run(
      "BackgroundReview.js",
      JSON.stringify({ transcript_path: t, session_id: "s2" }),
      s.env,
    );
    expect(r.code).toBe(0);
    // The worker it launches lives under HOME/.claude/hooks/lib, which this
    // sandbox does not have, so the two message files stay behind as proof.
    const files = readdirSync(s.tmp).filter((f) => f.startsWith("bgreview-"));
    expect(files).toHaveLength(2);
    const user = files.find((f) => f.startsWith("bgreview-user-")) as string;
    expect(readFileSync(join(s.tmp, user), "utf8")).toBe(
      "why does the build fail?",
    );
  });
});

describe("background-review-worker.js", () => {
  function msgFiles(base: string) {
    const u = join(base, "u.txt");
    const a = join(base, "a.txt");
    writeFileSync(u, "user words");
    writeFileSync(a, "assistant words");
    return { u, a };
  }

  it("exits 1 without the required arguments or when a message file is missing", () => {
    const s = sandbox(null);
    expect(run("background-review-worker.js", "", s.env).code).toBe(1);
    const r = run("background-review-worker.js", "", s.env, [
      "--log",
      join(s.base, "l.jsonl"),
      "--user-msg-file",
      join(s.base, "missing"),
      "--assistant-msg-file",
      join(s.base, "missing2"),
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("read failed");
  });

  it("writes the classifier's recommendation and removes the message files", () => {
    const s = sandbox(
      '{"category":"NEW_FEEDBACK_RULE","reason":"a rule","resonance_score":0.8,"themes":["a","b","c","d","e","f"],"proposed_slug":"slug"}',
    );
    const { u, a } = msgFiles(s.base);
    const log = join(s.base, "out", "rec.jsonl");
    const r = run("background-review-worker.js", "", s.env, [
      "--session-id",
      "s3",
      "--instance",
      "i1",
      "--mode",
      "shadow",
      "--log",
      log,
      "--user-msg-file",
      u,
      "--assistant-msg-file",
      a,
    ]);
    expect(r.code).toBe(0);
    const entry = JSON.parse(readFileSync(log, "utf8").trim()) as Record<
      string,
      unknown
    >;
    expect(entry).toMatchObject({
      session_id: "s3",
      instance: "i1",
      mode: "shadow",
      category: "NEW_FEEDBACK_RULE",
      resonance_score: 0.8,
      proposed_slug: "slug",
    });
    expect(entry.themes).toHaveLength(5);
    expect(existsSync(u) || existsSync(a)).toBe(false);
  });

  it("records a parse error when the classifier fails or answers outside the categories", () => {
    for (const [out, code, reason] of [
      ["", 4, "exit 4"],
      ['{"category":"SOMETHING_ELSE"}', 0, "unparseable"],
    ] as const) {
      const s = sandbox(out, code);
      const { u, a } = msgFiles(s.base);
      const log = join(s.base, "rec.jsonl");
      run("background-review-worker.js", "", s.env, [
        "--log",
        log,
        "--user-msg-file",
        u,
        "--assistant-msg-file",
        a,
      ]);
      const entry = JSON.parse(readFileSync(log, "utf8").trim()) as {
        category: string;
        reason: string;
        mode: string;
      };
      expect(entry.category).toBe("PARSE_ERROR");
      expect(entry.reason).toContain(reason);
      expect(entry.mode).toBe("active");
    }
  });
});
