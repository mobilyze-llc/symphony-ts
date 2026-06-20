import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runLinearPortfolioWriteCli } from "../../src/cli/linear-portfolio-write.js";
import {
  PORTFOLIO_INTAKE_PROJECT,
  PORTFOLIO_TAXONOMY_PROJECTS,
} from "../../src/portfolio/taxonomy.js";

describe("symphony-linear-portfolio", () => {
  const taxonomyProject = PORTFOLIO_TAXONOMY_PROJECTS.find(
    (project) => project.name === "Portfolio Taxonomy & Agent Workflow Tooling",
  )!;

  it("dry-runs issue create with an explicit taxonomy project and classification block", async () => {
    const descriptionFile = tempDescription("Body");
    const io = captureIo();

    await expect(
      runLinearPortfolioWriteCli(
        [
          "create",
          "--team",
          "MOB",
          "--title",
          "Enforce portfolio wrapper",
          "--description-file",
          descriptionFile,
          "--project",
          taxonomyProject.name,
          "--dry-run",
        ],
        { io },
      ),
    ).resolves.toBe(0);

    const dryRun = JSON.parse(io.out()) as {
      args: string[];
      description: string;
      classification: { status: string; targetProject: { id: string } };
    };
    expect(dryRun.args).toContain(taxonomyProject.id);
    expect(dryRun.classification).toMatchObject({
      status: "valid",
      targetProject: { id: taxonomyProject.id },
    });
    expect(dryRun.description).toContain("## Portfolio Classification");
    expect(dryRun.description).toContain(`Project ID: ${taxonomyProject.id}`);
  });

  it("dry-runs ambiguous issue creates into portfolio intake", async () => {
    const descriptionFile = tempDescription("No deterministic hints");
    const io = captureIo();

    await expect(
      runLinearPortfolioWriteCli(
        [
          "create",
          "--team",
          "SYMPH",
          "--title",
          "Needs a human classification",
          "--description-file",
          descriptionFile,
          "--dry-run",
        ],
        { io },
      ),
    ).resolves.toBe(0);

    const dryRun = JSON.parse(io.out()) as {
      args: string[];
      classification: { status: string; intakeProject: { id: string } };
    };
    expect(dryRun.args).toContain(PORTFOLIO_INTAKE_PROJECT.id);
    expect(dryRun.classification).toMatchObject({
      status: "intake",
      intakeProject: { id: PORTFOLIO_INTAKE_PROJECT.id },
    });
  });

  it("rejects ambiguous issue edits without a project or existing classification block", async () => {
    const descriptionFile = tempDescription("No deterministic hints");
    const io = captureIo();

    await expect(
      runLinearPortfolioWriteCli(
        [
          "edit",
          "SYMPH-123",
          "--team",
          "SYMPH",
          "--description-file",
          descriptionFile,
          "--dry-run",
        ],
        { io },
      ),
    ).resolves.toBe(1);

    expect(io.err()).toContain(
      "Portfolio edit without --project requires an existing Portfolio Classification block",
    );
  });

  it("dry-runs issue edits that preserve an existing classification block", async () => {
    const descriptionFile = tempDescription(
      [
        "Body",
        "",
        "## Portfolio Classification",
        "",
        `Project: \`${taxonomyProject.name}\``,
        `Project ID: ${taxonomyProject.id}`,
      ].join("\n"),
    );
    const io = captureIo();

    await expect(
      runLinearPortfolioWriteCli(
        [
          "edit",
          "MOB-263",
          "--team",
          "MOB",
          "--description-file",
          descriptionFile,
          "--dry-run",
        ],
        { io },
      ),
    ).resolves.toBe(0);

    const dryRun = JSON.parse(io.out()) as {
      args: string[];
      classification: { status: string; targetProject: { id: string } };
    };
    expect(dryRun.args).toContain(taxonomyProject.id);
    expect(dryRun.classification).toMatchObject({
      status: "repair",
      targetProject: { id: taxonomyProject.id },
    });
  });

  it("runs edit commands through the configured linear binary", async () => {
    const descriptionFile = tempDescription("Body");
    const io = captureIo();
    let generatedDescriptionFile: string | null = null;
    const runCommand = vi.fn(async (_command, args) => {
      generatedDescriptionFile =
        args[args.indexOf("--description-file") + 1] ?? null;
      expect(generatedDescriptionFile).not.toBeNull();
      expect(readFileSync(generatedDescriptionFile!, "utf8")).toContain(
        "## Portfolio Classification",
      );
      return "updated";
    });

    await expect(
      runLinearPortfolioWriteCli(
        [
          "edit",
          "MOB-263",
          "--team",
          "MOB",
          "--title",
          "Wrap Linear writes",
          "--description-file",
          descriptionFile,
          "--project",
          taxonomyProject.slugId,
          "--linear-bin",
          "/tmp/linear-pp-cli",
        ],
        { io, runCommand },
      ),
    ).resolves.toBe(0);

    expect(runCommand).toHaveBeenCalledWith(
      "/tmp/linear-pp-cli",
      expect.arrayContaining([
        "issues",
        "edit",
        "MOB-263",
        "--project",
        taxonomyProject.id,
        "--agent",
      ]),
    );
    expect(generatedDescriptionFile).not.toBeNull();
    expect(existsSync(generatedDescriptionFile!)).toBe(false);
    expect(io.out()).toBe("updated\n");
  });

  it("prints usage on invalid wrapper commands", async () => {
    const io = captureIo();

    await expect(
      runLinearPortfolioWriteCli(["delete", "MOB-263"], { io }),
    ).resolves.toBe(1);

    expect(io.err()).toContain("Unknown command: delete");
    expect(io.err()).toContain("symphony-linear-portfolio create");
  });
});

function tempDescription(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "linear-portfolio-write-test-"));
  const path = join(dir, "description.md");
  writeFileSync(path, body);
  return path;
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: (message: string) => stdout.push(message),
    stderr: (message: string) => stderr.push(message),
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  };
}
