import { z } from "zod";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
// This is a rejection filter, not a claim that arbitrary prose can be sanitized.
export const messageTextSchema = z.string().trim().min(1).max(4000).refine(
  (text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|(?:Bearer\s+\S+|-----BEGIN .*PRIVATE KEY|(?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?\S+|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{12,})/i.test(text),
  "message contains unsafe text",
);
export const agentMessageScopeSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  projectId: z.string().uuid(),
  workItemId: z.string().uuid(),
}).strict();
export const frictionReportSchema = z.object({
  reportId: z.string().uuid(),
  failureClass: id,
  candidate: digest,
  expected: messageTextSchema,
  observed: messageTextSchema,
  evidence: z.array(z.string().regex(/^codeops-context:\/\/sha256\/[0-9a-f]{64}\/[A-Za-z0-9._-]{1,100}$/)).min(1).max(10),
  impact: messageTextSchema,
  cause: z.object({ certainty: z.enum(["suspected", "verified"]), description: messageTextSchema }).strict(),
  workaround: z.object({ limits: messageTextSchema, removalCriterion: messageTextSchema }).strict(),
  proposedFixWorkItemId: z.string().uuid().nullable(),
}).strict();
export const agentMessageInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("send"), idempotencyKey: id,
    scope: agentMessageScopeSchema, recipient: z.literal("supervisor"),
    type: z.enum(["fyi", "question", "decision"]), body: messageTextSchema,
    friction: frictionReportSchema.optional(),
  }).strict(),
  z.object({ operation: z.literal("reply"), idempotencyKey: id,
    messageId: digest, body: messageTextSchema }).strict(),
  z.object({ operation: z.literal("inbox"), limit: z.number().int().min(1).max(20).default(20) }).strict(),
  z.object({ operation: z.literal("acknowledge"), messageId: digest }).strict(),
]).refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 48 * 1024,
  "message submission exceeds 49152 bytes");
export const agentMessageRequestSchema = z.object({
  claimToken: z.string().uuid(), input: agentMessageInputSchema,
}).strict();
export const agentMessageSchema = z.object({
  version: z.literal("codeops.agent-message/v1"),
  messageId: digest, threadId: digest, inReplyTo: digest.nullable(),
  scope: agentMessageScopeSchema,
  sessionId: id, generation: z.number().int().positive(), leaseId: z.string().uuid(),
  dispatchId: z.string().uuid(), claimCount: z.number().int().positive(),
  authorityDigest: digest, sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  sender: z.string().min(1).max(256), recipient: z.string().min(1).max(256),
  routeId: id, routeVersion: id,
  type: z.enum(["fyi", "question", "decision"]), body: messageTextSchema,
  friction: frictionReportSchema.optional(),
  createdAt: z.string().datetime({ offset: true }),
  state: z.enum(["persisted", "delivered", "acknowledged", "answered"]),
  executionAuthority: z.literal(false),
}).strict();
export const agentMessageResultSchema = z.object({
  messages: z.array(agentMessageSchema).max(20),
}).strict();
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentMessageInput = z.infer<typeof agentMessageInputSchema>;
export type AgentMessageResult = z.infer<typeof agentMessageResultSchema>;
