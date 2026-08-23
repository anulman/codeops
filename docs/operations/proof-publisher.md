# S3 proof publisher

The optional S3 proof publisher uploads sanitized reviewer media from a trusted
CodeOps publication request. It returns an identity-bound receipt with the
immutable object URLs, SHA-256 digests, ETags, and expected expiration time.

The contract is provider-neutral. A CodeOps installation selects an
S3-compatible endpoint through Helm values. The RenoConcierge installation
uses a dedicated OVHcloud Object Storage bucket.

## Security boundary

- Mount the S3 access key and secret key only in the proof publisher Pod.
- Mount a separate internal plugin token in the control gateway and publisher.
- Do not mount either credential in an Agent Job, acceptance runner, repository,
  or GitHub Actions runner.
- Give the S3 principal object read and write authority for one bucket only.
- Do not give the S3 principal bucket deletion, IAM, DNS, or application-bucket
  authority.
- Keep bucket listing private. Set `public-read` only on sanitized video, poster,
  and packet-index objects.
- Configure provider-enforced lifecycle expiration on the bucket. The receipt
  expiration is evidence of the configured policy, not the deletion mechanism.

The publisher accepts `sensitive` classification so it can return a stable
`sensitive_proof` failure receipt. It never uploads that classification.
The request allows a maximum 50 MiB MP4 and 10 MiB poster inside an 84 MiB
JSON body limit. This keeps base64 decoding within the publisher's default
512 MiB memory limit.

The publisher sends `PUT` with `If-None-Match: *` before authenticated `HEAD`.
This supports a bucket-scoped principal that has object read and write access
but no bucket list access. It verifies the stored metadata with authenticated
`HEAD`. It then verifies each returned URL with an unauthenticated `HEAD`.

S3 does not provide one transaction for three objects. The verified
packet-index object is the publication marker. A failed receipt uses
`publicationState: staged` and lists each immutable object key whose upload
was attempted. These objects can remain anonymously readable until the bucket
lifecycle rule expires them. Do not treat a video or poster object alone as a
successful publication.

## Request path

Send the strict `codeops.proof-publication-request/v1` body to:

```text
POST /v1/repositories/{owner}/{repository}/proof-publications
Authorization: Bearer {publication-token}
Content-Type: application/json
```

The control gateway verifies the repository route. It then relays the request
to the internal publisher with the separate plugin token. The response is a
`codeops.proof-publication-receipt/v1` object. A successful response includes
the MP4 URL, poster URL, and packet-index URL. The gateway independently binds
the media digest, byte length, immutable object key, and public origin to the
request before it returns the receipt.

## OVHcloud installation values

Create a new bucket for this purpose. Do not reuse an application bucket or the
short-retention acceptance bucket. Configure a 90-day lifecycle rule on the new
bucket before enabling the plugin.

```yaml
proofPublisher:
  enabled: true
  destinationId: ovh:<region>:codeops-proofs
  retentionDays: 90
  s3:
    endpoint: https://s3.<region>.io.cloud.ovh.net/
    publicBaseUrl: https://codeops-proofs.s3.<region>.io.cloud.ovh.net/
    bucket: codeops-proofs
    region: <region>
    credentialSecretName: codeops-proof-publisher-s3
    accessKeyIdKey: access-key-id
    secretAccessKeyKey: secret-access-key
  auth:
    secretName: codeops-proof-publisher-auth
    tokenKey: token
```

Create the two Kubernetes Secrets outside Helm. Use a no-echo operator prompt
for the OVH access key and secret key. Generate the internal plugin token from
a cryptographically secure random source. Do not put either Secret value in a
values file, repository, Job result, log, or chat message.

Enabling the plugin is not permission to create the OVH bucket or principal,
release CodeOps, deploy the RenoConcierge installation, or publish a GitHub PR
comment. Keep each operation as a separate gate.
