import type {
  AgentJobDispatchResult,
  ResearchPacket,
  ResearchRequest,
} from "@renoconcierge/codeops-contracts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function listHtml(title: string, values: readonly string[]): string {
  if (values.length === 0) return "";
  return `<p><strong>${title}</strong></p><ul>${values
    .map((value) => `<li>${escapeHtml(value)}</li>`)
    .join("")}</ul>`;
}

export function buildResearchPacket(input: {
  request: ResearchRequest;
  dispatches: readonly AgentJobDispatchResult[];
}): ResearchPacket {
  if (input.dispatches.length !== input.request.personas.length) {
    throw new Error("research dispatch count does not match requested personas");
  }
  const reports = input.dispatches.map((dispatch, index) => {
    const persona = input.request.personas[index];
    if (
      dispatch.role !== "qa-contract-researcher" ||
      dispatch.researchReport.requestId !== input.request.requestId ||
      dispatch.researchReport.persona !== persona
    ) {
      throw new Error("research dispatch result identity mismatch");
    }
    return dispatch.researchReport;
  });
  const currentBehavior = reports
    .flatMap((report) => report.currentBehavior)
    .slice(0, 100);
  const expectedBehavior = reports
    .flatMap((report) => report.expectedBehavior)
    .slice(0, 100);
  const decisions = reports.flatMap((report) => report.decisions).slice(0, 50);
  const evidence = input.dispatches.map((dispatch) => ({
    version: "codeops.evidence/v1" as const,
    kind: "checkpoint" as const,
    uri: dispatch.checkpointUri,
    digest: dispatch.checkpointDigest,
    sizeBytes: dispatch.checkpointSizeBytes,
    mediaType: "application/json",
  }));
  const reportHtml = reports
    .map(
      (report) =>
        `<p><strong>${escapeHtml(report.persona)}</strong> · ${escapeHtml(
          report.outcome,
        )}</p><p>${escapeHtml(report.summary)}</p>`,
    )
    .join("");
  const bodyHtml = [
    "<p><strong>CodeOps research complete</strong></p>",
    reportHtml,
    listHtml("Current behavior", currentBehavior),
    listHtml("Expected behavior", expectedBehavior),
    listHtml(
      "Decisions",
      decisions.map(
        (decision) =>
          `${decision.blocking ? "Blocking" : "Non-blocking"}: ${decision.question}`,
      ),
    ),
  ]
    .join("")
    .slice(0, 50_000);
  const summary = reports
    .map((report) => `${report.persona}: ${report.summary}`)
    .join("\n")
    .slice(0, 2_000);

  return {
    version: "codeops.research-packet/v2",
    personas: input.request.personas,
    perspectives: reports.map(({ persona, outcome, summary: perspectiveSummary }) => ({
      persona,
      outcome,
      summary: perspectiveSummary,
    })),
    requestId: input.request.requestId,
    projectId: input.request.projectId,
    workItemId: input.request.workItemId,
    baseSha: input.request.baseSha,
    projectContextDigest: input.request.projectContext.digest,
    planeRevisionDigest: input.request.planeRevisionDigest,
    summary,
    currentBehavior,
    expectedBehavior,
    evidence,
    videoNotApplicableReason:
      "This bounded repository-contract review does not exercise a live user journey.",
    decisions,
    proposedMutations: {
      version: "codeops.research-mutation-batch/v1",
      requestId: input.request.requestId,
      projectId: input.request.projectId,
      sourceWorkItemId: input.request.workItemId,
      mutations: [
        {
          type: "comment.create",
          targetWorkItemId: input.request.workItemId,
          bodyHtml,
          attachments: evidence,
        },
      ],
    },
    // Workflow time advances after a Temporal reset. The admitted request
    // timestamp is immutable, so it keeps projection identity byte-stable.
    createdAt: input.request.requestedAt,
  };
}
