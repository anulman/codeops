import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";
import { buildSessionProofCredentialEvidence } from "./codeops-session-proof-credential-evidence.mjs";
import {
  completeSessionProofStep,
  verifySessionProofStepAuthorization,
} from "./codeops-session-proof-step-receipts.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import {
  readFirstSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-step-authorization.mjs";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const METADATA_TEMPLATE = [
  '{{.metadata.uid}}{{"\\n"}}',
  '{{.type}}{{"\\n"}}',
  '{{index .metadata.labels "app.kubernetes.io/part-of"}}{{"\\n"}}',
  '{{index .metadata.labels "codeops.renoconcierge.ca/credential-scope"}}{{"\\n"}}',
  '{{range $key,$value := .data}}{{$key}}{{"\\n"}}{{end}}',
].join("");

const ISSUERS = {
  "issue-broker-capabilities": {
    action: "operator-issue-exact-secrets",
    script: fileURLToPath(new URL("./issue-codeops-session-proof-secrets.sh", import.meta.url)),
    names: [
      "codeops-session-proof-database-owner",
      "codeops-session-broker-database",
      "codeops-session-broker-read-auth",
      "codeops-session-broker-write-auth",
      "codeops-session-runtime-worker-auth",
      "codeops-session-job-initialization-auth",
      "codeops-session-runtime-worker-database",
    ],
    args: () => [],
  },
  "issue-runtime-capabilities": {
    action: "operator-issue-exact-runtime-credentials",
    script: fileURLToPath(new URL("./issue-codeops-session-proof-runtime-credentials.sh", import.meta.url)),
    names: ["ghcr-renoconcierge", "codeops-agent-source-credentials"],
    args: (input) => {
      if (
        typeof input.registryConfigFile !== "string" ||
        !isAbsolute(input.registryConfigFile) ||
        input.registryConfigFile.length > 4096 ||
        typeof input.repositoryTokenFile !== "string" ||
        !isAbsolute(input.repositoryTokenFile) ||
        input.repositoryTokenFile.length > 4096
      ) {
        throw new Error("bounded absolute runtime credential input paths are required");
      }
      return [
        "--registry-config-file", input.registryConfigFile,
        "--repository-token-file", input.repositoryTokenFile,
      ];
    },
  },
};

function run(file, args, runner) {
  return runner(file, args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
  });
}

function readCredentialMetadata(namespace, name, runner) {
  const source = run("kubectl", [
    "-n", namespace,
    "get", "secret", name,
    "-o", `go-template=${METADATA_TEMPLATE}`,
    "--request-timeout=15s",
  ], runner);
  const lines = source.split("\n");
  const [uid, type, partOf, scope, ...dataKeys] = lines;
  if (!uid || !type || !partOf || !scope) {
    throw new Error("proof credential metadata output was incomplete");
  }
  return {
    name,
    namespace,
    uid,
    type,
    dataKeys: dataKeys.filter(Boolean).sort(),
    labels: {
      "app.kubernetes.io/part-of": partOf,
      "codeops.renoconcierge.ca/credential-scope": scope,
    },
  };
}

function readAndVerifyLiveIdentity(authorization, observedAt, runner) {
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(authorization.namespace.name, runner);
  verifySessionProofOperation(authorization.admission, {
    stepId: authorization.stepId,
    namespaceResource,
    operator,
    target,
    observedAt,
  });
  return { namespaceResource, operator, target };
}

function verifyExecutionTimes(authorization, startedAt, completedAt) {
  if (
    !RFC3339.test(startedAt ?? "") ||
    !RFC3339.test(completedAt ?? "") ||
    Date.parse(startedAt) < Date.parse(authorization.authorizedAt) ||
    Date.parse(completedAt) < Date.parse(startedAt)
  ) {
    throw new Error("proof credential issuance timestamps drifted");
  }
}

export function issueSessionProofCredentials(input, runner = execFileSync) {
  const authorization = input.authorization;
  verifySessionProofStepAuthorization(authorization);
  const issuer = ISSUERS[authorization.stepId];
  if (!issuer || authorization.action !== issuer.action) {
    throw new Error("proof step is not an exact credential-issuance action");
  }
  verifyExecutionTimes(authorization, input.startedAt, input.completedAt);
  const issuerArgs = issuer.args(input);

  readAndVerifyLiveIdentity(authorization, input.startedAt, runner);
  run(issuer.script, [
    "--namespace", authorization.namespace.name,
    ...issuerArgs,
  ], runner);

  const secrets = issuer.names.map((name) =>
    readCredentialMetadata(authorization.namespace.name, name, runner));
  const live = readAndVerifyLiveIdentity(authorization, input.completedAt, runner);
  const evidence = buildSessionProofCredentialEvidence({
    authorization,
    observedAt: input.completedAt,
    secrets,
  });
  const evidenceSource = JSON.stringify(evidence);
  const receipt = completeSessionProofStep(authorization, {
    ...live,
    completedAt: input.completedAt,
    evidenceSource,
  });
  return { evidenceSource, receipt };
}

export function issueFirstSessionProofCredentialsFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const { authorization } = readFirstSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  return issueSessionProofCredentials({
    authorization,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, runner);
}
