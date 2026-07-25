# Trial 0 Plane, Temporal, and orchestrator

Trial 0 uses Plane Community Edition as the human-visible work-item and status
ledger. The chart and application versions are pinned in
`plane-chart.lock.json`; CI verifies the values contract. The trusted deployer
must separately verify the downloaded chart archive against the pinned digest.

The trusted external supervisor must:

1. derive the disposable namespace from the exact candidate SHA;
2. label the admitted worker `renoconcierge.ca/codeops=true` only after the live
   capacity gate passes;
3. create the five referenced Secrets in that namespace without writing their
   values to Git, logs, workflow inputs, Plane, or Temporal history;
4. copy `renoconcierge-preview-wildcard-tls` into the disposable namespace;
5. replace `plane-candidate.preview.renoconcierge.ca` with
   `plane-<candidate-sha-prefix>.preview.renoconcierge.ca`;
6. resolve every image in the rendered chart to an immutable registry digest
   and attest that every source tag still matches `plane-images.lock.json`;
7. apply `plane-limit-range.yaml`, then install the pinned, digest-rewritten
   chart with `plane-values.yaml`;
8. independently verify every Deployment, StatefulSet, PVC, Ingress, and
   required API operation before accepting the Plane portion of Trial 0.

Required Secret names and keys:

- `codeops-plane-rabbitmq`: `RABBITMQ_DEFAULT_USER`,
  `RABBITMQ_DEFAULT_PASS`;
- `codeops-plane-postgres`: `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB`;
- `codeops-plane-object-store`: `USE_MINIO`, `AWS_REGION`,
  `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_S3_ENDPOINT_URL`, `AWS_S3_BUCKET_NAME`,
  `FILE_SIZE_LIMIT`;
- `codeops-plane-app`: `SECRET_KEY`, `REDIS_URL`, `DATABASE_URL`,
  `AMQP_URL`;
- `codeops-plane-live`: `REDIS_URL`.

The candidate has no Kubernetes credential. Cleanup must remove the Helm
release, namespace, PVCs, copied TLS material, generated Secrets, node label,
and any external DNS record within the bootstrap plan's 24-hour deadline.

Render and rewrite without contacting the cluster:

```bash
helm template codeops-plane makeplane/plane-ce \
  --version 1.6.0 \
  --namespace "$CODEOPS_NAMESPACE" \
  -f infra/k8s/codeops/trial0/plane-values.yaml \
  --set "ingress.appHost=$CODEOPS_PLANE_HOST" \
  | node infra/scripts/rewrite-codeops-plane-images.mjs \
  > "$CODEOPS_RENDERED_MANIFEST"
```

The rewrite fails if the chart adds or removes an image, a lock entry is not a
SHA-256 digest for the same repository, no images are rendered, or any mutable
tag survives.

## Temporal and orchestrator

Trial 0 runs a real Temporal development server from the official
`temporalio/admin-tools` image pinned in `temporal-image.lock.json`. Its SQLite
store is persisted on a bounded Cinder PVC, and the `codeops` namespace is
created at startup. This is deliberately a single-node non-production server;
it proves durable workflow mechanics for the disposable trial but is not a
production topology.

`temporal.yaml` keeps both the Temporal UI and gRPC service cluster-internal.
The gRPC port is admitted only from the orchestrator pod; an operator may reach
the UI temporarily through an authenticated local port-forward, but there is no
public Temporal ingress. Both workloads use the CodeOps-only node selector,
explicit resources, non-root containers, and service accounts with token
mounting disabled.

The orchestrator implements the authoritative Trial 0 lifecycle through plan
approval, execution dispatch, and an externally reported independent acceptance
verdict. Its Agent Job activity currently fails closed. It does not simulate a
coding run; the isolated Job/session-gateway adapter must be installed before
the routing-matrix workload can be dispatched.

The trusted supervisor builds the `codeops-orchestrator-runtime` Docker target,
records its registry digest, and renders the deployment:

```bash
CODEOPS_ORCHESTRATOR_DIGEST=sha256:<64-lowercase-hex> \
  node infra/scripts/render-codeops-orchestrator.mjs \
  > "$CODEOPS_ORCHESTRATOR_MANIFEST"
```

Rendering rejects missing, mutable, malformed, or duplicated image
substitutions. The candidate still receives no Kubernetes credential.
