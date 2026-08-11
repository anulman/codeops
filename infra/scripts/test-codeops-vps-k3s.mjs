import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

test("the repository selects only the CodeOps VPS kubeconfig", async () => {
  const envrc = await text(".envrc");
  assert.match(envrc, /\.kube\/codeops-vps\.yaml/);
  assert.doesNotMatch(envrc, /ovh-renoconcierge/);
});

test("the VPS k3s contract preserves the host and retired-cluster boundaries", async () => {
  const config = parse(await text("infra/k3s/codeops-vps/config.yaml"));
  assert.equal(config["node-name"], "codeops-vps");
  assert.equal(config["secrets-encryption"], true);
  assert.deepEqual(config.disable.sort(), ["servicelb", "traefik"]);
  assert.equal(config["cluster-cidr"], "10.52.0.0/16");
  assert.equal(config["service-cidr"], "10.53.0.0/16");
  assert.equal(config["cluster-dns"], "10.53.0.10");
  assert.notEqual(config["service-cidr"], "10.43.0.0/16");
});

test("Caddy and ingress-nginx share only the private ingress NodePort", async () => {
  const ingress = parse(await text("infra/k3s/codeops-vps/ingress-nginx-values.yaml"));
  assert.equal(ingress.controller.service.type, "NodePort");
  assert.equal(ingress.controller.service.nodePorts.http, 32080);
  assert.equal(ingress.controller.service.nodePorts.https, 32443);

  const caddy = await text("infra/k3s/codeops-vps/Caddyfile");
  assert.match(caddy, /work\.aidans\.computer, agents\.aidans\.computer/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:32080/);

  const firewall = await text("infra/k3s/codeops-vps/firewall.nft");
  for (const port of [6443, 10250, 32080, 32443]) {
    assert.match(firewall, new RegExp(`\\b${port}\\b`));
  }
});
