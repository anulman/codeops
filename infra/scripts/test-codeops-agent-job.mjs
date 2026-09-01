import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderAgentJobManifest } from "./codeops-agent-job-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/agent-job-template.yaml", import.meta.url),
  "utf8",
);
const input = {
  runId: "routing-matrix-2fdebb4c",
  role: "coding-agent",
  baseSha: "a".repeat(40),
  prompt: "Inspect the routing matrix and propose a bounded implementation plan.",
  repository: "https://github.com/example-org/example-repository",
  agentDigest: `sha256:${"b".repeat(64)}`,
  sessionGatewayDigest: `sha256:${"c".repeat(64)}`,
};
const lifecycleCommand =
  "const f=require('node:fs'),s='/var/run/secrets/codeops-model-proxy/model-proxy-token',d='/run/codeops/model-proxy-token',t=d+'.tmp',v=f.readFileSync(s);if(!v.length)throw new Error('model proxy token is empty');const h=f.openSync(t,f.constants.O_WRONLY|f.constants.O_CREAT|f.constants.O_EXCL,0o600);try{f.fchmodSync(h,0o600);f.writeFileSync(h,v);f.fsyncSync(h)}finally{f.closeSync(h)}const w=f.readFileSync(t);if(!w.length||!w.equals(v))throw new Error('model proxy token copy is incomplete');f.renameSync(t,d);const q=f.openSync(d,f.constants.O_RDONLY|f.constants.O_NOFOLLOW);try{const a=f.fstatSync(q),x=f.readFileSync(q);if(!a.isFile()||(a.mode&0o777)!==0o600||!x.length||!x.equals(v))throw new Error('published model proxy token is invalid')}finally{f.closeSync(q)}";

function resources(rendered = renderAgentJobManifest(template, input)) {
  return parseAllDocuments(rendered).map((document) => document.toJS());
}

test("renders one tokenless, bounded Agent Job without reusable model credentials", () => {
  const rendered = renderAgentJobManifest(template, input);
  const manifests = resources(rendered);
  assert.deepEqual(
    manifests.map((resource) => resource.kind),
    ["ServiceAccount", "Job", "NetworkPolicy"],
  );
  const job = manifests[1];
  const pod = job.spec.template.spec;
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.activeDeadlineSeconds, 3600);
  assert.equal(job.spec.ttlSecondsAfterFinished, 3600);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.enableServiceLinks, false);
  assert.deepEqual(pod.imagePullSecrets, [{ name: "codeops-registry" }]);
  assert.deepEqual(pod.nodeSelector, { "codeops.example/codeops": "true" });
  assert.equal(pod.volumes.some((volume) => volume.persistentVolumeClaim), false);
  assert.equal(
    pod.volumes.find((volume) => volume.name === "temp").emptyDir.sizeLimit,
    "2Gi",
  );
  assert.equal(rendered.includes("hostPath"), false);
  assert.equal(rendered.includes("PersistentVolumeClaim"), false);
});

test("keeps ACP pod-local and exposes no Service or Ingress", () => {
  const manifests = resources();
  const pod = manifests[1].spec.template.spec;
  assert.deepEqual(
    pod.containers.map((container) => container.name),
    ["session-gateway", "coding-agent"],
  );
  assert.equal(
    pod.containers[0].env.find((entry) => entry.name === "CODEOPS_ACP_SOCKET")
      .value,
    "/run/codeops/agent.sock",
  );
  assert.equal(pod.containers[1].args, undefined);
  const codexConfig = JSON.parse(
    pod.containers[1].env.find((entry) => entry.name === "CODEX_CONFIG").value,
  );
  assert.equal(
    pod.containers[1].env.find((entry) => entry.name === "MODEL_PROVIDER").value,
    codexConfig.model_provider,
  );
  assert.equal(codexConfig.model_provider, "codeops_proxy");
  assert.equal(codexConfig.approvals_reviewer, "auto_review");
  assert.equal(codexConfig.web_search, "cached");
  assert.equal(
    manifests.some((resource) => ["Service", "Ingress"].includes(resource.kind)),
    false,
  );
});

test("mounts the source read-only for the QA Contract Researcher", () => {
  const rendered = renderAgentJobManifest(template, {
    ...input,
    runId: "research-qanbrdauth-1",
    role: "qa-contract-researcher",
  });
  const manifests = resources(rendered);
  const job = manifests[1];
  assert.equal(
    job.metadata.labels["codeops.example/agent-role"],
    "qa-contract-researcher",
  );
  for (const container of job.spec.template.spec.containers) {
    assert.equal(
      container.env.find((entry) => entry.name === "CODEOPS_AGENT_ROLE").value,
      "qa-contract-researcher",
    );
    assert.equal(
      container.volumeMounts.find((mount) => mount.name === "workspace").readOnly,
      true,
    );
  }
  const builder =
    job.spec.template.spec.initContainers.find(
      (container) => container.name === "workspace-builder",
    );
  assert.equal(
    builder.volumeMounts.find((mount) => mount.name === "workspace").readOnly,
    undefined,
  );
});

test("rejects critics without the control gateway candidate-evidence mount", () => {
  assert.throws(
    () =>
      renderAgentJobManifest(template, {
        ...input,
        runId: "critic-qanbrdauth-2",
        role: "critic-agent",
      }),
    /critics require the control gateway/,
  );
});

test("uses an exact source SHA and only immutable images", () => {
  const rendered = renderAgentJobManifest(template, input);
  assert.equal(rendered.includes(input.baseSha), true);
  assert.equal(rendered.includes(input.repository), true);
  const pod = resources(rendered)[1].spec.template.spec;
  const builder = pod.initContainers.find(
    (container) => container.name === "workspace-builder",
  );
  const checkout = builder.command.at(-1);
  assert.match(checkout, /git -c safe\.directory=\/workspace -C \/workspace/);
  assert.equal(checkout.includes("safe.directory=*"), false);
  const gateway = pod.containers.find(
    (container) => container.name === "session-gateway",
  );
  const agent = pod.containers.find(
    (container) => container.name === "coding-agent",
  );
  assert.equal(
    builder.env.find((entry) => entry.name === "CODEOPS_BASE_SHA").value,
    input.baseSha,
  );
  for (const container of [gateway, agent]) {
    assert.equal(
      container.env.find((entry) => entry.name === "CODEOPS_RUN_ID").value,
      input.runId,
    );
    assert.equal(
      container.env.find((entry) => entry.name === "CODEOPS_BASE_SHA").value,
      input.baseSha,
    );
  }
  const images = [...pod.initContainers, ...pod.containers].map(
    (container) => container.image,
  );
  assert.deepEqual(images, [
    `ghcr.io/anulman/codeops/agent@${input.agentDigest}`,
    `ghcr.io/anulman/codeops/session-gateway@${input.sessionGatewayDigest}`,
    `ghcr.io/anulman/codeops/agent@${input.agentDigest}`,
  ]);
});

test("scopes repository-read and model secrets to separate containers", () => {
  const job = resources()[1];
  const builder = job.spec.template.spec.initContainers.find(
    (container) => container.name === "workspace-builder",
  );
  const agent = job.spec.template.spec.containers.find(
    (container) => container.name === "coding-agent",
  );
  const gateway = job.spec.template.spec.containers.find(
    (container) => container.name === "session-gateway",
  );
  assert.equal(
    agent.env.find((entry) => entry.name === "CODEOPS_MODEL_PROXY_TOKEN_FILE").value,
    "/run/codeops/model-proxy-token",
  );
  assert.deepEqual(
    gateway.volumeMounts.find(({ mountPath }) => mountPath === "/run/codeops"),
    { name: "session", mountPath: "/run/codeops" },
  );
  assert.ok(job.spec.template.spec.volumes.find(({ name }) => name === "model-proxy-token").secret.items.some(
    (item) => item.key === "model-proxy-token" && item.path === "model-proxy-token",
  ));
  assert.equal(
    job.spec.template.spec.volumes.find(({ name }) => name === "run-input")
      .secret.items.some(
        (item) => item.key === "model-proxy-token" || item.path === "model-proxy-token",
      ),
    false,
  );
  assert.deepEqual(
    [...job.spec.template.spec.initContainers, ...job.spec.template.spec.containers]
      .flatMap((container) =>
        container.volumeMounts
          .filter((mount) => mount.name === "model-proxy-token")
          .map((mount) => container.name),
      ),
    ["session-gateway"],
  );
  assert.deepEqual(
    builder.env.find(
      (entry) => entry.name === "CODEOPS_REPOSITORY_READ_TOKEN",
    ).valueFrom.secretKeyRef,
    {
      name: "codeops-run-routing-matrix-2fdebb4c",
      key: "repository-read-token",
    },
  );
  assert.equal(
    agent.env.some((entry) => entry.name === "CODEOPS_REPOSITORY_READ_TOKEN"),
    false,
  );
  assert.equal(
    gateway.env.some((entry) => entry.name === "DEFAULT_AUTH_REQUEST"),
    false,
  );
  assert.equal(
    agent.env.find((entry) => entry.name === "DEFAULT_AUTH_REQUEST").value,
    '{"methodId":"api-key"}',
  );
  assert.equal(
    agent.env.find((entry) => entry.name === "CODEX_HOME").value,
    "/var/lib/codeops-agent/codex-home",
  );
  assert.deepEqual(
    agent.volumeMounts.find((entry) => entry.mountPath === "/var/lib/codeops-agent/codex-home"),
    {
      name: "workspace",
      mountPath: "/var/lib/codeops-agent/codex-home",
      subPath: ".codeops/codex-home",
      readOnly: false,
    },
  );
  assert.equal(JSON.stringify(job).includes("value: sk-"), false);
});

test("denies ingress and private-network egress while allowing DNS and public HTTPS", () => {
  const policy = resources()[2];
  assert.deepEqual(policy.spec.policyTypes, ["Ingress", "Egress"]);
  assert.deepEqual(policy.spec.ingress, []);
  const publicHttps = policy.spec.egress.find((rule) =>
    rule.ports?.some((port) => port.port === 443),
  );
  assert.equal(publicHttps.to[0].ipBlock.cidr, "0.0.0.0/0");
  assert.ok(publicHttps.to[0].ipBlock.except.includes("10.0.0.0/8"));
  assert.ok(publicHttps.to[0].ipBlock.except.includes("172.16.0.0/12"));
  assert.ok(publicHttps.to[0].ipBlock.except.includes("192.168.0.0/16"));
});

test("fails closed on malformed identity, source, image, or template drift", () => {
  for (const patch of [
    { runId: "UPPER" },
    { runId: "-bad" },
    { role: "administrator" },
    { baseSha: "abc" },
    { repository: "git@github.com:example-org/example-repository.git" },
    { prompt: "" },
    { agentDigest: "latest" },
    { sessionGatewayDigest: `sha256:${"C".repeat(64)}` },
  ]) {
    assert.throws(() => renderAgentJobManifest(template, { ...input, ...patch }));
  }
  assert.throws(() =>
    renderAgentJobManifest(
      template.replace("kind: NetworkPolicy", "kind: Service"),
      input,
    ),
  );
  assert.throws(() =>
    renderAgentJobManifest(
      template.replace("emptyDir: {}", "hostPath: { path: / }"),
      input,
    ),
  );
  assert.throws(() =>
    renderAgentJobManifest(
      template.replace(
        "automountServiceAccountToken: false",
        "automountServiceAccountToken: true",
      ),
      input,
    ),
  );
  for (const [index, drifted] of [
    template.replace("            - name: MODEL_PROVIDER\n              value: codeops_proxy\n", ""),
    template.replace("value: codeops_proxy\n            - name: CODEOPS_MODEL_PROXY_ORIGIN", "value: openai\n            - name: CODEOPS_MODEL_PROXY_ORIGIN"),
    template.replace("value: http://codeops-model-proxy:8080\n            - name: CODEX_CONFIG", "value: http://other-proxy:8080\n            - name: CODEX_CONFIG"),
    template.replace('"model_provider":"codeops_proxy"', '"model_provider":"openai"'),
    template.replace('"base_url":"http://codeops-model-proxy:8080/v1"', '"base_url":"http://other-proxy:8080/v1"'),
    template.replace('"env_key":"CODEX_API_KEY"', '"env_key":"OPENAI_API_KEY"'),
    template.replace('"wire_api":"responses"', '"wire_api":"chat"'),
    template.replace(
      "            - name: CODEOPS_MODEL_PROXY_TOKEN_FILE\n              value: /run/codeops/model-proxy-token",
      "            - name: CODEX_API_KEY\n              value: literal-reusable-key",
    ),
    template.replace(
      "            - name: CODEOPS_MODEL_PROXY_TOKEN_FILE\n              value: /run/codeops/model-proxy-token",
      "            - name: OPENAI_API_KEY\n              value: ''\n            - name: CODEOPS_MODEL_PROXY_TOKEN_FILE\n              value: /run/codeops/model-proxy-token",
    ),
    template.replace(
      "            - name: CODEOPS_MODEL_PROXY_TOKEN_FILE\n              value: /run/codeops/model-proxy-token",
      "            - name: OPENAI_API_KEY\n              valueFrom:\n                secretKeyRef: { name: alternate, key: token }\n            - name: CODEOPS_MODEL_PROXY_TOKEN_FILE\n              value: /run/codeops/model-proxy-token",
    ),
    template.replace(
      "            - name: CODEOPS_MODEL_PROXY_TOKEN_FILE\n              value: /run/codeops/model-proxy-token",
      "            - name: ALTERNATE_MODEL_TOKEN\n              valueFrom:\n                secretKeyRef: { name: codeops-run-__CODEOPS_RUN_SUFFIX__, key: model-proxy-token }\n            - name: CODEOPS_MODEL_PROXY_TOKEN_FILE\n              value: /run/codeops/model-proxy-token",
    ),
    template.replace(
      "          imagePullPolicy: IfNotPresent\n          lifecycle:",
      "          imagePullPolicy: IfNotPresent\n          envFrom:\n            - secretRef: { name: codeops-run-__CODEOPS_RUN_SUFFIX__ }\n          lifecycle:",
    ),
    template.replace("/run/codeops/model-proxy-token", "/run/codeops/other-token"),
    template.replace(
      "        - name: model-proxy-token\n          secret:\n            secretName: codeops-run-__CODEOPS_RUN_SUFFIX__",
      "        - name: model-proxy-token\n          secret:\n            secretName: alternate-run-secret",
    ),
    template.replace("key: model-proxy-token", "key: repository-read-token"),
    template.replace("path: model-proxy-token", "path: other-token"),
    template.replace("name: session\n          emptyDir:\n            medium: Memory", "name: session\n          secret:\n            secretName: alternate-run-secret"),
    template.replace("            - name: session\n              mountPath: /run/codeops", "            - name: temp\n              mountPath: /run/codeops"),
    template.replace(
      `          lifecycle:\n            postStart:\n              exec:\n                command: [node, -e, "${lifecycleCommand}"]\n`,
      "",
    ),
    template.replace(lifecycleCommand, "process.exit(0)"),
    template.replace(
      `command: [node, -e, "${lifecycleCommand}"]`,
      `command: [node, -e, "process.exit(0)"]\n            preStop:\n              exec:\n                command: [node, -e, "${lifecycleCommand}"]`,
    ),
    template.replace(
      "s='/var/run/secrets/codeops-model-proxy/model-proxy-token'",
      "s='/var/run/secrets/codeops-model-proxy/alternate-token'",
    ),
    template.replace("t=d+'.tmp'", "t=d"),
    template.replace("f.constants.O_EXCL", "f.constants.O_TRUNC"),
    template.replaceAll("0o600", "0o644"),
    template.replace(
      "if(!v.length)throw new Error('model proxy token is empty');",
      "",
    ),
    template.replace(
      "const w=f.readFileSync(t);if(!w.length||!w.equals(v))throw new Error('model proxy token copy is incomplete');",
      "",
    ),
    template.replace("f.renameSync(t,d)", "f.copyFileSync(t,d)"),
    template.replace("|f.constants.O_NOFOLLOW", ""),
    template.replace("!a.isFile()||(a.mode&0o777)!==0o600||", ""),
    template.replace("||!x.length||!x.equals(v)", ""),
    template.replace(
      "              - key: model-proxy-token\n                path: model-proxy-token",
      "              - key: model-proxy-token\n                path: model-proxy-token\n        - name: competing-model-proxy-token\n          secret:\n            secretName: alternate-run-secret",
    ).replace(
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }",
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }\n            - { name: competing-model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy, readOnly: true }",
    ),
    template.replace(
      "            items:\n              - key: agent-prompt\n                path: agent-prompt.txt\n",
      "",
    ),
    template.replace(
      "              - key: model-proxy-token\n                path: model-proxy-token\n---",
      "              - key: model-proxy-token\n                path: model-proxy-token\n        - name: alternate-run-secret\n          secret:\n            secretName: codeops-run-__CODEOPS_RUN_SUFFIX__\n---",
    ).replace(
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }",
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }\n            - { name: alternate-run-secret, mountPath: /alternate, readOnly: true }",
    ),
    template.replace(
      "              - key: model-proxy-token\n                path: model-proxy-token\n---",
      "              - key: model-proxy-token\n                path: model-proxy-token\n        - name: projected-run-secret\n          projected:\n            sources:\n              - secret:\n                  name: codeops-run-__CODEOPS_RUN_SUFFIX__\n---",
    ).replace(
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }",
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }\n            - { name: projected-run-secret, mountPath: /var/run/secrets/codeops-model-proxy, readOnly: true }",
    ),
    ...["/var/run/secrets/codeops-model-proxy/", "/var/run/secrets/alternate/../codeops-model-proxy"].map(
      (mountPath) => template.replace(
        "              - key: model-proxy-token\n                path: model-proxy-token\n---",
        "              - key: model-proxy-token\n                path: model-proxy-token\n        - name: parent-secret\n          secret:\n            secretName: alternate-run-secret\n            items:\n              - key: repository-read-token\n                path: repository-read-token\n---",
      ).replace(
        "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }",
        `            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }\n            - { name: parent-secret, mountPath: ${mountPath}, readOnly: true }`,
      ),
    ),
    ...[
      {
        name: "child-secret",
        volume: "          secret:\n            secretName: alternate-run-secret",
        mountPath: "/var/run/secrets/codeops-model-proxy/model-proxy-token/child",
      },
      {
        name: "projected-child-secret",
        volume: "          projected:\n            sources:\n              - secret:\n                  name: alternate-run-secret",
        mountPath: "/var/run/secrets/codeops-model-proxy/model-proxy-token/child",
      },
      {
        name: "trailing-child-secret",
        volume: "          secret:\n            secretName: alternate-run-secret",
        mountPath: "/var/run/secrets/codeops-model-proxy/model-proxy-token/child/",
      },
      {
        name: "normalized-child-secret",
        volume: "          secret:\n            secretName: alternate-run-secret",
        mountPath: "/var/run/secrets/codeops-model-proxy/model-proxy-token/alternate/../child",
      },
    ].map(({ name, volume, mountPath }) => template.replace(
      "              - key: model-proxy-token\n                path: model-proxy-token\n---",
      `              - key: model-proxy-token\n                path: model-proxy-token\n        - name: ${name}\n${volume}\n---`,
    ).replace(
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }",
      `            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }\n            - { name: ${name}, mountPath: ${mountPath}, readOnly: true }`,
    )),
    template.replace(
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }",
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }\n            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }",
    ),
    template.replace(
      "            - name: run-input\n              mountPath: /input\n              readOnly: true\n      containers:",
      "            - name: run-input\n              mountPath: /input\n              readOnly: true\n            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }\n      containers:",
    ),
    template.replace(
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }",
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }\n            - { name: session, mountPath: /alternate-session }",
    ),
    template.replace(
      "      volumes:\n",
      "      volumes:\n        - name: session-alias\n          emptyDir: {}\n",
    ).replace(
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }",
      "            - { name: model-proxy-token, mountPath: /var/run/secrets/codeops-model-proxy/model-proxy-token, subPath: model-proxy-token, readOnly: true }\n            - { name: session-alias, mountPath: /alternate/../run/codeops }",
    ),
    template.replace(
      "            - name: session\n              mountPath: /run/codeops\n            - name: checkpoint\n              mountPath: /checkpoint",
      "            - name: session\n              mountPath: /run/codeops\n            - { name: session, mountPath: /alternate-session }\n            - name: checkpoint\n              mountPath: /checkpoint",
    ),
    template.replace(
      "      volumes:\n",
      "      volumes:\n        - name: session-alias\n          emptyDir: {}\n",
    ).replace(
      "            - name: session\n              mountPath: /run/codeops\n            - name: checkpoint\n              mountPath: /checkpoint",
      "            - name: session\n              mountPath: /run/codeops\n            - { name: session-alias, mountPath: /run/codeops/consumer }\n            - name: checkpoint\n              mountPath: /checkpoint",
    ),
    ...["/alternate/../run/codeops/secret", "/run"].map((mountPath) =>
      template.replace(
        "              - key: model-proxy-token\n                path: model-proxy-token\n---",
        "              - key: model-proxy-token\n                path: model-proxy-token\n        - name: overlapping-secret\n          secret:\n            secretName: alternate-run-secret\n---",
      ).replace(
        "            - name: run-input\n              mountPath: /input\n              readOnly: true\n      containers:",
        `            - name: run-input\n              mountPath: /input\n              readOnly: true\n            - { name: overlapping-secret, mountPath: ${mountPath}, readOnly: true }\n      containers:`,
      ),
    ),
  ].entries()) {
    assert.throws(() => renderAgentJobManifest(drifted, input), /model proxy/, `mutation ${index}`);
  }
});
