import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runPortfolioAuditCli } from "../../src/cli/portfolio-audit.js";
import { runPortfolioClassifyCli } from "../../src/cli/portfolio-classify.js";
import { PORTFOLIO_TAXONOMY_PROJECTS } from "../../src/portfolio/taxonomy.js";

describe("portfolio CLI tools", () => {
  const taxonomyProject = PORTFOLIO_TAXONOMY_PROJECTS.find(
    (project) => project.name === "Portfolio Taxonomy & Agent Workflow Tooling",
  )!;

  it("classifies issue files and validates live registry payloads", async () => {
    const issueFile = tempJson({
      results: {
        identifier: "MOB-262",
        title: "Add portfolio taxonomy registry",
        teamKey: "MOB",
        projectId: taxonomyProject.id,
        projectSlug: taxonomyProject.slugId,
        projectName: taxonomyProject.name,
      },
    });
    const classifyIo = captureIo();

    await expect(
      runPortfolioClassifyCli(
        ["classify", "--issue-file", issueFile],
        classifyIo,
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(classifyIo.out())).toMatchObject({
      status: "valid",
      targetProject: { id: taxonomyProject.id },
    });

    const projectsFile = tempJson({
      results: {
        data: {
          projects: {
            nodes: liveProjectNodes(),
          },
        },
      },
    });
    const registryIo = captureIo();

    await expect(
      runPortfolioClassifyCli(
        ["validate-registry", "--projects-file", projectsFile],
        registryIo,
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(registryIo.out())).toEqual({ ok: true, findings: [] });
  });

  it("reports usage errors for malformed classifier input", async () => {
    const io = captureIo();

    await expect(runPortfolioClassifyCli(["classify"], io)).resolves.toBe(1);

    expect(io.err()).toContain("Missing required --issue-file");
    expect(io.err()).toContain("symphony-portfolio-classify classify");
  });

  it("renders audit reports from issue and project files", async () => {
    const issuesFile = tempJson({
      issues: [
        {
          id: "issue-1",
          identifier: "SYMPH-900",
          title: "Runtime admission safety",
          description: "Already classified",
          state: "Todo",
          labels: [],
          blockedBy: [],
          teamKey: "SYMPH",
          projectId: taxonomyProject.id,
          projectSlug: taxonomyProject.slugId,
          projectName: taxonomyProject.name,
          createdAt: "2026-06-20T12:00:00.000Z",
          updatedAt: "2026-06-20T12:00:00.000Z",
        },
      ],
    });
    const projectsFile = tempJson(liveProjectNodes());
    const io = captureIo();

    await expect(
      runPortfolioAuditCli(
        [
          "--issues-file",
          issuesFile,
          "--projects-file",
          projectsFile,
          "--generated-at",
          "2026-06-20T13:00:00.000Z",
          "--intake-stale-days",
          "7",
          "--json",
        ],
        io,
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.out())).toMatchObject({
      ok: true,
      generatedAt: "2026-06-20T13:00:00.000Z",
      issueCount: 1,
    });
  });

  it("exits non-zero when audit arguments are invalid", async () => {
    const io = captureIo();

    await expect(
      runPortfolioAuditCli(
        ["--issues-file", tempJson({ issues: [] }), "--intake-stale-days", "0"],
        io,
      ),
    ).resolves.toBe(1);

    expect(io.err()).toContain("Expected a positive integer");
  });
});

function liveProjectNodes() {
  return PORTFOLIO_TAXONOMY_PROJECTS.map((project) => ({
    id: project.id,
    slugId: project.slugId,
    name: project.name,
    teams: {
      nodes: project.teamKeys.map((key) => ({ key })),
    },
  }));
}

function tempJson(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "portfolio-tools-test-"));
  const path = join(dir, "input.json");
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: (message: string) => {
      stdout.push(message);
      return true;
    },
    stderr: (message: string) => {
      stderr.push(message);
      return true;
    },
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  };
}
