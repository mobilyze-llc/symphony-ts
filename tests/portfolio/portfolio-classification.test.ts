import { describe, expect, it } from "vitest";

import type { Issue } from "../../src/domain/model.js";
import {
  renderPortfolioAuditReport,
  runPortfolioTaxonomyAudit,
} from "../../src/portfolio/audit.js";
import {
  classifyPortfolioIssue,
  upsertPortfolioClassificationBlock,
} from "../../src/portfolio/classifier.js";
import { partitionPortfolioEligibleIssues } from "../../src/portfolio/eligibility.js";
import {
  PORTFOLIO_INTAKE_PROJECT,
  PORTFOLIO_TAXONOMY_PROJECTS,
} from "../../src/portfolio/taxonomy.js";

describe("portfolio classification", () => {
  const taxonomyProject = PORTFOLIO_TAXONOMY_PROJECTS.find(
    (project) => project.name === "Runtime Operations & Admission Safety",
  )!;

  it("accepts issues already assigned to a registered taxonomy project", () => {
    const classification = classifyPortfolioIssue({
      identifier: "SYMPH-900",
      title: "Harden runtime admission",
      teamKey: "SYMPH",
      projectId: taxonomyProject.id,
      projectSlug: taxonomyProject.slugId,
      projectName: taxonomyProject.name,
    });

    expect(classification).toMatchObject({
      status: "valid",
      confidence: "high",
      targetProject: { id: taxonomyProject.id },
      intakeProject: null,
    });
  });

  it("routes Pipeline assignments to portfolio intake instead of treating them as valid taxonomy", () => {
    const classification = classifyPortfolioIssue({
      identifier: "SYMPH-901",
      title: "Runtime admission cleanup",
      teamKey: "SYMPH",
      projectName: "Pipeline",
    });

    expect(classification.status).toBe("intake");
    expect(classification.intakeProject?.id).toBe(PORTFOLIO_INTAKE_PROJECT.id);
    expect(classification.whyUncertain).toContain("forbidden");
  });

  it("holds real SYMPH/MOB candidates with missing project classification", () => {
    const partition = partitionPortfolioEligibleIssues([
      issue({
        id: "issue-1",
        identifier: "SYMPH-902",
        teamKey: "SYMPH",
        projectId: null,
        projectSlug: null,
        projectName: null,
      }),
    ]);

    expect(partition.eligible).toHaveLength(0);
    expect(partition.held[0]?.result).toMatchObject({
      eligible: false,
      reasonCode: "portfolio_project_missing",
    });
  });

  it("does not force old metadata-free unit fixtures into portfolio scope", () => {
    const partition = partitionPortfolioEligibleIssues([
      issue({ id: "issue-1", identifier: "SYMPH-903" }),
    ]);

    expect(partition.eligible.map((entry) => entry.identifier)).toEqual([
      "SYMPH-903",
    ]);
    expect(partition.held).toEqual([]);
  });

  it("audits intake details and registry drift", () => {
    const report = runPortfolioTaxonomyAudit({
      generatedAt: "2026-06-20T12:00:00.000Z",
      issues: [
        issue({
          id: "issue-1",
          identifier: "MOB-904",
          teamKey: "MOB",
          projectId: PORTFOLIO_INTAKE_PROJECT.id,
          projectSlug: PORTFOLIO_INTAKE_PROJECT.slugId,
          projectName: PORTFOLIO_INTAKE_PROJECT.name,
          description:
            "why_uncertain: multiple hints\nCandidate projects: Runtime Operations & Admission Safety",
          createdAt: "2026-06-01T12:00:00.000Z",
        }),
      ],
      liveProjects: [
        {
          id: taxonomyProject.id,
          slugId: taxonomyProject.slugId,
          name: "Renamed Runtime Project",
          teamKeys: ["SYMPH", "MOB"],
        },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.reasonCode).toBe(
      "portfolio_intake_not_selectable",
    );
    expect(report.intake).toMatchObject({
      count: 1,
      staleCount: 1,
      withWhyUncertain: 1,
      withCandidateProjects: 1,
    });
    expect(renderPortfolioAuditReport(report)).toContain(
      "portfolio_intake_not_selectable",
    );
    expect(report.registryFindings.map((finding) => finding.code)).toContain(
      "project_name_mismatch",
    );
  });

  it("upserts the classification block without duplicating it", () => {
    const classification = classifyPortfolioIssue({
      identifier: "SYMPH-905",
      title: "Harden admission",
      teamKey: "SYMPH",
      projectId: taxonomyProject.id,
      projectSlug: taxonomyProject.slugId,
      projectName: taxonomyProject.name,
    });
    const first = upsertPortfolioClassificationBlock(
      "# Body\n\nSome text",
      classification,
    );
    const second = upsertPortfolioClassificationBlock(first, classification);

    expect([
      ...second.matchAll(/^## Portfolio Classification$/gm),
    ]).toHaveLength(1);
    expect(second).toContain(`Project ID: ${taxonomyProject.id}`);
  });
});

function issue(
  input: Partial<Issue> & Pick<Issue, "id" | "identifier">,
): Issue {
  return {
    title: input.identifier,
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...input,
  };
}
