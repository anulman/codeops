import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createProjectContext,
  type ProjectContext,
  type ProjectContextDocument,
} from "@renoconcierge/codeops-contracts";

const requiredDocuments = Object.freeze([
  {
    path: "AGENTS.md",
    purpose: "Repository-wide agent instructions and safety boundaries",
  },
  {
    path: "docs/agent-context/CURRENT-STATE.md",
    purpose: "Implemented, inactive, demo-shaped, and future product surfaces",
  },
  {
    path: "docs/agent-context/DECISIONS.md",
    purpose: "Locked product, data, authorization, and delivery decisions",
  },
  {
    path: "docs/agent-context/DOMAIN.md",
    purpose: "Canonical repository entities, authority, and relationships",
  },
  {
    path: "docs/agent-context/PRODUCT.md",
    purpose: "Mission, wedge, customer journey, promise, and non-goals",
  },
  {
    path: "docs/agent-context/SOURCE-MAP.md",
    purpose: "Authoritative repository sources by product and engineering area",
  },
  {
    path: "SOUL.md",
    purpose: "Coding-agent identity and technical product writing rules",
  },
]);

export async function loadProjectContextDocuments(
  rootDirectory: string,
): Promise<readonly ProjectContextDocument[]> {
  if (!path.isAbsolute(rootDirectory)) {
    throw new Error("project context root must be absolute");
  }
  const root = await realpath(rootDirectory);
  const documents: ProjectContextDocument[] = [];
  for (const document of requiredDocuments) {
    const candidate = path.resolve(root, document.path);
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("project context document escaped its root");
    }
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `project context document must be a regular file: ${document.path}`,
      );
    }
    const bytes = await readFile(candidate);
    if (bytes.length === 0 || bytes.length > 100_000) {
      throw new Error(
        `project context document has an invalid size: ${document.path}`,
      );
    }
    documents.push({
      ...document,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      content: bytes.toString("utf8"),
    });
  }
  return documents;
}

export function compileProjectContext(input: {
  repository: { owner: string; name: string };
  controlPlaneSha: string;
  baseSha: string;
  workspaceId: string;
  project: {
    id: string;
    name: string;
    descriptionHtml?: string | null;
    updatedAt: string;
  };
  documents: readonly ProjectContextDocument[];
}): ProjectContext {
  return createProjectContext({
    version: "codeops.project-context/v1",
    repository: input.repository,
    controlPlaneSha: input.controlPlaneSha,
    baseSha: input.baseSha,
    project: {
      workspaceId: input.workspaceId,
      projectId: input.project.id,
      name: input.project.name,
      descriptionHtml: input.project.descriptionHtml ?? "",
      updatedAt: input.project.updatedAt,
    },
    documents: [...input.documents],
  });
}

export const projectContextDocumentPaths = Object.freeze(
  requiredDocuments.map((document) => document.path),
);
