import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
    repository: { owner: "anulman", name: "renoconcierge" },
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
  const researchDispatchFile =
    input.researchDispatch === undefined
      ? undefined
      : path.join(inputDirectory, "research-dispatch.json");
  if (researchPacketFile) {
    await writeFile(researchPacketFile, JSON.stringify(input.researchPacket));
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
