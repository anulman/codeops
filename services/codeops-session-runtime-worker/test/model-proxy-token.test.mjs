import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  publishModelProxyToken,
  verifyPublishedModelProxyToken,
} from "../dist/model-proxy-token.js";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codeops-model-token-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return {
    directory,
    tokenPath: path.join(directory, "model-proxy-token"),
  };
}

async function assertMissing(filePath) {
  await assert.rejects(lstat(filePath), { code: "ENOENT" });
}

test("publishes the complete model proxy token atomically as mode 0600", async (t) => {
  const { tokenPath } = await fixture(t);
  const token = "v1.complete-token.signature";

  await publishModelProxyToken(tokenPath, token);

  assert.equal(await readFile(tokenPath, "utf8"), token);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(path.dirname(tokenPath)), ["model-proxy-token"]);
});

test("rejects an empty token without creating either publication path", async (t) => {
  const { tokenPath } = await fixture(t);

  await assert.rejects(
    publishModelProxyToken(tokenPath, ""),
    /model proxy token is empty/,
  );

  await assertMissing(tokenPath);
  await assertMissing(`${tokenPath}.tmp`);
});

test("restart rotation ignores a stale legacy temporary file", async (t) => {
  const { tokenPath } = await fixture(t);
  await writeFile(`${tokenPath}.tmp`, "partial", { mode: 0o600 });

  await publishModelProxyToken(tokenPath, "complete-token");

  assert.equal(await readFile(tokenPath, "utf8"), "complete-token");
  assert.equal(await readFile(`${tokenPath}.tmp`, "utf8"), "partial");
});

test("restart rotation ignores a stale symlink without changing its target", async (t) => {
  const { directory, tokenPath } = await fixture(t);
  const target = path.join(directory, "target");
  await writeFile(target, "unchanged", { mode: 0o600 });
  await symlink(target, `${tokenPath}.tmp`);

  await publishModelProxyToken(tokenPath, "complete-token");

  assert.equal(await readFile(target, "utf8"), "unchanged");
  assert.equal(await readFile(tokenPath, "utf8"), "complete-token");
  assert.equal((await lstat(`${tokenPath}.tmp`)).isSymbolicLink(), true);
});

test("rejects every invalid final token representation", async (t) => {
  const { directory, tokenPath } = await fixture(t);
  const expected = Buffer.from("complete-token");

  await writeFile(tokenPath, expected, { mode: 0o600 });
  await chmod(tokenPath, 0o644);
  await assert.rejects(
    verifyPublishedModelProxyToken(tokenPath, expected),
    /mode 0600 regular file/,
  );

  await writeFile(tokenPath, "", { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  await assert.rejects(
    verifyPublishedModelProxyToken(tokenPath, expected),
    /published model proxy token is empty/,
  );

  await writeFile(tokenPath, "complete-taken", { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  await assert.rejects(
    verifyPublishedModelProxyToken(tokenPath, expected),
    /content differs from the issued token/,
  );

  await rm(tokenPath);
  const target = path.join(directory, "symlink-target");
  await writeFile(target, expected, { mode: 0o600 });
  await symlink(target, tokenPath);
  await assert.rejects(
    verifyPublishedModelProxyToken(tokenPath, expected),
    (error) => error?.code === "ELOOP",
  );
  assert.equal(await readFile(target, "utf8"), expected.toString("utf8"));

  await rm(tokenPath);
  await mkdir(tokenPath, { mode: 0o600 });
  await assert.rejects(
    verifyPublishedModelProxyToken(tokenPath, expected),
    /mode 0600 regular file/,
  );
});

test("uses the required exclusive and no-follow filesystem flags", () => {
  assert.equal(typeof constants.O_EXCL, "number");
  assert.equal(typeof constants.O_NOFOLLOW, "number");
});
