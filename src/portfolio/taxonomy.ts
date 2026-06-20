export const PORTFOLIO_CLASSIFIER_VERSION = "portfolio-taxonomy-v1";

export const PORTFOLIO_TEAM_KEYS = ["SYMPH", "MOB"] as const;

export type PortfolioTeamKey = (typeof PORTFOLIO_TEAM_KEYS)[number];

export interface PortfolioInitiativeRef {
  id: string;
  name: string;
}

export interface PortfolioProject {
  kind: "taxonomy" | "intake";
  id: string;
  slugId: string;
  name: string;
  teamKeys: readonly PortfolioTeamKey[];
  keywords: readonly string[];
  initiative?: PortfolioInitiativeRef;
}

export interface ForbiddenPortfolioProject {
  reason: "pipeline_forbidden";
  id: string;
  slugId: string;
  name: string;
  teamKeys: readonly PortfolioTeamKey[];
}

export interface LivePortfolioProject {
  id: string;
  slugId?: string | null;
  name: string;
  teamKeys?: readonly string[];
  initiative?: PortfolioInitiativeRef | null;
}

export interface PortfolioRegistryFinding {
  code:
    | "missing_project"
    | "project_name_mismatch"
    | "project_slug_mismatch"
    | "project_team_mismatch"
    | "initiative_mismatch"
    | "unexpected_portfolio_project";
  projectId: string | null;
  projectName: string;
  expected?: unknown;
  observed?: unknown;
}

export const PORTFOLIO_INTAKE_PROJECT: PortfolioProject = {
  kind: "intake",
  id: "b4bde068-c981-45ae-ad09-0a4e1ee83dcc",
  slugId: "bef77bad782f",
  name: "Portfolio Intake / Needs Classification",
  teamKeys: ["SYMPH", "MOB"],
  keywords: ["intake", "needs classification", "ambiguous", "uncertain"],
};

export const PORTFOLIO_TAXONOMY_PROJECTS: readonly PortfolioProject[] = [
  PORTFOLIO_INTAKE_PROJECT,
  {
    kind: "taxonomy",
    id: "e1eccfc4-7bdd-447a-a6f0-2c9fdb526a91",
    slugId: "f44aa69da075",
    name: "Model Runner & Provider Strategy",
    teamKeys: ["SYMPH", "MOB"],
    keywords: ["model", "provider", "runner", "opus", "codex", "deepseek"],
  },
  {
    kind: "taxonomy",
    id: "1429bf6e-3ded-447c-beb1-a10288040a78",
    slugId: "4df9eedf18c6",
    name: "Spec Quality & Source Intent",
    teamKeys: ["SYMPH", "MOB"],
    keywords: [
      "spec",
      "source intent",
      "acceptance criteria",
      "review readiness",
    ],
  },
  {
    kind: "taxonomy",
    id: "d42eb53c-ace9-46d3-94ac-ca71c1661e72",
    slugId: "aafe20cfe45a",
    name: "Host Fleet & Runner Reliability",
    teamKeys: ["SYMPH", "MOB"],
    keywords: [
      "host",
      "fleet",
      "runner reliability",
      "pro14",
      "pro16",
      "studio",
    ],
  },
  {
    kind: "taxonomy",
    id: "1e392872-1bc4-47e6-a2bb-668485c60870",
    slugId: "b5abbd91ae7f",
    name: "Portfolio Taxonomy & Agent Workflow Tooling",
    teamKeys: ["SYMPH", "MOB"],
    keywords: [
      "portfolio",
      "taxonomy",
      "classification",
      "linear write",
      "agent workflow",
    ],
  },
  {
    kind: "taxonomy",
    id: "660b0b6d-9231-4a26-8a6f-5a1ef1d812e6",
    slugId: "d2ed39661cf8",
    name: "Closeout Intelligence & Context Reuse",
    teamKeys: ["SYMPH", "MOB"],
    keywords: ["closeout", "handoff", "context reuse", "memory"],
  },
  {
    kind: "taxonomy",
    id: "5d5b17a3-7b9f-4401-923d-0355fc42339a",
    slugId: "b1bfbd88832e",
    name: "Decorrelated QA & PR-Gate Proof",
    teamKeys: ["SYMPH", "MOB"],
    keywords: ["review", "qa", "pr-gate", "council", "decorrelated"],
  },
  {
    kind: "taxonomy",
    id: "e771fc0f-4a8c-4f2e-b4d9-4db674427903",
    slugId: "a5a086518ea6",
    name: "Operator Reporting & Fleet Visibility",
    teamKeys: ["SYMPH", "MOB"],
    keywords: ["dashboard", "reporting", "visibility", "slack", "operator"],
  },
  {
    kind: "taxonomy",
    id: "1d730b40-d8dd-45bd-a790-d074373b7170",
    slugId: "fe06c6c3adb9",
    name: "Usage, Cost & Outcome Intelligence",
    teamKeys: ["SYMPH", "MOB"],
    keywords: ["usage", "cost", "budget", "outcome", "token"],
  },
  {
    kind: "taxonomy",
    id: "76fe80ac-4ef6-4340-825b-5bfd7326ef89",
    slugId: "b3bd8e35b969",
    name: "Durable Agent Execution Substrate",
    teamKeys: ["SYMPH", "MOB"],
    keywords: [
      "agent execution",
      "substrate",
      "crabrunner",
      "crabbox",
      "session-orchestrator",
    ],
  },
  {
    kind: "taxonomy",
    id: "e2db3109-a49e-4e30-93cb-5dad2f97dc97",
    slugId: "63e7ffcc0722",
    name: "Platform Hygiene & Maintenance",
    teamKeys: ["SYMPH", "MOB"],
    keywords: ["hygiene", "maintenance", "cleanup", "dependency"],
  },
  {
    kind: "taxonomy",
    id: "33ea13a9-f545-4ac0-9834-8d71e64eda7a",
    slugId: "c17190197cd7",
    name: "Work Isolation & Collision Control",
    teamKeys: ["SYMPH", "MOB"],
    keywords: ["worktree", "collision", "isolation", "scope overlap"],
  },
  {
    kind: "taxonomy",
    id: "14b804e7-b794-4874-ad3f-411c40f8941e",
    slugId: "0a3c4e6d2085",
    name: "Execution Efficiency & Context Quality",
    teamKeys: ["SYMPH", "MOB"],
    keywords: ["efficiency", "context", "token burn", "prompt", "output"],
  },
  {
    kind: "taxonomy",
    id: "2ad1e919-c2dc-4ba0-991c-78abd35da54a",
    slugId: "504a76f36098",
    name: "Runtime Operations & Admission Safety",
    teamKeys: ["SYMPH", "MOB"],
    keywords: [
      "runtime",
      "admission",
      "dispatch",
      "emergency stop",
      "operations",
    ],
  },
  {
    kind: "taxonomy",
    id: "f451ce63-942c-46f5-b194-fe35faadc7e5",
    slugId: "0a0c21a8ca42",
    name: "Review and Merge Trust",
    teamKeys: ["SYMPH", "MOB"],
    keywords: ["merge", "trust", "pull request", "review proof"],
  },
  {
    kind: "taxonomy",
    id: "dce342b7-2b9f-4e4f-a96d-2cbb9afa0a58",
    slugId: "b683cb3581de",
    name: "Durable Stage Execution on Crabrunner",
    teamKeys: ["SYMPH", "MOB"],
    keywords: ["stage execution", "crabrunner", "stage job", "scheduler"],
  },
  {
    kind: "taxonomy",
    id: "f1002259-841d-41fa-8a28-e859c1d5dd4e",
    slugId: "9c1064215e8d",
    name: "Autonomous Backlog Manager & Dispatch Governance",
    teamKeys: ["SYMPH", "MOB"],
    keywords: [
      "backlog manager",
      "standing plan",
      "queue triage",
      "governance",
    ],
  },
  {
    kind: "taxonomy",
    id: "71851d52-ec6e-4c47-bd8b-9b0b14a35c9f",
    slugId: "05fe3eb7a57f",
    name: "Crucible",
    teamKeys: ["MOB"],
    keywords: ["crucible", "crabbox", "crabrunner", "orchestration substrate"],
  },
];

export const FORBIDDEN_PORTFOLIO_PROJECTS: readonly ForbiddenPortfolioProject[] =
  [
    {
      reason: "pipeline_forbidden",
      id: "2d819863-4180-4361-bfa0-3cae38f1bea6",
      slugId: "fdba14472043",
      name: "Pipeline",
      teamKeys: ["SYMPH"],
    },
  ];

export function isPortfolioTeamKey(
  value: string | null | undefined,
): value is PortfolioTeamKey {
  return value === "SYMPH" || value === "MOB";
}

export function normalizePortfolioName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function findPortfolioProject(input: {
  id?: string | null;
  slugId?: string | null;
  name?: string | null;
}): PortfolioProject | null {
  return (
    PORTFOLIO_TAXONOMY_PROJECTS.find((project) =>
      projectMatches(project, input),
    ) ?? null
  );
}

export function findForbiddenPortfolioProject(input: {
  id?: string | null;
  slugId?: string | null;
  name?: string | null;
}): ForbiddenPortfolioProject | null {
  return (
    FORBIDDEN_PORTFOLIO_PROJECTS.find((project) =>
      projectMatches(project, input),
    ) ??
    (input.name !== undefined &&
    input.name !== null &&
    normalizePortfolioName(input.name) === "pipeline"
      ? (FORBIDDEN_PORTFOLIO_PROJECTS[0] ?? null)
      : null)
  );
}

export function validatePortfolioTaxonomyRegistry(
  liveProjects: readonly LivePortfolioProject[],
): PortfolioRegistryFinding[] {
  const findings: PortfolioRegistryFinding[] = [];
  const liveById = new Map(
    liveProjects.map((project) => [project.id, project]),
  );
  const registeredIds = new Set(
    PORTFOLIO_TAXONOMY_PROJECTS.map((project) => project.id),
  );
  const forbiddenIds = new Set(
    FORBIDDEN_PORTFOLIO_PROJECTS.map((project) => project.id),
  );

  for (const expected of PORTFOLIO_TAXONOMY_PROJECTS) {
    const live = liveById.get(expected.id);
    if (live === undefined) {
      findings.push({
        code: "missing_project",
        projectId: expected.id,
        projectName: expected.name,
      });
      continue;
    }
    if (live.name !== expected.name) {
      findings.push({
        code: "project_name_mismatch",
        projectId: expected.id,
        projectName: expected.name,
        expected: expected.name,
        observed: live.name,
      });
    }
    if ((live.slugId ?? null) !== expected.slugId) {
      findings.push({
        code: "project_slug_mismatch",
        projectId: expected.id,
        projectName: expected.name,
        expected: expected.slugId,
        observed: live.slugId ?? null,
      });
    }
    const liveTeams = new Set(live.teamKeys ?? []);
    for (const teamKey of expected.teamKeys) {
      if (!liveTeams.has(teamKey)) {
        findings.push({
          code: "project_team_mismatch",
          projectId: expected.id,
          projectName: expected.name,
          expected: expected.teamKeys,
          observed: live.teamKeys ?? [],
        });
        break;
      }
    }
    if (
      expected.initiative !== undefined &&
      (live.initiative?.id !== expected.initiative.id ||
        live.initiative?.name !== expected.initiative.name)
    ) {
      findings.push({
        code: "initiative_mismatch",
        projectId: expected.id,
        projectName: expected.name,
        expected: expected.initiative,
        observed: live.initiative ?? null,
      });
    }
  }

  for (const live of liveProjects) {
    if (
      (live.teamKeys ?? []).some(isPortfolioTeamKey) &&
      !registeredIds.has(live.id) &&
      !forbiddenIds.has(live.id)
    ) {
      findings.push({
        code: "unexpected_portfolio_project",
        projectId: live.id,
        projectName: live.name,
        observed: live,
      });
    }
  }

  return findings;
}

function projectMatches(
  project: Pick<PortfolioProject, "id" | "slugId" | "name">,
  input: { id?: string | null; slugId?: string | null; name?: string | null },
): boolean {
  if (input.id !== undefined && input.id !== null && input.id === project.id) {
    return true;
  }
  if (
    input.slugId !== undefined &&
    input.slugId !== null &&
    input.slugId === project.slugId
  ) {
    return true;
  }
  return (
    input.name !== undefined &&
    input.name !== null &&
    normalizePortfolioName(input.name) === normalizePortfolioName(project.name)
  );
}
