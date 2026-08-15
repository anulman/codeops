export function browserAcceptanceReport() {
  return Object.freeze({
    version: "codeops.browser-acceptance-report/v1",
    evidence: Object.freeze({
      kind: "browser-acceptance",
      providerDelivery: false,
    }),
    status: "passed",
    target: "local-agents-ui",
  });
}
