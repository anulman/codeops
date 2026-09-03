export type ControlGatewayRuntimeRole = "api" | "file-dispatcher";

const candidatePublicationPath =
  /^\/v1\/repositories\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/candidate-publications$/;

export function controlGatewayRuntimeRole(value: string | undefined): ControlGatewayRuntimeRole {
  const role = value?.trim() || "api";
  if (role !== "api" && role !== "file-dispatcher") {
    throw new Error("CODEOPS_CONTROL_GATEWAY_RUNTIME_ROLE is invalid");
  }
  return role;
}

export function isFileBackedControlGatewayRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  return method === "POST" && (url === "/v1/agent-jobs" ||
    (url !== undefined && candidatePublicationPath.test(url)));
}

export function runtimeRoleOwnsRequest(
  role: ControlGatewayRuntimeRole,
  method: string | undefined,
  url: string | undefined,
): boolean {
  return role === "file-dispatcher" === isFileBackedControlGatewayRequest(method, url);
}
