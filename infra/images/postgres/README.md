# RenoConcierge PostgreSQL operand image

This image extends the pinned CloudNativePG PostgreSQL 18/PostGIS system image
with the two retrieval extensions RenoConcierge owns operationally:

- `pg_textsearch` 1.3.1 for BM25 lexical candidates
- `pgvector` 0.8.5 for dense semantic candidates

The upstream image, release artifacts, and source archive are version- and
SHA-256-pinned. The image does not enable either extension automatically.
Cluster manifests must preload `pg_textsearch`, and each database must install
`pg_textsearch` and `vector` explicitly through the provisioned schema path.

Build and run the extension smoke locally:

```bash
docker build -f infra/images/postgres/Dockerfile -t renoconcierge-postgres:test .
infra/scripts/test-postgres-retrieval-image.sh renoconcierge-postgres:test
```

The canonical PG16 cluster must not be changed merely because this image
builds. Promotion requires a disposable three-instance CNPG PG18 cluster plus
physical replication/failover, crash recovery, PITR restore, Sqitch, app,
resource, and rollback evidence.
