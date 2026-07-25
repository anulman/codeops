import { parseAllDocuments, stringify } from "yaml";

const DIGEST_REFERENCE =
  /^([a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/;

function canonicalRepository(image) {
  const withoutDigest = image.split("@", 1)[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  const repository = colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
  const first = repository.split("/", 1)[0];

  if (!repository.includes("/")) return `docker.io/library/${repository}`;
  if (!first.includes(".") && !first.includes(":") && first !== "localhost") {
    return `docker.io/${repository}`;
  }
  return repository;
}

function visit(value, callback) {
  if (Array.isArray(value)) {
    for (const child of value) visit(child, callback);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "image" && typeof child === "string") callback(value, key, child);
    visit(child, callback);
  }
}

function hardenPublicOrigin(values) {
  const planeIngresses = values.filter(
    (value) =>
      value.kind === "Ingress" &&
      value.metadata?.labels?.["app.kubernetes.io/name"] === "plane-ce",
  );
  if (planeIngresses.length !== 1) {
    throw new Error(`expected exactly one Plane ingress, found ${planeIngresses.length}`);
  }

  const ingress = planeIngresses[0];
  const host = ingress.spec?.rules?.[0]?.host;
  const tlsHosts = ingress.spec?.tls?.flatMap((entry) => entry.hosts || []) || [];
  if (
    typeof host !== "string" ||
    host.length === 0 ||
    !tlsHosts.includes(host)
  ) {
    throw new Error("Plane ingress must terminate TLS for its primary host");
  }

  const appVariableMaps = values.filter(
    (value) =>
      value.kind === "ConfigMap" &&
      value.metadata?.labels?.["app.kubernetes.io/name"] === "plane-ce" &&
      value.metadata?.name?.endsWith("-app-vars"),
  );
  if (appVariableMaps.length !== 1) {
    throw new Error(
      `expected exactly one Plane app variable ConfigMap, found ${appVariableMaps.length}`,
    );
  }

  const variables = appVariableMaps[0].data;
  const httpOrigin = `http://${host}`;
  const httpsOrigin = `https://${host}`;
  if (
    !variables ||
    ![httpOrigin, httpsOrigin].includes(variables.WEB_URL)
  ) {
    throw new Error("Plane WEB_URL does not match the rendered ingress host");
  }

  const corsOrigins = (variables.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!corsOrigins.includes(httpOrigin) && !corsOrigins.includes(httpsOrigin)) {
    throw new Error("Plane CORS origins do not include the rendered ingress host");
  }

  variables.WEB_URL = httpsOrigin;
  variables.CORS_ALLOWED_ORIGINS = [
    httpsOrigin,
    ...corsOrigins.filter(
      (origin) => origin !== httpOrigin && origin !== httpsOrigin,
    ),
  ].join(",");

  ingress.metadata.annotations ||= {};
  ingress.metadata.annotations[
    "nginx.ingress.kubernetes.io/proxy-redirect-from"
  ] = `${httpOrigin}:3000/`;
  ingress.metadata.annotations[
    "nginx.ingress.kubernetes.io/proxy-redirect-to"
  ] = `${httpsOrigin}/`;
}

export function rewritePlaneImages(manifests, imageLock) {
  if (!imageLock || typeof imageLock !== "object" || Array.isArray(imageLock)) {
    throw new Error("Plane image lock must be an object");
  }

  const documents = parseAllDocuments(manifests);
  const values = documents
    .filter((document) => document.contents !== null)
    .map((document) => {
      if (document.errors.length > 0) throw document.errors[0];
      return document.toJS();
    });

  let replacements = 0;
  const seen = new Set();
  for (const value of values) {
    visit(value, (owner, key, image) => {
      const replacement = imageLock[image];
      if (!replacement) throw new Error(`unlocked Plane image: ${image}`);
      if (!DIGEST_REFERENCE.test(replacement)) {
        throw new Error(`invalid digest reference for ${image}`);
      }
      const expectedPrefix = `${canonicalRepository(image)}@`;
      if (!replacement.startsWith(expectedPrefix)) {
        throw new Error(`repository mismatch for ${image}: ${replacement}`);
      }
      owner[key] = replacement;
      seen.add(image);
      replacements += 1;
    });
  }

  if (replacements === 0) throw new Error("rendered Plane manifests contain no images");

  const unused = Object.keys(imageLock).filter((image) => !seen.has(image));
  if (unused.length > 0) {
    throw new Error(`unused Plane image lock entries: ${unused.join(", ")}`);
  }

  for (const value of values) {
    visit(value, (_owner, _key, image) => {
      if (!DIGEST_REFERENCE.test(image)) {
        throw new Error(`mutable image remains after rewrite: ${image}`);
      }
    });
  }

  hardenPublicOrigin(values);

  return {
    manifests: values.map((value) => stringify(value).trimEnd()).join("\n---\n") + "\n",
    replacements,
    images: [...seen].sort(),
  };
}
