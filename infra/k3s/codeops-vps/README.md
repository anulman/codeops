# CodeOps VPS development cluster

This directory defines the single-node k3s cluster used to develop CodeOps on
the VPS. It is separate from the OVH RenoConcierge cluster.

## Boundaries

- Kubernetes context: `codeops-vps`
- Kubeconfig: `~/.kube/codeops-vps.yaml`
- Pod CIDR: `10.52.0.0/16`
- Service CIDR: `10.53.0.0/16`
- Public edge: Caddy on ports 80 and 443
- Cluster ingress: ingress-nginx on NodePorts 32080 and 32443
- Plane host: `work.aidans.computer`
- Agents UI host: `agents.aidans.computer`

The separate CIDRs prevent the new cluster from reusing retired RenoConcierge
ClusterIP addresses that remain in historical Caddy routes. The host firewall
must reject the Kubernetes API and ingress NodePorts on the public interface.

## Repository use

The repository `.envrc` selects only this kubeconfig. Run `direnv allow` once.
Do not merge this kubeconfig with the RenoConcierge kubeconfig. This reduces
the risk of a command targeting the wrong cluster.

Verify the selected cluster before an effect:

```sh
kubectl config current-context
nub run doctor -- --cluster
kubectl get nodes
```

Render the source chart without installing it:

```sh
nub run prepare:chart
helm template codeops infra/charts/codeops \
  --namespace codeops \
  --values /absolute/path/codeops-values.yaml >/dev/null
```

## Capacity gate

The current VPS can run k3s, ingress-nginx, and bounded development workloads.
Do not install the `full-managed` CodeOps profile on a 4 GiB host with less
than 25 GiB free disk. Managed Plane, PostgreSQL, Temporal, JetStream, and all
CodeOps services need a larger host or external dependencies.

Before a full installation, verify:

- at least 8 GiB RAM;
- at least 40 GiB free disk;
- the required credential and identity values;
- DNS and Cloudflare Access for both public hosts;
- verified backup and rollback procedures.

## Host installation

Use the exact versions in `versions.env`. Install the pinned k3s release with
`config.yaml` copied to
`/etc/rancher/k3s/config.yaml`. Install ingress-nginx with
`ingress-nginx-values.yaml`. Install `firewall.nft` under `/etc/nftables.d/`
before public DNS points to the host. Append the repository Caddy block to the
host Caddyfile only after `caddy validate` passes.

Keep `work.aidans.computer` and `agents.aidans.computer` proxied through
Cloudflare to the VPS. Caddy terminates TLS and forwards the original host to
ingress-nginx.
