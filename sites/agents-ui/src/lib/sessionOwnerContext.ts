import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";

const principalSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const headerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9!#$%&'*+.^_`|~-]+$/);

export function resolveSessionOwnerPrincipal(input: {
  readonly fixedPrincipal?: string;
  readonly principalHeader?: string;
  readonly readHeader: (name: string) => string | undefined;
}): string {
  const fixedPrincipal = input.fixedPrincipal?.trim() || undefined;
  const principalHeader = input.principalHeader?.trim().toLowerCase() || undefined;
  if ((fixedPrincipal === undefined) === (principalHeader === undefined)) {
    throw new Error(
      "configure exactly one fixed session owner or trusted principal header",
    );
  }
  if (fixedPrincipal !== undefined) return principalSchema.parse(fixedPrincipal);
  const header = headerNameSchema.parse(principalHeader);
  const value = input.readHeader(header);
  if (value === undefined || value.trim() !== value) {
    throw new Error("authenticated session owner principal is missing");
  }
  return principalSchema.parse(value);
}

export const sessionOwnerContextMiddleware = createMiddleware().server(
  async ({ next }) => next({
    context: {
      sessionOwnerPrincipal: resolveSessionOwnerPrincipal({
        fixedPrincipal: process.env.CODEOPS_SESSION_OWNER_FIXED_PRINCIPAL,
        principalHeader: process.env.CODEOPS_SESSION_OWNER_PRINCIPAL_HEADER,
        readHeader: getRequestHeader,
      }),
    },
  }),
);
