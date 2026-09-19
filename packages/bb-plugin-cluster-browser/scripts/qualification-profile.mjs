// SPDX-License-Identifier: Apache-2.0
// Operator assertions annotate evidence; they do not grant or change permissions.
export function qualificationProfile(env) {
  const profile = env.CLUSTER_BROWSER_FIXTURE_ISOLATION_PROFILE;
  if (!['chromium-internal', 'external-container'].includes(profile)) {
    throw new Error('Select CLUSTER_BROWSER_FIXTURE_ISOLATION_PROFILE: chromium-internal or external-container.');
  }
  const boundaryEvidenceSha256 = env.CLUSTER_BROWSER_FIXTURE_BOUNDARY_EVIDENCE_SHA256;
  if ((profile === 'external-container' || boundaryEvidenceSha256) && !/^[a-f0-9]{64}$/.test(boundaryEvidenceSha256 ?? '')) {
    throw new Error('External-container qualification requires CLUSTER_BROWSER_FIXTURE_BOUNDARY_EVIDENCE_SHA256 for the independent boundary evidence artifact.');
  }
  return {
    profile,
    boundaryEvidenceSha256: boundaryEvidenceSha256 ?? null,
    chromiumInternalSandbox: profile === 'external-container' ? 'disabled inside independently isolated runner; not tested' : 'required by operator profile; not attested by MCP',
    authority: 'operator assertion; MCP proof verifies browser-context behavior, not Pod, network, or process sandbox controls',
  };
}
