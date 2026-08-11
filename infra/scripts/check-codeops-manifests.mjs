import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseAllDocuments } from "yaml";

const paths = process.argv.slice(2);
assert.ok(paths.length > 0, "provide at least one rendered manifest path");

for (const path of paths) {
  const source = await readFile(path, "utf8");
  const documents = parseAllDocuments(source);
  assert.ok(documents.length > 0, `${path} must contain a resource`);
  const identities = new Set();

  for (const [index, document] of documents.entries()) {
    assert.equal(
      document.errors.length,
      0,
      `${path} document ${index + 1} must be valid YAML`,
    );
    const resource = document.toJS();
    assert.equal(typeof resource, "object", `${path} must contain objects`);
    assert.match(
      resource?.apiVersion ?? "",
      /^[a-z0-9.-]+(?:\/[a-z0-9.-]+)?$/,
      `${path} document ${index + 1} must declare apiVersion`,
    );
    assert.match(
      resource?.kind ?? "",
      /^[A-Z][A-Za-z0-9]+$/,
      `${path} document ${index + 1} must declare kind`,
    );
    assert.match(
      resource?.metadata?.name ?? "",
      /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/,
      `${path} document ${index + 1} must declare a DNS-safe metadata.name`,
    );
    const identity = `${resource.apiVersion}/${resource.kind}/${resource.metadata.name}`;
    assert.equal(
      identities.has(identity),
      false,
      `${path} contains duplicate ${identity}`,
    );
    identities.add(identity);
  }

  console.log(`${path}: ${documents.length} manifest resources parsed offline.`);
}
