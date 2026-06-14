const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state {
    name
  }
  labels {
    nodes {
      name
    }
  }
  inverseRelations(first: $relationFirst) {
    nodes {
      type
      issue {
        id
        identifier
        state {
          name
        }
      }
    }
    pageInfo {
      hasNextPage
    }
  }
`;

const TICKET_FEATURE_ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  branchName
  url
  createdAt
  updatedAt
  state {
    name
  }
  labels {
    nodes {
      name
    }
  }
  creator {
    id
    name
    displayName
    email
  }
  parent {
    id
    identifier
    title
    state {
      name
    }
  }
  inverseRelations(first: $relationFirst) {
    nodes {
      id
      type
      createdAt
      issue {
        id
        identifier
        title
        state {
          name
        }
      }
      relatedIssue {
        id
        identifier
        title
        state {
          name
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
  history(first: $historyFirst) {
    nodes {
      createdAt
      actor {
        id
        name
        displayName
        email
      }
      botActor {
        id
        type
        subType
        name
        userDisplayName
      }
      relationChanges {
        identifier
        type
      }
      toParent {
        id
        identifier
        title
        state {
          name
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`;

export const LINEAR_CANDIDATE_ISSUES_QUERY = `
  query SymphonyCandidateIssues(
    $projectSlug: String!
    $activeStates: [String!]!
    $first: Int!
    $relationFirst: Int!
    $after: String
  ) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $activeStates } }
      }
      orderBy: createdAt
    ) {
      nodes {
        ${ISSUE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`.trim();

export const LINEAR_ISSUES_BY_STATES_QUERY = `
  query SymphonyIssuesByStates(
    $projectSlug: String!
    $stateNames: [String!]!
    $first: Int!
    $relationFirst: Int!
    $after: String
  ) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $stateNames } }
      }
      orderBy: createdAt
    ) {
      nodes {
        ${ISSUE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`.trim();

export const LINEAR_ISSUE_BY_IDENTIFIER_QUERY = `
  query SymphonyIssueByIdentifier(
    $identifier: String!
    $relationFirst: Int!
  ) {
    issue(id: $identifier) {
      ${ISSUE_FIELDS}
    }
  }
`.trim();

export const LINEAR_TICKET_FEATURE_ISSUES_QUERY = `
  query SymphonyTicketFeatureIssues(
    $projectSlug: String!
    $stateNames: [String!]!
    $first: Int!
    $relationFirst: Int!
    $historyFirst: Int!
    $after: String
  ) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $stateNames } }
      }
      orderBy: createdAt
    ) {
      nodes {
        ${TICKET_FEATURE_ISSUE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`.trim();

export const LINEAR_ISSUE_STATES_BY_IDS_QUERY = `
  query SymphonyIssueStatesByIds($issueIds: [ID!]!) {
    issues(filter: { id: { in: $issueIds } }) {
      nodes {
        id
        identifier
        state {
          name
        }
      }
    }
  }
`.trim();

export const LINEAR_WORKFLOW_STATES_QUERY = `
  query SymphonyWorkflowStates($teamKey: String!) {
    workflowStates(filter: { team: { key: { eq: $teamKey } } }) {
      nodes {
        id
        name
      }
    }
  }
`.trim();

export const LINEAR_ISSUE_UPDATE_MUTATION = `
  mutation SymphonyIssueUpdate($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
      issue {
        id
        state {
          name
        }
      }
    }
  }
`.trim();

export const LINEAR_CREATE_COMMENT_MUTATION = `
  mutation SymphonyCreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment {
        id
      }
    }
  }
`.trim();

export const LINEAR_UPDATE_ISSUE_DESCRIPTION_MUTATION = `
  mutation SymphonyUpdateIssueDescription($issueId: String!, $description: String!) {
    issueUpdate(id: $issueId, input: { description: $description }) {
      success
      issue {
        id
        identifier
        title
      }
    }
  }
`.trim();

export const LINEAR_ISSUES_BY_LABELS_QUERY = `
  query SymphonyIssuesByLabels(
    $projectSlug: String!
    $labelNames: [String!]!
    $first: Int!
    $relationFirst: Int!
    $after: String
  ) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        labels: { name: { in: $labelNames } }
      }
      orderBy: createdAt
    ) {
      nodes {
        ${ISSUE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`.trim();

export const LINEAR_ISSUE_PARENT_AND_SIBLINGS_QUERY = `
  query SymphonyIssueParentAndSiblings($issueId: String!) {
    issue(id: $issueId) {
      id
      identifier
      parent {
        id
        identifier
        state {
          name
        }
        children {
          nodes {
            id
            identifier
            state {
              name
            }
          }
        }
      }
    }
  }
`.trim();

export const LINEAR_ISSUE_PARENT_DETAIL_QUERY = `
  query SymphonyIssueParentDetail($issueId: String!) {
    issue(id: $issueId) {
      id
      identifier
      parent {
        identifier
        title
        url
      }
    }
  }
`.trim();

export const LINEAR_CREATE_ISSUE_MUTATION = `
  mutation SymphonyCreateIssue(
    $teamId: String!
    $title: String!
    $projectId: String!
    $labelIds: [String!]!
    $description: String
    $parentId: String
  ) {
    issueCreate(input: {
      teamId: $teamId
      title: $title
      projectId: $projectId
      labelIds: $labelIds
      description: $description
      parentId: $parentId
    }) {
      success
      issue {
        id
        identifier
        title
        state {
          name
        }
      }
    }
  }
`.trim();

export const LINEAR_ISSUE_DETAILS_BY_IDS_QUERY = `
  query SymphonyIssueDetailsByIds($issueIds: [ID!]!) {
    issues(filter: { id: { in: $issueIds } }) {
      nodes {
        id
        identifier
        title
        description
        url
        team {
          id
          key
        }
        project {
          id
          slugId
        }
        labels {
          nodes {
            name
          }
        }
        parent {
          id
          identifier
          title
          url
        }
      }
    }
  }
`.trim();

// $projectId must be ID! — the project IDComparator position expects ID, and
// Linear's GraphQL validation rejects String! variables in ID positions with
// HTTP 400 GRAPHQL_VALIDATION_FAILED (SYMPH-413, verified live 2026-06-11).
export const LINEAR_OPEN_ISSUES_BY_TITLE_QUERY = `
  query SymphonyOpenIssuesByTitle(
    $projectId: ID!
    $title: String!
    $excludeStateNames: [String!]!
    $first: Int!
  ) {
    issues(
      first: $first
      filter: {
        project: { id: { eq: $projectId } }
        title: { eq: $title }
        state: { name: { nin: $excludeStateNames } }
      }
      orderBy: updatedAt
    ) {
      nodes {
        id
        identifier
        title
        description
        url
        team {
          id
          key
        }
        project {
          id
          slugId
        }
        labels {
          nodes {
            name
          }
        }
        parent {
          id
          identifier
          title
          url
        }
      }
    }
  }
`.trim();

export const LINEAR_ISSUE_LABELS_BY_NAMES_QUERY = `
  query SymphonyIssueLabelsByNames($teamKey: String!, $labelNames: [String!]!) {
    issueLabels(
      first: 50
      filter: {
        or: [
          { team: { null: true } }
          { team: { key: { eq: $teamKey } } }
        ]
        name: { in: $labelNames }
      }
    ) {
      nodes {
        id
        name
      }
    }
  }
`.trim();

export const LINEAR_ISSUE_DETAILS_UPDATE_MUTATION = `
  mutation SymphonyIssueDetailsUpdate(
    $issueId: String!
    $description: String!
    $labelIds: [String!]
    $parentId: String
  ) {
    issueUpdate(
      id: $issueId
      input: {
        description: $description
        labelIds: $labelIds
        parentId: $parentId
      }
    ) {
      success
      issue {
        id
        identifier
        title
      }
    }
  }
`.trim();

export const LINEAR_OPEN_ISSUES_BY_LABELS_QUERY = `
  query SymphonyOpenIssuesByLabels(
    $projectSlug: String!
    $labelNames: [String!]!
    $excludeStateNames: [String!]!
    $first: Int!
    $relationFirst: Int!
  ) {
    issues(
      first: $first
      filter: {
        project: { slugId: { eq: $projectSlug } }
        labels: { name: { in: $labelNames } }
        state: { name: { nin: $excludeStateNames } }
      }
      orderBy: createdAt
    ) {
      nodes {
        ${ISSUE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`.trim();

export const LINEAR_ISSUE_STATE_TRANSITIONS_QUERY = `
  query IssueStateTransitions($issueId: String!) {
    issue(id: $issueId) {
      history(first: 50) {
        nodes {
          createdAt
          toState {
            name
          }
        }
      }
    }
  }
`;
// Linear's issue history connection is ordered NEWEST-FIRST: first
// returns recent entries; last returns a stale window that silently
// omits the operator's latest transitions (verified live, 2026-06-10 —
// the resume-evidence path never saw the resume it was looking for).

/**
 * Mutation to create an issue with an explicit stateId (SYMPH-398 watchdog
 * ticket filer). The stateId must be resolved beforehand via
 * LINEAR_WORKFLOW_STATES_QUERY.
 */
export const LINEAR_CREATE_ISSUE_WITH_STATE_MUTATION = `
  mutation SymphonyCreateIssueWithState(
    $teamId: String!
    $title: String!
    $stateId: String!
    $description: String
  ) {
    issueCreate(input: {
      teamId: $teamId
      title: $title
      stateId: $stateId
      description: $description
    }) {
      success
      issue {
        id
        identifier
        title
        state {
          name
        }
      }
    }
  }
`.trim();

/**
 * Search for an existing open issue by title prefix within a team (SYMPH-398).
 * Used to deduplicate watchdog tickets by searching for the signature marker
 * in the title.
 */
export const LINEAR_SEARCH_ISSUES_BY_TITLE_AND_TEAM_QUERY = `
  query SymphonySearchIssuesByTitleAndTeam(
    $teamKey: String!
    $title: String!
    $first: Int!
  ) {
    issues(
      first: $first
      filter: {
        team: { key: { eq: $teamKey } }
        title: { eq: $title }
      }
      orderBy: updatedAt
    ) {
      nodes {
        id
        identifier
        title
        description
        state {
          name
          type
        }
      }
    }
  }
`.trim();
