# Web Push notifications

CodeOps can send private Agents UI notifications through the Web Push
standard. Web Push is disabled by default.

Create one VAPID key pair outside the repository. Put only the private key in
a Kubernetes Secret. Do not put the private key in Helm values.

```yaml
controlGateway:
  webPush:
    enabled: true
    publicKey: "<VAPID public key>"
    subject: "mailto:ops@example.com"
    secretName: codeops-web-push
    privateKeyKey: private-key
```

The Agents UI requests permission only after the operator selects **Enable
notifications**. If the operator dismisses the prompt, the UI waits seven days
before it shows the prompt again automatically. A persistent **Notifications**
control remains available and can reopen the prompt immediately. If the browser
denies permission, the control shows the iPhone Settings recovery path instead
of issuing an invalid second permission request.

On iPhone and iPad, first add the Agents UI to the Home Screen. Open the
installed app and select **Enable notifications**. iOS does not offer Web Push
permission to a normal browser tab.

The control gateway stores one authenticated subscription for each UI principal
and device. Push payloads contain only a notification kind, exact session
identity, cursor, short operator text, and the session route. The payload does
not contain prompts, permission operations, repository content, or credentials.
The trusted server accepts endpoints only from the Apple, Mozilla, and Google
browser push services. This prevents a subscription from turning Web Push into
an arbitrary server-side HTTPS request.

The delivery worker uses an expiring database claim for each attempt. It backs
off transient failures, stops after eight attempts, and revokes subscriptions
when the push service returns HTTP 404 or 410. Each provider request has a
ten-second timeout.
