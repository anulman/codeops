# Trial 0 Plane

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
   and reject the deployment if any tag remains;
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
