// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { qualificationProfile } from '../scripts/qualification-profile.mjs';
test('qualification explicitly records the operator isolation profile and independent evidence', () => {
  assert.throws(() => qualificationProfile({}), /Select CLUSTER_BROWSER/);
  assert.throws(() => qualificationProfile({ CLUSTER_BROWSER_FIXTURE_ISOLATION_PROFILE: 'external-container' }), /independent boundary evidence/);
  assert.throws(() => qualificationProfile({ CLUSTER_BROWSER_FIXTURE_ISOLATION_PROFILE: 'external-container', CLUSTER_BROWSER_FIXTURE_BOUNDARY_EVIDENCE_SHA256: 'invalid' }), /independent boundary evidence/);
  const external = qualificationProfile({ CLUSTER_BROWSER_FIXTURE_ISOLATION_PROFILE: 'external-container', CLUSTER_BROWSER_FIXTURE_BOUNDARY_EVIDENCE_SHA256: 'a'.repeat(64) });
  assert.equal(external.boundaryEvidenceSha256, 'a'.repeat(64));
  assert.match(external.chromiumInternalSandbox, /not tested/);
  const internal = qualificationProfile({ CLUSTER_BROWSER_FIXTURE_ISOLATION_PROFILE: 'chromium-internal' });
  assert.match(internal.chromiumInternalSandbox, /required.*not attested/);
});
