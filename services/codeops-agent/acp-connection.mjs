import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { spawn } from "node:child_process";

export function loadModelProxyAuthority(
  tokenPath,
  expectedPath = "/run/codeops/model-proxy-token",
) {
  if (tokenPath !== expectedPath) {
    throw new Error(
      "CODEOPS_MODEL_PROXY_TOKEN_FILE must equal /run/codeops/model-proxy-token",
    );
  }
  const descriptor = openSync(
    tokenPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
      throw new Error(
        "published model proxy token must be one mode 0600 regular file",
      );
    }
    const token = readFileSync(descriptor, "utf8");
    if (
      token.length < 32 ||
      token.length > 8_192 ||
      !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
    ) {
      throw new Error("published model proxy token is invalid");
    }
    return token;
  } finally {
    closeSync(descriptor);
  }
}

export async function runAcpConnection(input = {}) {
  const token = loadModelProxyAuthority(
    input.tokenPath ?? process.env.CODEOPS_MODEL_PROXY_TOKEN_FILE,
  );
  const executable = input.executable ??
    "/opt/codeops-agent/node_modules/.bin/codex-acp";
  const child = (input.spawn ?? spawn)(executable, [], {
    stdio: "inherit",
    env: {
      ...process.env,
      CODEX_API_KEY: token,
    },
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`codex-acp stopped by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runAcpConnection();
}
