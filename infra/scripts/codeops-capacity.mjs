const CPU_UNITS = new Map([
  ["n", 1 / 1_000_000],
  ["u", 1 / 1_000],
  ["m", 1],
  ["", 1_000],
]);

const MEMORY_UNITS = new Map([
  ["", 1],
  ["Ki", 2 ** 10],
  ["Mi", 2 ** 20],
  ["Gi", 2 ** 30],
  ["Ti", 2 ** 40],
  ["k", 1_000],
  ["M", 1_000_000],
  ["G", 1_000_000_000],
  ["T", 1_000_000_000_000],
]);

function parseQuantity(value, units, kind) {
  const match = /^([0-9]+(?:\.[0-9]+)?)([A-Za-z]*)$/.exec(value);
  if (!match || !units.has(match[2])) {
    throw new Error(`invalid Kubernetes ${kind} quantity: ${value}`);
  }
  return Number(match[1]) * units.get(match[2]);
}

export function parseCpuMillis(value) {
  return parseQuantity(value, CPU_UNITS, "CPU");
}

export function parseMemoryBytes(value) {
  return parseQuantity(value, MEMORY_UNITS, "memory");
}

function condition(node, type) {
  return node.status?.conditions?.find((value) => value.type === type)?.status;
}

export function evaluateCodeOpsCapacity(
  snapshot,
  { requiredCpuMillis = 2_500, requiredMemoryBytes = 8 * 2 ** 30 } = {},
) {
  const { node, metrics } = snapshot;
  const reasons = [];

  if (!Number.isFinite(requiredCpuMillis) || requiredCpuMillis <= 0) {
    reasons.push("required CPU must be a positive finite number");
  }
  if (!Number.isFinite(requiredMemoryBytes) || requiredMemoryBytes <= 0) {
    reasons.push("required memory must be a positive finite number");
  }
  if (node.metadata?.labels?.["codeops.example/codeops"] !== "true") {
    reasons.push("node is missing codeops.example/codeops=true");
  }
  if (condition(node, "Ready") !== "True") reasons.push("node is not Ready");
  for (const type of ["MemoryPressure", "DiskPressure", "PIDPressure"]) {
    if (condition(node, type) !== "False") reasons.push(`${type} is not False`);
  }

  let allocatableCpuMillis = 0;
  let usedCpuMillis = 0;
  let allocatableMemoryBytes = 0;
  let usedMemoryBytes = 0;
  try {
    allocatableCpuMillis = parseCpuMillis(node.status?.allocatable?.cpu);
    usedCpuMillis = parseCpuMillis(metrics?.usage?.cpu);
    allocatableMemoryBytes = parseMemoryBytes(node.status?.allocatable?.memory);
    usedMemoryBytes = parseMemoryBytes(metrics?.usage?.memory);
  } catch (error) {
    reasons.push(error.message);
  }

  const availableCpuMillis = allocatableCpuMillis - usedCpuMillis;
  const availableMemoryBytes = allocatableMemoryBytes - usedMemoryBytes;
  if (availableCpuMillis < requiredCpuMillis) {
    reasons.push(`available CPU ${availableCpuMillis}m is below ${requiredCpuMillis}m`);
  }
  if (availableMemoryBytes < requiredMemoryBytes) {
    reasons.push(
      `available memory ${availableMemoryBytes} bytes is below ${requiredMemoryBytes} bytes`,
    );
  }

  return {
    ok: reasons.length === 0,
    node: node.metadata?.name ?? null,
    requiredCpuMillis,
    requiredMemoryBytes,
    allocatableCpuMillis,
    usedCpuMillis,
    availableCpuMillis,
    allocatableMemoryBytes,
    usedMemoryBytes,
    availableMemoryBytes,
    reasons,
  };
}
