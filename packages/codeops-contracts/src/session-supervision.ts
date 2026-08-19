import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const uuid = z.string().uuid();
const repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);

export const sessionSupervisionReconciliationRequestSchema = z
  .object({
    version: z.literal("codeops.session-supervision-reconciliation/v1"),
    idempotencyKey: uuid,
    supervisorSessionId: identifier,
    childSessionIds: z.array(identifier).min(1).max(20),
    repository,
    workItemId: uuid,
    workflowId: identifier,
    pullRequestNumber: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    pullRequestHeadSha: gitSha,
  })
  .strict()
  .refine(
    (request) => new Set(request.childSessionIds).size === request.childSessionIds.length,
    "supervision reconciliation child sessions must be unique",
  )
  .refine(
    (request) => !request.childSessionIds.includes(request.supervisorSessionId),
    "a session cannot supervise itself",
  );

export const sessionSupervisionReconciliationResultSchema = z
  .object({
    version: z.literal("codeops.session-supervision-reconciliation-result/v1"),
    idempotencyKey: uuid,
    supervisorSessionId: identifier,
    projected: z
      .array(
        z
          .object({
            childSessionId: identifier,
            disposition: z.enum(["created", "existing"]),
            eventCursor: z
              .number()
              .int()
              .positive()
              .max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export type SessionSupervisionReconciliationRequest = z.infer<
  typeof sessionSupervisionReconciliationRequestSchema
>;
export type SessionSupervisionReconciliationResult = z.infer<
  typeof sessionSupervisionReconciliationResultSchema
>;
