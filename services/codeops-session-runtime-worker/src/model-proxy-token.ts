import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  open,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

async function readExact(handle: FileHandle, length: number): Promise<Buffer> {
  const contents = Buffer.alloc(length);
  let offset = 0;
  while (offset < contents.length) {
    const { bytesRead } = await handle.read(
      contents,
      offset,
      contents.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return contents.subarray(0, offset);
}

async function verifyTokenHandle(
  handle: FileHandle,
  expected: Buffer,
  description: string,
): Promise<void> {
  const stats = await handle.stat();
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
    throw new Error(`${description} must be one mode 0600 regular file`);
  }
  if (stats.size === 0) {
    throw new Error(`${description} is empty`);
  }
  if (stats.size !== expected.byteLength) {
    throw new Error(`${description} content differs from the issued token`);
  }
  const contents = await readExact(handle, expected.byteLength);
  if (!contents.equals(expected)) {
    throw new Error(`${description} content differs from the issued token`);
  }
}

export async function verifyPublishedModelProxyToken(
  tokenPath: string,
  expected: Buffer,
): Promise<void> {
  const handle = await open(
    tokenPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await verifyTokenHandle(handle, expected, "published model proxy token");
  } finally {
    await handle.close();
  }
}

export async function publishModelProxyToken(
  tokenPath: string,
  token: string,
): Promise<void> {
  const expected = Buffer.from(token, "utf8");
  if (expected.byteLength === 0) {
    throw new Error("model proxy token is empty");
  }

  const temporaryPath = `${tokenPath}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  let published = false;
  try {
    const temporary = await open(
      temporaryPath,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    try {
      await temporary.chmod(0o600);
      await temporary.writeFile(expected);
      await verifyTokenHandle(
        temporary,
        expected,
        "temporary model proxy token",
      );
      await temporary.sync();
    } finally {
      await temporary.close();
    }

    await rename(temporaryPath, tokenPath);
    temporaryCreated = false;
    published = true;
    await verifyPublishedModelProxyToken(tokenPath, expected);

    const directory = await open(
      path.dirname(tokenPath),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (published) await rm(tokenPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    if (temporaryCreated) {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}
