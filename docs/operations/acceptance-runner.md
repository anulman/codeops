# Run post-deploy acceptance

The CodeOps release owns the generic Agents UI browser acceptance test. Each
release publishes the test as the immutable `acceptance-runner` image and
records its digest in `release-manifest.json`.

A deployment consumer owns the invocation. It must:

1. Pin the chart and `acceptance-runner` image from one release manifest.
2. Verify the deployed chart version, source SHA, and image set before the
   browser test starts.
3. Create an ephemeral Job with the pinned runner image.
4. Set `CODEOPS_AGENTS_UI_BASE_URL` to one exact HTTPS origin.
5. Mount a separately revocable Cloudflare Access service token as files.
6. Set `CODEOPS_ACCESS_CLIENT_ID_FILE` and
   `CODEOPS_ACCESS_CLIENT_SECRET_FILE` to those mounted files.
7. Require the Job to complete and retain its JSON result with the deployment
   evidence.

The runner checks the desktop and mobile Agents UI contracts. It requires an
HTTP 200 response, the expected accessible headings and controls, and no
horizontal overflow. It does not test product-specific customer files,
payments, signing, email, database effects, or provider workflows.

Keep product acceptance in the product repository. Do not copy the CodeOps
browser test source or build a second runner image there. If a second control
plane product later needs lower-level browser or evidence primitives, extract
only those primitives after the second use case exists.

The service-token files must contain one non-empty value each. The values must
be different and no larger than 4 KiB. Do not put either value in an
environment variable, workflow log, Helm value, or release artifact.
