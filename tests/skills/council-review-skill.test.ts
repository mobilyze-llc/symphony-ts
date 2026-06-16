import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SKILL_ROOT = resolve(ROOT, "skills/council-review");
const ASSERT_CLEAN_PASS = resolve(SKILL_ROOT, "scripts/assert-clean-pass.py");
const WRITE_REVIEW_TARGET = resolve(
  SKILL_ROOT,
  "scripts/write-review-target-artifacts.py",
);

function readSkillFile(path: string): string {
  return readFileSync(resolve(SKILL_ROOT, path), "utf-8");
}

function expectAll(content: string, snippets: readonly string[]): void {
  for (const snippet of snippets) {
    expect(content).toContain(snippet);
  }
}

function uniqueMatches(content: string, pattern: RegExp): string[] {
  return [...new Set(content.match(pattern) ?? [])];
}

function withArtifactDir(callback: (dir: string) => void): void {
  const dir = mkdtempSync(resolve(tmpdir(), "council-review-test-"));
  try {
    callback(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function writeArtifact(dir: string, name: string, content: string): void {
  writeFileSync(resolve(dir, name), content, "utf-8");
}

function writeJsonArtifact(
  dir: string,
  name: string,
  content: Record<string, unknown>,
): void {
  writeArtifact(dir, name, `${JSON.stringify(content)}\n`);
}

function readArtifact(dir: string, name: string): string {
  return readFileSync(resolve(dir, name), "utf-8").trim();
}

function runPython(script: string, dir: string, args: string[] = []) {
  return spawnSync("python3", [script, ...args, dir], { encoding: "utf-8" });
}

function runCloseoutAssert(dir: string) {
  return runPython(ASSERT_CLEAN_PASS, dir, ["--closeout"]);
}

function requiredArtifactsFromAssertScript(): string[] {
  const source = readFileSync(ASSERT_CLEAN_PASS, "utf-8");
  const match = /REQUIRED_ARTIFACTS = \(([\s\S]*?)\)/.exec(source);
  expect(match).not.toBeNull();
  return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)]
    .map((artifactMatch) => artifactMatch[1])
    .filter((artifact): artifact is string => artifact !== undefined);
}

function laneArtifactStemsFromAssertScript(): string[] {
  const source = readFileSync(ASSERT_CLEAN_PASS, "utf-8");
  const match = /LANE_ARTIFACT_STEMS = \(([\s\S]*?)\)/.exec(source);
  expect(match).not.toBeNull();
  return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)]
    .map((artifactMatch) => artifactMatch[1])
    .filter((artifact): artifact is string => artifact !== undefined);
}

function phase1ArtifactNamesFromSkill(skill: string): string[] {
  const phase1End = skill.indexOf("### Phase 2: Cross-Examination");
  expect(phase1End).toBeGreaterThan(0);
  const phase1 = skill.slice(0, phase1End);
  return [
    ...new Set(
      [...phase1.matchAll(/--artifact-name\s+([A-Za-z0-9-]+)/g)]
        .map((match) => match[1])
        .filter((artifact): artifact is string => artifact !== undefined),
    ),
  ].sort();
}

function mergeAuthoritativePhase1ArtifactNamesFromSkill(
  skill: string,
): string[] {
  return phase1ArtifactNamesFromSkill(skill).filter(
    (artifact) => artifact !== "kimi-k27-shadow",
  );
}

function assertCleanPassInvocationShapesFromSkill(
  skill: string,
): Array<"bare" | "closeout"> {
  const shapes = new Set<"bare" | "closeout">();
  for (const match of skill.matchAll(
    /assert-clean-pass\.py(?:["`])?(?:\s+(--closeout))?/g,
  )) {
    shapes.add(match[1] === "--closeout" ? "closeout" : "bare");
  }
  return [...shapes].sort();
}

function writeBaseSetupFacts(dir: string): void {
  writeArtifact(dir, "pr-view-exit-code.txt", "0\n");
  writeArtifact(dir, "git-status-short.txt", "");
  writeArtifact(
    dir,
    "local-head-sha.txt",
    "1111111111111111111111111111111111111111\n",
  );
  writeArtifact(
    dir,
    "resolved-base-sha.txt",
    "2222222222222222222222222222222222222222\n",
  );
  writeArtifact(dir, "resolved-base-ref.txt", "origin/main\n");
  writeArtifact(
    dir,
    "pr.json",
    JSON.stringify({
      baseRefName: "main",
      baseRefOid: "2222222222222222222222222222222222222222",
      headRefOid: "1111111111111111111111111111111111111111",
      isDraft: true,
    }),
  );
}

function writeCleanPassArtifacts(dir: string): void {
  writeArtifact(dir, "pr-mode.txt", "PR-backed draft\n");
  writeArtifact(dir, "pr-is-draft.txt", "true\n");
  writeArtifact(dir, "pr-view-exit-code.txt", "0\n");
  writeArtifact(dir, "git-status-short.txt", "");
  writeArtifact(dir, "pr-diff-provenance.txt", "match\n");
  writeArtifact(dir, "pr-base-equivalence.txt", "exact\n");
  writeArtifact(
    dir,
    "pr-head-sha.txt",
    "1111111111111111111111111111111111111111\n",
  );
  writeArtifact(
    dir,
    "local-head-sha.txt",
    "1111111111111111111111111111111111111111\n",
  );
  writeArtifact(
    dir,
    "pr-base-sha.txt",
    "2222222222222222222222222222222222222222\n",
  );
  writeArtifact(
    dir,
    "resolved-base-sha.txt",
    "2222222222222222222222222222222222222222\n",
  );
  writeKimiDisabledMarker(dir);
}

function writeKimiDisabledMarker(
  dir: string,
  reason = "disabled-by-config",
): void {
  writeJsonArtifact(dir, "kimi-k27-shadow.disabled.json", {
    enabled: false,
    reason,
    mergeAuthoritative: false,
  });
}

function writeCompletedLaneStatus(
  dir: string,
  stem: string,
  message = "Review complete",
): void {
  writeArtifact(
    dir,
    `${stem}.status.json`,
    JSON.stringify({
      schema: "agent-harness.lane-status.v1",
      agent: "claude",
      lane: stem,
      phase: stem,
      state: "complete",
      message,
      artifact: resolve(dir, `${stem}.md`),
    }),
  );
}

function validReviewArtifact(): string {
  return [
    "## Verdict",
    "PASS",
    "",
    "## Artifact Quality",
    "Current head SHA: 1111111111111111111111111111111111111111.",
    "Reviewed the current PR-backed draft artifact and found the evidence surface complete.",
    "The cmux status message was treated as diagnostic; this Markdown body is the authority.",
    "",
    "## No Findings",
    "No P1/P2 findings. I inspected the reviewed diff against the current head and found no merge-blocking correctness, security, API-contract, or test-proof gaps.",
    "",
    "## P1 Must Fix",
    "None",
    "",
    "## P2 Should Fix",
    "None",
    "",
    "## Track",
    "None",
    "",
  ].join("\n");
}

function validPhase2CrossExamArtifact(): string {
  return [
    "### Reviewer Alpha Finding: Example edge-case claim",
    "",
    "**Verdict**: REFUTE",
    "**Evidence**: Current head SHA 1111111111111111111111111111111111111111 was inspected. The alleged failure is not reachable because the guarded branch returns before artifact validation.",
    "",
    "### Reviewer Beta Finding: Example follow-up claim",
    "",
    "**Verdict**: CONFIRM",
    "**Evidence**: The cross-exam lane is intentionally shaped around finding-by-finding confirmation, not the phase-1 reviewer artifact contract.",
    "",
  ].join("\n");
}

function malformedReviewArtifactWithContractSubstrings(): string {
  return [
    "Council status summary for current head SHA 1111111111111111111111111111111111111111.",
    "This summary mentions ## Verdict and PASS in prose, but it does not start with the required verdict section.",
    "It also mentions ## Artifact Quality and ## P1 Must Fix inline while avoiding real Markdown section headings.",
    "The remaining text is padded so it is comfortably over the minimum byte threshold without becoming contract-valid review evidence.",
    "A compliant artifact needs actual headings and either a No Findings section or the full structured finding surface.",
    "This document is deliberately malformed and must fail closed even though it contains all of the important words.",
    "",
  ].join("\n");
}

describe("council-review manual skill", () => {
  const skill = readSkillFile("SKILL.md");
  const opusPrompt = readSkillFile("templates/phase1-opus-prompt.md");
  const piPrompt = readSkillFile("templates/phase1-pi-prompt.md");
  const codexCrossExam = readSkillFile("templates/cross-exam-codex-prompt.md");
  const opusCrossExam = readSkillFile("templates/cross-exam-opus-prompt.md");
  const reportTemplate = readSkillFile("templates/council-report.md");
  const cycleReport = readSkillFile("templates/cycle-report.md");
  const cliReference = readSkillFile("cli-reference.md");
  const kimiPrompt = readSkillFile("templates/phase1-kimi-shadow-prompt.md");

  it("defines distinct initial and convergence review modes", () => {
    for (const prompt of [opusPrompt, piPrompt]) {
      expectAll(prompt, [
        "Initial broad pass:",
        "Convergence pass:",
        "`previous_reviewed_head..HEAD`",
        "semantic",
        "Do not reopen unrelated P3/Track items",
      ]);
    }

    expectAll(skill, [
      "initial broad pass",
      "convergence passes",
      "`previous_reviewed_head..HEAD`",
      "falsify the named invariant",
    ]);
  });

  it("requires current-head evidence for every P1/P2", () => {
    for (const prompt of [opusPrompt, piPrompt, codexCrossExam]) {
      expectAll(prompt, [
        "Current head SHA",
        "Exact file:line evidence",
        "contract violated",
        "reachable failure mode",
        "test/proof gap",
      ]);
    }

    expectAll(reportTemplate, [
      "current-head file:line",
      "contract violated",
      "reachable failure mode",
      "test/proof gap",
    ]);
  });

  it("does not let stale or degraded artifacts become blockers by themselves", () => {
    for (const prompt of [
      opusPrompt,
      piPrompt,
      codexCrossExam,
      opusCrossExam,
    ]) {
      expectAll(prompt, [
        "Stale-base",
        "degraded-lane",
        "not merge-blocking by itself",
      ]);
    }

    expect(reportTemplate).toContain(
      "Stale-base, degraded-lane, malformed, partial, or empty artifact evidence is unavailable evidence",
    );
  });

  it("keeps documented clean-pass command shapes accepted by the helper", () => {
    const shapes = assertCleanPassInvocationShapesFromSkill(skill);
    expect(shapes).toEqual(["bare", "closeout"]);

    withArtifactDir((dir) => {
      for (const shape of shapes) {
        const args = shape === "closeout" ? ["--closeout"] : [];
        const result = runPython(ASSERT_CLEAN_PASS, dir, args);
        expect(result.status).not.toBe(2);
        expect(result.stderr).not.toContain(
          "usage: assert-clean-pass.py [--closeout] COUNCIL_DIR",
        );
      }

      const unknownFlag = runPython(ASSERT_CLEAN_PASS, dir, ["--bogus"]);
      expect(unknownFlag.status).toBe(2);
      expect(unknownFlag.stderr).toContain(
        "usage: assert-clean-pass.py [--closeout] COUNCIL_DIR",
      );
    });
  });

  it("forces cold-read Track items and reviewer immutability", () => {
    for (const prompt of [
      opusPrompt,
      piPrompt,
      codexCrossExam,
      opusCrossExam,
    ]) {
      expectAll(prompt, [
        "cold-read acceptance criteria",
        "source refs",
        "verification steps",
        "Do not edit files, create commits, update PRs",
        "mutate the target worktree",
      ]);
    }
  });

  it("records cap-hit and same-family operator decision behavior", () => {
    expectAll(skill, [
      "same-family finding reopens",
      "operator-decision brief",
      "Do not silently launch another broad review loop.",
    ]);

    expectAll(reportTemplate, [
      "Operator Decision Brief",
      "round cap is hit",
      "same family reopens twice",
      "Exact next question",
    ]);
  });

  it("covers Opus cross-exam template variables in setup instructions", () => {
    const start = skill.indexOf(
      "If both Opus and Pi succeeded in Phase 1, also ask Opus",
    );
    const end = skill.indexOf("```bash", start);
    const opusSetup = skill.slice(start, end);
    const templateTokens = [
      ...uniqueMatches(opusCrossExam, /\{[A-Z_]+\}/g),
      ...uniqueMatches(opusCrossExam, /\[content from [^\]]+\]/g),
    ];

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    for (const expected of [
      "{WORKSPACE_PATH}",
      "{BASE_BRANCH}",
      "{REVIEW_MODE}",
      "{CURRENT_HEAD_SHA}",
      "{PREVIOUS_REVIEWED_HEAD_SHA}",
      "{ARTIFACT_STATUS}",
      "[content from Reviewer Beta Phase 1 findings]",
    ]) {
      expect(templateTokens).toContain(expected);
    }
    expectAll(opusSetup, templateTokens);
  });

  it("captures a forward-test that narrows the historical stale Pipeline family", () => {
    const forwardTest = readFileSync(
      resolve(ROOT, "docs/council-review-forward-test.md"),
      "utf-8",
    );

    expectAll(forwardTest, [
      "stale Pipeline attachment",
      "Review mode: convergence pass",
      "`previous_reviewed_head..HEAD`",
      "Do not launch another broad whole-diff round.",
      "unavailable evidence, not as a merge blocker",
    ]);
  });

  it("extracts setup provenance classification into a tested helper", () => {
    expect(skill).toContain("scripts/write-review-target-artifacts.py");
    expect(skill).toContain(
      '"$COUNCIL_REVIEW_SKILL_DIR/scripts/write-review-target-artifacts.py" "$COUNCIL_DIR" || exit 1',
    );
  });

  it("keeps closeout reviewer stems in sync with Phase 1 spawn artifacts only", () => {
    expect(mergeAuthoritativePhase1ArtifactNamesFromSkill(skill)).toEqual(
      laneArtifactStemsFromAssertScript().sort(),
    );
    expect(phase1ArtifactNamesFromSkill(skill)).toContain("kimi-k27-shadow");
    expect(laneArtifactStemsFromAssertScript()).not.toContain(
      "kimi-k27-shadow",
    );
    expect(skill).toContain("--artifact-name phase2-opus");
    expect(laneArtifactStemsFromAssertScript()).not.toContain("phase2-opus");
  });

  it("documents Kimi shadow as optional and non-merge-authoritative", () => {
    expectAll(skill, [
      "SYMPHONY_COUNCIL_KIMI_SHADOW_ENABLED",
      "--agent kimi",
      "--artifact-name kimi-k27-shadow",
      "--lane-id kimi-k27-shadow",
      "kimi-k27-shadow.disabled.json",
      "mergeAuthoritative:false",
      "uncorroborated Kimi finding cannot set a merge-authoritative P1/P2",
    ]);

    expectAll(cliReference, [
      "Kimi K2.7 Shadow",
      "SYMPHONY_COUNCIL_KIMI_SHADOW_ENABLED",
      "--agent kimi",
      "--artifact-name kimi-k27-shadow",
      "--lane-id kimi-k27-shadow",
      "disabled-by-config",
      "substrate-unavailable",
      "preflight-failed",
      "mergeAuthoritative:false",
    ]);

    expectAll(reportTemplate, [
      "Kimi K2.7 Shadow Diagnostics (non-merge-authoritative)",
      "`$COUNCIL_DIR/kimi-k27-shadow.md` or `$COUNCIL_DIR/kimi-k27-shadow.disabled.json`",
      "Kimi diagnostics never contribute to the authoritative P1/P2 tally",
      "[K-shadow]",
    ]);

    expectAll(cycleReport, [
      "Kimi K2.7 shadow diagnostics",
      "mergeAuthoritative:false",
    ]);

    expectAll(kimiPrompt, [
      "non-merge-authoritative",
      "cannot set a P1/P2",
      "mergeAuthoritative:false",
      "Do not edit files, create commits, update PRs",
    ]);
  });

  it("documents closeout evidence as provenance rather than reviewer PASS", () => {
    const assertSource = readFileSync(ASSERT_CLEAN_PASS, "utf-8");

    expectAll(skill, [
      "validates reviewer evidence quality and",
      "a Phase 1 artifact whose verdict is `FINDINGS` can still be",
      "Phase 3 triage remains the authority",
    ]);
    expectAll(assertSource, [
      "A FINDINGS verdict is contract-valid evidence",
      "fail-closed heuristic floor",
      "Diagnostic only",
      "can never independently block a contract-valid artifact",
    ]);
  });

  it("classifies review-target modes and clean-pass outcomes", () => {
    const cases = [
      {
        assertionExit: 0,
        mode: "PR-backed draft",
        provenance: "match",
        setup: (dir: string) => writeBaseSetupFacts(dir),
      },
      {
        assertionExit: 1,
        mode: "PR-backed non-draft deviation",
        provenance: "match",
        setup: (dir: string) => {
          writeBaseSetupFacts(dir);
          writeArtifact(
            dir,
            "pr.json",
            JSON.stringify({
              baseRefName: "main",
              baseRefOid: "2222222222222222222222222222222222222222",
              headRefOid: "1111111111111111111111111111111111111111",
              isDraft: false,
            }),
          );
        },
      },
      {
        assertionExit: 1,
        mode: "DEGRADED dirty working tree",
        provenance: "match",
        setup: (dir: string) => {
          writeBaseSetupFacts(dir);
          writeArtifact(dir, "git-status-short.txt", " M SKILL.md\n");
        },
      },
      {
        assertionExit: 1,
        mode: "DEGRADED gh-unavailable",
        provenance: "unknown",
        setup: (dir: string) => {
          writeBaseSetupFacts(dir);
          rmSync(resolve(dir, "pr.json"));
          writeArtifact(dir, "pr-view-exit-code.txt", "1\n");
          writeArtifact(dir, "pr.stderr", "gh api unavailable\n");
        },
      },
      {
        assertionExit: 1,
        mode: "DEGRADED pr-diff-provenance",
        provenance: "mismatch pr-base-sha",
        setup: (dir: string) => {
          writeBaseSetupFacts(dir);
          writeArtifact(
            dir,
            "pr.json",
            JSON.stringify({
              baseRefName: "main",
              baseRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              headRefOid: "1111111111111111111111111111111111111111",
              isDraft: true,
            }),
          );
        },
      },
      {
        assertionExit: 1,
        mode: "committed branch diff",
        provenance: "none",
        setup: (dir: string) => {
          writeBaseSetupFacts(dir);
          rmSync(resolve(dir, "pr.json"));
          writeArtifact(dir, "pr-view-exit-code.txt", "1\n");
          writeArtifact(dir, "pr.stderr", "no pull requests found\n");
        },
      },
    ];

    for (const testCase of cases) {
      withArtifactDir((dir) => {
        testCase.setup(dir);

        const classify = runPython(WRITE_REVIEW_TARGET, dir);
        expect(classify.status).toBe(0);
        expect(readArtifact(dir, "pr-mode.txt")).toBe(testCase.mode);
        expect(readArtifact(dir, "pr-diff-provenance.txt")).toBe(
          testCase.provenance,
        );

        const assertion = runPython(ASSERT_CLEAN_PASS, dir);
        expect(assertion.status).toBe(testCase.assertionExit);
      });
    }
  });

  it("fails before classification when PR draft state is malformed", () => {
    withArtifactDir((dir) => {
      writeBaseSetupFacts(dir);
      writeArtifact(
        dir,
        "pr.json",
        JSON.stringify({
          baseRefName: "main",
          baseRefOid: "2222222222222222222222222222222222222222",
          headRefOid: "1111111111111111111111111111111111111111",
          isDraft: "true",
        }),
      );

      const classify = runPython(WRITE_REVIEW_TARGET, dir);
      expect(classify.status).toBe(1);
      expect(classify.stderr).toContain(
        "Cannot mechanically assert PR draft state",
      );
      expect(() => readArtifact(dir, "pr-mode.txt")).toThrow();
    });
  });

  it("keeps missing-artifact diagnostics focused", () => {
    for (const missingArtifact of requiredArtifactsFromAssertScript()) {
      withArtifactDir((dir) => {
        writeCleanPassArtifacts(dir);
        rmSync(resolve(dir, missingArtifact));

        const assertion = runPython(ASSERT_CLEAN_PASS, dir);
        expect(assertion.status).toBe(1);
        expect(assertion.stdout).toContain(
          `- missing required artifact: ${missingArtifact}`,
        );
        expect(assertion.stdout).not.toContain("must be");
      });
    }
  });

  it("rejects completed Opus lanes whose artifact is a thin status summary", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeCompletedLaneStatus(
        dir,
        "phase1-opus",
        "Opus review complete: 1 P1 and 2 P2s, artifact quality sound",
      );
      writeArtifact(
        dir,
        "phase1-opus.md",
        "Codex council review ready: P1 test coverage gap + 2 P2 consistency issues identified\n",
      );

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(1);
      expect(assertion.stdout).toContain(
        "phase1-opus: reviewer artifact too thin",
      );
      expect(assertion.stdout).toContain(
        "status-message-only P1/P2 claims are non-authoritative",
      );
      expect(assertion.stdout).toContain(
        "missing required heading '## Verdict'",
      );
    });
  });

  it("rejects clean provenance without a contract-valid reviewer artifact", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(1);
      expect(assertion.stdout).toContain(
        "at least one phase1 reviewer artifact must satisfy the closeout contract",
      );
    });
  });

  it("rejects orphan reviewer artifacts without completed lane status", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeArtifact(dir, "phase1-opus.md", validReviewArtifact());

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(1);
      expect(assertion.stdout).toContain(
        "phase1-opus: reviewer artifact requires complete lane status",
      );
      expect(assertion.stdout).toContain(
        "at least one phase1 reviewer artifact must satisfy the closeout contract",
      );
    });
  });

  it("rejects attempted lanes that only wrote cmux sidecars", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeArtifact(dir, "phase1-opus.cli.json", "{}\n");

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(1);
      expect(assertion.stdout).toContain(
        "phase1-opus: reviewer artifact requires complete lane status",
      );
      expect(assertion.stdout).toContain(
        "phase1-opus: reviewer artifact path does not exist:",
      );
    });
  });

  it("rejects attempted lanes that only wrote usage telemetry", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeCompletedLaneStatus(dir, "phase1-pi");
      writeArtifact(dir, "phase1-pi.md", validReviewArtifact());
      writeArtifact(dir, "phase1-opus.usage.json", "{}\n");

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(1);
      expect(assertion.stdout).toContain(
        "phase1-opus: reviewer artifact requires complete lane status",
      );
    });
  });

  it("reports malformed reviewer lane status JSON distinctly", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeArtifact(dir, "phase1-opus.status.json", "{not-json\n");
      writeArtifact(dir, "phase1-opus.md", validReviewArtifact());

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(1);
      expect(assertion.stdout).toContain(
        "phase1-opus: status JSON is unreadable or malformed",
      );
      expect(assertion.stdout).toContain(
        "phase1-opus: reviewer artifact requires complete lane status",
      );
    });
  });

  it("rejects completed lanes whose canonical artifact is missing", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      const externalArtifact = resolve(dir, "external-opus.md");
      writeArtifact(dir, "external-opus.md", validReviewArtifact());
      writeArtifact(
        dir,
        "phase1-opus.status.json",
        JSON.stringify({
          schema: "agent-harness.lane-status.v1",
          agent: "claude",
          lane: "phase1-opus",
          phase: "phase1-opus",
          state: "complete",
          message: "Review complete",
          artifact: externalArtifact,
        }),
      );

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(1);
      expect(assertion.stdout).toContain(
        "phase1-opus: status is complete but reviewer artifact is missing",
      );
      expect(assertion.stdout).toContain(
        "at least one phase1 reviewer artifact must satisfy the closeout contract",
      );
    });
  });

  it("rejects closeout when Kimi shadow neither wrote an artifact nor a disabled marker", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      rmSync(resolve(dir, "kimi-k27-shadow.disabled.json"));
      writeCompletedLaneStatus(dir, "phase1-opus");
      writeArtifact(dir, "phase1-opus.md", validReviewArtifact());

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(1);
      expect(assertion.stdout).toContain(
        "kimi-k27-shadow: closeout requires either non-empty kimi-k27-shadow.md or valid kimi-k27-shadow.disabled.json",
      );
      expect(assertion.stdout).not.toContain(
        "at least one phase1 reviewer artifact must satisfy the closeout contract",
      );
    });
  });

  it("accepts a non-empty Kimi shadow artifact without counting it as reviewer evidence", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      rmSync(resolve(dir, "kimi-k27-shadow.disabled.json"));
      writeCompletedLaneStatus(dir, "phase1-opus");
      writeArtifact(dir, "phase1-opus.md", validReviewArtifact());
      writeArtifact(
        dir,
        "kimi-k27-shadow.md",
        "Kimi shadow diagnostics only. mergeAuthoritative:false\n",
      );

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(0);
      expect(assertion.stdout).toContain(
        "PASS council-review clean PASS assertion",
      );
    });
  });

  it("accepts an empty Kimi shadow artifact when a valid disabled marker explains it", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeCompletedLaneStatus(dir, "phase1-opus");
      writeArtifact(dir, "phase1-opus.md", validReviewArtifact());
      writeArtifact(dir, "kimi-k27-shadow.md", "");

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(0);
      expect(assertion.stdout).toContain(
        "PASS council-review clean PASS assertion",
      );
    });
  });

  it("rejects malformed Kimi disabled markers", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeCompletedLaneStatus(dir, "phase1-opus");
      writeArtifact(dir, "phase1-opus.md", validReviewArtifact());
      writeArtifact(dir, "kimi-k27-shadow.disabled.json", "{not-json\n");

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(1);
      expect(assertion.stdout).toContain(
        "kimi-k27-shadow: disabled marker JSON is unreadable or malformed",
      );
    });
  });

  it("rejects Kimi disabled markers that are merge-authoritative or use an unknown reason", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeCompletedLaneStatus(dir, "phase1-opus");
      writeArtifact(dir, "phase1-opus.md", validReviewArtifact());
      writeJsonArtifact(dir, "kimi-k27-shadow.disabled.json", {
        enabled: true,
        reason: "not-configured",
        mergeAuthoritative: true,
      });

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(1);
      expect(assertion.stdout).toContain(
        "kimi-k27-shadow: disabled marker must set enabled:false",
      );
      expect(assertion.stdout).toContain(
        "kimi-k27-shadow: disabled marker must set mergeAuthoritative:false",
      );
      expect(assertion.stdout).toContain(
        "kimi-k27-shadow: disabled marker reason must be one of",
      );
    });
  });

  it("accepts completed reviewer artifacts that satisfy the closeout contract", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeCompletedLaneStatus(dir, "phase1-opus");
      writeArtifact(dir, "phase1-opus.md", validReviewArtifact());

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(0);
      expect(assertion.stdout).toContain(
        "PASS council-review clean PASS assertion",
      );
    });
  });

  it("accepts valid FINDINGS artifacts because closeout validates evidence quality", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeCompletedLaneStatus(dir, "phase1-opus");
      writeArtifact(
        dir,
        "phase1-opus.md",
        validReviewArtifact().replace("PASS", "FINDINGS"),
      );

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(0);
      expect(assertion.stdout).toContain(
        "PASS council-review clean PASS assertion",
      );
    });
  });

  it("keeps status blocker claims diagnostic-only for valid artifacts", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeCompletedLaneStatus(
        dir,
        "phase1-opus",
        "Review complete: 2 P1s mentioned in status diagnostics",
      );
      writeArtifact(dir, "phase1-opus.md", validReviewArtifact());

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(0);
      expect(assertion.stdout).toContain(
        "PASS council-review clean PASS assertion",
      );
    });
  });

  it("accepts completed Pi reviewer artifacts that satisfy the closeout contract", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeCompletedLaneStatus(dir, "phase1-pi");
      writeArtifact(dir, "phase1-pi.md", validReviewArtifact());

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(0);
      expect(assertion.stdout).toContain(
        "PASS council-review clean PASS assertion",
      );
    });
  });

  it("does not validate phase2-opus cross-exam artifacts as phase1 reviewer evidence", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeCompletedLaneStatus(dir, "phase1-opus");
      writeArtifact(dir, "phase1-opus.md", validReviewArtifact());
      writeCompletedLaneStatus(dir, "phase2-opus");
      writeArtifact(dir, "phase2-opus.md", validPhase2CrossExamArtifact());

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(0);
      expect(assertion.stdout).toContain(
        "PASS council-review clean PASS assertion",
      );
    });
  });

  it("rejects malformed reviewer artifacts that only mention contract strings", () => {
    withArtifactDir((dir) => {
      writeCleanPassArtifacts(dir);
      writeCompletedLaneStatus(dir, "phase1-opus");
      writeArtifact(
        dir,
        "phase1-opus.md",
        malformedReviewArtifactWithContractSubstrings(),
      );

      const assertion = runCloseoutAssert(dir);
      expect(assertion.status).toBe(1);
      expect(assertion.stdout).toContain(
        "must start with ## Verdict followed by PASS or FINDINGS",
      );
      expect(assertion.stdout).toContain(
        "missing required heading '## Verdict'",
      );
      expect(assertion.stdout).toContain(
        "reviewer artifact must include No Findings or structured finding sections",
      );
    });
  });
});
