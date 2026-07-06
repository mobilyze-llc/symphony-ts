import { describe, expect, it } from "vitest";

import { readCollectedArtifact } from "../../src/stage-execution/collected-artifact.js";

describe("readCollectedArtifact", () => {
  it("maps ready materialized content without reading producerPath", () => {
    const artifact = readCollectedArtifact({
      job_id: "job-1",
      materialized: {
        status: "ready",
        producerPath: "/remote/host/path/that/does/not/exist",
        primary: {
          name: "attempts/01/artifact/review.md",
          content: "## Verdict\nPASS\n",
          hash: "primary-sha",
        },
        entries: [
          {
            name: "attempts/01/artifact/review.usage.json",
            content: '{"available":true,"totalTokens":42}',
            hash: "usage-sha",
          },
        ],
      },
    });

    expect(artifact).toEqual({
      status: "ready",
      jobId: "job-1",
      producerPath: "/remote/host/path/that/does/not/exist",
      primary: {
        name: "attempts/01/artifact/review.md",
        content: "## Verdict\nPASS\n",
        hash: "primary-sha",
      },
      entries: [
        {
          name: "attempts/01/artifact/review.usage.json",
          content: '{"available":true,"totalTokens":42}',
          hash: "usage-sha",
        },
      ],
    });
  });

  it("maps absent materialized payloads to rollout-safe missing", () => {
    expect(readCollectedArtifact({ job_id: "job-1" })).toEqual({
      status: "missing",
      jobId: "job-1",
      entries: [],
      reason: "producer_predates_materialization",
    });
  });

  it("preserves non-ready entries and oversize primary metadata", () => {
    expect(
      readCollectedArtifact({
        job_id: "job-1",
        materialized: {
          status: "oversize",
          reason: "primary too large",
          primary: { name: "artifact/review.md", hash: "sha", bytes: 123 },
          entries: [
            {
              name: "artifact/large.log",
              hash: "large-sha",
              bytes: 456,
              contentWithheld: true,
            },
          ],
        },
      }),
    ).toEqual({
      status: "oversize",
      jobId: "job-1",
      primary: { name: "artifact/review.md", hash: "sha", bytes: 123 },
      entries: [
        {
          name: "artifact/large.log",
          hash: "large-sha",
          bytes: 456,
          contentWithheld: true,
        },
      ],
      reason: "primary too large",
    });
  });
});
