// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAllDocuments } from 'yaml';
const documents=parseAllDocuments(await readFile(new URL('../../packages/bb-plugin-codeops/operator/validation.yaml',import.meta.url),'utf8')).map(d=>d.toJSON());
test('validation Role covers kubectl logs preflight without extra authority',()=>{
  const roles=documents.filter(d=>d.kind==='Role');assert.equal(roles.length,1);
  assert.equal(roles[0].metadata.namespace,'codeops-validation');
  assert.deepEqual(roles[0].rules,[
    {apiGroups:['batch'],resources:['jobs'],verbs:['create','get']},
    {apiGroups:[''],resources:['pods'],verbs:['get','list']},
    {apiGroups:[''],resources:['pods/log'],verbs:['get']},
    {apiGroups:['networking.k8s.io'],resources:['networkpolicies'],verbs:['list']},
  ]);
  assert.equal(documents.filter(d=>d.kind==='ClusterRole'||d.kind==='ClusterRoleBinding').length,0);
  const bindings=documents.filter(d=>d.kind==='RoleBinding');assert.equal(bindings.length,1);
  assert.equal(bindings[0].metadata.namespace,'codeops-validation');
  assert.deepEqual(bindings[0].subjects,[{kind:'ServiceAccount',name:'codeops-validation-launcher',namespace:'bb-system'}]);
  assert.deepEqual(bindings[0].roleRef,{apiGroup:'rbac.authorization.k8s.io',kind:'Role',name:'codeops-validation-launcher'});
  const worker=documents.find(d=>d.kind==='ServiceAccount'&&d.metadata.name==='codeops-validation');
  assert.equal(worker.automountServiceAccountToken,false);
});
