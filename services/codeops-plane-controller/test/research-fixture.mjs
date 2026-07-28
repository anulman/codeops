export function upgradeResearchPacket(packet) {
  const comment =
    packet.proposedMutations.mutations.find(
      (mutation) => mutation.type === "comment.create",
    ) ?? {
      type: "comment.create",
      targetWorkItemId: packet.workItemId,
      bodyHtml: "<p>Research complete.</p>",
      attachments: packet.evidence,
    };
  return {
    ...packet,
    version: "codeops.research-packet/v3",
    synthesis: {
      version: "codeops.research-synthesis/v1",
      requestId: packet.requestId,
      verdict: "ready-to-refine",
      summary: packet.summary,
      topFindings: [],
      decisions: [],
      downstreamFindings: [],
      followUpTasks: [],
      matrix: {
        version: "codeops.route-state-credential-matrix/v1",
        rows: [
          {
            id: "matrix-1",
            lifecycleState: "qualified",
            credentialState: "valid",
            routeOrRpc: "/claim",
            currentOracle: "Repository-backed behavior.",
            expectedOracle: "Deterministic behavior.",
            allowedSideEffects: "None during research.",
            status: "verified",
            citationIds: ["citation-1"],
          },
        ],
      },
      citations: [
        {
          id: "citation-1",
          path: "services/auth.ts",
          lineStart: 1,
          claim: "Fixture citation.",
        },
      ],
    },
    proposedMutations: {
      ...packet.proposedMutations,
      version: "codeops.research-mutation-batch/v2",
      mutations: [
        {
          type: "ticket.update",
          targetWorkItemId: packet.workItemId,
          changes: {
            descriptionHtml:
              "<p>Source</p><h3>CodeOps research synthesis</h3><p>Refined description.</p>",
          },
        },
        comment,
      ],
    },
  };
}
