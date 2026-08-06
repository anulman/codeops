import { execFileSync } from "node:child_process";
import { applySessionProofGateway } from "./codeops-session-proof-gateway-apply.mjs";
import { readSessionProofOperatorArtifact } from "./codeops-session-proof-operator-admission.mjs";
import {
  readFifthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-step-authorization.mjs";

export function applySessionProofGatewayFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofGateway,
) {
  const { authorization } = readFifthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const manifestSource = readSessionProofOperatorArtifact(input, "gateway");
  return apply({
    authorization,
    manifestSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, runner);
}
