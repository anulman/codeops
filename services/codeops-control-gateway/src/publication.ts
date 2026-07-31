import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  candidatePublicationResultSchema,
  candidatePublicationSchema,
  type CandidatePublication,
  type CandidatePublicationResult,
} from "@renoconcierge/codeops-contracts";

const execFileAsync = promisify(execFile);

function repositoryUrl(publication: CandidatePublication): string {
  return `https://github.com/${encodeURIComponent(
    publication.repository.owner,
  )}/${encodeURIComponent(publication.repository.name)}.git`;
}

export async function publishCandidateRevision(input: {
  publication: CandidatePublication;
  evidenceRoot: string;
  repositoryWriteToken: string;
  exec?: typeof execFileAsync;
}): Promise<CandidatePublicationResult> {
  const publication = candidatePublicationSchema.parse(input.publication);
  if (!path.isAbsolute(input.evidenceRoot)) {
    throw new Error("candidate publication evidence root must be absolute");
  }
  if (
    input.repositoryWriteToken.length < 16 ||
    /\s/.test(input.repositoryWriteToken)
  ) {
    throw new Error("candidate publication write token is invalid");
  }
  const patchPath = path.join(
    input.evidenceRoot,
    "agent-runs",
    publication.candidate.runId,
    "changes.patch",
  );
  const patch = await readFile(patchPath);
  const patchDigest = `sha256:${createHash("sha256")
    .update(patch)
    .digest("hex")}`;
  if (
    patch.length === 0 ||
    patch.length !== publication.candidate.patch.sizeBytes ||
    patchDigest !== publication.candidate.patch.digest
  ) {
    throw new Error("candidate publication patch evidence does not match");
  }

  const directory = await mkdtemp(path.join(tmpdir(), "codeops-publish-"));
  const repository = path.join(directory, "repository");
  const run = input.exec ?? execFileAsync;
  const auth = Buffer.from(
    `x-access-token:${input.repositoryWriteToken}`,
  ).toString("base64");
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (args: readonly string[]): Promise<string> => {
    const { stdout } = await run("git", [...args], {
      env: gitEnvironment,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return String(stdout).trim();
  };

  try {
    await git([
      "clone",
      "--no-checkout",
      "--filter=blob:none",
      "--single-branch",
      "--branch",
      publication.headRef,
      repositoryUrl(publication),
      repository,
    ]);
    const currentHead = await git(["-C", repository, "rev-parse", "HEAD"]);
    if (currentHead !== publication.expectedHeadSha) {
      throw new Error("candidate publication PR head drifted before apply");
    }
    await git([
      "-C",
      repository,
      "apply",
      "--check",
      "--whitespace=error-all",
      patchPath,
    ]);
    await git(["-C", repository, "apply", "--whitespace=error-all", patchPath]);
    await git(["-C", repository, "add", "--all", "--"]);
    const staged = await git(["-C", repository, "diff", "--cached", "--name-only"]);
    if (staged.length === 0) {
      throw new Error("candidate publication patch produced no source change");
    }
    await git([
      "-C",
      repository,
      "-c",
      "user.name=RenoConcierge CodeOps",
      "-c",
      "user.email=codeops@renoconcierge.ca",
      "commit",
      "--no-gpg-sign",
      "-m",
      publication.commitMessage,
    ]);
    const publishedHeadSha = await git([
      "-C",
      repository,
      "rev-parse",
      "HEAD",
    ]);
    await git([
      "-C",
      repository,
      "push",
      "origin",
      `HEAD:refs/heads/${publication.headRef}`,
    ]);
    return candidatePublicationResultSchema.parse({
      version: "codeops.candidate-publication-result/v1",
      workflowId: publication.workflowId,
      workItemId: publication.workItemId,
      pullRequestNumber: publication.pullRequestNumber,
      previousHeadSha: publication.expectedHeadSha,
      publishedHeadSha,
      headRef: publication.headRef,
      patchDigest,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
