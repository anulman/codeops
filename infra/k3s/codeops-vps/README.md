# CodeOps VPS development cluster

This directory defines the single-node k3s cluster used to develop CodeOps on
the VPS. It is separate from consumer clusters.

## Boundaries

- Kubernetes context: `codeops-vps`
- Kubeconfig: `~/.kube/codeops-vps.yaml`
- Pod CIDR: `10.52.0.0/16`
- Service CIDR: `10.53.0.0/16`
- Cluster ingress: ingress-nginx on NodePorts 32080 and 32443

The separate CIDRs prevent the new cluster from reusing service addresses from
other clusters. The host firewall must reject the Kubernetes API and ingress
NodePorts on the public interface.

## Repository use

The repository `.envrc` selects only this kubeconfig. Run `direnv allow` once.
Do not merge this kubeconfig with a consumer kubeconfig. This reduces the risk
of a command targeting the wrong cluster.

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
- verified backup and rollback procedures.

## Host installation

Use the exact versions in `versions.env`. Install the pinned k3s release with
`config.yaml` copied to
`/etc/rancher/k3s/config.yaml`. Install ingress-nginx with
`ingress-nginx-values.yaml`. Install `firewall.nft` under `/etc/nftables.d/`.
Keep the Kubernetes API and ingress NodePorts private.
