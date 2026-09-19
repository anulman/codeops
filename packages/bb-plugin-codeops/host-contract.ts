// SPDX-License-Identifier: Apache-2.0
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { briefSchema, candidateSchema, checkSchema } from './core/model.ts';
const target = z.object({ path:z.string().min(1), repository:briefSchema.shape.repository, base:briefSchema.shape.base }).strict();
export const hostContract = defineRpcContract({
  identity: { input: target, output:z.object({valid:z.literal(true)}) },
  inspect: { input: target, output:candidateSchema },
  bundle: { input:target.extend({candidate:candidateSchema}), output:z.object({data:z.string().max(24*1024*1024),sha256:z.string().length(64)}).strict() },
  check: { input:target.extend({ candidate:candidateSchema, check:briefSchema.shape.checks.element }), output:checkSchema },
});
