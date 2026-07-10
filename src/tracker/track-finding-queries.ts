/**
 * Track-finding intake GraphQL operations (SYMPH-763 / SYMPH-1110).
 *
 * The marker search stays lean. Disposition comments and inverse relations are
 * paged independently only after an anchored cancelled twin is found.
 */
export const LINEAR_SEARCH_ISSUES_BY_TITLE_MARKER_AND_TEAM_QUERY = `
  query SymphonySearchIssuesByTitleMarkerAndTeam(
    $teamKey: String!
    $marker: String!
    $first: Int!
  ) {
    issues(
      first: $first
      filter: {
        team: { key: { eq: $teamKey } }
        title: { containsIgnoreCase: $marker }
      }
      orderBy: updatedAt
    ) {
      nodes {
        id
        identifier
        title
        url
        state {
          name
          type
        }
      }
    }
  }
`.trim();

export const LINEAR_TRACK_FINDING_DISPOSITION_DETAIL_QUERY = `
  query SymphonyTrackFindingDispositionDetail(
    $issueId: String!
    $first: Int!
    $after: String
  ) {
    issue(id: $issueId) {
      id
      comments(first: $first, after: $after) {
        nodes {
          body
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`.trim();

export const LINEAR_TRACK_FINDING_INVERSE_RELATIONS_QUERY = `
  query SymphonyTrackFindingInverseRelations(
    $issueId: String!
    $first: Int!
    $after: String
  ) {
    issue(id: $issueId) {
      id
      inverseRelations(first: $first, after: $after) {
        nodes {
          type
          issue {
            id
            identifier
            title
            url
            state {
              name
              type
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`.trim();

export const LINEAR_CREATE_TRACK_FINDING_ISSUE_MUTATION = `
  mutation SymphonyCreateTrackFindingIssue(
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
        url
        state {
          name
        }
      }
    }
  }
`.trim();
