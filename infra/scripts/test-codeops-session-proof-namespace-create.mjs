import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import {
  issueFirstSessionProofCredentialsFromOperatorPacket,
} from "./codeops-session-proof-credential-issuer.mjs";
import { createSessionProofNamespace } from "./codeops-session-proof-namespace-create.mjs";
import {
  buildSessionProofGrantCompletionEvidence,
} from "./codeops-session-proof-grant-completion-evidence.mjs";
import {
  buildSessionProofCodexLoginCompletionEvidence,
} from "./codeops-session-proof-codex-login-completion-evidence.mjs";
import { attachSessionProofOperatorAdmission } from "./codeops-session-proof-operator-admission.mjs";
import {
  authorizeNinthSessionProofStepFromOperatorPacket,
  persistNinthSessionProofStepAuthorizationFromOperatorPacket,
  readNinthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-login-step-authorization.mjs";
import {
  applySessionProofCodexLoginFromOperatorPacket,
  persistSessionProofCodexLoginApplyFromOperatorPacket,
  readSessionProofCodexLoginApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-login-apply.mjs";
import {
  authorizeTenthSessionProofStepFromOperatorPacket,
  persistTenthSessionProofStepAuthorizationFromOperatorPacket,
  readTenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-login-wait-authorization.mjs";
import {
  persistSessionProofCodexLoginWaitFromOperatorPacket,
  readSessionProofCodexLoginWaitOutputsFromOperatorPacket,
  waitForSessionProofCodexLoginFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-login-wait.mjs";
import {
  authorizeEleventhSessionProofStepFromOperatorPacket,
  persistEleventhSessionProofStepAuthorizationFromOperatorPacket,
  readEleventhSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-smoke-step-authorization.mjs";
import {
  persistSessionProofCodexSmokeReplacementFromOperatorPacket,
  readSessionProofCodexSmokeReplacementOutputsFromOperatorPacket,
  replaceSessionProofCodexSmokeFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-smoke-replace.mjs";
import {
  authorizeTwelfthSessionProofStepFromOperatorPacket,
  persistTwelfthSessionProofStepAuthorizationFromOperatorPacket,
  readTwelfthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-smoke-wait-authorization.mjs";
import {
  persistSessionProofCodexSmokeWaitFromOperatorPacket,
  waitForSessionProofCodexSmokeFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-smoke-wait.mjs";
import {
  buildSessionProofCodexSmokeCompletionEvidence,
} from "./codeops-session-proof-codex-smoke-completion-evidence.mjs";
import {
  persistThirteenthSessionProofStepAuthorizationFromOperatorPacket,
  readThirteenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-ui-step-authorization.mjs";
import {
  persistSessionProofUiApplyFromOperatorPacket,
  readSessionProofUiApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-ui-apply.mjs";
import {
  persistFourteenthSessionProofStepAuthorizationFromOperatorPacket,
  readFourteenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-ui-wait-authorization.mjs";
import {
  persistSessionProofUiWaitFromOperatorPacket,
  readSessionProofUiWaitOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-ui-wait.mjs";
import {
  buildSessionProofUiReadinessEvidence,
} from "./codeops-session-proof-ui-readiness-evidence.mjs";
import {
  persistFifteenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-step-authorization.mjs";
import {
  applySessionProofRuntimeFromOperatorPacket,
  persistSessionProofRuntimeApplyFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-apply.mjs";
import {
  buildSessionProofCodexSmokeReplacementEvidence,
} from "./codeops-session-proof-codex-smoke-replacement-evidence.mjs";
import {
  persistFirstSessionProofCredentialIssuanceFromOperatorPacket,
} from "./codeops-session-proof-operator-credential-issuance.mjs";
import {
  authorizeSecondSessionProofStepFromOperatorPacket,
  persistSecondSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-next-step-authorization.mjs";
import {
  issueSecondSessionProofCredentialsFromOperatorPacket,
  persistSecondSessionProofCredentialIssuanceFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-credential-issuance.mjs";
import {
  authorizeThirdSessionProofStepFromOperatorPacket,
  persistThirdSessionProofStepAuthorizationFromOperatorPacket,
  readThirdSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-database-step-authorization.mjs";
import {
  applySessionProofDatabaseFromOperatorPacket,
  persistSessionProofDatabaseApplyFromOperatorPacket,
} from "./codeops-session-proof-operator-database-apply.mjs";
import {
  authorizeFourthSessionProofStepFromOperatorPacket,
  persistFourthSessionProofStepAuthorizationFromOperatorPacket,
  readFourthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-database-wait-authorization.mjs";
import {
  persistSessionProofDatabaseWaitFromOperatorPacket,
  readSessionProofDatabaseWaitOutputsFromOperatorPacket,
  waitForSessionProofDatabaseFromOperatorPacket,
} from "./codeops-session-proof-operator-database-wait.mjs";
import {
  authorizeFifthSessionProofStepFromOperatorPacket,
  persistFifthSessionProofStepAuthorizationFromOperatorPacket,
  readFifthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-step-authorization.mjs";
import {
  applySessionProofGatewayFromOperatorPacket,
  persistSessionProofGatewayApplyFromOperatorPacket,
  readSessionProofGatewayApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-apply.mjs";
import {
  authorizeSixthSessionProofStepFromOperatorPacket,
  persistSixthSessionProofStepAuthorizationFromOperatorPacket,
  readSixthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-wait-authorization.mjs";
import {
  persistSessionProofGatewayMigrationWaitFromOperatorPacket,
  readSessionProofGatewayMigrationWaitOutputsFromOperatorPacket,
  waitForSessionProofGatewayMigrationFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-wait.mjs";
import {
  authorizeSeventhSessionProofStepFromOperatorPacket,
  persistSeventhSessionProofStepAuthorizationFromOperatorPacket,
  readSeventhSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-step-authorization.mjs";
import {
  applySessionProofGrantsFromOperatorPacket,
  persistSessionProofGrantApplyFromOperatorPacket,
  readSessionProofGrantApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-apply.mjs";
import {
  authorizeEighthSessionProofStepFromOperatorPacket,
  persistEighthSessionProofStepAuthorizationFromOperatorPacket,
  readEighthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-wait-authorization.mjs";
import {
  persistSessionProofGrantWaitFromOperatorPacket,
  readSessionProofGrantWaitOutputsFromOperatorPacket,
  waitForSessionProofGrantsFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-wait.mjs";
import { createSessionProofNamespaceFromOperatorPacket } from "./codeops-session-proof-operator-namespace-create.mjs";
import {
  authorizeFirstSessionProofStepFromOperatorPacket,
  persistFirstSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-step-authorization.mjs";
import { persistSessionProofOperatorPacket } from "./codeops-session-proof-operator-packet.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";
import { buildSessionProofReadinessEvidence } from "./codeops-session-proof-readiness-evidence.mjs";
import {
  buildSessionProofGatewayReadinessEvidence,
  sessionProofGatewayMigrationRelation,
} from "./codeops-session-proof-gateway-readiness-evidence.mjs";
import { completeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

function readShardInteger(name, fallback) {
  const source = process.env[name];
  if (source === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(source)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(source);
}

const proofTestShardCount = readShardInteger("CODEOPS_PROOF_TEST_SHARD_COUNT", 1);
const proofTestShardIndex = readShardInteger("CODEOPS_PROOF_TEST_SHARD_INDEX", 0);
if (proofTestShardCount < 1 || proofTestShardIndex >= proofTestShardCount) {
  throw new Error("proof test shard index must identify one configured shard");
}
// Keep the deep predecessor-chain cases balanced; all tests remain registered in every shard.
const proofThreeShardOverrides = new Map([
  [
    "hands only the exact persisted Codex smoke authorization and login-completion outputs to replacement",
    1,
  ],
  ["login-completion evidence drift fails before Codex smoke authorization", 1],
  ["durably persists the exact Codex-login completion evidence and receipt", 2],
  [
    "authorizes only Codex-login completion from the exact persisted login apply outputs",
    2,
  ],
  [
    "rejects a substituted or existing Codex-login completion authorization before live reads",
    2,
  ],
  ["persisted Codex-login authorization drift fails before the create-only adapter", 2],
  ["durably persists exact UI apply outputs behind the private authorization chain", 1],
  ["persists exact UI readiness and the private runtime-start authorization", 2],
  ["durably persists the exact Codex smoke replacement evidence and receipt", 0],
]);
const proofSeenTestNames = new Set();
let proofTestOrdinal = 0;
function test(name, implementation) {
  const ordinal = proofTestOrdinal;
  proofTestOrdinal += 1;
  proofSeenTestNames.add(name);
  const selectedShard = proofTestShardCount === 3
    ? (proofThreeShardOverrides.get(name) ?? ordinal % proofTestShardCount)
    : ordinal % proofTestShardCount;
  return nodeTest(name, {
    skip: selectedShard !== proofTestShardIndex,
  }, implementation);
}

const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "a".repeat(40),
  sessionSuffix: "video-1",
};
const namespaceManifestSource = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: codeops-session-proof-video-1\n";
const certificateData = Buffer.from("synthetic-client-certificate").toString("base64");
const operator = {
  username: "kubernetes-admin",
  uid: null,
  credentialSha256: createHash("sha256")
    .update(Buffer.from(certificateData, "base64"))
    .digest("hex"),
};
const target = { context: "proof-context", server: "https://cluster.example.invalid" };
const artifactIds = [
  "namespace", "database", "gateway", "grants", "codex-login", "codex-smoke", "ui", "runtime",
];
const planSource = JSON.stringify({
  apiVersion: "codeops.example/session-proof-plan/v1",
  admission: "closed",
  execution: "render-and-review-only",
  identity,
  artifacts: artifactIds.map((id, index) => ({
    id,
    sha256: id === "namespace"
      ? createHash("sha256").update(namespaceManifestSource).digest("hex")
      : `${index}`.repeat(64),
  })),
  sequence: sessionProofSequence(),
});
const admission = createSessionProofAdmission({
  planSource,
  reviewedPlanSha256: createHash("sha256").update(planSource).digest("hex"),
  operator,
  target,
  approvedAt: "2026-08-05T05:00:00Z",
  expiresAt: "2026-08-05T08:00:00Z",
});
const brokerContracts = {
  "codeops-session-proof-database-owner": ["database", "password", "username"],
  "codeops-session-broker-database": ["database-url"],
  "codeops-session-broker-read-auth": ["token"],
  "codeops-session-broker-write-auth": ["token"],
  "codeops-session-runtime-worker-auth": ["token"],
  "codeops-session-job-initialization-auth": ["token"],
  "codeops-session-runtime-worker-database": ["database-url", "password"],
};
const runtimeContracts = {
  "codeops-registry": {
    type: "kubernetes.io/dockerconfigjson",
    keys: [".dockerconfigjson"],
  },
  "codeops-agent-source-credentials": {
    type: "Opaque",
    keys: ["repository-read-token"],
  },
};

function persistOperatorInputs(root) {
  const artifactSources = Object.fromEntries(artifactIds.map((id) => [
    id,
    id === "namespace" ? namespaceManifestSource : `synthetic-${id}-artifact\n`,
  ]));
  const packetPlanSource = JSON.stringify({
    apiVersion: "codeops.example/session-proof-plan/v1",
    admission: "closed",
    execution: "render-and-review-only",
    identity,
    artifacts: artifactIds.map((id) => ({
      id,
      sha256: createHash("sha256").update(artifactSources[id]).digest("hex"),
    })),
    sequence: sessionProofSequence(),
  });
  const packetPath = join(root, `${identity.namespace}.packet`);
  const admissionPath = join(root, `${identity.namespace}.admission.json`);
  const receiptPath = join(root, `${identity.namespace}.namespace-create-receipt.json`);
  const authorizationPath = join(
    root,
    `${identity.namespace}.step-02-issue-broker-capabilities.authorization.json`,
  );
  const evidencePath = join(
    root,
    `${identity.namespace}.step-02-issue-broker-capabilities.evidence.json`,
  );
  const stepReceiptPath = join(
    root,
    `${identity.namespace}.step-02-issue-broker-capabilities.receipt.json`,
  );
  const secondAuthorizationPath = join(
    root,
    `${identity.namespace}.step-03-issue-runtime-capabilities.authorization.json`,
  );
  const secondEvidencePath = join(
    root,
    `${identity.namespace}.step-03-issue-runtime-capabilities.evidence.json`,
  );
  const secondStepReceiptPath = join(
    root,
    `${identity.namespace}.step-03-issue-runtime-capabilities.receipt.json`,
  );
  const thirdAuthorizationPath = join(
    root,
    `${identity.namespace}.step-04-start-database.authorization.json`,
  );
  const thirdEvidencePath = join(
    root,
    `${identity.namespace}.step-04-start-database.evidence.json`,
  );
  const thirdStepReceiptPath = join(
    root,
    `${identity.namespace}.step-04-start-database.receipt.json`,
  );
  const fourthAuthorizationPath = join(
    root,
    `${identity.namespace}.step-05-wait-database.authorization.json`,
  );
  const fourthEvidencePath = join(
    root,
    `${identity.namespace}.step-05-wait-database.evidence.json`,
  );
  const fourthStepReceiptPath = join(
    root,
    `${identity.namespace}.step-05-wait-database.receipt.json`,
  );
  const fifthAuthorizationPath = join(
    root,
    `${identity.namespace}.step-06-start-gateway.authorization.json`,
  );
  const fifthEvidencePath = join(
    root,
    `${identity.namespace}.step-06-start-gateway.evidence.json`,
  );
  const fifthStepReceiptPath = join(
    root,
    `${identity.namespace}.step-06-start-gateway.receipt.json`,
  );
  const sixthAuthorizationPath = join(
    root,
    `${identity.namespace}.step-07-wait-gateway-migration.authorization.json`,
  );
  const sixthEvidencePath = join(
    root,
    `${identity.namespace}.step-07-wait-gateway-migration.evidence.json`,
  );
  const sixthStepReceiptPath = join(
    root,
    `${identity.namespace}.step-07-wait-gateway-migration.receipt.json`,
  );
  const seventhAuthorizationPath = join(
    root,
    `${identity.namespace}.step-08-grant-receipts.authorization.json`,
  );
  const seventhEvidencePath = join(
    root,
    `${identity.namespace}.step-08-grant-receipts.evidence.json`,
  );
  const seventhStepReceiptPath = join(
    root,
    `${identity.namespace}.step-08-grant-receipts.receipt.json`,
  );
  const eighthAuthorizationPath = join(
    root,
    `${identity.namespace}.step-09-wait-grants.authorization.json`,
  );
  const eighthEvidencePath = join(
    root,
    `${identity.namespace}.step-09-wait-grants.evidence.json`,
  );
  const eighthStepReceiptPath = join(
    root,
    `${identity.namespace}.step-09-wait-grants.receipt.json`,
  );
  const ninthAuthorizationPath = join(
    root,
    `${identity.namespace}.step-10-codex-login.authorization.json`,
  );
  const ninthEvidencePath = join(
    root,
    `${identity.namespace}.step-10-codex-login.evidence.json`,
  );
  const ninthStepReceiptPath = join(
    root,
    `${identity.namespace}.step-10-codex-login.receipt.json`,
  );
  const tenthAuthorizationPath = join(
    root,
    `${identity.namespace}.step-11-wait-codex-login.authorization.json`,
  );
  const tenthEvidencePath = join(
    root,
    `${identity.namespace}.step-11-wait-codex-login.evidence.json`,
  );
  const tenthStepReceiptPath = join(
    root,
    `${identity.namespace}.step-11-wait-codex-login.receipt.json`,
  );
  const eleventhAuthorizationPath = join(
    root,
    `${identity.namespace}.step-12-codex-smoke.authorization.json`,
  );
  const eleventhEvidencePath = join(
    root,
    `${identity.namespace}.step-12-codex-smoke.evidence.json`,
  );
  const eleventhStepReceiptPath = join(
    root,
    `${identity.namespace}.step-12-codex-smoke.receipt.json`,
  );
  const twelfthAuthorizationPath = join(
    root,
    `${identity.namespace}.step-13-wait-codex-smoke.authorization.json`,
  );
  const twelfthEvidencePath = join(
    root,
    `${identity.namespace}.step-13-wait-codex-smoke.evidence.json`,
  );
  const twelfthStepReceiptPath = join(
    root,
    `${identity.namespace}.step-13-wait-codex-smoke.receipt.json`,
  );
  const thirteenthAuthorizationPath = join(
    root,
    `${identity.namespace}.step-14-start-ui.authorization.json`,
  );
  const thirteenthEvidencePath = join(
    root,
    `${identity.namespace}.step-15-start-ui.evidence.json`,
  );
  const thirteenthStepReceiptPath = join(
    root,
    `${identity.namespace}.step-15-start-ui.receipt.json`,
  );
  const fourteenthAuthorizationPath = join(
    root,
    `${identity.namespace}.step-16-wait-ui.authorization.json`,
  );
  const fourteenthEvidencePath = join(
    root,
    `${identity.namespace}.step-16-wait-ui.evidence.json`,
  );
  const fourteenthStepReceiptPath = join(
    root,
    `${identity.namespace}.step-16-wait-ui.receipt.json`,
  );
  const fifteenthAuthorizationPath = join(
    root,
    `${identity.namespace}.step-17-start-runtime.authorization.json`,
  );
  const fifteenthEvidencePath = join(
    root,
    `${identity.namespace}.step-18-start-runtime.evidence.json`,
  );
  const fifteenthStepReceiptPath = join(
    root,
    `${identity.namespace}.step-18-start-runtime.receipt.json`,
  );
  persistSessionProofOperatorPacket({ packetPath, planSource: packetPlanSource, artifactSources });
  attachSessionProofOperatorAdmission({
    packetPath,
    admissionPath,
    operator,
    target,
    approvedAt: "2026-08-05T05:00:00Z",
    expiresAt: "2026-08-05T08:00:00Z",
  });
  return {
    packetPath,
    admissionPath,
    receiptPath,
    authorizationPath,
    evidencePath,
    stepReceiptPath,
    secondAuthorizationPath,
    secondEvidencePath,
    secondStepReceiptPath,
    thirdAuthorizationPath,
    thirdEvidencePath,
    thirdStepReceiptPath,
    fourthAuthorizationPath,
    fourthEvidencePath,
    fourthStepReceiptPath,
    fifthAuthorizationPath,
    fifthEvidencePath,
    fifthStepReceiptPath,
    sixthAuthorizationPath,
    sixthEvidencePath,
    sixthStepReceiptPath,
    seventhAuthorizationPath,
    seventhEvidencePath,
    seventhStepReceiptPath,
    eighthAuthorizationPath,
    eighthEvidencePath,
    eighthStepReceiptPath,
    ninthAuthorizationPath,
    ninthEvidencePath,
    ninthStepReceiptPath,
    tenthAuthorizationPath,
    tenthEvidencePath,
    tenthStepReceiptPath,
    eleventhAuthorizationPath,
    eleventhEvidencePath,
    eleventhStepReceiptPath,
    twelfthAuthorizationPath,
    twelfthEvidencePath,
    twelfthStepReceiptPath,
    thirteenthAuthorizationPath,
    thirteenthEvidencePath,
    thirteenthStepReceiptPath,
    fourteenthAuthorizationPath,
    fourteenthEvidencePath,
    fourteenthStepReceiptPath,
    fifteenthAuthorizationPath,
    fifteenthEvidencePath,
    fifteenthStepReceiptPath,
  };
}

function namespace() {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: identity.namespace,
      uid: "namespace-uid-1",
      labels: {
        "app.kubernetes.io/part-of": "codeops-session-proof",
        "codeops.example/proof-run": identity.runId,
        "codeops.example/base-sha": identity.baseSha,
      },
    },
  };
}

function runner(initiallyPresent = false, failCreateAfterNamespace = false) {
  let created = initiallyPresent;
  let brokerIssued = false;
  let runtimeIssued = false;
  const calls = [];
  const execute = (file, args, options = {}) => {
    calls.push({ file, args, options });
    const key = args.join(" ");
    if (file.endsWith("issue-codeops-session-proof-secrets.sh")) {
      brokerIssued = true;
      return "issued\n";
    }
    if (file.endsWith("issue-codeops-session-proof-runtime-credentials.sh")) {
      assert.deepEqual(args, [
        "--namespace", identity.namespace,
        "--registry-config-file", "/private/registry-config.json",
        "--repository-token-file", "/private/repository-token",
      ]);
      runtimeIssued = true;
      return "issued\n";
    }
    if (
      file === "kubectl" &&
      args[0] === "-n" &&
      args[2] === "get" &&
      args[3] === "secret"
    ) {
      const name = args[4];
      const brokerContract = brokerContracts[name];
      const runtimeContract = runtimeContracts[name];
      assert.ok(brokerContract ?? runtimeContract);
      assert.equal(brokerContract ? brokerIssued : runtimeIssued, true);
      return [
        `secret-uid-${name}`,
        brokerContract ? "Opaque" : runtimeContract.type,
        "codeops-session-proof",
        brokerContract ? "session-video-proof" : "session-video-proof-runtime",
        ...(brokerContract ?? runtimeContract.keys),
        "",
      ].join("\n");
    }
    if (key === "config current-context") return `${target.context}\n`;
    if (key === "config view --minify -o json") {
      return JSON.stringify({ clusters: [{ cluster: { server: target.server } }] });
    }
    if (key === "auth whoami -o json") {
      return JSON.stringify({ status: { userInfo: { username: operator.username } } });
    }
    if (key.includes("jsonpath={.users[0].user.client-certificate-data}")) return certificateData;
    if (key.startsWith("get namespace ")) return created ? JSON.stringify(namespace()) : "";
    if (key === "create --filename - --request-timeout=30s") {
      assert.equal(options.input, namespaceManifestSource);
      created = true;
      if (failCreateAfterNamespace) throw new Error("synthetic partial create");
      return "created\n";
    }
    throw new Error(`unexpected kubectl call: ${key}`);
  };
  return { calls, execute };
}

function persistThroughDatabaseAuthorization(inputs, stub) {
  createSessionProofNamespaceFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:00:00Z",
  }, stub.execute);
  persistFirstSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:01:00Z",
  }, stub.execute);
  persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:02:00Z",
    completedAt: "2026-08-05T06:03:00Z",
  }, stub.execute);
  persistSecondSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:04:00Z",
  }, stub.execute);
  persistSecondSessionProofCredentialIssuanceFromOperatorPacket({
    ...inputs,
    registryConfigFile: "/private/registry-config.json",
    repositoryTokenFile: "/private/repository-token",
    startedAt: "2026-08-05T06:05:00Z",
    completedAt: "2026-08-05T06:06:00Z",
  }, stub.execute);
  return persistThirdSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:07:00Z",
  }, stub.execute);
}

function persistThroughDatabaseOutputs(inputs, stub) {
  const authorization = persistThroughDatabaseAuthorization(inputs, stub);
  const completedAt = "2026-08-05T06:09:00Z";
  const evidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
    authorization,
    observedAt: completedAt,
    resources: sessionProofApplyResourceIdentities("start-database").map((resource, index) => ({
      ...resource,
      uid: `database-resource-uid-${index + 1}`,
    })),
  }));
  const receipt = completeSessionProofStep(authorization, {
    namespaceResource: namespace(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  persistSessionProofDatabaseApplyFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:08:00Z",
    completedAt,
  }, stub.execute, () => ({ evidenceSource, receipt }));
  return { authorization, evidenceSource, receipt };
}

function persistThroughDatabaseWaitAuthorization(inputs, stub) {
  const outputs = persistThroughDatabaseOutputs(inputs, stub);
  const authorization = persistFourthSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:10:00Z",
  }, stub.execute);
  return { ...outputs, waitAuthorization: authorization };
}

function readyDatabaseDeployment() {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "codeops-session-proof-database",
      namespace: identity.namespace,
      uid: "database-resource-uid-2",
      generation: 1,
    },
    spec: { replicas: 1 },
    status: {
      observedGeneration: 1,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
      unavailableReplicas: 0,
      conditions: [
        { type: "Available", status: "True" },
        { type: "Progressing", status: "True" },
      ],
    },
  };
}

function persistThroughDatabaseWaitOutputs(inputs, stub) {
  const { receipt: applyReceipt, waitAuthorization } =
    persistThroughDatabaseWaitAuthorization(inputs, stub);
  const completedAt = "2026-08-05T06:12:00Z";
  const evidenceSource = JSON.stringify(buildSessionProofReadinessEvidence({
    authorization: waitAuthorization,
    databaseApplyReceiptSource: `${JSON.stringify(applyReceipt, null, 2)}\n`,
    databaseApplyEvidenceSource: readFileSync(inputs.thirdEvidencePath, "utf8"),
    deployment: readyDatabaseDeployment(),
    observedAt: completedAt,
  }));
  const receipt = completeSessionProofStep(waitAuthorization, {
    namespaceResource: namespace(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  persistSessionProofDatabaseWaitFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:11:00Z",
    completedAt,
    maxAttempts: 12,
    pollIntervalMs: 1000,
  }, stub.execute, () => ({ evidenceSource, receipt }));
  return { evidenceSource, receipt };
}

function persistThroughGatewayAuthorization(inputs, stub) {
  persistThroughDatabaseWaitOutputs(inputs, stub);
  return persistFifthSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:13:00Z",
  }, stub.execute);
}

function persistThroughGatewayApplyOutputs(inputs, stub) {
  const authorization = persistThroughGatewayAuthorization(inputs, stub);
  const completedAt = "2026-08-05T06:15:00Z";
  const evidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
    authorization,
    observedAt: completedAt,
    resources: sessionProofApplyResourceIdentities("start-gateway").map((resource, index) => ({
      ...resource,
      uid: `gateway-resource-uid-${index}`,
    })),
  }));
  const receipt = completeSessionProofStep(authorization, {
    namespaceResource: namespace(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  persistSessionProofGatewayApplyFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:14:00Z",
    completedAt,
  }, stub.execute, () => ({ evidenceSource, receipt }));
  return { evidenceSource, receipt };
}

function persistThroughGatewayWaitAuthorization(inputs, stub) {
  persistThroughGatewayApplyOutputs(inputs, stub);
  return persistSixthSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:16:00Z",
  }, stub.execute);
}

function readyGatewayDeployment() {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "codeops-control-gateway",
      namespace: identity.namespace,
      uid: "gateway-resource-uid-0",
      generation: 1,
    },
    spec: { replicas: 1 },
    status: {
      observedGeneration: 1,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
      unavailableReplicas: 0,
      conditions: [
        { type: "Available", status: "True" },
        { type: "Progressing", status: "True" },
      ],
    },
  };
}

function persistThroughGatewayWaitOutputs(inputs, stub) {
  const authorization = persistThroughGatewayWaitAuthorization(inputs, stub);
  const completedAt = "2026-08-05T06:18:00Z";
  const evidenceSource = JSON.stringify(buildSessionProofGatewayReadinessEvidence({
    authorization,
    gatewayApplyReceiptSource: readFileSync(inputs.fifthStepReceiptPath, "utf8"),
    gatewayApplyEvidenceSource: readFileSync(inputs.fifthEvidencePath, "utf8"),
    deployment: readyGatewayDeployment(),
    migrationRelation: sessionProofGatewayMigrationRelation(),
    observedAt: completedAt,
  }));
  const receipt = completeSessionProofStep(authorization, {
    namespaceResource: namespace(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  persistSessionProofGatewayMigrationWaitFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:17:00Z",
    completedAt,
    maxAttempts: 12,
    pollIntervalMs: 1000,
  }, stub.execute, () => ({ evidenceSource, receipt }));
  return { evidenceSource, receipt };
}

function persistThroughGrantOutputs(inputs, stub) {
  persistThroughGatewayWaitOutputs(inputs, stub);
  const authorization = persistSeventhSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:19:00Z",
  }, stub.execute);
  const completedAt = "2026-08-05T06:21:00Z";
  const evidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
    authorization,
    observedAt: completedAt,
    resources: sessionProofApplyResourceIdentities("grant-receipts").map((resource, index) => ({
      ...resource,
      uid: `grant-resource-uid-${index + 1}`,
    })),
  }));
  const receipt = completeSessionProofStep(authorization, {
    namespaceResource: namespace(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  persistSessionProofGrantApplyFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:20:00Z",
    completedAt,
  }, stub.execute, () => ({ evidenceSource, receipt }));
  return { authorization, evidenceSource, receipt };
}

function persistThroughGrantWaitAuthorization(inputs, stub) {
  persistThroughGrantOutputs(inputs, stub);
  return persistEighthSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:22:00Z",
  }, stub.execute);
}

function persistThroughGrantWaitOutputs(inputs, stub) {
  const authorization = persistThroughGrantWaitAuthorization(inputs, stub);
  const completedAt = "2026-08-05T06:24:00Z";
  const grantApplyReceiptSource = readFileSync(inputs.seventhStepReceiptPath, "utf8");
  const grantApplyEvidenceSource = readFileSync(inputs.seventhEvidencePath, "utf8");
  const grantJobUid = JSON.parse(grantApplyEvidenceSource).resourceInventory.find(
    (resource) => resource.kind === "Job",
  ).uid;
  const evidenceSource = JSON.stringify(buildSessionProofGrantCompletionEvidence({
    authorization,
    grantApplyReceiptSource,
    grantApplyEvidenceSource,
    job: {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: "codeops-session-proof-grants",
        namespace: identity.namespace,
        uid: grantJobUid,
        generation: 1,
      },
      spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 300 },
      status: {
        active: 0,
        succeeded: 1,
        failed: 0,
        startTime: "2026-08-05T06:23:00Z",
        completionTime: "2026-08-05T06:23:04Z",
        conditions: [{ type: "Complete", status: "True" }],
      },
    },
    observedAt: completedAt,
  }));
  const receipt = completeSessionProofStep(authorization, {
    namespaceResource: namespace(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  persistSessionProofGrantWaitFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:23:00Z",
    completedAt,
    maxAttempts: 36,
    pollIntervalMs: 10_000,
  }, stub.execute, () => ({ evidenceSource, receipt }));
  return { authorization, evidenceSource, receipt };
}

function persistThroughCodexLoginOutputs(inputs, stub) {
  persistThroughGrantWaitOutputs(inputs, stub);
  const authorization = persistNinthSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:25:00Z",
  }, stub.execute);
  const completedAt = "2026-08-05T06:27:00Z";
  const evidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
    authorization,
    observedAt: completedAt,
    resources: sessionProofApplyResourceIdentities("codex-login").map((resource, index) => ({
      ...resource,
      uid: `codex-login-resource-uid-${index + 1}`,
    })),
  }));
  const receipt = completeSessionProofStep(authorization, {
    namespaceResource: namespace(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  persistSessionProofCodexLoginApplyFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:26:00Z",
    completedAt,
  }, stub.execute, () => ({ evidenceSource, receipt }));
  return { authorization, evidenceSource, receipt };
}

function persistThroughCodexLoginWaitAuthorization(inputs, stub) {
  persistThroughCodexLoginOutputs(inputs, stub);
  return persistTenthSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:28:00Z",
  }, stub.execute);
}

function persistThroughCodexLoginWaitOutputs(inputs, stub) {
  const authorization = persistThroughCodexLoginWaitAuthorization(inputs, stub);
  const completedAt = "2026-08-05T06:30:00Z";
  const loginApplyReceiptSource = readFileSync(inputs.ninthStepReceiptPath, "utf8");
  const loginApplyEvidenceSource = readFileSync(inputs.ninthEvidencePath, "utf8");
  const resourceInventory = JSON.parse(loginApplyEvidenceSource).resourceInventory;
  const evidenceSource = JSON.stringify(buildSessionProofCodexLoginCompletionEvidence({
    authorization,
    loginApplyReceiptSource,
    loginApplyEvidenceSource,
    job: {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: "codeops-codex-auth-login",
        namespace: identity.namespace,
        uid: resourceInventory.find((resource) => resource.kind === "Job").uid,
        generation: 1,
      },
      spec: {
        completions: 1,
        parallelism: 1,
        backoffLimit: 0,
        activeDeadlineSeconds: 900,
        ttlSecondsAfterFinished: 3600,
      },
      status: {
        active: 0,
        succeeded: 1,
        failed: 0,
        startTime: "2026-08-05T06:29:00Z",
        completionTime: "2026-08-05T06:29:30Z",
        conditions: [{ type: "Complete", status: "True", reason: "CompletionsReached" }],
      },
    },
    persistentVolumeClaim: {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: "codeops-codex-auth",
        namespace: identity.namespace,
        uid: resourceInventory.find(
          (resource) => resource.kind === "PersistentVolumeClaim",
        ).uid,
      },
      status: { phase: "Bound" },
    },
    observedAt: completedAt,
  }));
  const receipt = completeSessionProofStep(authorization, {
    namespaceResource: namespace(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  persistSessionProofCodexLoginWaitFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:29:00Z",
    completedAt,
    maxAttempts: 96,
    pollIntervalMs: 10_000,
  }, stub.execute, () => ({ evidenceSource, receipt }));
  return { authorization, evidenceSource, receipt };
}

async function persistThroughCodexSmokeReplacementOutputs(inputs, stub) {
  persistThroughCodexLoginWaitOutputs(inputs, stub);
  const authorization = persistEleventhSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:31:00Z",
  }, stub.execute);
  const completedAt = "2026-08-05T06:33:00Z";
  const loginCompletionReceiptSource = readFileSync(inputs.tenthStepReceiptPath, "utf8");
  const loginCompletionEvidenceSource = readFileSync(inputs.tenthEvidencePath, "utf8");
  const loginInventory = JSON.parse(readFileSync(inputs.ninthEvidencePath, "utf8"))
    .resourceInventory;
  const evidenceSource = JSON.stringify(buildSessionProofCodexSmokeReplacementEvidence({
    authorization,
    loginCompletionReceiptSource,
    loginCompletionEvidenceSource,
    resources: sessionProofApplyResourceIdentities("codex-smoke").map((resource) => ({
      ...resource,
      uid: resource.kind === "Job"
        ? "codex-smoke-resource-uid"
        : loginInventory.find((previous) =>
          previous.apiVersion === resource.apiVersion &&
          previous.kind === resource.kind &&
          previous.name === resource.name).uid,
    })),
    loginJobAbsent: true,
    observedAt: completedAt,
  }));
  const receipt = completeSessionProofStep(authorization, {
    namespaceResource: namespace(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  await persistSessionProofCodexSmokeReplacementFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:32:00Z",
    completedAt,
  }, stub.execute, () => ({ evidenceSource, receipt }));
  return { authorization, evidenceSource, receipt };
}

async function persistThroughCodexSmokeWaitOutputs(inputs, stub) {
  await persistThroughCodexSmokeReplacementOutputs(inputs, stub);
  const authorization = persistTwelfthSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:34:00Z",
  }, stub.execute);
  const smokeReplacementReceiptSource = readFileSync(
    inputs.eleventhStepReceiptPath,
    "utf8",
  );
  const smokeReplacementEvidenceSource = readFileSync(inputs.eleventhEvidencePath, "utf8");
  const smokeApplyEvidence = JSON.parse(
    JSON.parse(smokeReplacementEvidenceSource).smokeApplyEvidenceSource,
  );
  const smokeJob = smokeApplyEvidence.resourceInventory.find((resource) =>
    resource.kind === "Job" && resource.name === "codeops-codex-auth-smoke");
  const smokeClaim = smokeApplyEvidence.resourceInventory.find((resource) =>
    resource.kind === "PersistentVolumeClaim" && resource.name === "codeops-codex-auth");
  const completedAt = "2026-08-05T06:36:00Z";
  const evidenceSource = JSON.stringify(buildSessionProofCodexSmokeCompletionEvidence({
    authorization,
    smokeReplacementReceiptSource,
    smokeReplacementEvidenceSource,
    loginJobAbsent: true,
    job: {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: "codeops-codex-auth-smoke",
        namespace: identity.namespace,
        uid: smokeJob.uid,
        generation: 1,
      },
      spec: {
        completions: 1,
        parallelism: 1,
        backoffLimit: 0,
        activeDeadlineSeconds: 900,
        ttlSecondsAfterFinished: 3600,
      },
      status: {
        active: 0,
        succeeded: 1,
        failed: 0,
        startTime: "2026-08-05T06:35:00Z",
        completionTime: "2026-08-05T06:35:30Z",
        conditions: [{ type: "Complete", status: "True" }],
      },
    },
    persistentVolumeClaim: {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: "codeops-codex-auth",
        namespace: identity.namespace,
        uid: smokeClaim.uid,
      },
      status: { phase: "Bound" },
    },
    observedAt: completedAt,
  }));
  const receipt = completeSessionProofStep(authorization, {
    namespaceResource: namespace(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  persistSessionProofCodexSmokeWaitFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:35:00Z",
    completedAt,
    maxAttempts: 96,
    pollIntervalMs: 10_000,
  }, stub.execute, () => ({ evidenceSource, receipt }));
  return { authorization, evidenceSource, receipt };
}

async function persistThroughUiAuthorization(inputs, stub) {
  await persistThroughCodexSmokeWaitOutputs(inputs, stub);
  return persistThirteenthSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:37:00Z",
  }, stub.execute);
}

async function persistThroughUiApplyOutputs(inputs, stub) {
  const authorization = await persistThroughUiAuthorization(inputs, stub);
  const completedAt = "2026-08-05T06:39:00Z";
  const evidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
    authorization,
    observedAt: completedAt,
    resources: sessionProofApplyResourceIdentities("start-ui").map((resource, index) => ({
      ...resource,
      uid: `ui-resource-uid-${index}`,
    })),
  }));
  const receipt = completeSessionProofStep(authorization, {
    namespaceResource: namespace(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  const persisted = persistSessionProofUiApplyFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:38:00Z",
    completedAt,
  }, stub.execute, (input, runnerArgument) => {
    assert.equal(runnerArgument, stub.execute);
    assert.deepEqual(input, {
      authorization,
      manifestSource: "synthetic-ui-artifact\n",
      startedAt: "2026-08-05T06:38:00Z",
      completedAt,
    });
    assert.equal(statSync(inputs.thirteenthEvidencePath).mode & 0o777, 0o600);
    assert.equal(statSync(inputs.thirteenthStepReceiptPath).mode & 0o777, 0o600);
    assert.equal(statSync(inputs.thirteenthEvidencePath).size, 0);
    assert.equal(statSync(inputs.thirteenthStepReceiptPath).size, 0);
    return { evidenceSource, receipt };
  });
  return { authorization, evidenceSource, receipt, persisted };
}

async function persistThroughUiWaitAuthorization(inputs, stub) {
  const outputs = await persistThroughUiApplyOutputs(inputs, stub);
  const authorization = persistFourteenthSessionProofStepAuthorizationFromOperatorPacket({
    ...inputs,
    observedAt: "2026-08-05T06:40:00Z",
  }, stub.execute);
  return { ...outputs, waitAuthorization: authorization };
}

async function persistThroughUiWaitOutputs(inputs, stub) {
  const { persisted: uiApply, waitAuthorization: authorization } =
    await persistThroughUiWaitAuthorization(inputs, stub);
  const completedAt = "2026-08-05T06:42:00Z";
  const uiApplyEvidenceSource = readFileSync(inputs.thirteenthEvidencePath, "utf8");
  const evidenceSource = JSON.stringify(buildSessionProofUiReadinessEvidence({
    authorization,
    uiApplyReceiptSource: uiApply.receiptSource,
    uiApplyEvidenceSource,
    deployment: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: "codeops-agents-ui",
        namespace: identity.namespace,
        uid: "ui-resource-uid-0",
        generation: 1,
      },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 1,
        replicas: 1,
        updatedReplicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        unavailableReplicas: 0,
        conditions: [
          { type: "Available", status: "True" },
          { type: "Progressing", status: "True" },
        ],
      },
    },
    observedAt: completedAt,
  }));
  const receipt = completeSessionProofStep(authorization, {
    namespaceResource: namespace(),
    operator,
    target,
    completedAt,
    evidenceSource,
  });
  const persisted = persistSessionProofUiWaitFromOperatorPacket({
    ...inputs,
    startedAt: "2026-08-05T06:41:00Z",
    completedAt,
    maxAttempts: 120,
    pollIntervalMs: 1000,
  }, stub.execute, (input, runnerArgument) => {
    assert.equal(runnerArgument, stub.execute);
    assert.deepEqual(input, {
      authorization,
      uiApplyReceiptSource: uiApply.receiptSource,
      uiApplyEvidenceSource,
      startedAt: "2026-08-05T06:41:00Z",
      completedAt,
      maxAttempts: 120,
      pollIntervalMs: 1000,
    });
    assert.equal(statSync(inputs.fourteenthEvidencePath).mode & 0o777, 0o600);
    assert.equal(statSync(inputs.fourteenthStepReceiptPath).mode & 0o777, 0o600);
    assert.equal(statSync(inputs.fourteenthEvidencePath).size, 0);
    assert.equal(statSync(inputs.fourteenthStepReceiptPath).size, 0);
    return { evidenceSource, receipt };
  });
  return { authorization, evidenceSource, receipt, persisted };
}

test("creates only the reviewed namespace package after live preflight and binds its UID", () => {
  const stub = runner();
  const result = createSessionProofNamespace({
    planSource,
    admission,
    namespaceManifestSource,
    observedAt: "2026-08-05T06:00:00Z",
  }, stub.execute);
  assert.equal(result.result, "created-and-uid-bound");
  assert.equal(result.namespace.uid, "namespace-uid-1");
  assert.equal(result.admission.state, "approved-bound");
  assert.equal(result.proceed, true);
  const mutations = stub.calls.filter(({ args }) => args[0] === "create");
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].args, ["create", "--filename", "-", "--request-timeout=30s"]);
});

test("returns a UID-bound non-proceed receipt after partial package creation", () => {
  const stub = runner(false, true);
  const result = createSessionProofNamespace({
    planSource,
    admission,
    namespaceManifestSource,
    observedAt: "2026-08-05T06:00:00Z",
  }, stub.execute);
  assert.equal(result.result, "namespace-uid-bound-create-incomplete");
  assert.equal(result.proceed, false);
  assert.equal(result.admission.namespaceUid, "namespace-uid-1");
});

test("rejects manifest drift or an existing namespace before create", () => {
  const drift = runner();
  assert.throws(() => createSessionProofNamespace({
    planSource,
    admission,
    namespaceManifestSource: `${namespaceManifestSource}\n`,
    observedAt: "2026-08-05T06:00:00Z",
  }, drift.execute));
  assert.equal(drift.calls.length, 0);
  const existing = runner(true);
  assert.throws(() => createSessionProofNamespace({
    planSource,
    admission,
    namespaceManifestSource,
    observedAt: "2026-08-05T06:00:00Z",
  }, existing.execute));
  assert.equal(existing.calls.some(({ args }) => args[0] === "create"), false);
});

test("creates from only the exact operator packet and attached admission", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const result = createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    assert.equal(result.result, "created-and-uid-bound");
    assert.equal(result.admission.namespaceUid, "namespace-uid-1");
    assert.deepEqual(Object.keys(result).sort(), [
      "admission",
      "apiVersion",
      "checkedAt",
      "namespace",
      "namespaceManifestSha256",
      "planSha256",
      "proceed",
      "result",
    ]);
    assert.equal(stub.calls.filter(({ args }) => args[0] === "create").length, 1);
    assert.equal(statSync(inputs.receiptPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(inputs.receiptPath, "utf8")), result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a substituted or existing creation receipt before Kubernetes access", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    assert.throws(() => createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      receiptPath: join(root, "substituted-receipt.json"),
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute), /derive exactly/i);
    assert.equal(stub.calls.length, 0);

    writeFileSync(inputs.receiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists the UID-bound non-proceed receipt after partial package creation", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner(false, true);
    const result = createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    assert.equal(result.result, "namespace-uid-bound-create-incomplete");
    assert.equal(result.proceed, false);
    assert.equal(result.namespace.uid, "namespace-uid-1");
    assert.deepEqual(JSON.parse(readFileSync(inputs.receiptPath, "utf8")), result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only the first intermediate step from the exact persisted operator artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    const mutationCount = stub.calls.filter(({ args }) => args[0] === "create").length;
    const authorization = persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    assert.equal(authorization.stepIndex, 2);
    assert.equal(authorization.stepId, "issue-broker-capabilities");
    assert.equal(authorization.artifact, null);
    assert.equal(statSync(inputs.authorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.authorizationPath, "utf8")),
      authorization,
    );
    assert.equal(
      stub.calls.filter(({ args }) => args[0] === "create").length,
      mutationCount,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the broker issuer consumes only the exact persisted first-step authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    const result = issueFirstSessionProofCredentialsFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute);
    assert.equal(result.receipt.stepId, "issue-broker-capabilities");
    assert.equal(result.receipt.previousReceiptSha256,
      createHash("sha256").update(readFileSync(inputs.receiptPath)).digest("hex"));
    assert.equal(
      stub.calls.filter(({ file }) => file.endsWith("issue-codeops-session-proof-secrets.sh")).length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably persists the exact broker evidence and completion receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    const execute = (file, args, options) => {
      if (file.endsWith("issue-codeops-session-proof-secrets.sh")) {
        assert.equal(statSync(inputs.evidencePath).mode & 0o777, 0o600);
        assert.equal(statSync(inputs.stepReceiptPath).mode & 0o777, 0o600);
        assert.equal(statSync(inputs.evidencePath).size, 0);
        assert.equal(statSync(inputs.stepReceiptPath).size, 0);
      }
      return stub.execute(file, args, options);
    };
    const result = persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, execute);
    assert.equal(statSync(inputs.evidencePath).mode & 0o777, 0o600);
    assert.equal(statSync(inputs.stepReceiptPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(inputs.evidencePath, "utf8"), result.evidenceSource);
    assert.equal(readFileSync(inputs.stepReceiptPath, "utf8"), result.receiptSource);
    assert.equal(
      result.receipt.evidenceSha256,
      createHash("sha256").update(readFileSync(inputs.evidencePath)).digest("hex"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserves exact broker output paths before credential issuance", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);

    assert.throws(() => persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      evidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute), /derive exactly/);
    writeFileSync(inputs.stepReceiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute), /already exists/);
    assert.equal(
      stub.calls.some(({ file }) => file.endsWith("issue-codeops-session-proof-secrets.sh")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only step 3 from the exact persisted broker outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute);
    const issuerCalls = stub.calls.filter(({ file }) =>
      file.endsWith("issue-codeops-session-proof-secrets.sh")).length;
    const authorization = persistSecondSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:04:00Z",
    }, stub.execute);
    assert.equal(authorization.stepIndex, 3);
    assert.equal(authorization.stepId, "issue-runtime-capabilities");
    assert.equal(authorization.artifact, null);
    assert.equal(
      authorization.previousReceiptSha256,
      createHash("sha256").update(readFileSync(inputs.stepReceiptPath)).digest("hex"),
    );
    assert.equal(statSync(inputs.secondAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.secondAuthorizationPath, "utf8")),
      authorization,
    );
    assert.equal(stub.calls.filter(({ file }) =>
      file.endsWith("issue-codeops-session-proof-secrets.sh")).length, issuerCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted or existing step-3 authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const setup = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, setup.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, setup.execute);
    persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, setup.execute);
    const stub = runner(true);
    assert.throws(() => persistSecondSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      secondAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:04:00Z",
    }, stub.execute), /derive exactly/);
    assert.equal(stub.calls.length, 0);

    writeFileSync(inputs.secondAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSecondSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:04:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runtime issuer consumes only the exact persisted step-3 authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute);
    persistSecondSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:04:00Z",
    }, stub.execute);
    const result = issueSecondSessionProofCredentialsFromOperatorPacket({
      ...inputs,
      registryConfigFile: "/private/registry-config.json",
      repositoryTokenFile: "/private/repository-token",
      startedAt: "2026-08-05T06:05:00Z",
      completedAt: "2026-08-05T06:06:00Z",
    }, stub.execute);
    assert.equal(result.receipt.stepId, "issue-runtime-capabilities");
    assert.equal(result.receipt.previousReceiptSha256,
      createHash("sha256").update(readFileSync(inputs.stepReceiptPath)).digest("hex"));
    assert.equal(stub.calls.filter(({ file }) =>
      file.endsWith("issue-codeops-session-proof-runtime-credentials.sh")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("step-3 authorization drift fails before the runtime issuer is invoked", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute);
    persistSecondSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:04:00Z",
    }, stub.execute);
    const authorization = JSON.parse(readFileSync(inputs.secondAuthorizationPath, "utf8"));
    writeFileSync(inputs.secondAuthorizationPath, `${JSON.stringify({
      ...authorization,
      action: "operator-apply",
    }, null, 2)}\n`);
    assert.throws(() => issueSecondSessionProofCredentialsFromOperatorPacket({
      ...inputs,
      registryConfigFile: "/private/registry-config.json",
      repositoryTokenFile: "/private/repository-token",
      startedAt: "2026-08-05T06:05:00Z",
      completedAt: "2026-08-05T06:06:00Z",
    }, stub.execute), /exact persisted artifact/);
    assert.equal(stub.calls.some(({ file }) =>
      file.endsWith("issue-codeops-session-proof-runtime-credentials.sh")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably persists the exact runtime evidence and completion receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute);
    persistSecondSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:04:00Z",
    }, stub.execute);
    const execute = (file, args, options) => {
      if (file.endsWith("issue-codeops-session-proof-runtime-credentials.sh")) {
        assert.equal(statSync(inputs.secondEvidencePath).mode & 0o777, 0o600);
        assert.equal(statSync(inputs.secondStepReceiptPath).mode & 0o777, 0o600);
        assert.equal(statSync(inputs.secondEvidencePath).size, 0);
        assert.equal(statSync(inputs.secondStepReceiptPath).size, 0);
      }
      return stub.execute(file, args, options);
    };
    const result = persistSecondSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      registryConfigFile: "/private/registry-config.json",
      repositoryTokenFile: "/private/repository-token",
      startedAt: "2026-08-05T06:05:00Z",
      completedAt: "2026-08-05T06:06:00Z",
    }, execute);
    assert.equal(statSync(inputs.secondEvidencePath).mode & 0o777, 0o600);
    assert.equal(statSync(inputs.secondStepReceiptPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(inputs.secondEvidencePath, "utf8"), result.evidenceSource);
    assert.equal(readFileSync(inputs.secondStepReceiptPath, "utf8"), result.receiptSource);
    assert.equal(
      result.receipt.evidenceSha256,
      createHash("sha256").update(readFileSync(inputs.secondEvidencePath)).digest("hex"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserves exact runtime output paths before credential issuance", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute);
    persistSecondSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:04:00Z",
    }, stub.execute);

    assert.throws(() => persistSecondSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      secondEvidencePath: join(root, "substituted.evidence.json"),
      registryConfigFile: "/private/registry-config.json",
      repositoryTokenFile: "/private/repository-token",
      startedAt: "2026-08-05T06:05:00Z",
      completedAt: "2026-08-05T06:06:00Z",
    }, stub.execute), /derive exactly/);
    writeFileSync(inputs.secondStepReceiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSecondSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      registryConfigFile: "/private/registry-config.json",
      repositoryTokenFile: "/private/repository-token",
      startedAt: "2026-08-05T06:05:00Z",
      completedAt: "2026-08-05T06:06:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.some(({ file }) =>
      file.endsWith("issue-codeops-session-proof-runtime-credentials.sh")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only database start from the exact persisted runtime outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute);
    persistSecondSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:04:00Z",
    }, stub.execute);
    persistSecondSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      registryConfigFile: "/private/registry-config.json",
      repositoryTokenFile: "/private/repository-token",
      startedAt: "2026-08-05T06:05:00Z",
      completedAt: "2026-08-05T06:06:00Z",
    }, stub.execute);
    const authorization = authorizeThirdSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:07:00Z",
    }, stub.execute);
    assert.equal(authorization.stepIndex, 4);
    assert.equal(authorization.stepId, "start-database");
    assert.equal(authorization.action, "operator-apply");
    assert.equal(authorization.artifact, "database");
    assert.equal(
      authorization.artifactSha256,
      createHash("sha256").update("synthetic-database-artifact\n").digest("hex"),
    );
    assert.equal(
      authorization.previousReceiptSha256,
      createHash("sha256").update(readFileSync(inputs.secondStepReceiptPath)).digest("hex"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime evidence drift fails before database-start authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute);
    persistSecondSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:04:00Z",
    }, stub.execute);
    persistSecondSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      registryConfigFile: "/private/registry-config.json",
      repositoryTokenFile: "/private/repository-token",
      startedAt: "2026-08-05T06:05:00Z",
      completedAt: "2026-08-05T06:06:00Z",
    }, stub.execute);
    const evidence = JSON.parse(readFileSync(inputs.secondEvidencePath, "utf8"));
    writeFileSync(inputs.secondEvidencePath, JSON.stringify({ ...evidence, result: "partial" }));
    assert.throws(() => authorizeThirdSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:07:00Z",
    }, stub.execute));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists the exact private database-start authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute);
    persistSecondSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:04:00Z",
    }, stub.execute);
    persistSecondSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      registryConfigFile: "/private/registry-config.json",
      repositoryTokenFile: "/private/repository-token",
      startedAt: "2026-08-05T06:05:00Z",
      completedAt: "2026-08-05T06:06:00Z",
    }, stub.execute);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    const authorization = persistThirdSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:07:00Z",
    }, stub.execute);
    assert.equal(statSync(inputs.thirdAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(inputs.thirdAuthorizationPath, "utf8")), authorization);
    assert.deepEqual(
      readThirdSessionProofStepAuthorizationFromOperatorPacket(inputs, stub.execute).authorization,
      authorization,
    );
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted or existing database-start authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const setup = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, setup.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, setup.execute);
    persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, setup.execute);
    persistSecondSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:04:00Z",
    }, setup.execute);
    persistSecondSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      registryConfigFile: "/private/registry-config.json",
      repositoryTokenFile: "/private/repository-token",
      startedAt: "2026-08-05T06:05:00Z",
      completedAt: "2026-08-05T06:06:00Z",
    }, setup.execute);
    const stub = runner(true);
    assert.throws(() => persistThirdSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      thirdAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:07:00Z",
    }, stub.execute), /derive exactly/);
    assert.equal(stub.calls.length, 0);
    writeFileSync(inputs.thirdAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistThirdSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:07:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands only the exact persisted database authorization and manifest to the apply adapter", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const authorization = persistThroughDatabaseAuthorization(inputs, stub);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    let received;
    const result = applySessionProofDatabaseFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:08:00Z",
      completedAt: "2026-08-05T06:09:00Z",
    }, stub.execute, (input, runnerArgument) => {
      received = input;
      assert.equal(runnerArgument, stub.execute);
      return { accepted: true };
    });
    assert.deepEqual(result, { accepted: true });
    assert.deepEqual(received.authorization, authorization);
    assert.equal(received.manifestSource, "synthetic-database-artifact\n");
    assert.equal(received.startedAt, "2026-08-05T06:08:00Z");
    assert.equal(received.completedAt, "2026-08-05T06:09:00Z");
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorization drift fails before the database apply adapter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughDatabaseAuthorization(inputs, stub);
    const authorization = JSON.parse(readFileSync(inputs.thirdAuthorizationPath, "utf8"));
    writeFileSync(inputs.thirdAuthorizationPath, `${JSON.stringify({
      ...authorization,
      artifactSha256: "f".repeat(64),
    }, null, 2)}\n`, { mode: 0o600 });
    let applyCalls = 0;
    assert.throws(() => applySessionProofDatabaseFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:08:00Z",
      completedAt: "2026-08-05T06:09:00Z",
    }, stub.execute, () => {
      applyCalls += 1;
    }), /exact persisted artifact/);
    assert.equal(applyCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably persists the exact database apply evidence and completion receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const authorization = persistThroughDatabaseAuthorization(inputs, stub);
    const evidenceSource = JSON.stringify({
      apiVersion: "codeops.example/session-proof-apply-evidence/v1",
      stepId: "start-database",
      observedAt: "2026-08-05T06:09:00Z",
    });
    const receipt = {
      stepId: "start-database",
      evidenceSha256: createHash("sha256").update(evidenceSource).digest("hex"),
    };
    let applyCalls = 0;
    const result = persistSessionProofDatabaseApplyFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:08:00Z",
      completedAt: "2026-08-05T06:09:00Z",
    }, stub.execute, (received, runnerArgument) => {
      applyCalls += 1;
      assert.deepEqual(received.authorization, authorization);
      assert.equal(received.manifestSource, "synthetic-database-artifact\n");
      assert.equal(runnerArgument, stub.execute);
      assert.equal(statSync(inputs.thirdEvidencePath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.thirdStepReceiptPath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.thirdEvidencePath).size, 0);
      assert.equal(statSync(inputs.thirdStepReceiptPath).size, 0);
      return { evidenceSource, receipt };
    });
    assert.equal(applyCalls, 1);
    assert.equal(readFileSync(inputs.thirdEvidencePath, "utf8"), evidenceSource);
    assert.equal(readFileSync(inputs.thirdStepReceiptPath, "utf8"), result.receiptSource);
    assert.equal(result.receipt.evidenceSha256,
      createHash("sha256").update(readFileSync(inputs.thirdEvidencePath)).digest("hex"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserves exact database output paths before the apply adapter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughDatabaseAuthorization(inputs, stub);
    let applyCalls = 0;
    const apply = () => {
      applyCalls += 1;
      return { evidenceSource: "{}", receipt: {} };
    };
    assert.throws(() => persistSessionProofDatabaseApplyFromOperatorPacket({
      ...inputs,
      thirdEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:08:00Z",
      completedAt: "2026-08-05T06:09:00Z",
    }, stub.execute, apply), /derive exactly/);
    writeFileSync(inputs.thirdStepReceiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSessionProofDatabaseApplyFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:08:00Z",
      completedAt: "2026-08-05T06:09:00Z",
    }, stub.execute, apply), /already exists/);
    assert.equal(applyCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only database readiness from the exact persisted database outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const { receipt } = persistThroughDatabaseOutputs(inputs, stub);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    const authorization = authorizeFourthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:10:00Z",
    }, stub.execute);
    assert.equal(authorization.stepIndex, 5);
    assert.equal(authorization.stepId, "wait-database");
    assert.equal(authorization.action, "operator-wait-ready");
    assert.equal(authorization.artifact, null);
    assert.equal(authorization.artifactSha256, null);
    assert.equal(authorization.previousReceiptSha256,
      createHash("sha256").update(`${JSON.stringify(receipt, null, 2)}\n`).digest("hex"));
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database apply evidence drift fails before database readiness authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughDatabaseOutputs(inputs, stub);
    const evidence = JSON.parse(readFileSync(inputs.thirdEvidencePath, "utf8"));
    writeFileSync(inputs.thirdEvidencePath, JSON.stringify({ ...evidence, extra: true }));
    assert.throws(() => authorizeFourthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:10:00Z",
    }, stub.execute), /evidence|receipt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists the exact private database-readiness authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughDatabaseOutputs(inputs, stub);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    const authorization = persistFourthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:10:00Z",
    }, stub.execute);
    assert.equal(statSync(inputs.fourthAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.fourthAuthorizationPath, "utf8")),
      authorization,
    );
    assert.deepEqual(
      readFourthSessionProofStepAuthorizationFromOperatorPacket(inputs, stub.execute)
        .authorization,
      authorization,
    );
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted or existing database-readiness authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const setup = runner();
    persistThroughDatabaseOutputs(inputs, setup);
    const stub = runner(true);
    assert.throws(() => persistFourthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      fourthAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:10:00Z",
    }, stub.execute), /derive exactly/);
    assert.equal(stub.calls.length, 0);
    writeFileSync(inputs.fourthAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistFourthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:10:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands only the exact persisted database-readiness authorization and apply chain to the waiter", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const { evidenceSource, receipt, waitAuthorization } =
      persistThroughDatabaseWaitAuthorization(inputs, stub);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    let received;
    const result = waitForSessionProofDatabaseFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:11:00Z",
      completedAt: "2026-08-05T06:12:00Z",
      maxAttempts: 12,
      pollIntervalMs: 1000,
    }, stub.execute, (input, runnerArgument) => {
      received = input;
      assert.equal(runnerArgument, stub.execute);
      return { accepted: true };
    });
    assert.deepEqual(result, { accepted: true });
    assert.deepEqual(received.authorization, waitAuthorization);
    assert.equal(received.databaseApplyEvidenceSource, evidenceSource);
    assert.equal(
      received.databaseApplyReceiptSource,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    assert.equal(received.startedAt, "2026-08-05T06:11:00Z");
    assert.equal(received.completedAt, "2026-08-05T06:12:00Z");
    assert.equal(received.maxAttempts, 12);
    assert.equal(received.pollIntervalMs, 1000);
    assert.deepEqual(Object.keys(received).sort(), [
      "authorization",
      "completedAt",
      "databaseApplyEvidenceSource",
      "databaseApplyReceiptSource",
      "maxAttempts",
      "pollIntervalMs",
      "startedAt",
    ]);
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database-readiness authorization drift fails before the waiter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughDatabaseWaitAuthorization(inputs, stub);
    const authorization = JSON.parse(readFileSync(inputs.fourthAuthorizationPath, "utf8"));
    writeFileSync(inputs.fourthAuthorizationPath, `${JSON.stringify({
      ...authorization,
      maxAttempts: 1,
    }, null, 2)}\n`, { mode: 0o600 });
    let waiterCalls = 0;
    assert.throws(() => waitForSessionProofDatabaseFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:11:00Z",
      completedAt: "2026-08-05T06:12:00Z",
      maxAttempts: 12,
      pollIntervalMs: 1000,
    }, stub.execute, () => {
      waiterCalls += 1;
    }), /exact persisted artifact/);
    assert.equal(waiterCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably persists the exact database-readiness evidence and completion receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const { evidenceSource: applyEvidenceSource, receipt: applyReceipt, waitAuthorization } =
      persistThroughDatabaseWaitAuthorization(inputs, stub);
    const completedAt = "2026-08-05T06:12:00Z";
    const evidenceSource = JSON.stringify(buildSessionProofReadinessEvidence({
      authorization: waitAuthorization,
      databaseApplyReceiptSource: `${JSON.stringify(applyReceipt, null, 2)}\n`,
      databaseApplyEvidenceSource: applyEvidenceSource,
      deployment: readyDatabaseDeployment(),
      observedAt: completedAt,
    }));
    const receipt = completeSessionProofStep(waitAuthorization, {
      namespaceResource: namespace(),
      operator,
      target,
      completedAt,
      evidenceSource,
    });
    let waiterCalls = 0;
    const result = persistSessionProofDatabaseWaitFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:11:00Z",
      completedAt,
      maxAttempts: 12,
      pollIntervalMs: 1000,
    }, stub.execute, (received, runnerArgument) => {
      waiterCalls += 1;
      assert.deepEqual(received.authorization, waitAuthorization);
      assert.equal(runnerArgument, stub.execute);
      assert.equal(statSync(inputs.fourthEvidencePath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.fourthStepReceiptPath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.fourthEvidencePath).size, 0);
      assert.equal(statSync(inputs.fourthStepReceiptPath).size, 0);
      return { evidenceSource, receipt };
    });
    assert.equal(waiterCalls, 1);
    assert.equal(readFileSync(inputs.fourthEvidencePath, "utf8"), evidenceSource);
    assert.equal(readFileSync(inputs.fourthStepReceiptPath, "utf8"), result.receiptSource);
    assert.equal(result.receipt.evidenceSha256,
      createHash("sha256").update(readFileSync(inputs.fourthEvidencePath)).digest("hex"));
    const reopened = readSessionProofDatabaseWaitOutputsFromOperatorPacket(inputs, stub.execute);
    assert.equal(reopened.fourthEvidenceSource, evidenceSource);
    assert.equal(reopened.fourthStepReceiptSource, result.receiptSource);
    assert.deepEqual(reopened.fourthAuthorization, waitAuthorization);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserves exact database-readiness output paths before the waiter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughDatabaseWaitAuthorization(inputs, stub);
    let waiterCalls = 0;
    const waiter = () => {
      waiterCalls += 1;
      return { evidenceSource: "{}", receipt: {} };
    };
    assert.throws(() => persistSessionProofDatabaseWaitFromOperatorPacket({
      ...inputs,
      fourthEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:11:00Z",
      completedAt: "2026-08-05T06:12:00Z",
      maxAttempts: 12,
      pollIntervalMs: 1000,
    }, stub.execute, waiter), /derive exactly/);
    writeFileSync(inputs.fourthStepReceiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSessionProofDatabaseWaitFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:11:00Z",
      completedAt: "2026-08-05T06:12:00Z",
      maxAttempts: 12,
      pollIntervalMs: 1000,
    }, stub.execute, waiter), /already exists/);
    assert.equal(waiterCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only gateway creation from the exact persisted database readiness outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const { receipt } = persistThroughDatabaseWaitOutputs(inputs, stub);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    const authorization = authorizeFifthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:13:00Z",
    }, stub.execute);
    assert.equal(authorization.stepIndex, 6);
    assert.equal(authorization.stepId, "start-gateway");
    assert.equal(authorization.action, "operator-apply");
    assert.equal(authorization.artifact, "gateway");
    assert.equal(
      authorization.artifactSha256,
      createHash("sha256").update("synthetic-gateway-artifact\n").digest("hex"),
    );
    assert.equal(
      authorization.previousReceiptSha256,
      createHash("sha256").update(`${JSON.stringify(receipt, null, 2)}\n`).digest("hex"),
    );
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("database readiness evidence drift fails before gateway authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughDatabaseWaitOutputs(inputs, stub);
    const evidence = JSON.parse(readFileSync(inputs.fourthEvidencePath, "utf8"));
    writeFileSync(inputs.fourthEvidencePath, JSON.stringify({ ...evidence, extra: true }));
    assert.throws(() => authorizeFifthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:13:00Z",
    }, stub.execute), /evidence|receipt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists the exact private gateway-start authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughDatabaseWaitOutputs(inputs, stub);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    const authorization = persistFifthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:13:00Z",
    }, stub.execute);
    assert.equal(statSync(inputs.fifthAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.fifthAuthorizationPath, "utf8")),
      authorization,
    );
    assert.deepEqual(
      readFifthSessionProofStepAuthorizationFromOperatorPacket(inputs, stub.execute)
        .authorization,
      authorization,
    );
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted or existing gateway-start authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const setup = runner();
    persistThroughDatabaseWaitOutputs(inputs, setup);
    const stub = runner(true);
    assert.throws(() => persistFifthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      fifthAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:13:00Z",
    }, stub.execute), /derive exactly/);
    assert.equal(stub.calls.length, 0);
    writeFileSync(inputs.fifthAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistFifthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:13:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands only the exact persisted gateway authorization and manifest to the apply adapter", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const authorization = persistThroughGatewayAuthorization(inputs, stub);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    let received;
    const result = applySessionProofGatewayFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:14:00Z",
      completedAt: "2026-08-05T06:15:00Z",
    }, stub.execute, (input, runnerArgument) => {
      received = input;
      assert.equal(runnerArgument, stub.execute);
      return { accepted: true };
    });
    assert.deepEqual(result, { accepted: true });
    assert.deepEqual(received.authorization, authorization);
    assert.equal(received.manifestSource, "synthetic-gateway-artifact\n");
    assert.equal(received.startedAt, "2026-08-05T06:14:00Z");
    assert.equal(received.completedAt, "2026-08-05T06:15:00Z");
    assert.deepEqual(Object.keys(received).sort(), [
      "authorization", "completedAt", "manifestSource", "startedAt",
    ]);
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gateway authorization drift fails before the apply adapter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGatewayAuthorization(inputs, stub);
    const authorization = JSON.parse(readFileSync(inputs.fifthAuthorizationPath, "utf8"));
    writeFileSync(inputs.fifthAuthorizationPath, `${JSON.stringify({
      ...authorization,
      artifactSha256: "f".repeat(64),
    }, null, 2)}\n`, { mode: 0o600 });
    let applyCalls = 0;
    assert.throws(() => applySessionProofGatewayFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:14:00Z",
      completedAt: "2026-08-05T06:15:00Z",
    }, stub.execute, () => {
      applyCalls += 1;
    }), /exact persisted artifact/);
    assert.equal(applyCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably persists the exact gateway apply evidence and completion receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const authorization = persistThroughGatewayAuthorization(inputs, stub);
    const completedAt = "2026-08-05T06:15:00Z";
    const evidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
      authorization,
      observedAt: completedAt,
      resources: sessionProofApplyResourceIdentities("start-gateway").map((resource, index) => ({
        ...resource,
        uid: `gateway-resource-uid-${index}`,
      })),
    }));
    const receipt = completeSessionProofStep(authorization, {
      namespaceResource: namespace(),
      operator,
      target,
      completedAt,
      evidenceSource,
    });
    let applyCalls = 0;
    const result = persistSessionProofGatewayApplyFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:14:00Z",
      completedAt,
    }, stub.execute, (received, runnerArgument) => {
      applyCalls += 1;
      assert.deepEqual(received.authorization, authorization);
      assert.equal(runnerArgument, stub.execute);
      assert.equal(statSync(inputs.fifthEvidencePath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.fifthStepReceiptPath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.fifthEvidencePath).size, 0);
      assert.equal(statSync(inputs.fifthStepReceiptPath).size, 0);
      return { evidenceSource, receipt };
    });
    assert.equal(applyCalls, 1);
    assert.equal(readFileSync(inputs.fifthEvidencePath, "utf8"), evidenceSource);
    assert.equal(readFileSync(inputs.fifthStepReceiptPath, "utf8"), result.receiptSource);
    assert.equal(result.receipt.evidenceSha256,
      createHash("sha256").update(readFileSync(inputs.fifthEvidencePath)).digest("hex"));
    const reopened = readSessionProofGatewayApplyOutputsFromOperatorPacket(inputs, stub.execute);
    assert.equal(reopened.fifthEvidenceSource, evidenceSource);
    assert.equal(reopened.fifthStepReceiptSource, result.receiptSource);
    assert.deepEqual(reopened.fifthAuthorization, authorization);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserves exact gateway output paths before the apply adapter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGatewayAuthorization(inputs, stub);
    let applyCalls = 0;
    const apply = () => {
      applyCalls += 1;
      return { evidenceSource: "{}", receipt: {} };
    };
    assert.throws(() => persistSessionProofGatewayApplyFromOperatorPacket({
      ...inputs,
      fifthEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:14:00Z",
      completedAt: "2026-08-05T06:15:00Z",
    }, stub.execute, apply), /derive exactly/);
    writeFileSync(inputs.fifthStepReceiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSessionProofGatewayApplyFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:14:00Z",
      completedAt: "2026-08-05T06:15:00Z",
    }, stub.execute, apply), /already exists/);
    assert.equal(applyCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only gateway migration readiness from the exact persisted gateway outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const { receipt } = persistThroughGatewayApplyOutputs(inputs, stub);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    const authorization = authorizeSixthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:16:00Z",
    }, stub.execute);
    assert.equal(authorization.stepIndex, 7);
    assert.equal(authorization.stepId, "wait-gateway-migration");
    assert.equal(authorization.action, "operator-wait-ready");
    assert.equal(authorization.artifact, null);
    assert.equal(authorization.artifactSha256, null);
    assert.equal(
      authorization.previousReceiptSha256,
      createHash("sha256").update(`${JSON.stringify(receipt, null, 2)}\n`).digest("hex"),
    );
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gateway apply evidence drift fails before gateway migration authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGatewayApplyOutputs(inputs, stub);
    const evidence = JSON.parse(readFileSync(inputs.fifthEvidencePath, "utf8"));
    writeFileSync(inputs.fifthEvidencePath, JSON.stringify({ ...evidence, extra: true }));
    assert.throws(() => authorizeSixthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:16:00Z",
    }, stub.execute), /evidence|receipt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists the exact private gateway-migration readiness authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGatewayApplyOutputs(inputs, stub);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    const authorization = persistSixthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:16:00Z",
    }, stub.execute);
    assert.equal(statSync(inputs.sixthAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.sixthAuthorizationPath, "utf8")),
      authorization,
    );
    assert.deepEqual(
      readSixthSessionProofStepAuthorizationFromOperatorPacket(inputs, stub.execute)
        .authorization,
      authorization,
    );
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted or existing gateway-migration authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const setup = runner();
    persistThroughGatewayApplyOutputs(inputs, setup);
    const stub = runner(true);
    assert.throws(() => persistSixthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      sixthAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:16:00Z",
    }, stub.execute), /derive exactly/);
    assert.equal(stub.calls.length, 0);
    writeFileSync(inputs.sixthAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSixthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:16:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands only the exact persisted gateway readiness authorization and apply outputs to the waiter", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const authorization = persistThroughGatewayWaitAuthorization(inputs, stub);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    let received;
    const result = waitForSessionProofGatewayMigrationFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:17:00Z",
      completedAt: "2026-08-05T06:18:00Z",
      maxAttempts: 12,
      pollIntervalMs: 1000,
    }, stub.execute, (input, runnerArgument) => {
      received = input;
      assert.equal(runnerArgument, stub.execute);
      return { accepted: true };
    });
    assert.deepEqual(result, { accepted: true });
    assert.deepEqual(received.authorization, authorization);
    assert.equal(received.gatewayApplyReceiptSource, readFileSync(inputs.fifthStepReceiptPath, "utf8"));
    assert.equal(received.gatewayApplyEvidenceSource, readFileSync(inputs.fifthEvidencePath, "utf8"));
    assert.equal(received.startedAt, "2026-08-05T06:17:00Z");
    assert.equal(received.completedAt, "2026-08-05T06:18:00Z");
    assert.equal(received.maxAttempts, 12);
    assert.equal(received.pollIntervalMs, 1000);
    assert.deepEqual(Object.keys(received).sort(), [
      "authorization",
      "completedAt",
      "gatewayApplyEvidenceSource",
      "gatewayApplyReceiptSource",
      "maxAttempts",
      "pollIntervalMs",
      "startedAt",
    ]);
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted gateway readiness authorization drift fails before the waiter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGatewayWaitAuthorization(inputs, stub);
    const authorization = JSON.parse(readFileSync(inputs.sixthAuthorizationPath, "utf8"));
    writeFileSync(inputs.sixthAuthorizationPath, `${JSON.stringify({
      ...authorization,
      action: "operator-apply",
    }, null, 2)}\n`, { mode: 0o600 });
    let waiterCalls = 0;
    assert.throws(() => waitForSessionProofGatewayMigrationFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:17:00Z",
      completedAt: "2026-08-05T06:18:00Z",
      maxAttempts: 12,
      pollIntervalMs: 1000,
    }, stub.execute, () => {
      waiterCalls += 1;
    }), /exact persisted artifact/);
    assert.equal(waiterCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably persists the exact gateway readiness evidence and completion receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const authorization = persistThroughGatewayWaitAuthorization(inputs, stub);
    const completedAt = "2026-08-05T06:18:00Z";
    const evidenceSource = JSON.stringify(buildSessionProofGatewayReadinessEvidence({
      authorization,
      gatewayApplyReceiptSource: readFileSync(inputs.fifthStepReceiptPath, "utf8"),
      gatewayApplyEvidenceSource: readFileSync(inputs.fifthEvidencePath, "utf8"),
      deployment: readyGatewayDeployment(),
      migrationRelation: sessionProofGatewayMigrationRelation(),
      observedAt: completedAt,
    }));
    const receipt = completeSessionProofStep(authorization, {
      namespaceResource: namespace(),
      operator,
      target,
      completedAt,
      evidenceSource,
    });
    let waiterCalls = 0;
    const result = persistSessionProofGatewayMigrationWaitFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:17:00Z",
      completedAt,
      maxAttempts: 12,
      pollIntervalMs: 1000,
    }, stub.execute, (received, runnerArgument) => {
      waiterCalls += 1;
      assert.deepEqual(received.authorization, authorization);
      assert.equal(runnerArgument, stub.execute);
      assert.equal(statSync(inputs.sixthEvidencePath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.sixthStepReceiptPath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.sixthEvidencePath).size, 0);
      assert.equal(statSync(inputs.sixthStepReceiptPath).size, 0);
      return { evidenceSource, receipt };
    });
    assert.equal(waiterCalls, 1);
    assert.equal(readFileSync(inputs.sixthEvidencePath, "utf8"), evidenceSource);
    assert.equal(readFileSync(inputs.sixthStepReceiptPath, "utf8"), result.receiptSource);
    assert.equal(result.receipt.evidenceSha256,
      createHash("sha256").update(readFileSync(inputs.sixthEvidencePath)).digest("hex"));
    const reopened = readSessionProofGatewayMigrationWaitOutputsFromOperatorPacket(
      inputs,
      stub.execute,
    );
    assert.equal(reopened.sixthEvidenceSource, evidenceSource);
    assert.equal(reopened.sixthStepReceiptSource, result.receiptSource);
    assert.deepEqual(reopened.sixthAuthorization, authorization);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserves exact gateway-readiness output paths before the waiter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGatewayWaitAuthorization(inputs, stub);
    let waiterCalls = 0;
    const waiter = () => {
      waiterCalls += 1;
      return { evidenceSource: "{}", receipt: {} };
    };
    assert.throws(() => persistSessionProofGatewayMigrationWaitFromOperatorPacket({
      ...inputs,
      sixthEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:17:00Z",
      completedAt: "2026-08-05T06:18:00Z",
      maxAttempts: 12,
      pollIntervalMs: 1000,
    }, stub.execute, waiter), /derive exactly/);
    writeFileSync(inputs.sixthStepReceiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSessionProofGatewayMigrationWaitFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:17:00Z",
      completedAt: "2026-08-05T06:18:00Z",
      maxAttempts: 12,
      pollIntervalMs: 1000,
    }, stub.execute, waiter), /already exists/);
    assert.equal(waiterCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only receipt grants from the exact persisted gateway-readiness outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const { receipt } = persistThroughGatewayWaitOutputs(inputs, stub);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    const authorization = authorizeSeventhSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:19:00Z",
    }, stub.execute);
    assert.equal(authorization.stepIndex, 8);
    assert.equal(authorization.stepId, "grant-receipts");
    assert.equal(authorization.action, "operator-apply");
    assert.equal(authorization.artifact, "grants");
    assert.equal(
      authorization.artifactSha256,
      createHash("sha256").update("synthetic-grants-artifact\n").digest("hex"),
    );
    assert.equal(
      authorization.previousReceiptSha256,
      createHash("sha256").update(`${JSON.stringify(receipt, null, 2)}\n`).digest("hex"),
    );
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gateway readiness evidence drift fails before receipt-grant authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGatewayWaitOutputs(inputs, stub);
    const evidence = JSON.parse(readFileSync(inputs.sixthEvidencePath, "utf8"));
    writeFileSync(inputs.sixthEvidencePath, JSON.stringify({ ...evidence, extra: true }));
    assert.throws(() => authorizeSeventhSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:19:00Z",
    }, stub.execute), /evidence|receipt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists the exact private receipt-grant authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGatewayWaitOutputs(inputs, stub);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    const authorization = persistSeventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:19:00Z",
    }, stub.execute);
    assert.equal(statSync(inputs.seventhAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.seventhAuthorizationPath, "utf8")),
      authorization,
    );
    let predecessorReads = 0;
    const kubernetesReadsBefore = stub.calls.length;
    assert.deepEqual(
      readSeventhSessionProofStepAuthorizationFromOperatorPacket(
        inputs,
        stub.execute,
        (received, runnerArgument) => {
          predecessorReads += 1;
          assert.equal(received, inputs);
          assert.notEqual(runnerArgument, stub.execute);
          return readSessionProofGatewayMigrationWaitOutputsFromOperatorPacket(
            received,
            runnerArgument,
          );
        },
      )
        .authorization,
      authorization,
    );
    assert.equal(predecessorReads, 1);
    assert.equal(stub.calls.length - kubernetesReadsBefore, 5);
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted or existing receipt-grant authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const setup = runner();
    persistThroughGatewayWaitOutputs(inputs, setup);
    const stub = runner(true);
    assert.throws(() => persistSeventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      seventhAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:19:00Z",
    }, stub.execute), /derive exactly/);
    assert.equal(stub.calls.length, 0);
    writeFileSync(inputs.seventhAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSeventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:19:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands only the exact persisted receipt-grant authorization and reviewed manifest to the adapter", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGatewayWaitOutputs(inputs, stub);
    const authorization = persistSeventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:19:00Z",
    }, stub.execute);
    const createCalls = stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length;
    let received;
    const result = applySessionProofGrantsFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:20:00Z",
      completedAt: "2026-08-05T06:21:00Z",
    }, stub.execute, (input, runnerArgument) => {
      received = input;
      assert.equal(runnerArgument, stub.execute);
      return { accepted: true };
    });
    assert.deepEqual(result, { accepted: true });
    assert.deepEqual(received, {
      authorization,
      manifestSource: "synthetic-grants-artifact\n",
      startedAt: "2026-08-05T06:20:00Z",
      completedAt: "2026-08-05T06:21:00Z",
    });
    assert.equal(stub.calls.filter(({ file, args }) =>
      file === "kubectl" && args[0] === "create").length, createCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted receipt-grant authorization drift fails before the adapter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGatewayWaitOutputs(inputs, stub);
    persistSeventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:19:00Z",
    }, stub.execute);
    const authorization = JSON.parse(readFileSync(inputs.seventhAuthorizationPath, "utf8"));
    writeFileSync(inputs.seventhAuthorizationPath, `${JSON.stringify({
      ...authorization,
      action: "operator-wait-complete",
    }, null, 2)}\n`, { mode: 0o600 });
    let adapterCalls = 0;
    assert.throws(() => applySessionProofGrantsFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:20:00Z",
      completedAt: "2026-08-05T06:21:00Z",
    }, stub.execute, () => {
      adapterCalls += 1;
    }), /exact persisted artifact/);
    assert.equal(adapterCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably persists the exact receipt-grant apply evidence and completion receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGatewayWaitOutputs(inputs, stub);
    const authorization = persistSeventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:19:00Z",
    }, stub.execute);
    const completedAt = "2026-08-05T06:21:00Z";
    const evidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
      authorization,
      observedAt: completedAt,
      resources: sessionProofApplyResourceIdentities("grant-receipts").map((resource, index) => ({
        ...resource,
        uid: `grant-resource-uid-${index + 1}`,
      })),
    }));
    const receipt = completeSessionProofStep(authorization, {
      namespaceResource: namespace(),
      operator,
      target,
      completedAt,
      evidenceSource,
    });
    let adapterCalls = 0;
    const result = persistSessionProofGrantApplyFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:20:00Z",
      completedAt,
    }, stub.execute, (received, runnerArgument) => {
      adapterCalls += 1;
      assert.deepEqual(received.authorization, authorization);
      assert.equal(runnerArgument, stub.execute);
      assert.equal(statSync(inputs.seventhEvidencePath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.seventhStepReceiptPath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.seventhEvidencePath).size, 0);
      assert.equal(statSync(inputs.seventhStepReceiptPath).size, 0);
      return { evidenceSource, receipt };
    });
    assert.equal(adapterCalls, 1);
    assert.equal(readFileSync(inputs.seventhEvidencePath, "utf8"), evidenceSource);
    assert.equal(readFileSync(inputs.seventhStepReceiptPath, "utf8"), result.receiptSource);
    assert.equal(result.receipt.evidenceSha256,
      createHash("sha256").update(readFileSync(inputs.seventhEvidencePath)).digest("hex"));
    const readStart = stub.calls.length;
    const reopened = readSessionProofGrantApplyOutputsFromOperatorPacket(inputs, stub.execute);
    assert.equal(reopened.seventhEvidenceSource, evidenceSource);
    assert.equal(reopened.seventhStepReceiptSource, result.receiptSource);
    assert.deepEqual(reopened.seventhAuthorization, authorization);
    assert.equal(stub.calls.length - readStart, 5);

    let predecessorReads = 0;
    let authorizationReads = 0;
    const verifiedPredecessor = reopened;
    const handedOff = readSessionProofGrantApplyOutputsFromOperatorPacket(
      inputs,
      stub.execute,
      (received, runnerArgument) => {
        predecessorReads += 1;
        assert.equal(received, inputs);
        assert.equal(typeof runnerArgument, "function");
        return verifiedPredecessor;
      },
      (received, runnerArgument, receivedPredecessor) => {
        authorizationReads += 1;
        assert.equal(received, inputs);
        assert.equal(typeof runnerArgument, "function");
        assert.equal(receivedPredecessor, verifiedPredecessor);
        return {
          authorization,
          authorizationSource: `${JSON.stringify(authorization, null, 2)}\n`,
        };
      },
    );
    assert.equal(predecessorReads, 1);
    assert.equal(authorizationReads, 1);
    assert.equal(handedOff.seventhEvidenceSource, evidenceSource);

    let recoveredPredecessorReads = 0;
    const recovered = readSessionProofGrantApplyOutputsFromOperatorPacket(
      { ...inputs, recoveryContinuationPath: join(root, "recovery-continuation.json") },
      stub.execute,
      undefined,
      (received, runnerArgument, receivedPredecessor) => {
        assert.equal(received.recoveryContinuationPath,
          join(root, "recovery-continuation.json"));
        assert.equal(typeof runnerArgument, "function");
        assert.equal(receivedPredecessor, verifiedPredecessor);
        return {
          authorization,
          authorizationSource: `${JSON.stringify(authorization, null, 2)}\n`,
        };
      },
      (received, runnerArgument) => {
        recoveredPredecessorReads += 1;
        assert.equal(received.recoveryContinuationPath,
          join(root, "recovery-continuation.json"));
        assert.equal(typeof runnerArgument, "function");
        return verifiedPredecessor;
      },
    );
    assert.equal(recoveredPredecessorReads, 1);
    assert.equal(recovered.seventhEvidenceSource, evidenceSource);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserves exact receipt-grant output paths before the adapter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGatewayWaitOutputs(inputs, stub);
    persistSeventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:19:00Z",
    }, stub.execute);
    let adapterCalls = 0;
    const adapter = () => {
      adapterCalls += 1;
      return { evidenceSource: "{}", receipt: {} };
    };
    assert.throws(() => persistSessionProofGrantApplyFromOperatorPacket({
      ...inputs,
      seventhEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:20:00Z",
      completedAt: "2026-08-05T06:21:00Z",
    }, stub.execute, adapter), /derive exactly/);
    writeFileSync(inputs.seventhStepReceiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSessionProofGrantApplyFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:20:00Z",
      completedAt: "2026-08-05T06:21:00Z",
    }, stub.execute, adapter), /already exists/);
    assert.equal(adapterCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only grant completion from the exact persisted grant outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const { receipt } = persistThroughGrantOutputs(inputs, stub);
    const callCount = stub.calls.length;
    const authorization = authorizeEighthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:22:00Z",
    }, stub.execute);
    assert.equal(authorization.stepIndex, 9);
    assert.equal(authorization.stepId, "wait-grants");
    assert.equal(authorization.action, "operator-wait-complete");
    assert.equal(authorization.artifact, null);
    assert.equal(authorization.artifactSha256, null);
    assert.equal(authorization.previousReceiptSha256,
      createHash("sha256").update(`${JSON.stringify(receipt, null, 2)}\n`).digest("hex"));
    assert.equal(stub.calls.slice(callCount).some(({ args }) => args.includes("job")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grant apply evidence drift fails before grant completion authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGrantOutputs(inputs, stub);
    const evidence = JSON.parse(readFileSync(inputs.seventhEvidencePath, "utf8"));
    writeFileSync(inputs.seventhEvidencePath, JSON.stringify({ ...evidence, extra: true }));
    const callCount = stub.calls.length;
    assert.throws(() => authorizeEighthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:22:00Z",
    }, stub.execute), /evidence|receipt/);
    assert.equal(stub.calls.slice(callCount).some(({ args }) => args.includes("job")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists the exact private grant-completion authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGrantOutputs(inputs, stub);
    const authorization = persistEighthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:22:00Z",
    }, stub.execute);
    assert.equal(statSync(inputs.eighthAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.eighthAuthorizationPath, "utf8")),
      authorization,
    );
    assert.deepEqual(
      readEighthSessionProofStepAuthorizationFromOperatorPacket(inputs, stub.execute).authorization,
      authorization,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted or existing grant-completion authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    persistThroughGrantOutputs(inputs, runner());
    const stub = runner(true);
    assert.throws(() => persistEighthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      eighthAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:22:00Z",
    }, stub.execute), /derive exactly/);
    assert.equal(stub.calls.length, 0);

    writeFileSync(inputs.eighthAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistEighthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:22:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands only the exact persisted grant-completion authorization and apply outputs to the waiter", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const authorization = persistThroughGrantWaitAuthorization(inputs, stub);
    const callCount = stub.calls.length;
    let received;
    const result = waitForSessionProofGrantsFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:23:00Z",
      completedAt: "2026-08-05T06:24:00Z",
      maxAttempts: 36,
      pollIntervalMs: 10_000,
    }, stub.execute, (input, runnerArgument) => {
      received = input;
      assert.equal(runnerArgument, stub.execute);
      return { accepted: true };
    });
    assert.deepEqual(result, { accepted: true });
    assert.deepEqual(received, {
      authorization,
      grantApplyReceiptSource: readFileSync(inputs.seventhStepReceiptPath, "utf8"),
      grantApplyEvidenceSource: readFileSync(inputs.seventhEvidencePath, "utf8"),
      startedAt: "2026-08-05T06:23:00Z",
      completedAt: "2026-08-05T06:24:00Z",
      maxAttempts: 36,
      pollIntervalMs: 10_000,
    });
    assert.equal(stub.calls.slice(callCount).some(({ args }) => args.includes("job.batch")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted grant-completion authorization drift fails before the waiter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGrantWaitAuthorization(inputs, stub);
    const authorization = JSON.parse(readFileSync(inputs.eighthAuthorizationPath, "utf8"));
    writeFileSync(inputs.eighthAuthorizationPath, `${JSON.stringify({
      ...authorization,
      action: "operator-apply",
    }, null, 2)}\n`, { mode: 0o600 });
    let waiterCalls = 0;
    assert.throws(() => waitForSessionProofGrantsFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:23:00Z",
      completedAt: "2026-08-05T06:24:00Z",
      maxAttempts: 36,
      pollIntervalMs: 10_000,
    }, stub.execute, () => {
      waiterCalls += 1;
    }), /exact persisted artifact/);
    assert.equal(waiterCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably persists the exact grant completion evidence and receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const authorization = persistThroughGrantWaitAuthorization(inputs, stub);
    const completedAt = "2026-08-05T06:24:00Z";
    const grantApplyReceiptSource = readFileSync(inputs.seventhStepReceiptPath, "utf8");
    const grantApplyEvidenceSource = readFileSync(inputs.seventhEvidencePath, "utf8");
    const grantJobUid = JSON.parse(grantApplyEvidenceSource).resourceInventory.find(
      (resource) => resource.kind === "Job",
    ).uid;
    const evidenceSource = JSON.stringify(buildSessionProofGrantCompletionEvidence({
      authorization,
      grantApplyReceiptSource,
      grantApplyEvidenceSource,
      job: {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: "codeops-session-proof-grants",
          namespace: identity.namespace,
          uid: grantJobUid,
          generation: 1,
        },
        spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 300 },
        status: {
          active: 0,
          succeeded: 1,
          failed: 0,
          startTime: "2026-08-05T06:23:00Z",
          completionTime: "2026-08-05T06:23:04Z",
          conditions: [{ type: "Complete", status: "True" }],
        },
      },
      observedAt: completedAt,
    }));
    const receipt = completeSessionProofStep(authorization, {
      namespaceResource: namespace(),
      operator,
      target,
      completedAt,
      evidenceSource,
    });
    let waiterCalls = 0;
    const result = persistSessionProofGrantWaitFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:23:00Z",
      completedAt,
      maxAttempts: 36,
      pollIntervalMs: 10_000,
    }, stub.execute, (received, runnerArgument) => {
      waiterCalls += 1;
      assert.deepEqual(received.authorization, authorization);
      assert.equal(runnerArgument, stub.execute);
      assert.equal(statSync(inputs.eighthEvidencePath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.eighthStepReceiptPath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.eighthEvidencePath).size, 0);
      assert.equal(statSync(inputs.eighthStepReceiptPath).size, 0);
      return { evidenceSource, receipt };
    });
    assert.equal(waiterCalls, 1);
    assert.equal(readFileSync(inputs.eighthEvidencePath, "utf8"), evidenceSource);
    assert.equal(readFileSync(inputs.eighthStepReceiptPath, "utf8"), result.receiptSource);
    assert.equal(result.receipt.evidenceSha256,
      createHash("sha256").update(readFileSync(inputs.eighthEvidencePath)).digest("hex"));
    const reopened = readSessionProofGrantWaitOutputsFromOperatorPacket(inputs, stub.execute);
    assert.equal(reopened.eighthEvidenceSource, evidenceSource);
    assert.equal(reopened.eighthStepReceiptSource, result.receiptSource);
    assert.deepEqual(reopened.eighthAuthorization, authorization);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserves exact grant-completion output paths before the waiter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGrantWaitAuthorization(inputs, stub);
    let waiterCalls = 0;
    const waiter = () => {
      waiterCalls += 1;
      return { evidenceSource: "{}", receipt: {} };
    };
    assert.throws(() => persistSessionProofGrantWaitFromOperatorPacket({
      ...inputs,
      eighthEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:23:00Z",
      completedAt: "2026-08-05T06:24:00Z",
      maxAttempts: 36,
      pollIntervalMs: 10_000,
    }, stub.execute, waiter), /derive exactly/);
    writeFileSync(inputs.eighthStepReceiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSessionProofGrantWaitFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:23:00Z",
      completedAt: "2026-08-05T06:24:00Z",
      maxAttempts: 36,
      pollIntervalMs: 10_000,
    }, stub.execute, waiter), /already exists/);
    assert.equal(waiterCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only Codex login from the exact persisted grant-completion outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const { receipt } = persistThroughGrantWaitOutputs(inputs, stub);
    const callCount = stub.calls.length;
    const authorization = authorizeNinthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:25:00Z",
    }, stub.execute);
    assert.equal(authorization.stepIndex, 10);
    assert.equal(authorization.stepId, "codex-login");
    assert.equal(authorization.action, "operator-apply");
    assert.equal(authorization.artifact, "codex-login");
    assert.equal(
      authorization.artifactSha256,
      createHash("sha256").update("synthetic-codex-login-artifact\n").digest("hex"),
    );
    assert.equal(
      authorization.previousReceiptSha256,
      createHash("sha256").update(`${JSON.stringify(receipt, null, 2)}\n`).digest("hex"),
    );
    assert.equal(stub.calls.slice(callCount).some(({ args }) => args.includes("job.batch")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grant-completion evidence drift fails before Codex login authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGrantWaitOutputs(inputs, stub);
    const evidence = JSON.parse(readFileSync(inputs.eighthEvidencePath, "utf8"));
    writeFileSync(inputs.eighthEvidencePath, JSON.stringify({ ...evidence, extra: true }));
    const callCount = stub.calls.length;
    assert.throws(() => authorizeNinthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:25:00Z",
    }, stub.execute), /evidence|receipt/);
    assert.equal(stub.calls.slice(callCount).some(({ args }) => args.includes("job.batch")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists the exact private Codex-login authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGrantWaitOutputs(inputs, stub);
    const authorization = persistNinthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:25:00Z",
    }, stub.execute);
    assert.equal(statSync(inputs.ninthAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.ninthAuthorizationPath, "utf8")),
      authorization,
    );
    assert.deepEqual(
      readNinthSessionProofStepAuthorizationFromOperatorPacket(inputs, stub.execute).authorization,
      authorization,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted or existing Codex-login authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    persistThroughGrantWaitOutputs(inputs, runner());
    const stub = runner(true);
    assert.throws(() => persistNinthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      ninthAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:25:00Z",
    }, stub.execute), /derive exactly/);
    assert.equal(stub.calls.length, 0);

    writeFileSync(inputs.ninthAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistNinthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:25:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands the exact persisted Codex-login authorization and reviewed manifest to the create-only adapter", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGrantWaitOutputs(inputs, stub);
    const authorization = persistNinthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:25:00Z",
    }, stub.execute);
    let applyCalls = 0;
    const result = applySessionProofCodexLoginFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:26:00Z",
      completedAt: "2026-08-05T06:27:00Z",
    }, stub.execute, (received, runnerArgument) => {
      applyCalls += 1;
      assert.deepEqual(received.authorization, authorization);
      assert.equal(received.manifestSource, "synthetic-codex-login-artifact\n");
      assert.equal(received.startedAt, "2026-08-05T06:26:00Z");
      assert.equal(received.completedAt, "2026-08-05T06:27:00Z");
      assert.equal(runnerArgument, stub.execute);
      return { evidenceSource: "synthetic", receipt: { result: "completed" } };
    });
    assert.equal(applyCalls, 1);
    assert.deepEqual(result, {
      evidenceSource: "synthetic",
      receipt: { result: "completed" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted Codex-login authorization drift fails before the create-only adapter", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGrantWaitOutputs(inputs, stub);
    persistNinthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:25:00Z",
    }, stub.execute);
    const authorization = JSON.parse(readFileSync(inputs.ninthAuthorizationPath, "utf8"));
    writeFileSync(inputs.ninthAuthorizationPath, `${JSON.stringify({
      ...authorization,
      artifact: "codex-smoke",
    }, null, 2)}\n`);
    let applyCalls = 0;
    assert.throws(() => applySessionProofCodexLoginFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:26:00Z",
      completedAt: "2026-08-05T06:27:00Z",
    }, stub.execute, () => {
      applyCalls += 1;
    }), /exact persisted artifact/);
    assert.equal(applyCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably persists the exact Codex-login apply evidence and completion receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGrantWaitOutputs(inputs, stub);
    const authorization = persistNinthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:25:00Z",
    }, stub.execute);
    const completedAt = "2026-08-05T06:27:00Z";
    const evidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
      authorization,
      observedAt: completedAt,
      resources: sessionProofApplyResourceIdentities("codex-login").map((resource, index) => ({
        ...resource,
        uid: `codex-login-resource-uid-${index + 1}`,
      })),
    }));
    const receipt = completeSessionProofStep(authorization, {
      namespaceResource: namespace(),
      operator,
      target,
      completedAt,
      evidenceSource,
    });
    let applyCalls = 0;
    const result = persistSessionProofCodexLoginApplyFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:26:00Z",
      completedAt,
    }, stub.execute, () => {
      applyCalls += 1;
      assert.equal(statSync(inputs.ninthEvidencePath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.ninthStepReceiptPath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.ninthEvidencePath).size, 0);
      assert.equal(statSync(inputs.ninthStepReceiptPath).size, 0);
      return { evidenceSource, receipt };
    });
    assert.equal(applyCalls, 1);
    assert.equal(readFileSync(inputs.ninthEvidencePath, "utf8"), evidenceSource);
    assert.equal(readFileSync(inputs.ninthStepReceiptPath, "utf8"), result.receiptSource);
    assert.equal(result.receipt.evidenceSha256,
      createHash("sha256").update(readFileSync(inputs.ninthEvidencePath)).digest("hex"));
    const reopened = readSessionProofCodexLoginApplyOutputsFromOperatorPacket(
      inputs,
      stub.execute,
    );
    assert.equal(reopened.ninthEvidenceSource, evidenceSource);
    assert.equal(reopened.ninthStepReceiptSource, result.receiptSource);
    assert.deepEqual(reopened.ninthAuthorization, authorization);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserves exact Codex-login output paths before the create-only adapter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughGrantWaitOutputs(inputs, stub);
    persistNinthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:25:00Z",
    }, stub.execute);
    let applyCalls = 0;
    const apply = () => {
      applyCalls += 1;
      return { evidenceSource: "{}", receipt: {} };
    };
    assert.throws(() => persistSessionProofCodexLoginApplyFromOperatorPacket({
      ...inputs,
      ninthEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:26:00Z",
      completedAt: "2026-08-05T06:27:00Z",
    }, stub.execute, apply), /derive exactly/);
    writeFileSync(inputs.ninthStepReceiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSessionProofCodexLoginApplyFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:26:00Z",
      completedAt: "2026-08-05T06:27:00Z",
    }, stub.execute, apply), /already exists/);
    assert.equal(applyCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only Codex-login completion from the exact persisted login apply outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const { receipt } = persistThroughCodexLoginOutputs(inputs, stub);
    const callCount = stub.calls.length;
    const authorization = authorizeTenthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:28:00Z",
    }, stub.execute);
    assert.equal(authorization.stepIndex, 11);
    assert.equal(authorization.stepId, "wait-codex-login");
    assert.equal(authorization.action, "operator-wait-complete");
    assert.equal(authorization.artifact, null);
    assert.equal(
      authorization.previousReceiptSha256,
      createHash("sha256").update(`${JSON.stringify(receipt, null, 2)}\n`).digest("hex"),
    );
    assert.equal(stub.calls.slice(callCount).some(({ args }) => args.includes("job.batch")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex-login apply evidence drift fails before completion authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughCodexLoginOutputs(inputs, stub);
    const evidence = JSON.parse(readFileSync(inputs.ninthEvidencePath, "utf8"));
    writeFileSync(inputs.ninthEvidencePath, JSON.stringify({ ...evidence, extra: true }));
    const callCount = stub.calls.length;
    assert.throws(() => authorizeTenthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:28:00Z",
    }, stub.execute), /evidence|receipt/);
    assert.equal(stub.calls.slice(callCount).some(({ args }) => args.includes("job.batch")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists the exact private Codex-login completion authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughCodexLoginOutputs(inputs, stub);
    const authorization = persistTenthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:28:00Z",
    }, stub.execute);
    assert.equal(statSync(inputs.tenthAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.tenthAuthorizationPath, "utf8")),
      authorization,
    );
    assert.deepEqual(
      readTenthSessionProofStepAuthorizationFromOperatorPacket(inputs, stub.execute)
        .authorization,
      authorization,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted or existing Codex-login completion authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    persistThroughCodexLoginOutputs(inputs, runner());
    const stub = runner(true);
    assert.throws(() => persistTenthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      tenthAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:28:00Z",
    }, stub.execute), /derive exactly/);
    assert.equal(stub.calls.length, 0);

    writeFileSync(inputs.tenthAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistTenthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:28:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands only the exact persisted Codex-login completion authorization and apply outputs to the waiter", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const authorization = persistThroughCodexLoginWaitAuthorization(inputs, stub);
    const callCount = stub.calls.length;
    let received;
    const result = waitForSessionProofCodexLoginFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:29:00Z",
      completedAt: "2026-08-05T06:30:00Z",
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    }, stub.execute, (input, runnerArgument) => {
      received = input;
      assert.equal(runnerArgument, stub.execute);
      return { accepted: true };
    });
    assert.deepEqual(result, { accepted: true });
    assert.deepEqual(received, {
      authorization,
      loginApplyReceiptSource: readFileSync(inputs.ninthStepReceiptPath, "utf8"),
      loginApplyEvidenceSource: readFileSync(inputs.ninthEvidencePath, "utf8"),
      startedAt: "2026-08-05T06:29:00Z",
      completedAt: "2026-08-05T06:30:00Z",
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    });
    assert.equal(stub.calls.slice(callCount).some(({ args }) => args.includes("job.batch")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted Codex-login completion authorization drift fails before the waiter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughCodexLoginWaitAuthorization(inputs, stub);
    const authorization = JSON.parse(readFileSync(inputs.tenthAuthorizationPath, "utf8"));
    writeFileSync(inputs.tenthAuthorizationPath, `${JSON.stringify({
      ...authorization,
      action: "operator-apply",
    }, null, 2)}\n`, { mode: 0o600 });
    let waiterCalls = 0;
    assert.throws(() => waitForSessionProofCodexLoginFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:29:00Z",
      completedAt: "2026-08-05T06:30:00Z",
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    }, stub.execute, () => {
      waiterCalls += 1;
    }), /exact persisted artifact/);
    assert.equal(waiterCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably persists the exact Codex-login completion evidence and receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const authorization = persistThroughCodexLoginWaitAuthorization(inputs, stub);
    const completedAt = "2026-08-05T06:30:00Z";
    const loginApplyReceiptSource = readFileSync(inputs.ninthStepReceiptPath, "utf8");
    const loginApplyEvidenceSource = readFileSync(inputs.ninthEvidencePath, "utf8");
    const resourceInventory = JSON.parse(loginApplyEvidenceSource).resourceInventory;
    const evidenceSource = JSON.stringify(buildSessionProofCodexLoginCompletionEvidence({
      authorization,
      loginApplyReceiptSource,
      loginApplyEvidenceSource,
      job: {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: "codeops-codex-auth-login",
          namespace: identity.namespace,
          uid: resourceInventory.find((resource) => resource.kind === "Job").uid,
          generation: 1,
        },
        spec: {
          completions: 1,
          parallelism: 1,
          backoffLimit: 0,
          activeDeadlineSeconds: 900,
          ttlSecondsAfterFinished: 3600,
        },
        status: {
          active: 0,
          succeeded: 1,
          failed: 0,
          startTime: "2026-08-05T06:29:00Z",
          completionTime: "2026-08-05T06:29:30Z",
          conditions: [{ type: "Complete", status: "True", reason: "CompletionsReached" }],
        },
      },
      persistentVolumeClaim: {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          name: "codeops-codex-auth",
          namespace: identity.namespace,
          uid: resourceInventory.find(
            (resource) => resource.kind === "PersistentVolumeClaim",
          ).uid,
        },
        status: { phase: "Bound" },
      },
      observedAt: completedAt,
    }));
    const receipt = completeSessionProofStep(authorization, {
      namespaceResource: namespace(),
      operator,
      target,
      completedAt,
      evidenceSource,
    });
    let waiterCalls = 0;
    const result = persistSessionProofCodexLoginWaitFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:29:00Z",
      completedAt,
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    }, stub.execute, () => {
      waiterCalls += 1;
      assert.equal(statSync(inputs.tenthEvidencePath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.tenthStepReceiptPath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.tenthEvidencePath).size, 0);
      assert.equal(statSync(inputs.tenthStepReceiptPath).size, 0);
      return { evidenceSource, receipt };
    });
    assert.equal(waiterCalls, 1);
    assert.equal(readFileSync(inputs.tenthEvidencePath, "utf8"), evidenceSource);
    assert.equal(readFileSync(inputs.tenthStepReceiptPath, "utf8"), result.receiptSource);
    assert.equal(result.receipt.evidenceSha256,
      createHash("sha256").update(readFileSync(inputs.tenthEvidencePath)).digest("hex"));
    const reopened = readSessionProofCodexLoginWaitOutputsFromOperatorPacket(
      inputs,
      stub.execute,
    );
    assert.equal(reopened.tenthEvidenceSource, evidenceSource);
    assert.equal(reopened.tenthStepReceiptSource, result.receiptSource);
    assert.deepEqual(reopened.tenthAuthorization, authorization);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resumes exact empty Codex-login completion reservations after an interrupted waiter", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const authorization = persistThroughCodexLoginWaitAuthorization(inputs, stub);
    const completedAt = "2026-08-05T06:30:00Z";
    const loginApplyReceiptSource = readFileSync(inputs.ninthStepReceiptPath, "utf8");
    const loginApplyEvidenceSource = readFileSync(inputs.ninthEvidencePath, "utf8");
    const resourceInventory = JSON.parse(loginApplyEvidenceSource).resourceInventory;
    const evidenceSource = JSON.stringify(buildSessionProofCodexLoginCompletionEvidence({
      authorization,
      loginApplyReceiptSource,
      loginApplyEvidenceSource,
      job: {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: "codeops-codex-auth-login",
          namespace: identity.namespace,
          uid: resourceInventory.find((resource) => resource.kind === "Job").uid,
          generation: 1,
        },
        spec: {
          completions: 1,
          parallelism: 1,
          backoffLimit: 0,
          activeDeadlineSeconds: 900,
          ttlSecondsAfterFinished: 3600,
        },
        status: {
          active: 0,
          succeeded: 1,
          failed: 0,
          startTime: "2026-08-05T06:29:00Z",
          completionTime: "2026-08-05T06:29:30Z",
          conditions: [{ type: "Complete", status: "True" }],
        },
      },
      persistentVolumeClaim: {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          name: "codeops-codex-auth",
          namespace: identity.namespace,
          uid: resourceInventory.find(
            (resource) => resource.kind === "PersistentVolumeClaim",
          ).uid,
        },
        status: { phase: "Bound" },
      },
      observedAt: completedAt,
    }));
    const receipt = completeSessionProofStep(authorization, {
      namespaceResource: namespace(),
      operator,
      target,
      completedAt,
      evidenceSource,
    });
    writeFileSync(inputs.tenthEvidencePath, "", { mode: 0o600 });
    writeFileSync(inputs.tenthStepReceiptPath, "", { mode: 0o600 });
    const result = persistSessionProofCodexLoginWaitFromOperatorPacket({
      ...inputs,
      resumeInterruptedReservation: true,
      startedAt: "2026-08-05T06:29:00Z",
      completedAt,
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    }, stub.execute, () => ({ evidenceSource, receipt }));
    assert.equal(readFileSync(inputs.tenthEvidencePath, "utf8"), evidenceSource);
    assert.equal(readFileSync(inputs.tenthStepReceiptPath, "utf8"), result.receiptSource);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reserves exact Codex-login completion output paths before the waiter is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughCodexLoginWaitAuthorization(inputs, stub);
    let waiterCalls = 0;
    const waiter = () => {
      waiterCalls += 1;
      return { evidenceSource: "{}", receipt: {} };
    };
    assert.throws(() => persistSessionProofCodexLoginWaitFromOperatorPacket({
      ...inputs,
      tenthEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:29:00Z",
      completedAt: "2026-08-05T06:30:00Z",
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    }, stub.execute, waiter), /derive exactly/);
    writeFileSync(inputs.tenthStepReceiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSessionProofCodexLoginWaitFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:29:00Z",
      completedAt: "2026-08-05T06:30:00Z",
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    }, stub.execute, waiter), /already exists/);
    assert.equal(waiterCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only Codex smoke replacement from exact persisted login-completion outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const { receipt } = persistThroughCodexLoginWaitOutputs(inputs, stub);
    const callCount = stub.calls.length;
    const authorization = authorizeEleventhSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:31:00Z",
    }, stub.execute);
    assert.equal(authorization.stepIndex, 12);
    assert.equal(authorization.stepId, "codex-smoke");
    assert.equal(authorization.action, "operator-replace-auth-job");
    assert.equal(authorization.artifact, "codex-smoke");
    assert.equal(
      authorization.artifactSha256,
      createHash("sha256").update("synthetic-codex-smoke-artifact\n").digest("hex"),
    );
    assert.equal(
      authorization.previousReceiptSha256,
      createHash("sha256").update(`${JSON.stringify(receipt, null, 2)}\n`).digest("hex"),
    );
    assert.equal(stub.calls.slice(callCount).some(({ args }) => args.includes("job.batch")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("login-completion evidence drift fails before Codex smoke authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughCodexLoginWaitOutputs(inputs, stub);
    const evidence = JSON.parse(readFileSync(inputs.tenthEvidencePath, "utf8"));
    writeFileSync(inputs.tenthEvidencePath, JSON.stringify({ ...evidence, extra: true }));
    const callCount = stub.calls.length;
    assert.throws(() => authorizeEleventhSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:31:00Z",
    }, stub.execute), /evidence|receipt/);
    assert.equal(stub.calls.slice(callCount).some(({ args }) => args.includes("job.batch")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists the exact private Codex smoke replacement authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughCodexLoginWaitOutputs(inputs, stub);
    const authorization = persistEleventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:31:00Z",
    }, stub.execute);
    assert.equal(statSync(inputs.eleventhAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.eleventhAuthorizationPath, "utf8")),
      authorization,
    );
    assert.deepEqual(
      readEleventhSessionProofStepAuthorizationFromOperatorPacket(inputs, stub.execute)
        .authorization,
      authorization,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted or existing Codex smoke authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    persistThroughCodexLoginWaitOutputs(inputs, runner());
    const stub = runner(true);
    assert.throws(() => persistEleventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      eleventhAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:31:00Z",
    }, stub.execute), /derive exactly/);
    assert.equal(stub.calls.length, 0);

    writeFileSync(inputs.eleventhAuthorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistEleventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:31:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hands only the exact persisted Codex smoke authorization and login-completion outputs to replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughCodexLoginWaitOutputs(inputs, stub);
    const authorization = persistEleventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:31:00Z",
    }, stub.execute);
    const callCount = stub.calls.length;
    let received;
    const result = await replaceSessionProofCodexSmokeFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:32:00Z",
      completedAt: "2026-08-05T06:33:00Z",
    }, stub.execute, (input, dependencies) => {
      received = input;
      assert.deepEqual(dependencies, { runner: stub.execute });
      return { accepted: true };
    });
    assert.deepEqual(result, { accepted: true });
    assert.deepEqual(received, {
      authorization,
      manifestSource: "synthetic-codex-smoke-artifact\n",
      loginCompletionReceiptSource: readFileSync(inputs.tenthStepReceiptPath, "utf8"),
      loginCompletionEvidenceSource: readFileSync(inputs.tenthEvidencePath, "utf8"),
      startedAt: "2026-08-05T06:32:00Z",
      completedAt: "2026-08-05T06:33:00Z",
    });
    assert.equal(stub.calls.slice(callCount).some(({ args }) => args.includes("job.batch")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted Codex smoke authorization drift fails before replacement is reached", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughCodexLoginWaitOutputs(inputs, stub);
    persistEleventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:31:00Z",
    }, stub.execute);
    const authorization = JSON.parse(readFileSync(inputs.eleventhAuthorizationPath, "utf8"));
    writeFileSync(inputs.eleventhAuthorizationPath, `${JSON.stringify({
      ...authorization,
      action: "operator-apply",
    }, null, 2)}\n`, { mode: 0o600 });
    let replacementCalls = 0;
    assert.throws(() => replaceSessionProofCodexSmokeFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:32:00Z",
      completedAt: "2026-08-05T06:33:00Z",
    }, stub.execute, () => {
      replacementCalls += 1;
    }), /exact persisted artifact/);
    assert.equal(replacementCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably persists the exact Codex smoke replacement evidence and receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    persistThroughCodexLoginWaitOutputs(inputs, stub);
    const authorization = persistEleventhSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:31:00Z",
    }, stub.execute);
    const completedAt = "2026-08-05T06:33:00Z";
    const loginCompletionReceiptSource = readFileSync(inputs.tenthStepReceiptPath, "utf8");
    const loginCompletionEvidenceSource = readFileSync(inputs.tenthEvidencePath, "utf8");
    const loginInventory = JSON.parse(readFileSync(inputs.ninthEvidencePath, "utf8"))
      .resourceInventory;
    const evidenceSource = JSON.stringify(buildSessionProofCodexSmokeReplacementEvidence({
      authorization,
      loginCompletionReceiptSource,
      loginCompletionEvidenceSource,
      resources: sessionProofApplyResourceIdentities("codex-smoke").map((resource) => ({
        ...resource,
        uid: resource.kind === "Job"
          ? "codex-smoke-resource-uid"
          : loginInventory.find((previous) =>
            previous.apiVersion === resource.apiVersion &&
            previous.kind === resource.kind &&
            previous.name === resource.name).uid,
      })),
      loginJobAbsent: true,
      observedAt: completedAt,
    }));
    const receipt = completeSessionProofStep(authorization, {
      namespaceResource: namespace(),
      operator,
      target,
      completedAt,
      evidenceSource,
    });
    let replacementCalls = 0;
    const replacement = () => {
      replacementCalls += 1;
      assert.equal(statSync(inputs.eleventhEvidencePath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.eleventhStepReceiptPath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.eleventhEvidencePath).size, 0);
      assert.equal(statSync(inputs.eleventhStepReceiptPath).size, 0);
      return { evidenceSource, receipt };
    };
    await assert.rejects(() => persistSessionProofCodexSmokeReplacementFromOperatorPacket({
      ...inputs,
      eleventhEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:32:00Z",
      completedAt,
    }, stub.execute, replacement), /derive exactly/);
    writeFileSync(inputs.eleventhStepReceiptPath, "occupied\n", { mode: 0o600 });
    await assert.rejects(() => persistSessionProofCodexSmokeReplacementFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:32:00Z",
      completedAt,
    }, stub.execute, replacement), /already exists/);
    rmSync(inputs.eleventhStepReceiptPath);
    assert.equal(replacementCalls, 0);
    const result = await persistSessionProofCodexSmokeReplacementFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:32:00Z",
      completedAt,
    }, stub.execute, replacement);
    assert.equal(replacementCalls, 1);
    assert.equal(readFileSync(inputs.eleventhEvidencePath, "utf8"), evidenceSource);
    assert.equal(readFileSync(inputs.eleventhStepReceiptPath, "utf8"), result.receiptSource);
    assert.equal(result.receipt.evidenceSha256,
      createHash("sha256").update(readFileSync(inputs.eleventhEvidencePath)).digest("hex"));
    const reopened = readSessionProofCodexSmokeReplacementOutputsFromOperatorPacket(
      inputs,
      stub.execute,
    );
    assert.equal(reopened.eleventhEvidenceSource, evidenceSource);
    assert.equal(reopened.eleventhStepReceiptSource, result.receiptSource);
    assert.deepEqual(reopened.eleventhAuthorization, authorization);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only Codex smoke completion from exact persisted replacement outputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const { receipt } = await persistThroughCodexSmokeReplacementOutputs(inputs, stub);
    const callCount = stub.calls.length;
    const closedStub = runner(true);
    assert.throws(() => persistTwelfthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      twelfthAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:34:00Z",
    }, closedStub.execute), /derive exactly/);
    assert.equal(closedStub.calls.length, 0);
    assert.throws(() => readTwelfthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      twelfthAuthorizationPath: join(root, "substituted.authorization.json"),
    }, closedStub.execute), /derive exactly/);
    assert.equal(closedStub.calls.length, 0);
    let substitutedWaiterCalls = 0;
    assert.throws(() => waitForSessionProofCodexSmokeFromOperatorPacket({
      ...inputs,
      twelfthAuthorizationPath: join(root, "substituted.authorization.json"),
      startedAt: "2026-08-05T06:35:00Z",
      completedAt: "2026-08-05T06:36:00Z",
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    }, closedStub.execute, () => {
      substitutedWaiterCalls += 1;
    }), /derive exactly/);
    assert.equal(substitutedWaiterCalls, 0);
    assert.equal(closedStub.calls.length, 0);

    const persisted = persistTwelfthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:34:00Z",
    }, stub.execute);
    const authorization = persisted;
    assert.equal(authorization.stepIndex, 13);
    assert.equal(authorization.stepId, "wait-codex-smoke");
    assert.equal(authorization.action, "operator-wait-complete");
    assert.equal(authorization.artifact, null);
    assert.equal(authorization.artifactSha256, null);
    assert.equal(
      authorization.previousReceiptSha256,
      createHash("sha256").update(`${JSON.stringify(receipt, null, 2)}\n`).digest("hex"),
    );
    assert.equal(
      stub.calls.slice(callCount).some(({ args }) => args.includes("job.batch")),
      false,
    );
    assert.equal(statSync(inputs.twelfthAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.twelfthAuthorizationPath, "utf8")),
      authorization,
    );
    let received;
    const waitResult = waitForSessionProofCodexSmokeFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:35:00Z",
      completedAt: "2026-08-05T06:36:00Z",
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    }, stub.execute, (input, runnerArgument) => {
      received = input;
      assert.equal(runnerArgument, stub.execute);
      return { accepted: true };
    });
    assert.deepEqual(waitResult, { accepted: true });
    assert.deepEqual(received, {
      authorization,
      smokeReplacementReceiptSource: readFileSync(inputs.eleventhStepReceiptPath, "utf8"),
      smokeReplacementEvidenceSource: readFileSync(inputs.eleventhEvidencePath, "utf8"),
      startedAt: "2026-08-05T06:35:00Z",
      completedAt: "2026-08-05T06:36:00Z",
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    });
    const authorizationSource = readFileSync(inputs.twelfthAuthorizationPath, "utf8");
    writeFileSync(inputs.twelfthAuthorizationPath, `${JSON.stringify({
      ...authorization,
      action: "operator-apply",
    }, null, 2)}\n`, { mode: 0o600 });
    let driftedWaiterCalls = 0;
    const beforeAuthorizationDrift = stub.calls.length;
    assert.throws(() => waitForSessionProofCodexSmokeFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:35:00Z",
      completedAt: "2026-08-05T06:36:00Z",
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    }, stub.execute, () => {
      driftedWaiterCalls += 1;
    }), /authorization drifted/);
    assert.equal(driftedWaiterCalls, 0);
    assert.equal(stub.calls.length, beforeAuthorizationDrift);
    writeFileSync(inputs.twelfthAuthorizationPath, authorizationSource, { mode: 0o600 });

    const smokeReplacementReceiptSource = readFileSync(
      inputs.eleventhStepReceiptPath,
      "utf8",
    );
    const smokeReplacementEvidenceSource = readFileSync(inputs.eleventhEvidencePath, "utf8");
    const smokeApplyEvidence = JSON.parse(
      JSON.parse(smokeReplacementEvidenceSource).smokeApplyEvidenceSource,
    );
    const smokeJob = smokeApplyEvidence.resourceInventory.find((resource) =>
      resource.kind === "Job" && resource.name === "codeops-codex-auth-smoke");
    const smokeClaim = smokeApplyEvidence.resourceInventory.find((resource) =>
      resource.kind === "PersistentVolumeClaim" && resource.name === "codeops-codex-auth");
    const completedAt = "2026-08-05T06:36:00Z";
    const completionEvidenceSource = JSON.stringify(
      buildSessionProofCodexSmokeCompletionEvidence({
        authorization,
        smokeReplacementReceiptSource,
        smokeReplacementEvidenceSource,
        loginJobAbsent: true,
        job: {
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: {
            name: "codeops-codex-auth-smoke",
            namespace: identity.namespace,
            uid: smokeJob.uid,
            generation: 1,
          },
          spec: {
            completions: 1,
            parallelism: 1,
            backoffLimit: 0,
            activeDeadlineSeconds: 900,
            ttlSecondsAfterFinished: 3600,
          },
          status: {
            active: 0,
            succeeded: 1,
            failed: 0,
            startTime: "2026-08-05T06:35:00Z",
            completionTime: "2026-08-05T06:35:30Z",
            conditions: [{ type: "Complete", status: "True" }],
          },
        },
        persistentVolumeClaim: {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: {
            name: "codeops-codex-auth",
            namespace: identity.namespace,
            uid: smokeClaim.uid,
          },
          status: { phase: "Bound" },
        },
        observedAt: completedAt,
      }),
    );
    const completionReceipt = completeSessionProofStep(authorization, {
      namespaceResource: namespace(),
      operator,
      target,
      completedAt,
      evidenceSource: completionEvidenceSource,
    });
    let persistenceWaiterCalls = 0;
    const persistenceWaiter = () => {
      persistenceWaiterCalls += 1;
      assert.equal(statSync(inputs.twelfthEvidencePath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.twelfthStepReceiptPath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.twelfthEvidencePath).size, 0);
      assert.equal(statSync(inputs.twelfthStepReceiptPath).size, 0);
      return { evidenceSource: completionEvidenceSource, receipt: completionReceipt };
    };
    assert.throws(() => persistSessionProofCodexSmokeWaitFromOperatorPacket({
      ...inputs,
      twelfthEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:35:00Z",
      completedAt,
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    }, stub.execute, persistenceWaiter), /derive exactly/);
    writeFileSync(inputs.twelfthStepReceiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistSessionProofCodexSmokeWaitFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:35:00Z",
      completedAt,
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    }, stub.execute, persistenceWaiter), /already exists/);
    assert.equal(persistenceWaiterCalls, 0);
    rmSync(inputs.twelfthEvidencePath, { force: true });
    rmSync(inputs.twelfthStepReceiptPath);

    const persistedCompletion = persistSessionProofCodexSmokeWaitFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:35:00Z",
      completedAt,
      maxAttempts: 96,
      pollIntervalMs: 10_000,
    }, stub.execute, persistenceWaiter);
    assert.equal(persistenceWaiterCalls, 1);
    assert.equal(readFileSync(inputs.twelfthEvidencePath, "utf8"), completionEvidenceSource);
    assert.equal(
      readFileSync(inputs.twelfthStepReceiptPath, "utf8"),
      persistedCompletion.receiptSource,
    );
    assert.equal(
      persistedCompletion.receipt.evidenceSha256,
      createHash("sha256").update(readFileSync(inputs.twelfthEvidencePath)).digest("hex"),
    );
    const closedUiStub = runner(true);
    assert.throws(() => persistThirteenthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      thirteenthAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:37:00Z",
    }, closedUiStub.execute), /derive exactly/);
    assert.equal(closedUiStub.calls.length, 0);
    assert.throws(() => readThirteenthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      thirteenthAuthorizationPath: join(root, "substituted.authorization.json"),
    }, closedUiStub.execute), /derive exactly/);
    assert.equal(closedUiStub.calls.length, 0);

    const beforeUiAuthorization = stub.calls.length;
    const uiAuthorization = persistThirteenthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:37:00Z",
    }, stub.execute);
    assert.equal(uiAuthorization.stepIndex, 14);
    assert.equal(uiAuthorization.stepId, "start-ui");
    assert.equal(uiAuthorization.action, "operator-apply");
    assert.equal(uiAuthorization.artifact, "ui");
    assert.equal(
      uiAuthorization.artifactSha256,
      createHash("sha256").update("synthetic-ui-artifact\n").digest("hex"),
    );
    assert.equal(
      uiAuthorization.previousReceiptSha256,
      createHash("sha256").update(persistedCompletion.receiptSource).digest("hex"),
    );
    assert.equal(statSync(inputs.thirteenthAuthorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.thirteenthAuthorizationPath, "utf8")),
      uiAuthorization,
    );
    const reopenedUiAuthorization =
      readThirteenthSessionProofStepAuthorizationFromOperatorPacket(inputs, stub.execute);
    assert.deepEqual(reopenedUiAuthorization.authorization, uiAuthorization);
    assert.equal(
      reopenedUiAuthorization.authorizationSource,
      readFileSync(inputs.thirteenthAuthorizationPath, "utf8"),
    );
    assert.equal(
      reopenedUiAuthorization.completionOutputs.twelfthEvidenceSource,
      completionEvidenceSource,
    );
    assert.equal(
      reopenedUiAuthorization.completionOutputs.twelfthStepReceiptSource,
      persistedCompletion.receiptSource,
    );
    assert.deepEqual(
      reopenedUiAuthorization.completionOutputs.twelfthAuthorization,
      authorization,
    );
    assert.equal(
      stub.calls.slice(beforeUiAuthorization).some(({ args }) => args.includes("job.batch")),
      false,
    );
    const uiAuthorizationSource = readFileSync(inputs.thirteenthAuthorizationPath, "utf8");
    writeFileSync(inputs.thirteenthAuthorizationPath, `${JSON.stringify({
      ...uiAuthorization,
      action: "operator-wait-ready",
    }, null, 2)}\n`, { mode: 0o600 });
    const beforeUiAuthorizationDrift = stub.calls.length;
    assert.throws(() => readThirteenthSessionProofStepAuthorizationFromOperatorPacket(
      inputs,
      stub.execute,
    ), /authorization drifted/);
    assert.equal(stub.calls.length, beforeUiAuthorizationDrift);
    writeFileSync(
      inputs.thirteenthAuthorizationPath,
      uiAuthorizationSource,
      { mode: 0o600 },
    );

    const beforeOccupiedUiAuthorization = stub.calls.length;
    assert.throws(() => persistThirteenthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:37:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, beforeOccupiedUiAuthorization);

    const beforeOccupied = stub.calls.length;
    assert.throws(() => persistTwelfthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:34:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, beforeOccupied);

    const evidence = JSON.parse(readFileSync(inputs.eleventhEvidencePath, "utf8"));
    writeFileSync(inputs.eleventhEvidencePath, JSON.stringify({ ...evidence, extra: true }));
    const driftCallCount = stub.calls.length;
    assert.throws(() => authorizeTwelfthSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:34:00Z",
    }, stub.execute), /evidence|receipt/);
    assert.equal(
      stub.calls.slice(driftCallCount).some(({ args }) => args.includes("job.batch")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durably persists exact UI apply outputs behind the private authorization chain", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const closedStub = runner(true);
    assert.throws(() => persistSessionProofUiApplyFromOperatorPacket({
      ...inputs,
      thirteenthEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:38:00Z",
      completedAt: "2026-08-05T06:39:00Z",
    }, closedStub.execute), /derive exactly/);
    assert.equal(closedStub.calls.length, 0);

    const stub = runner();
    const result = await persistThroughUiApplyOutputs(inputs, stub);
    assert.equal(result.authorization.stepIndex, 14);
    assert.equal(result.authorization.stepId, "start-ui");
    assert.equal(result.authorization.action, "operator-apply");
    assert.equal(result.authorization.artifact, "ui");
    assert.equal(statSync(inputs.thirteenthEvidencePath).mode & 0o777, 0o600);
    assert.equal(statSync(inputs.thirteenthStepReceiptPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(inputs.thirteenthEvidencePath, "utf8"), result.evidenceSource);
    assert.equal(
      readFileSync(inputs.thirteenthStepReceiptPath, "utf8"),
      result.persisted.receiptSource,
    );
    assert.equal(
      result.persisted.receipt.evidenceSha256,
      createHash("sha256").update(result.evidenceSource).digest("hex"),
    );
    const reopened = readSessionProofUiApplyOutputsFromOperatorPacket(inputs, stub.execute);
    assert.deepEqual(reopened.thirteenthAuthorization, result.authorization);
    assert.equal(reopened.thirteenthEvidenceSource, result.evidenceSource);
    assert.equal(reopened.thirteenthStepReceiptSource, result.persisted.receiptSource);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists exact UI readiness and the private runtime-start authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const closedStub = runner(true);
    assert.throws(() => persistFourteenthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      fourteenthAuthorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:40:00Z",
    }, closedStub.execute), /derive exactly/);
    assert.throws(() => persistSessionProofUiWaitFromOperatorPacket({
      ...inputs,
      fourteenthEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:41:00Z",
      completedAt: "2026-08-05T06:42:00Z",
      maxAttempts: 120,
      pollIntervalMs: 1000,
    }, closedStub.execute), /derive exactly/);
    assert.equal(closedStub.calls.length, 0);

    const stub = runner();
    const result = await persistThroughUiWaitOutputs(inputs, stub);
    assert.equal(result.authorization.stepIndex, 15);
    assert.equal(result.authorization.stepId, "wait-ui");
    assert.equal(result.authorization.action, "operator-wait-ready");
    assert.equal(result.authorization.artifact, null);
    assert.equal(statSync(inputs.fourteenthAuthorizationPath).mode & 0o777, 0o600);
    assert.equal(statSync(inputs.fourteenthEvidencePath).mode & 0o777, 0o600);
    assert.equal(statSync(inputs.fourteenthStepReceiptPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(inputs.fourteenthEvidencePath, "utf8"), result.evidenceSource);
    assert.equal(
      readFileSync(inputs.fourteenthStepReceiptPath, "utf8"),
      result.persisted.receiptSource,
    );
    const runtimeAuthorization = persistFifteenthSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:43:00Z",
    }, stub.execute);
    assert.equal(runtimeAuthorization.stepIndex, 16);
    assert.equal(runtimeAuthorization.stepId, "start-runtime");
    assert.equal(runtimeAuthorization.action, "operator-apply");
    assert.equal(runtimeAuthorization.artifact, "runtime");
    assert.equal(statSync(inputs.fifteenthAuthorizationPath).mode & 0o777, 0o600);

    assert.throws(() => persistSessionProofRuntimeApplyFromOperatorPacket({
      ...inputs,
      fifteenthEvidencePath: join(root, "substituted.evidence.json"),
      startedAt: "2026-08-05T06:44:00Z",
      completedAt: "2026-08-05T06:45:00Z",
    }, closedStub.execute), /derive exactly/);
    assert.equal(closedStub.calls.length, 0);

    const authorizationSource = readFileSync(inputs.fifteenthAuthorizationPath, "utf8");
    assert.equal(authorizationSource, `${JSON.stringify(runtimeAuthorization, null, 2)}\n`);
    let applyCalls = 0;
    const runtimeEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
      authorization: runtimeAuthorization,
      observedAt: "2026-08-05T06:45:00Z",
      resources: sessionProofApplyResourceIdentities("start-runtime", runtimeAuthorization)
        .map((resource, index) => ({ ...resource, uid: `runtime-resource-uid-${index}` })),
    }));
    const runtimeReceipt = completeSessionProofStep(runtimeAuthorization, {
      namespaceResource: namespace(),
      operator,
      target,
      completedAt: "2026-08-05T06:45:00Z",
      evidenceSource: runtimeEvidenceSource,
    });
    const applyResult = persistSessionProofRuntimeApplyFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:44:00Z",
      completedAt: "2026-08-05T06:45:00Z",
    }, stub.execute, (received, runnerArgument) => {
      applyCalls += 1;
      assert.deepEqual(received.authorization, runtimeAuthorization);
      assert.equal(received.manifestSource, "synthetic-runtime-artifact\n");
      assert.equal(received.startedAt, "2026-08-05T06:44:00Z");
      assert.equal(received.completedAt, "2026-08-05T06:45:00Z");
      assert.equal(runnerArgument, stub.execute);
      assert.equal(statSync(inputs.fifteenthEvidencePath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.fifteenthStepReceiptPath).mode & 0o777, 0o600);
      assert.equal(statSync(inputs.fifteenthEvidencePath).size, 0);
      assert.equal(statSync(inputs.fifteenthStepReceiptPath).size, 0);
      return { evidenceSource: runtimeEvidenceSource, receipt: runtimeReceipt };
    });
    assert.equal(applyCalls, 1);
    assert.equal(applyResult.evidenceSource, runtimeEvidenceSource);
    assert.equal(
      readFileSync(inputs.fifteenthEvidencePath, "utf8"),
      runtimeEvidenceSource,
    );
    assert.equal(
      readFileSync(inputs.fifteenthStepReceiptPath, "utf8"),
      applyResult.receiptSource,
    );
    assert.equal(applyResult.receipt.evidenceSha256,
      createHash("sha256").update(runtimeEvidenceSource).digest("hex"));
    writeFileSync(inputs.fifteenthAuthorizationPath, `${JSON.stringify({
      ...runtimeAuthorization,
      artifact: "ui",
    }, null, 2)}\n`, { mode: 0o600 });
    assert.throws(() => applySessionProofRuntimeFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:44:00Z",
      completedAt: "2026-08-05T06:45:00Z",
    }, stub.execute, () => {
      applyCalls += 1;
    }), /authorization|artifact/);
    assert.equal(applyCalls, 1);
    writeFileSync(inputs.fifteenthAuthorizationPath, authorizationSource, { mode: 0o600 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects persisted broker evidence drift before step-3 authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    persistFirstSessionProofCredentialIssuanceFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute);
    const evidence = JSON.parse(readFileSync(inputs.evidencePath, "utf8"));
    writeFileSync(inputs.evidencePath, JSON.stringify({ ...evidence, extra: true }));
    const issuerCalls = stub.calls.filter(({ file }) =>
      file.endsWith("issue-codeops-session-proof-secrets.sh")).length;
    assert.throws(() => authorizeSecondSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:04:00Z",
    }, stub.execute), /evidence/);
    assert.equal(stub.calls.filter(({ file }) =>
      file.endsWith("issue-codeops-session-proof-secrets.sh")).length, issuerCalls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorization drift fails before the broker issuer is invoked", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    const authorization = JSON.parse(readFileSync(inputs.authorizationPath, "utf8"));
    writeFileSync(inputs.authorizationPath, `${JSON.stringify({
      ...authorization,
      action: "operator-apply",
    }, null, 2)}\n`);
    assert.throws(() => issueFirstSessionProofCredentialsFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute), /exact persisted artifact/);
    assert.equal(
      stub.calls.some(({ file }) => file.endsWith("issue-codeops-session-proof-secrets.sh")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted or existing first-step authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, runner().execute);
    const stub = runner(true);
    assert.throws(() => persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      authorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute), /derive exactly/);
    assert.equal(stub.calls.length, 0);

    writeFileSync(inputs.authorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects creation-receipt drift or an incomplete create before live authorization reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const driftedInputs = persistOperatorInputs(root);
    const createStub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...driftedInputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, createStub.execute);
    const receipt = JSON.parse(readFileSync(driftedInputs.receiptPath, "utf8"));
    writeFileSync(
      driftedInputs.receiptPath,
      `${JSON.stringify({ ...receipt, checkedAt: "2026-08-05T09:00:00Z" }, null, 2)}\n`,
    );
    const timeDriftStub = runner(true);
    assert.throws(() => authorizeFirstSessionProofStepFromOperatorPacket({
      ...driftedInputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, timeDriftStub.execute), /outcome drifted/);
    assert.equal(timeDriftStub.calls.length, 0);

    writeFileSync(
      driftedInputs.receiptPath,
      `${JSON.stringify({ ...receipt, extra: true }, null, 2)}\n`,
    );
    const driftStub = runner(true);
    assert.throws(() => authorizeFirstSessionProofStepFromOperatorPacket({
      ...driftedInputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, driftStub.execute), /exact persisted artifact/);
    assert.equal(driftStub.calls.length, 0);

    const incompleteRoot = mkdtempSync(join(tmpdir(), "session-proof-create-incomplete-"));
    try {
      const incompleteInputs = persistOperatorInputs(incompleteRoot);
      createSessionProofNamespaceFromOperatorPacket({
        ...incompleteInputs,
        observedAt: "2026-08-05T06:00:00Z",
      }, runner(false, true).execute);
      const incompleteStub = runner(true);
      assert.throws(() => authorizeFirstSessionProofStepFromOperatorPacket({
        ...incompleteInputs,
        observedAt: "2026-08-05T06:01:00Z",
      }, incompleteStub.execute), /did not admit/);
      assert.equal(incompleteStub.calls.length, 0);
    } finally {
      rmSync(incompleteRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a permission-weakened creation receipt before live authorization reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, runner().execute);
    chmodSync(inputs.receiptPath, 0o644);
    const stub = runner(true);
    assert.throws(() => authorizeFirstSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute), /bounded private regular file/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects packet attachment drift before any create preflight read", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const admissionValue = JSON.parse(readFileSync(inputs.admissionPath, "utf8"));
    writeFileSync(
      inputs.admissionPath,
      `${JSON.stringify({ ...admissionValue, extra: true }, null, 2)}\n`,
    );
    const stub = runner();
    assert.throws(() => createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute), /exact attached artifact/i);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (proofTestShardCount === 3) {
  const missingOverrides = [...proofThreeShardOverrides.keys()]
    .filter((name) => !proofSeenTestNames.has(name));
  if (missingOverrides.length > 0) {
    throw new Error(
      `proof test shard overrides do not name registered tests: ${missingOverrides.join(", ")}`,
    );
  }
}
