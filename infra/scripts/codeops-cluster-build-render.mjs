import { parseAllDocuments } from "yaml";

const SHA = /^[0-9a-f]{40}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.preview\.renoconcierge\.ca$/;
const BUILD_KINDS = {
  orchestrator: {
    dockerfileDirectory: ".",
    dockerfileName: "Dockerfile",
    imageRepository: "renoconcierge-codeops-orchestrator",
    targetArgs:
      "            - --opt\n            - target=codeops-orchestrator-runtime",
  },
  "plane-controller": {
    dockerfileDirectory: "infra/docker",
    dockerfileName: "codeops-plane-controller.Dockerfile",
    imageRepository: "renoconcierge-codeops-plane-controller",
    targetArgs: "",
  },
};

function parseResources(rendered) {
  return parseAllDocuments(rendered).map((document) => {
    if (document.errors.length > 0) {
      throw new Error(`invalid cluster-build YAML: ${document.errors[0].message}`);
    }
    return document.toJS();
  });
}

function resourceSet(resources) {
  return resources
    .map((resource) => `${resource.kind}/${resource.metadata.name}`)
    .sort();
}

export function renderClusterRegistryManifest(template, input) {
  if (!SHA.test(input.baseSha ?? "")) {
    throw new Error("base SHA must contain exactly 40 lowercase hex characters");
  }
  const expectedHost = `registry-${input.baseSha.slice(0, 12)}.preview.renoconcierge.ca`;
  if (!HOST.test(input.registryHost ?? "") || input.registryHost !== expectedHost) {
    throw new Error(`registry host must be ${expectedHost}`);
  }
  const occurrences = template.split("__CODEOPS_REGISTRY_HOST__").length - 1;
  if (occurrences !== 2) {
    throw new Error(`expected two registry host tokens, found ${occurrences}`);
  }
  const rendered = template.replaceAll(
    "__CODEOPS_REGISTRY_HOST__",
    input.registryHost,
  );
  const resources = parseResources(rendered);
  const expectedResources = [
    "Deployment/codeops-registry",
    "Ingress/codeops-registry",
    "NetworkPolicy/codeops-registry",
    "PersistentVolumeClaim/codeops-registry-data",
    "Service/codeops-registry",
    "ServiceAccount/codeops-registry",
  ].sort();
  if (
    JSON.stringify(resourceSet(resources)) !==
    JSON.stringify(expectedResources)
  ) {
    throw new Error("registry manifest contains an unexpected resource set");
  }

  const deployment = resources.find((resource) => resource.kind === "Deployment");
  const account = resources.find(
    (resource) => resource.kind === "ServiceAccount",
  );
  const claim = resources.find(
    (resource) => resource.kind === "PersistentVolumeClaim",
  );
  const service = resources.find((resource) => resource.kind === "Service");
  const ingress = resources.find((resource) => resource.kind === "Ingress");
  const policy = resources.find(
    (resource) => resource.kind === "NetworkPolicy",
  );
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  const env = Object.fromEntries(
    container.env.map((entry) => [entry.name, entry.value]),
  );
  if (
    deployment.spec.replicas !== 1 ||
    deployment.spec.strategy?.type !== "Recreate" ||
    pod.automountServiceAccountToken !== false ||
    pod.enableServiceLinks !== false ||
    account.automountServiceAccountToken !== false
  ) {
    throw new Error("registry must be a tokenless single-writer deployment");
  }
  if (
    container.image !==
    "docker.io/library/registry@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278"
  ) {
    throw new Error("registry image must match the locked platform digest");
  }
  if (
    env.REGISTRY_AUTH !== "htpasswd" ||
    env.REGISTRY_AUTH_HTPASSWD_PATH !==
      "/var/run/secrets/codeops/htpasswd" ||
    env.REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY !== "/var/lib/registry"
  ) {
    throw new Error("registry auth or storage binding drifted");
  }
  if (
    claim.spec.accessModes.join(",") !== "ReadWriteOnce" ||
    claim.spec.resources.requests.storage !== "8Gi"
  ) {
    throw new Error("registry must use one bounded RWO claim");
  }
  if (
    service.spec.type !== undefined ||
    service.spec.ports.length !== 1 ||
    service.spec.ports[0].port !== 5000
  ) {
    throw new Error("registry Service must remain cluster-internal");
  }
  if (
    ingress.spec.rules.length !== 1 ||
    ingress.spec.rules[0].host !== input.registryHost ||
    ingress.spec.tls[0].hosts[0] !== input.registryHost ||
    ingress.spec.tls[0].secretName !==
      "renoconcierge-preview-wildcard-tls" ||
    ingress.spec.rules[0].http.paths[0].path !== "/"
  ) {
    throw new Error("registry TLS ingress drifted");
  }
  if (
    policy.spec.policyTypes.join(",") !== "Ingress,Egress" ||
    policy.spec.ingress.length !== 2 ||
    policy.spec.egress.length !== 0
  ) {
    throw new Error("registry ingress isolation drifted");
  }
  if (
    !container.securityContext?.readOnlyRootFilesystem ||
    container.securityContext?.allowPrivilegeEscalation !== false ||
    pod.securityContext?.runAsNonRoot !== true
  ) {
    throw new Error("registry pod security contract drifted");
  }
  return rendered;
}

export function renderClusterImageBuilderManifest(template, input) {
  if (!SHA.test(input.baseSha ?? "")) {
    throw new Error("base SHA must contain exactly 40 lowercase hex characters");
  }
  const build = BUILD_KINDS[input.imageKind];
  if (build === undefined) {
    throw new Error("image kind must be orchestrator or plane-controller");
  }
  const expectedBuildId = `build-${input.imageKind}-${input.baseSha.slice(0, 12)}`;
  if (input.buildId !== expectedBuildId) {
    throw new Error(`build ID must be ${expectedBuildId}`);
  }
  const tokens = {
    __CODEOPS_BASE_SHA__: input.baseSha,
    __CODEOPS_BUILD_ID__: input.buildId,
    __CODEOPS_BUILD_SUFFIX__: input.buildId,
    __CODEOPS_DOCKERFILE_DIRECTORY__: build.dockerfileDirectory,
    __CODEOPS_DOCKERFILE_NAME__: build.dockerfileName,
    __CODEOPS_IMAGE_KIND__: input.imageKind,
    __CODEOPS_IMAGE_REPOSITORY__: build.imageRepository,
    __CODEOPS_TARGET_ARGS__: build.targetArgs,
  };
  let rendered = template;
  for (const [token, value] of Object.entries(tokens)) {
    const occurrences = rendered.split(token).length - 1;
    if (occurrences < 1) throw new Error(`expected ${token} token`);
    rendered = rendered.replaceAll(token, value);
  }
  if (Object.keys(tokens).some((token) => rendered.includes(token))) {
    throw new Error("unresolved image-builder token survived rendering");
  }
  const resources = parseResources(rendered);
  const expectedResources = [
    `Job/codeops-image-builder-${input.buildId}`,
    `NetworkPolicy/codeops-image-builder-${input.buildId}`,
    `ServiceAccount/codeops-image-builder-${input.buildId}`,
  ].sort();
  if (
    JSON.stringify(resourceSet(resources)) !==
    JSON.stringify(expectedResources)
  ) {
    throw new Error("image-builder manifest contains an unexpected resource set");
  }

  const job = resources.find((resource) => resource.kind === "Job");
  const account = resources.find(
    (resource) => resource.kind === "ServiceAccount",
  );
  const policy = resources.find(
    (resource) => resource.kind === "NetworkPolicy",
  );
  const pod = job.spec.template.spec;
  const source = pod.initContainers[0];
  const builder = pod.containers[0];
  if (
    job.spec.backoffLimit !== 0 ||
    job.spec.activeDeadlineSeconds !== 3600 ||
    pod.automountServiceAccountToken !== false ||
    pod.enableServiceLinks !== false ||
    pod.securityContext?.fsGroup !== 1000 ||
    account.automountServiceAccountToken !== false
  ) {
    throw new Error("image builder must be bounded and tokenless");
  }
  if (
    source.image !==
      "docker.io/alpine/git@sha256:53a6239398162098fed2f49a46512f9cbba9e3f31b9f2cea4fa90129ee069a99" ||
    builder.image !==
      "docker.io/moby/buildkit@sha256:d947144c3dc4f827f8dacaaf98d622f0143465740075fa9790991bc381761dc9"
  ) {
    throw new Error("builder images must match locked platform digests");
  }
  if (
    source.env.find((entry) => entry.name === "CODEOPS_BASE_SHA")?.value !==
      input.baseSha ||
    !source.env.some(
      (entry) =>
        entry.name === "CODEOPS_REPOSITORY_READ_TOKEN" &&
        entry.valueFrom?.secretKeyRef?.name ===
          `codeops-build-${input.buildId}`,
    )
  ) {
    throw new Error("builder source identity or credential scope drifted");
  }
  const output = builder.args.at(-1);
  if (
    output !==
    `type=image,name=codeops-registry:5000/${build.imageRepository}:candidate-${input.baseSha},push=true,registry.insecure=true`
  ) {
    throw new Error("builder output is not bound to the exact candidate image");
  }
  if (
    builder.securityContext?.allowPrivilegeEscalation !== false ||
    builder.securityContext?.readOnlyRootFilesystem !== true ||
    builder.securityContext?.seccompProfile?.type !== "Unconfined" ||
    builder.securityContext?.appArmorProfile?.type !== "Unconfined" ||
    builder.securityContext?.capabilities?.drop?.[0] !== "ALL"
  ) {
    throw new Error("rootless BuildKit security boundary drifted");
  }
  if (
    policy.spec.policyTypes.join(",") !== "Ingress,Egress" ||
    policy.spec.ingress.length !== 0 ||
    policy.spec.egress.length !== 3
  ) {
    throw new Error("builder network isolation drifted");
  }
  if (
    JSON.stringify(resources).includes("hostPath") ||
    resources.some((resource) =>
      ["Role", "RoleBinding", "Secret"].includes(resource.kind),
    )
  ) {
    throw new Error("builder may not receive host, RBAC, or literal Secret access");
  }
  return rendered;
}
