import type {
  AgentJobDispatchResult,
  ResearchCitation,
  ResearchPacket,
  ResearchRequest,
  ResearchSynthesis,
} from "@renoconcierge/codeops-contracts";
import {
  RESEARCH_MANAGED_HEADING,
  RESEARCH_TASK_MANAGED_HEADING,
} from "@renoconcierge/codeops-contracts/managed-content";
const DESCRIPTION_HTML_LIMIT = 50_000;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sourceUrl(
  request: ResearchRequest,
  citation: ResearchCitation,
): string {
  const path = citation.path
    .split("/")
    .map((component) => encodeURIComponent(component))
    .join("/");
  const end = citation.lineEnd ?? citation.lineStart;
  return `https://github.com/${encodeURIComponent(request.repository.owner)}/${encodeURIComponent(
    request.repository.name,
  )}/blob/${request.baseSha}/${path}#L${citation.lineStart}-L${end}`;
}

function citationLinks(
  request: ResearchRequest,
  synthesis: ResearchSynthesis,
  ids: readonly string[],
): string {
  const citations = new Map(
    synthesis.citations.map((citation) => [citation.id, citation]),
  );
  return ids
    .map((id) => citations.get(id))
    .filter((citation): citation is ResearchCitation => citation !== undefined)
    .map((citation) => {
      const test = citation.testName ? ` · ${citation.testName}` : "";
      return `<a href="${sourceUrl(request, citation)}">${escapeHtml(
        `${citation.path}:${citation.lineStart}${test}`,
      )}</a>`;
    })
    .join("; ");
}

function findingsHtml(
  request: ResearchRequest,
  synthesis: ResearchSynthesis,
): string {
  if (synthesis.topFindings.length === 0) return "";
  return `<p><strong>Top findings</strong></p><ol>${synthesis.topFindings
    .map(
      (finding) =>
        `<li><strong>${escapeHtml(
          `${finding.severity} · ${finding.confidence} confidence`,
        )}</strong>: ${escapeHtml(finding.currentBehavior)} Expected: ${escapeHtml(
          finding.expectedBehavior,
        )}<br>${citationLinks(request, synthesis, finding.citationIds)}</li>`,
    )
    .join("")}</ol>`;
}

function decisionsHtml(
  request: ResearchRequest,
  synthesis: ResearchSynthesis,
): string {
  if (synthesis.decisions.length === 0) return "";
  return `<p><strong>Product decisions (maximum three)</strong></p><ol>${synthesis.decisions
    .map(
      (decision) =>
        `<li>${decision.blocking ? "<strong>Blocking:</strong> " : ""}${escapeHtml(
          decision.question,
        )}<br>${citationLinks(request, synthesis, decision.citationIds)}</li>`,
    )
    .join("")}</ol>`;
}

function boundedMatrixHtml(
  request: ResearchRequest,
  synthesis: ResearchSynthesis,
  available: number,
): string {
  const header = `<p><strong>Route/state/credential matrix · ${synthesis.matrix.version}</strong></p><ol>`;
  const footer = "</ol>";
  if (header.length + footer.length > available) return "";

  const rows: string[] = [];
  let rowsLength = 0;
  for (const row of synthesis.matrix.rows) {
    const rendered =
      `<li><strong>${escapeHtml(row.routeOrRpc)}</strong> — ${escapeHtml(
        `${row.lifecycleState} / ${row.credentialState} / ${row.status}`,
      )}<br>Current oracle: ${escapeHtml(
        row.currentOracle,
      )}<br>Expected oracle: ${escapeHtml(
        row.expectedOracle,
      )}<br>Allowed side effects: ${escapeHtml(
        row.allowedSideEffects,
      )}<br>${citationLinks(request, synthesis, row.citationIds)}</li>`;
    const remainingCount = synthesis.matrix.rows.length - rows.length - 1;
    const truncation =
      remainingCount > 0
        ? `<li><em>Showing ${rows.length + 1} of ${synthesis.matrix.rows.length} rows. The complete versioned matrix remains in the research packet.</em></li>`
        : "";
    if (
      header.length +
        rowsLength +
        rendered.length +
        truncation.length +
        footer.length >
      available
    ) {
      break;
    }
    rows.push(rendered);
    rowsLength += rendered.length;
  }
  if (rows.length === 0) return "";
  const omitted = synthesis.matrix.rows.length - rows.length;
  const truncation =
    omitted > 0
      ? `<li><em>Showing ${rows.length} of ${synthesis.matrix.rows.length} rows. The complete versioned matrix remains in the research packet.</em></li>`
      : "";
  return `${header}${rows.join("")}${truncation}${footer}`;
}

function downstreamHtml(
  request: ResearchRequest,
  synthesis: ResearchSynthesis,
): string {
  if (synthesis.downstreamFindings.length === 0) return "";
  return `<p><strong>Downstream findings (not ticket scope)</strong></p><ul>${synthesis.downstreamFindings
    .map(
      (finding) =>
        `<li>${escapeHtml(finding.currentBehavior)}<br>${citationLinks(
          request,
          synthesis,
          finding.citationIds,
        )}</li>`,
    )
    .join("")}</ul>`;
}

function followUpTasksHtml(synthesis: ResearchSynthesis): string {
  if (synthesis.followUpTasks.length === 0) return "";
  return `<p><strong>Follow-up tasks</strong></p><ol>${synthesis.followUpTasks
    .map(
      (task) =>
        `<li><strong>${escapeHtml(task.area)}</strong>: ${escapeHtml(
          task.targetWorkItemId === null ? `Create “${task.title}”` : `Update “${task.title}”`,
        )}</li>`,
    )
    .join("")}</ol>`;
}

function taskDescription(input: {
  request: ResearchRequest;
  synthesis: ResearchSynthesis;
  task: ResearchSynthesis["followUpTasks"][number];
  original: string;
}): string {
  const preserved = input.original
    .split(RESEARCH_TASK_MANAGED_HEADING)[0]!
    .trim();
  return [
    preserved,
    RESEARCH_TASK_MANAGED_HEADING,
    `<p><strong>Area:</strong> ${escapeHtml(input.task.area)}</p>`,
    `<p>${escapeHtml(input.task.objective)}</p>`,
    `<p><strong>Acceptance criteria</strong></p><ul>${input.task.acceptanceCriteria
      .map((criterion) => `<li>${escapeHtml(criterion)}</li>`)
      .join("")}</ul>`,
    `<p><strong>Evidence</strong><br>${citationLinks(
      input.request,
      input.synthesis,
      input.task.citationIds,
    )}</p>`,
    `<p><code>[codeops-research-task:${escapeHtml(input.task.key)}]</code></p>`,
  ]
    .filter((value) => value.length > 0)
    .join("");
}

function managedDescription(
  request: ResearchRequest,
  synthesis: ResearchSynthesis,
): string {
  const original = request.ticketSnapshot.descriptionHtml
    .split(RESEARCH_MANAGED_HEADING)[0]!
    .trim();
  const required = [
    original,
    RESEARCH_MANAGED_HEADING,
    `<p><strong>Verdict:</strong> ${escapeHtml(
      synthesis.verdict,
    )}</p><p>${escapeHtml(synthesis.summary)}</p>`,
  ]
    .filter((value) => value.length > 0)
    .join("");
  if (required.length > DESCRIPTION_HTML_LIMIT) {
    throw new Error(
      "source ticket has insufficient description capacity for the managed research header",
    );
  }

  let description = required;
  const appendIfFits = (block: string): void => {
    if (
      block.length > 0 &&
      description.length + block.length <= DESCRIPTION_HTML_LIMIT
    ) {
      description += block;
    }
  };
  appendIfFits(findingsHtml(request, synthesis));
  appendIfFits(
    boundedMatrixHtml(
      request,
      synthesis,
      DESCRIPTION_HTML_LIMIT - description.length,
    ),
  );
  for (const block of [
    decisionsHtml(request, synthesis),
    downstreamHtml(request, synthesis),
    followUpTasksHtml(synthesis),
  ]) {
    appendIfFits(block);
  }
  return description;
}

function compactComment(
  request: ResearchRequest,
  synthesis: ResearchSynthesis,
): string {
  const blocks = [
    "<p><strong>CodeOps research synthesized</strong></p>",
    `<p><strong>Verdict:</strong> ${escapeHtml(
      synthesis.verdict,
    )}</p><p>${escapeHtml(synthesis.summary)}</p>`,
    findingsHtml(request, synthesis),
    decisionsHtml(request, synthesis),
    downstreamHtml(request, synthesis),
    followUpTasksHtml(synthesis),
    `<p>The current ticket description was refined with the versioned route/state/credential matrix and exact-SHA evidence links. Evidence-backed same-project follow-up tasks were created or updated where applicable.</p>`,
  ];
  let body = "";
  for (const block of blocks) {
    if (body.length + block.length <= 7_900) body += block;
  }
  return body;
}

export function buildResearchPacket(input: {
  request: ResearchRequest;
  personaDispatches: readonly AgentJobDispatchResult[];
  synthesisDispatch: AgentJobDispatchResult;
}): ResearchPacket {
  if (input.personaDispatches.length !== input.request.personas.length) {
    throw new Error("research dispatch count does not match requested personas");
  }
  const reports = input.personaDispatches.map((dispatch, index) => {
    const persona = input.request.personas[index];
    if (
      dispatch.role !== "qa-contract-researcher" ||
      dispatch.researchResult.kind !== "persona" ||
      dispatch.researchResult.report.requestId !== input.request.requestId ||
      dispatch.researchResult.report.persona !== persona
    ) {
      throw new Error("research persona dispatch result identity mismatch");
    }
    return dispatch.researchResult.report;
  });
  if (
    input.synthesisDispatch.role !== "qa-contract-researcher" ||
    input.synthesisDispatch.researchResult.kind !== "synthesis" ||
    input.synthesisDispatch.researchResult.synthesis.requestId !==
      input.request.requestId
  ) {
    throw new Error("research synthesis dispatch result identity mismatch");
  }
  const synthesis = input.synthesisDispatch.researchResult.synthesis;
  const projectTasks = new Map(
    (input.request.ticketSnapshot.projectTasks ?? []).map((task) => [
      task.workItemId,
      task,
    ]),
  );
  for (const task of synthesis.followUpTasks) {
    if (
      task.targetWorkItemId !== null &&
      !projectTasks.has(task.targetWorkItemId)
    ) {
      throw new Error("research follow-up target is absent from the admitted task index");
    }
  }
  const orderedTasks = [...synthesis.followUpTasks].sort((left, right) => {
    const areaOrder = Number(right.area === "security") - Number(left.area === "security");
    return areaOrder || left.key.localeCompare(right.key);
  });
  const dispatches = [...input.personaDispatches, input.synthesisDispatch];
  const evidence = dispatches.map((dispatch) => ({
    version: "codeops.evidence/v1" as const,
    kind: "checkpoint" as const,
    uri: dispatch.checkpointUri,
    digest: dispatch.checkpointDigest,
    sizeBytes: dispatch.checkpointSizeBytes,
    mediaType: "application/json",
  }));

  return {
    version: "codeops.research-packet/v3",
    personas: input.request.personas,
    perspectives: reports.map(({ persona, outcome, summary }) => ({
      persona,
      outcome,
      summary,
    })),
    requestId: input.request.requestId,
    projectId: input.request.projectId,
    workItemId: input.request.workItemId,
    baseSha: input.request.baseSha,
    projectContextDigest: input.request.projectContext.digest,
    planeRevisionDigest: input.request.planeRevisionDigest,
    summary: synthesis.summary,
    synthesis,
    currentBehavior: synthesis.topFindings.map(
      (finding) => finding.currentBehavior,
    ),
    expectedBehavior: synthesis.topFindings.map(
      (finding) => finding.expectedBehavior,
    ),
    evidence,
    videoNotApplicableReason:
      "This bounded repository-contract review does not exercise a live user journey.",
    decisions: synthesis.decisions.map(({ question, blocking }) => ({
      question,
      blocking,
    })),
    proposedMutations: {
      version: "codeops.research-mutation-batch/v2",
      requestId: input.request.requestId,
      projectId: input.request.projectId,
      sourceWorkItemId: input.request.workItemId,
      mutations: [
        {
          type: "ticket.update",
          targetWorkItemId: input.request.workItemId,
          changes: {
            descriptionHtml: managedDescription(input.request, synthesis),
          },
        },
        ...orderedTasks.map((task) => {
          const existing =
            task.targetWorkItemId === null
              ? undefined
              : projectTasks.get(task.targetWorkItemId);
          return {
            type: "task.upsert" as const,
            key: task.key,
            targetWorkItemId: task.targetWorkItemId,
            expectedDescriptionDigest:
              existing === undefined
                ? null
                : existing.descriptionDigest,
            name: task.title,
            descriptionHtml: taskDescription({
              request: input.request,
              synthesis,
              task,
              original: existing?.descriptionHtml ?? "",
            }),
          };
        }),
        {
          type: "comment.create",
          targetWorkItemId: input.request.workItemId,
          bodyHtml: compactComment(input.request, synthesis),
          attachments: evidence,
        },
      ],
    },
    createdAt: input.request.requestedAt,
  };
}
