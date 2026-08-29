import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { codingRequestSchema } from "@codeops/codeops-contracts";

const execute = promisify(execFile);
const script = new URL("../prepare-project-context.mjs", import.meta.url);

function canonicalSerialize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerialize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`)
    .join(",")}}`;
}

function projectContext(documentContent) {
  const identity = {
    version: "codeops.project-context/v1",
    repository: { owner: "example-org", name: "example-repository" },
    controlPlaneSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    project: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      name: "Onboarding Auth QA",
      descriptionHtml: "<p>Exact project description.</p>",
      updatedAt: "2026-07-27T00:00:00.000Z",
    },
    documents: [
      {
        path: "AGENTS.md",
        purpose: "Repository guidance",
        digest: `sha256:${createHash("sha256")
          .update(documentContent)
          .digest("hex")}`,
        content: documentContent,
      },
    ],
  };
  return {
    ...identity,
    digest: `sha256:${createHash("sha256")
      .update(canonicalSerialize(identity))
      .digest("hex")}`,
  };
}

function completeCodingRequest(context, version = "codeops.coding-request/v3") {
  const workItemId = "33333333-3333-4333-8333-333333333333";
  const request = {
    version,
    requestId: "coding-request-1",
    eventId: "ready-event-1",
    workspaceId: context.project.workspaceId,
    projectId: context.project.projectId,
    requestedBy: "44444444-4444-4444-8444-444444444444",
    controlPlaneSha: context.controlPlaneSha,
    planeRevisionDigest: `sha256:${"c".repeat(64)}`,
    ticketSnapshot: {
      workItemId,
      name: "Implement the bounded correction",
      descriptionHtml: "<p>Preserve exact identities.</p>",
      priority: "high",
      stateId: "55555555-5555-4555-8555-555555555555",
      labelIds: [],
      assigneeIds: [],
      moduleId: null,
      parentId: null,
      updatedAt: "2026-08-29T00:00:00.000Z",
      relevantComments: [],
      relations: [],
      projectTasks: [],
    },
    researchDisposition: {
      mode: "skipped",
      rationale: "The bounded correction is already fully specified.",
    },
    projectContext: context,
    workItem: {
      version: "codeops.work-item/v1",
      workItemId,
      workflowId: "coding-request-1",
      runId: "coding-request-1",
      repository: context.repository,
      baseSha: context.baseSha,
      branch: "codeops/bounded-correction",
      summary: "Implement the bounded correction.",
      acceptanceCriteria: ["Every identity remains exact."],
      secretReferences: [],
      requestedAt: "2026-08-29T00:00:00.000Z",
    },
  };
  if (version === "codeops.coding-request/v3") {
    request.planeWorkItem = {
      version: "codeops.trusted-plane-work-item-reference/v1",
      apiOrigin: "https://plane.example.com/",
      workspaceSlug: "engineering",
      workspaceId: context.project.workspaceId,
      projectId: context.project.projectId,
      projectIdentifier: "COAUTO",
      workItemId,
      sequenceId: 19,
      reference: "COAUTO-19",
    };
  }
  return request;
}

async function run(input) {
  const inputDirectory = path.join(
    path.dirname(input.contextDirectory),
    `${path.basename(input.contextDirectory)}-input`,
  );
  await mkdir(inputDirectory);
  const projectContextFile = path.join(inputDirectory, "project-context.json");
  await writeFile(projectContextFile, JSON.stringify(input.projectContext));
  const researchPacketFile =
    input.researchPacket === undefined
      ? undefined
      : path.join(inputDirectory, "research-packet.json");
  const codingRequestFile =
    input.codingRequest === undefined
      ? undefined
      : path.join(inputDirectory, "coding-request.json");
  const researchDispatchFile =
    input.researchDispatch === undefined
      ? undefined
      : path.join(inputDirectory, "research-dispatch.json");
  if (researchPacketFile) {
    await writeFile(researchPacketFile, JSON.stringify(input.researchPacket));
  }
  if (codingRequestFile) {
    await writeFile(codingRequestFile, JSON.stringify(input.codingRequest));
  }
  if (researchDispatchFile) {
    await writeFile(
      researchDispatchFile,
      JSON.stringify(input.researchDispatch),
    );
  }
  return execute(process.execPath, [script.pathname], {
    env: {
      ...process.env,
      CODEOPS_WORKSPACE: input.workspace,
      CODEOPS_CONTEXT_DIR: input.contextDirectory,
      CODEOPS_INPUT_ROOT: inputDirectory,
      CODEOPS_BASE_SHA: "a".repeat(40),
      CODEOPS_CONTROL_PLANE_SHA: "b".repeat(40),
      CODEOPS_PROJECT_CONTEXT_FILE: projectContextFile,
      ...(input.codingRequest === undefined
        ? {}
        : {
            CODEOPS_CODING_REQUEST_FILE: codingRequestFile,
          }),
      ...(input.researchPacket === undefined
        ? {}
        : {
            CODEOPS_RESEARCH_PACKET_FILE: researchPacketFile,
          }),
      ...(input.researchDispatch === undefined
        ? {}
        : {
            CODEOPS_RESEARCH_DISPATCH_FILE: researchDispatchFile,
          }),
    },
  });
}

test("materializes trusted context documents and rejects inline digest drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-agent-context-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const bytes = "bounded guidance\n";
    const context = projectContext(bytes);
    const validOutput = path.join(root, "valid");
    await run({
      workspace,
      contextDirectory: validOutput,
      projectContext: context,
      researchPacket: {
        version: "codeops.research-packet/v3",
        baseSha: context.baseSha,
        projectId: context.project.projectId,
        projectContextDigest: context.digest,
      },
    });
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(validOutput, "project-context.json"),
          "utf8",
        ),
      ),
      context,
    );
    assert.equal(
      await readFile(
        path.join(validOutput, "project-documents", "AGENTS.md"),
        "utf8",
      ),
      bytes,
    );
    const codingOutput = path.join(root, "coding");
    const codingRequest = completeCodingRequest(
      context,
      "codeops.coding-request/v2",
    );
    await run({
      workspace,
      contextDirectory: codingOutput,
      projectContext: context,
      codingRequest,
    });
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(codingOutput, "coding-request.json"), "utf8"),
      ),
      codingRequest,
    );
    const trustedCodingOutput = path.join(root, "trusted-coding");
    const trustedCodingRequest = {
      ...completeCodingRequest(context),
    };
    await run({
      workspace,
      contextDirectory: trustedCodingOutput,
      projectContext: context,
      codingRequest: trustedCodingRequest,
    });
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(trustedCodingOutput, "coding-request.json"),
          "utf8",
        ),
      ),
      trustedCodingRequest,
    );
    const dispatchOutput = path.join(root, "dispatch");
    const workItemId = "33333333-3333-4333-8333-333333333333";
    const dispatch = {
      version: "codeops.agent-job-dispatch/v1",
      role: "qa-contract-researcher",
      workItemId,
      workflowId: "research-request-1",
      baseSha: context.baseSha,
      researchRequest: {
        requestId: "research-request-1",
        workItemId,
        projectId: context.project.projectId,
        projectContext: context,
        ticketSnapshot: { workItemId },
      },
      researchStage: { kind: "persona", persona: "@ai-security" },
    };
    await run({
      workspace,
      contextDirectory: dispatchOutput,
      projectContext: context,
      researchDispatch: dispatch,
    });
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(dispatchOutput, "research-dispatch.json"),
          "utf8",
        ),
      ),
      dispatch,
    );
    const driftedIdentity = {
      ...context,
      documents: [
        {
          ...context.documents[0],
          content: "drifted\n",
        },
      ],
    };
    delete driftedIdentity.digest;
    const driftedContext = {
      ...driftedIdentity,
      digest: `sha256:${createHash("sha256")
        .update(canonicalSerialize(driftedIdentity))
        .digest("hex")}`,
    };
    await assert.rejects(
      run({
        workspace,
        contextDirectory: path.join(root, "drift"),
        projectContext: driftedContext,
      }),
      /project context document digest drift/,
    );
    await assert.rejects(
      run({
        workspace,
        contextDirectory: path.join(root, "bad-context"),
        projectContext: { ...context, digest: `sha256:${"f".repeat(64)}` },
      }),
      /project context digest mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts only an exact trusted v3 coding request identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-agent-v3-context-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const context = projectContext("bounded guidance\n");
    const codingRequest = completeCodingRequest(context);
    const output = path.join(root, "exact");
    await run({
      workspace,
      contextDirectory: output,
      projectContext: context,
      codingRequest,
    });
    assert.deepEqual(
      JSON.parse(await readFile(path.join(output, "coding-request.json"), "utf8")),
      codingRequest,
    );
    const punycodeOutput = path.join(root, "canonical-punycode");
    const punycodeRequest = {
      ...codingRequest,
      planeWorkItem: {
        ...codingRequest.planeWorkItem,
        apiOrigin: "https://xn--bcher-kva.example/",
      },
    };
    await run({
      workspace,
      contextDirectory: punycodeOutput,
      projectContext: context,
      codingRequest: punycodeRequest,
    });
    assert.equal(
      JSON.parse(
        await readFile(path.join(punycodeOutput, "coding-request.json"), "utf8"),
      ).planeWorkItem.apiOrigin,
      punycodeRequest.planeWorkItem.apiOrigin,
    );

    const rejectedRequests = [
      (() => {
        const { requestedBy: _requestedBy, ...missing } = codingRequest;
        return missing;
      })(),
      { ...codingRequest, unknownTopLevel: true },
      {
        ...codingRequest,
        workItem: { ...codingRequest.workItem, unknownNested: true },
      },
      {
        ...codingRequest,
        planeWorkItem: {
          ...codingRequest.planeWorkItem,
          workspaceId: codingRequest.planeWorkItem.projectId,
          projectId: codingRequest.planeWorkItem.workspaceId,
        },
      },
      {
        ...codingRequest,
        requestId: "drifted-request",
      },
      {
        ...codingRequest,
        controlPlaneSha: "c".repeat(40),
      },
      {
        ...codingRequest,
        workItem: { ...codingRequest.workItem, baseSha: "d".repeat(40) },
      },
      {
        ...codingRequest,
        planeWorkItem: {
          ...codingRequest.planeWorkItem,
          workspaceId: "44444444-4444-4444-8444-444444444444",
        },
      },
      {
        ...codingRequest,
        planeWorkItem: {
          ...codingRequest.planeWorkItem,
          projectId: "55555555-5555-4555-8555-555555555555",
        },
      },
      {
        ...codingRequest,
        planeWorkItem: {
          ...codingRequest.planeWorkItem,
          workItemId: "66666666-6666-4666-8666-666666666666",
        },
      },
      {
        ...codingRequest,
        planeWorkItem: {
          ...codingRequest.planeWorkItem,
          apiOrigin: "http://attacker.invalid/not-an-origin?query=1",
        },
      },
      {
        ...codingRequest,
        planeWorkItem: {
          ...codingRequest.planeWorkItem,
          workspaceSlug: "../invalid",
        },
      },
      {
        ...codingRequest,
        planeWorkItem: {
          ...codingRequest.planeWorkItem,
          projectIdentifier: "invalid",
        },
      },
      {
        ...codingRequest,
        planeWorkItem: {
          ...codingRequest.planeWorkItem,
          sequenceId: -1,
        },
      },
      {
        ...codingRequest,
        planeWorkItem: {
          ...codingRequest.planeWorkItem,
          reference: "UNRELATED-999",
        },
      },
      {
        ...codingRequest,
        planeWorkItem: {
          ...codingRequest.planeWorkItem,
          unsupported: true,
        },
      },
      ...[
        "https://PLANE.example.com/",
        "https://plane.example.com:443/",
        "https:////evil.example/",
        "https://plane.example.com/%2e%2e/",
        "https://plane.example.com\n.evil.example/",
        "https://bücher.example/",
        "https://plane.example.com/?query=1",
        "https://plane.example.com/#fragment",
        "https://user@plane.example.com/",
        "https://plane.example.com/path",
        "http://plane.example.com/",
        "https://plane.example.com",
      ].map((apiOrigin) => ({
        ...codingRequest,
        planeWorkItem: { ...codingRequest.planeWorkItem, apiOrigin },
      })),
    ];
    for (const [index, rejectedRequest] of rejectedRequests.entries()) {
      const rejectedOutput = path.join(root, `rejected-${index}`);
      await assert.rejects(
        run({
          workspace,
          contextDirectory: rejectedOutput,
          projectContext: context,
          codingRequest: rejectedRequest,
        }),
        undefined,
      );
      await assert.rejects(
        readFile(path.join(rejectedOutput, "coding-request.json")),
        { code: "ENOENT" },
      );
      await assert.rejects(
        readFile(path.join(rejectedOutput, "project-context.json")),
        { code: "ENOENT" },
      );
      await assert.rejects(
        lstat(path.join(rejectedOutput, "project-documents")),
        { code: "ENOENT" },
      );
      await assert.rejects(lstat(rejectedOutput), { code: "ENOENT" });
    }

    const legacyOutput = path.join(root, "legacy");
    const legacy = completeCodingRequest(context, "codeops.coding-request/v2");
    await run({
      workspace,
      contextDirectory: legacyOutput,
      projectContext: context,
      codingRequest: legacy,
    });
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(legacyOutput, "coding-request.json"), "utf8"),
      ),
      legacy,
    );
    assert.equal("planeWorkItem" in legacy, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects schema-valid cross-context drift before materialization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-agent-drift-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const admittedContext = projectContext("admitted guidance\n");
    const embeddedContext = projectContext("different guidance\n");
    assert.notEqual(
      admittedContext.documents[0].digest,
      embeddedContext.documents[0].digest,
    );
    assert.notEqual(admittedContext.digest, embeddedContext.digest);
    const codingRequest = completeCodingRequest(embeddedContext);
    assert.deepEqual(codingRequestSchema.parse(codingRequest), codingRequest);

    const output = path.join(root, "cross-context-output");
    await assert.rejects(
      run({
        workspace,
        contextDirectory: output,
        projectContext: admittedContext,
        codingRequest,
      }),
      /coding request does not match the project context/,
    );
    await assert.rejects(
      readFile(path.join(output, "project-context.json")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(path.join(output, "coding-request.json")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      lstat(path.join(output, "project-documents")),
      { code: "ENOENT" },
    );
    await assert.rejects(lstat(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
