import { createHash } from "node:crypto";

const canonicalJsonEncoder = new TextEncoder();

function serialize(value: unknown, ancestors: Set<object>): string {
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new TypeError("value is not representable as canonical JSON");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (ancestors.has(value)) {
    throw new TypeError("value is not representable as canonical JSON");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("value is not representable as canonical JSON");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("value is not representable as canonical JSON");
        }
      }
      return `[${value.map((entry) => serialize(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("value is not representable as canonical JSON");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJsonText(value: unknown): string {
  return serialize(value, new Set());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return canonicalJsonEncoder.encode(canonicalJsonText(value));
}

export function sha256CanonicalJsonDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonBytes(value))
    .digest("hex")}`;
}

/** @deprecated Use canonicalJsonText instead. */
export const canonicalSerialize = canonicalJsonText;
