import { execFileSync } from "node:child_process";
import { issueSessionProofCredentials } from "./codeops-session-proof-credential-issuer.mjs";
import {
  readSecondSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-next-step-authorization.mjs";

export function issueSecondSessionProofCredentialsFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const { authorization } = readSecondSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  return issueSessionProofCredentials({
    authorization,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    registryConfigFile: input.registryConfigFile,
    repositoryTokenFile: input.repositoryTokenFile,
  }, runner);
}
