import { timingSafeEqual } from "node:crypto";

export function authenticateBearer(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const received = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return (
    received.length === expected.length &&
    received.length > 0 &&
    timingSafeEqual(received, expected)
  );
}
