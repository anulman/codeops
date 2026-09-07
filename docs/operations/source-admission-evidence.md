# Deployment evidence for source-only admission

When source work depends on a deployed prerequisite, the operator must deliver
its evidence with the launch. A receipt on the operator's filesystem is not
available to the agent. A successful launch is not proof of deployment or ticket
completion.

1. Authenticate the release through the release provider. Check the exact source,
   immutable chart and image identities. Read back the installed release and its
   readiness. Do not infer deployment from a source merge or successful build.
2. Build a small, sanitized JSON receipt with those identities, verification
   results, evidence references and explicit limitations. Do not include tokens,
   connection strings, raw logs or authority to execute later work.
3. Put the receipt bytes in the existing launch request's `contextAttachments`.
   Use `application/json`, a descriptive name such as `deployment-receipt.json`,
   canonical base64, the exact byte count, and a SHA-256 digest of those bytes.
   The digest checks transport integrity; it does not authenticate a deployment.
4. Submit through the authenticated workspace-launch endpoint under the exact
   operator principal. Keep the returned attachment descriptor and request digest
   with the admission evidence. Reject missing, mismatched or stale prerequisite
   evidence before submission. Use a new admission only when separately authorized.
5. Tell the agent to read the attached receipt. The runtime delivers it as an
   embedded ACP resource at `codeops-context://sha256/<digest>/<name>`. It is not
   a file in the repository or workspace. The agent must stop before editing if
   required evidence is absent or does not match the admitted source.

The launch controller retains the attachment in the initial prompt command.
The runtime verifies its byte count and digest before building the agent prompt.
Public launch reads expose descriptors, not payload bytes.

Deployment evidence does not prove checkpoint routing. Before reopening work
that needs checkpoint/recovery, prove both paths on the installed entrypoint
under fresh, exact claim authority. Do not replay a failed dispatch, rewrite its
historical input, or promote a retained workspace with no source changes into an
implementation candidate. Keep merge, release and deployment approval separate.
