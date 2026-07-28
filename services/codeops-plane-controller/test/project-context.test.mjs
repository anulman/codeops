import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  compileProjectContext,
  loadProjectContextDocuments,
  projectContextDocumentPaths,
} from "../dist/index.js";

test("loads the complete bounded context pack and compiles one digest", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const documents = await loadProjectContextDocuments(repositoryRoot);
  assert.deepEqual(
    documents.map((document) => document.path),
    projectContextDocumentPaths,
  );
  assert.ok(
    documents.every((document) =>
      /^sha256:[0-9a-f]{64}$/.test(document.digest),
    ),
  );
  const context = compileProjectContext({
    repository: { owner: "anulman", name: "renoconcierge" },
    controlPlaneSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    workspaceId: "11111111-1111-4111-8111-111111111111",
    project: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Onboarding Auth QA",
      descriptionHtml: "<p>Exact Plane project description.</p>",
      updatedAt: "2026-07-27T00:00:00.000Z",
    },
    documents,
  });
  assert.equal(
    context.project.descriptionHtml,
    "<p>Exact Plane project description.</p>",
  );
  assert.match(context.digest, /^sha256:[0-9a-f]{64}$/);
});

test("fails closed on missing, empty, or symlinked context documents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-context-"));
  try {
    await assert.rejects(
      loadProjectContextDocuments(root),
      /AGENTS\.md/,
    );
    await writeFile(path.join(root, "target"), "not trusted through a link\n");
    await symlink(path.join(root, "target"), path.join(root, "AGENTS.md"));
    await assert.rejects(
      loadProjectContextDocuments(root),
      /regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
