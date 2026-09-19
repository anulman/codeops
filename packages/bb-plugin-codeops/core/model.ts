// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PublicationReceipt } from './publication.ts';

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const commit = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().min(1).max(160);
export const briefSchema = z.object({
  key: id, projectId: id, parentThreadId: id, environmentId: id,
  repository: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/),
  base: commit, outcome: z.string().min(1).max(4000),
  scope: z.array(z.string().min(1).max(500)).min(1).max(40),
  acceptance: z.array(z.string().min(1).max(500)).min(1).max(40),
  checks: z.array(z.object({ name: id, argv: z.array(z.string().min(1).max(500)).min(1).max(30) }).strict()).min(1).max(12),
  correctionLimit: z.number().int().min(0).max(3),
  intent: z.object({ provider: z.literal('local'), item: id, revision: id }).strict(),
}).strict();
export type Brief = z.infer<typeof briefSchema>;
export const candidateSchema = z.object({ head: commit, tree: commit, files: z.array(z.string()).max(2000) }).strict();
export type Candidate = z.infer<typeof candidateSchema>;
export const checkSchema = z.object({ name: id, candidate: commit, tree: commit, argvDigest: id,
  exitCode: z.number().int(), outputDigest: z.string().regex(/^[a-f0-9]{64}$/), isolation: z.discriminatedUnion('backend', [
    z.object({backend:z.literal('bubblewrap'),version:z.literal(1)}).strict(),
    z.object({backend:z.literal('kubernetes-job'),version:z.literal(1),requestDigest:z.string().regex(/^[a-f0-9]{64}$/),
      namespace:id,jobName:id,jobUid:id,podUid:id,image:z.string().regex(/@sha256:[a-f0-9]{64}$/),
      runId:id,generation:z.number().int().positive(),lease:id,repository:briefSchema.shape.repository,base:commit}).strict(),
  ]),
}).strict();
export type Check = z.infer<typeof checkSchema>;
export const reviewSchema = z.object({ candidate: commit, tree: commit, scopeDigest: id,
  evidenceDigest: id, outcome: z.enum(['accept','rework','uncertain']),
  findings: z.array(z.object({ requirement: z.string().min(1).max(500), impact: z.string().min(1).max(1000), remedy: z.string().min(1).max(1000) }).strict()).max(30),
  scopeAssessment: z.string().min(1).max(3000),
}).strict();
export type Review = z.infer<typeof reviewSchema>;
export type Stage = 'Explore'|'Plan'|'Implement'|'Validate'|'Critic'|'Publish'|'AwaitMerge'|'Done';
export type Condition = 'Waiting'|'Running'|'Stopping'|'Paused'|'NeedsAttention'|'Completed'|'Cancelled';
export type Gate = 'G0'|'G1'|'G2'|'G3'|'G4'|'G5'|'G6'|'G7'|'G8'|'exception';
export interface Decision { gate: Gate; version: 1; revision: number; scopeDigest: string; candidate: string|null;
  evidenceDigest: string; outcome: 'allow'|'deny'|'needs_attention'; reason: string; at: string; }
export interface Action { key: string; kind: 'worker'|'reviewer'|'checks'|'stop'; state: 'authorized'|'attempting'|'succeeded'|'failed'|'unknown'; threadId?: string; generation: number; }
export interface Run { id: string; revision: number; brief: Brief; scopeDigest: string; policy: 'codeops/bb-v1';
  authority: { source: 'admitted-brief'; projectId: string; effects: ['implement','validate','review']; digest: string };
  stage: Stage; condition: Condition; desired: 'run'|'pause'|'cancel'; reason: string; generation: number; lease: string;
  corrections: number; interrupted?: 'worker'|'reviewer'; candidate: Candidate|null; checks: Check[]; review: Review|null;
  abandonedPublications?: {permitId:string;identity:import('./publication.ts').PublicationIdentity;revokedAt:string}[];
  publicationAttempt?: {permitId:string;identity:import('./publication.ts').PublicationIdentity;phase:'attempting'|'unknown'};
  publication?: {permitId:string;receipt:PublicationReceipt};
  actions: Action[]; decisions: Decision[]; createdAt: string; updatedAt: string; }
export function decision(run: Run, gate: Gate, outcome: Decision['outcome'], reason: string): Decision {
  return { gate, version: 1, revision: run.revision, scopeDigest: run.scopeDigest, candidate: run.candidate?.head ?? null,
    evidenceDigest: digest(run.checks), outcome, reason, at: new Date().toISOString() };
}
/** Pure gate evaluation. No model result can supply a deterministic fact. */
export function evaluate(run: Run, gate: Gate): Decision {
  const result = (outcome: Decision['outcome'], reason: string) => decision(run, gate, outcome, reason);
  if (gate === 'G0') return result('allow','Known native project; complete local intent');
  if (gate === 'G1') return run.scopeDigest === digest(run.brief) && run.policy === 'codeops/bb-v1' && run.authority.projectId === run.brief.projectId &&
    digest(run.authority.effects) === digest(['implement','validate','review']) && run.authority.digest === digest({projectId:run.brief.projectId,effects:['implement','validate','review']})
    ? result('allow','Frozen brief and implementation-only run policy') : result('deny','Frozen identity mismatch');
  if (gate === 'G2') return result(run.candidate ? 'allow':'needs_attention',run.candidate ? 'Exact clean candidate captured':'Candidate missing');
  if (gate === 'G3') {
    const valid = run.candidate && run.brief.checks.every(required => run.checks.some(check =>
      check.name === required.name && check.argvDigest === digest(required.argv) && check.exitCode === 0 &&
      check.candidate === run.candidate!.head && check.tree === run.candidate!.tree && checkSchema.safeParse(check).success && (check.isolation.backend === 'bubblewrap' ||
        (check.isolation.runId === run.id && check.isolation.generation === run.generation && check.isolation.lease === run.lease &&
         check.isolation.repository === run.brief.repository && check.isolation.base === run.brief.base &&
         check.isolation.requestDigest === digest(validationRequest(run, required))))));
    return result(valid ? 'allow':'needs_attention', valid ? 'Exact isolated checks passed':'Required isolated evidence missing or failed');
  }
  if (gate === 'G4') {
    const r = run.review;
    if (!r || r.candidate !== run.candidate?.head || r.tree !== run.candidate?.tree || r.scopeDigest !== run.scopeDigest || r.evidenceDigest !== digest(run.checks)) return result('needs_attention','Missing or stale independent review');
    if (r.outcome === 'accept' && r.findings.length === 0) return result('allow','Independent advisory review accepts candidate');
    return result('needs_attention',r.outcome === 'rework' && run.corrections < run.brief.correctionLimit ? 'Bounded correction required':'Review uncertain or correction budget exhausted');
  }
  if (gate === 'G5') return result('needs_attention','Manual publication: no credential-separated publisher or authenticated human authority');
  if (gate === 'G6') return result('needs_attention','Human merge decision and live GitHub readback required');
  if (gate === 'G7') return result('needs_attention','Separate human release/deploy authority required; no executor registered');
  if (gate === 'G8') return result('needs_attention','Completion requires live terminal milestone evidence; no dependent admission');
  return result('needs_attention','Exception preserves interrupted stage');
}
export type Judgment = { status:'unavailable'; reason:string } | { status:'uncertain'; questionVersion:string } |
  { status:'shadow'; model:string; questionVersion:string; choice:'within_scope'|'expands_scope'|'insufficient_evidence'; distribution:Record<string,number> };
export interface JudgmentAdapter { assess(input: { brief: Brief; selectedFacts: string[] }): Promise<Judgment> }
export const jevUnavailable: JudgmentAdapter = { async assess() { return { status:'unavailable', reason:'No Jev credential or verified transport configured' }; } };

export function validationRequest(run:Run, check:Brief['checks'][number]) {
  if (!run.candidate) throw new Error('Candidate missing');
  return {runId:run.id,generation:run.generation,lease:run.lease,repository:run.brief.repository,base:run.brief.base,candidate:run.candidate,check};
}
export type ValidationRequest = ReturnType<typeof validationRequest>;
export interface ValidationRunner { readonly backend:'kubernetes-job'|'bubblewrap'; check(request:ValidationRequest):Promise<Check>; }
