// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const lock=JSON.parse(readFileSync(new URL('../package-lock.json',import.meta.url)));
const allowed=new Set(['MIT','Apache-2.0','ISC','BSD-2-Clause','BSD-3-Clause','0BSD','CC0-1.0','Unlicense']);
let checked=0;
for(const [path,entry] of Object.entries(lock.packages)) {
 if(!path)continue;
 if(path==='node_modules/@get-bb/plugin-sdk') {
  assert.equal(entry.version,'0.4.87');
  assert.equal(entry.integrity,'sha512-mTlcPPpef2fA7eWEiP7VutYXP1grn3efKzGDYaSTBXelkrwatUdlPXyZodehJyEJhRYGa8rUXo/WxNIecP9Nvg==');
  assert.match(readFileSync(new URL('../SDK-LICENSE.txt',import.meta.url),'utf8'),/^MIT License/);
 } else assert.ok(allowed.has(entry.license),`Unreviewed license: ${path}@${entry.version}`);
 assert.ok(entry.integrity,`Missing artifact integrity: ${path}`);checked++;
}
console.log(`License policy passed for ${checked} pinned package artifacts, including the exact SDK source-license review.`);
