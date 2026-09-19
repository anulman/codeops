// SPDX-License-Identifier: Apache-2.0
// Operator-side qualification entrypoint. This DOES create a disposable Job.
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { briefSchema, candidateSchema } from '../core/model.ts';
import { configSchema, KubernetesRunner } from '../validation.ts';
const requestSchema=z.object({runId:z.string().min(1),generation:z.number().int().positive(),lease:z.string().min(1),
  repository:briefSchema.shape.repository,base:briefSchema.shape.base,candidate:candidateSchema,check:briefSchema.shape.checks.element}).strict();
const [configPath,requestPath,outputPath]=process.argv.slice(2);
if(!configPath||!requestPath||!outputPath) throw new Error('Usage: node operator/qualify.ts <config.json> <request.json> <new-receipt.json>');
try {
  const config=configSchema.parse(JSON.parse(await readFile(configPath,'utf8')));
  const request=requestSchema.parse(JSON.parse(await readFile(requestPath,'utf8')));
  const result=await new KubernetesRunner(config).check(request);
  await writeFile(outputPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  process.exitCode=result.exitCode===0?0:1;
} catch {process.stderr.write('Validation did not produce accepted evidence. Inspect the exact Job and server configuration; do not retry unknown effects.\n');process.exitCode=1;}
