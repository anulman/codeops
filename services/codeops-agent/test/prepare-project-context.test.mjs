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

function projectContext(documentDigest) {
  const identity = {
    version: "codeops.project-context/v1",
    repository: { owner: "anulman", name: "renoconcierge" },
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
        digest: documentDigest,
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
  return execute(process.execPath, [script.pathname], {
    env: {
      ...process.env,
      CODEOPS_WORKSPACE: input.workspace,
      CODEOPS_CONTEXT_DIR: input.contextDirectory,
      CODEOPS_BASE_SHA: "a".repeat(40),
      CODEOPS_PROJECT_CONTEXT_B64: Buffer.from(
        JSON.stringify(input.projectContext),
      ).toString("base64"),
      ...(input.researchPacket === undefined
        ? {}
        : {
            CODEOPS_RESEARCH_PACKET_B64: Buffer.from(
              JSON.stringify(input.researchPacket),
            ).toString("base64"),
          }),
      ...(input.researchDispatch === undefined
        ? {}
        : {
            CODEOPS_RESEARCH_DISPATCH_B64: Buffer.from(
              JSON.stringify(input.researchDispatch),
            ).toString("base64"),
          }),
    },
  });
}

test("materializes verified context and fails on missing or digest-drifted files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-agent-context-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const bytes = "bounded guidance\n";
    await writeFile(path.join(workspace, "AGENTS.md"), bytes);
    const digest = `sha256:${createHash("sha256")
      .update(bytes)
      .digest("hex")}`;
    const context = projectContext(digest);
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
    await writeFile(path.join(workspace, "AGENTS.md"), "drifted\n");
    await assert.rejects(
      run({
        workspace,
        contextDirectory: path.join(root, "drift"),
        projectContext: context,
      }),
      /project context document digest drift/,
    );
    await rm(path.join(workspace, "AGENTS.md"));
    await assert.rejects(
      run({
        workspace,
        contextDirectory: path.join(root, "missing"),
        projectContext: context,
      }),
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
