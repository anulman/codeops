// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { sameReleaseLine } from '../compatibility.mjs';
test('patch-line filter bounds versions without claiming qualification', () => {
  for (const version of ['1.64.0-alpha-1789764292001', '1.64.0', '1.64.1', '1.64.1+build'])
    assert.equal(sameReleaseLine(version, '1.64.0-alpha-1789764292000'), true, version);
  for (const version of [undefined, '', 'wrong', '01.64.0', '1.65.0', '2.64.0', '1.63.9', '1.64.1-..', '1.64.1+.', '1.64.1-01', '1.64.1\n'])
    assert.equal(sameReleaseLine(version, '1.64.0-alpha-1789764292000'), false, String(version));
  assert.equal(sameReleaseLine('0.43.0', '0.43.1'), false);
});
