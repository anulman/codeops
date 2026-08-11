import { execFileSync } from "node:child_process";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofGatewayReadinessEvidence,
  verifySessionProofGatewayApplyChain,
} from "./codeops-session-proof-gateway-readiness-evidence.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import {
  completeSessionProofStep,
  verifySessionProofStepAuthorization,
} from "./codeops-session-proof-step-receipts.mjs";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_ATTEMPTS = 120;
const MAX_INTERVAL_MS = 10_000;
const MAX_WAIT_MS = 2 * 60 * 1000;
const EXPECTED_CHECK_DEFINITIONS = new Map([
  ["(dispatch_digest ~ '^sha256:[0-9a-f]{64}$'::text)", "dispatch-digest-sha256"],
  ["(status = ANY (ARRAY['started'::text, 'completed'::text]))", "status-enum"],
  ["(((status = 'started'::text) AND (result_json IS NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (result_json IS NOT NULL) AND (completed_at IS NOT NULL) AND (completed_at >= created_at)))", "receipt-state-shape"],
  ["((result_json IS NULL) OR ((jsonb_typeof(result_json) = 'object'::text) AND (result_json ? 'type'::text) AND ((result_json ->> 'type'::text) = ANY (ARRAY['prompt'::text, 'checkpoint'::text, 'hibernate'::text, 'resume'::text, 'fork'::text]))))", "result-type-lifecycle"],
]);
const MIGRATION_METADATA_SQL = String.raw`
WITH relation AS (
  SELECT class.oid
    FROM pg_catalog.pg_class AS class
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
   WHERE namespace.nspname = 'codeops'
     AND class.relname = 'session_runtime_execution_receipts'
     AND class.relkind = 'r'
), columns AS (
  SELECT jsonb_agg(jsonb_build_object(
           'name', attribute.attname,
           'dataType', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
           'nullable', NOT attribute.attnotnull
         ) ORDER BY attribute.attnum) AS value
    FROM relation
    JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
   WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
), primary_key AS (
  SELECT jsonb_agg(attribute.attname ORDER BY key.ordinality) AS value
    FROM relation
    JOIN pg_catalog.pg_constraint AS con ON con.conrelid = relation.oid AND con.contype = 'p'
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true
    JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid AND attribute.attnum = key.attnum
), foreign_keys AS (
  SELECT jsonb_agg(value ORDER BY value::text) AS value
    FROM (
      SELECT jsonb_build_object(
        'columns', jsonb_agg(source_attribute.attname ORDER BY source_key.ordinality),
        'referencedSchema', referenced_namespace.nspname,
        'referencedTable', referenced_class.relname,
        'referencedColumns', jsonb_agg(referenced_attribute.attname ORDER BY source_key.ordinality)
      ) AS value
      FROM relation
      JOIN pg_catalog.pg_constraint AS con ON con.conrelid = relation.oid AND con.contype = 'f'
      JOIN pg_catalog.pg_class AS referenced_class ON referenced_class.oid = con.confrelid
      JOIN pg_catalog.pg_namespace AS referenced_namespace ON referenced_namespace.oid = referenced_class.relnamespace
      JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS source_key(attnum, ordinality) ON true
      JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS referenced_key(attnum, ordinality) ON referenced_key.ordinality = source_key.ordinality
      JOIN pg_catalog.pg_attribute AS source_attribute ON source_attribute.attrelid = relation.oid AND source_attribute.attnum = source_key.attnum
      JOIN pg_catalog.pg_attribute AS referenced_attribute ON referenced_attribute.attrelid = con.confrelid AND referenced_attribute.attnum = referenced_key.attnum
      GROUP BY con.oid, referenced_namespace.nspname, referenced_class.relname
    ) AS foreign_key_values
), checks AS (
  SELECT jsonb_agg(pg_catalog.pg_get_expr(con.conbin, con.conrelid) ORDER BY pg_catalog.pg_get_expr(con.conbin, con.conrelid)) AS value
    FROM relation
    JOIN pg_catalog.pg_constraint AS con ON con.conrelid = relation.oid AND con.contype = 'c'
)
SELECT jsonb_build_object(
  'schema', 'codeops',
  'name', 'session_runtime_execution_receipts',
  'oid', relation.oid::bigint,
  'columns', columns.value,
  'primaryKey', primary_key.value,
  'foreignKeys', foreign_keys.value,
  'checkDefinitions', checks.value
)
FROM relation, columns, primary_key, foreign_keys, checks;
`.trim();

function run(args, runner) {
  return runner("kubectl", args, { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, timeout: 20_000 });
}

function parseJson(source, label) {
  try { return JSON.parse(source); } catch { throw new Error(`${label} returned invalid JSON`); }
}

function sameKeys(value, keys) {
  return JSON.stringify(Object.keys(value ?? {}).sort()) === JSON.stringify([...keys].sort());
}

function readAndVerifyLiveIdentity(authorization, observedAt, runner) {
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(authorization.namespace.name, runner);
  verifySessionProofOperation(authorization.admission, {
    stepId: authorization.stepId, namespaceResource, operator, target, observedAt,
  });
  return { namespaceResource, operator, target };
}

function verifyExecutionBoundary(authorization, input) {
  if (
    !RFC3339.test(input.startedAt ?? "") || !RFC3339.test(input.completedAt ?? "") ||
    Date.parse(input.startedAt) < Date.parse(authorization.authorizedAt) ||
    Date.parse(input.completedAt) < Date.parse(input.startedAt) ||
    !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > MAX_ATTEMPTS ||
    !Number.isInteger(input.pollIntervalMs) || input.pollIntervalMs < 0 || input.pollIntervalMs > MAX_INTERVAL_MS ||
    (input.maxAttempts - 1) * input.pollIntervalMs > MAX_WAIT_MS
  ) throw new Error("proof gateway migration polling boundary drifted");
}

function readDeployment(authorization, appliedDeploymentUid, runner) {
  const deployment = parseJson(run([
    "-n", authorization.namespace.name, "get", "deployment.apps", "codeops-control-gateway",
    "-o", "json", "--request-timeout=15s",
  ], runner), "proof gateway Deployment");
  if (
    deployment?.apiVersion !== "apps/v1" || deployment.kind !== "Deployment" ||
    deployment.metadata?.name !== "codeops-control-gateway" ||
    deployment.metadata?.namespace !== authorization.namespace.name ||
    deployment.metadata?.uid !== appliedDeploymentUid || deployment.metadata?.generation !== 1
  ) throw new Error("proof gateway live Deployment identity drifted");
  return deployment;
}

function normalizeMigrationRelation(raw) {
  if (!sameKeys(raw, ["schema", "name", "oid", "columns", "primaryKey", "foreignKeys", "checkDefinitions"]) ||
      !Array.isArray(raw.columns) || !Array.isArray(raw.primaryKey) || !Array.isArray(raw.foreignKeys) ||
      !Array.isArray(raw.checkDefinitions) || raw.checkDefinitions.length !== EXPECTED_CHECK_DEFINITIONS.size ||
      raw.columns.some((column) => !sameKeys(column, ["name", "dataType", "nullable"])) ||
      raw.foreignKeys.some((key) => !sameKeys(key, ["columns", "referencedSchema", "referencedTable", "referencedColumns"]))) {
    throw new Error("proof gateway migration catalog drifted");
  }
  const checkConstraints = raw.checkDefinitions.map((definition) => EXPECTED_CHECK_DEFINITIONS.get(definition));
  if (checkConstraints.some((value) => !value) || new Set(checkConstraints).size !== EXPECTED_CHECK_DEFINITIONS.size) {
    throw new Error("proof gateway migration check semantics drifted");
  }
  return {
    schema: raw.schema, name: raw.name, oid: raw.oid,
    columns: raw.columns.map((column) => ({
      name: column.name, dataType: column.dataType, nullable: column.nullable,
    })),
    primaryKey: [...raw.primaryKey],
    foreignKeys: raw.foreignKeys.map((key) => ({
      columns: [...key.columns], referencedSchema: key.referencedSchema,
      referencedTable: key.referencedTable, referencedColumns: [...key.referencedColumns],
    })),
    checkConstraints: checkConstraints.sort(),
  };
}

function readMigrationRelation(authorization, runner) {
  const source = run([
    "-n", authorization.namespace.name, "exec", "deployment.apps/codeops-session-proof-database",
    "-c", "postgres", "--", "psql", "-X", "--no-psqlrc", "--quiet", "--tuples-only", "--no-align",
    "--set=ON_ERROR_STOP=1", "--username=codeops_session_broker_owner",
    "--dbname=codeops_session_proof", "--command", MIGRATION_METADATA_SQL,
  ], runner).trim();
  if (!source) throw new Error("proof gateway migration relation is absent");
  return normalizeMigrationRelation(parseJson(source, "proof gateway migration catalog"));
}

function defaultWait(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function buildEvidence(input, deployment, migrationRelation) {
  return buildSessionProofGatewayReadinessEvidence({
    authorization: input.authorization,
    gatewayApplyReceiptSource: input.gatewayApplyReceiptSource,
    gatewayApplyEvidenceSource: input.gatewayApplyEvidenceSource,
    deployment, migrationRelation, observedAt: input.completedAt,
  });
}

export function waitForSessionProofGatewayMigration(input, runner = execFileSync, wait = defaultWait) {
  const authorization = input.authorization;
  verifySessionProofStepAuthorization(authorization);
  if (authorization.stepId !== "wait-gateway-migration" || authorization.action !== "operator-wait-ready" || authorization.artifact !== null) {
    throw new Error("proof step is not the exact gateway migration readiness action");
  }
  verifyExecutionBoundary(authorization, input);
  const appliedDeploymentUid = verifySessionProofGatewayApplyChain(
    authorization, input.gatewayApplyReceiptSource ?? "", input.gatewayApplyEvidenceSource ?? "",
  );

  readAndVerifyLiveIdentity(authorization, input.startedAt, runner);
  let ready = null;
  for (let attempt = 0; attempt < input.maxAttempts; attempt += 1) {
    const deployment = readDeployment(authorization, appliedDeploymentUid, runner);
    try {
      const migrationRelation = readMigrationRelation(authorization, runner);
      buildEvidence(input, deployment, migrationRelation);
      ready = { deployment, migrationRelation };
      break;
    } catch (error) {
      if (!/(readiness deployment drifted|migration relation is absent)/.test(String(error?.message))) throw error;
    }
    if (attempt + 1 < input.maxAttempts) wait(input.pollIntervalMs);
  }
  if (!ready) throw new Error("proof gateway migration did not become ready within the reviewed polling boundary");

  const live = readAndVerifyLiveIdentity(authorization, input.completedAt, runner);
  const finalDeployment = readDeployment(authorization, appliedDeploymentUid, runner);
  const finalMigrationRelation = readMigrationRelation(authorization, runner);
  const evidenceSource = JSON.stringify(buildEvidence(input, finalDeployment, finalMigrationRelation));
  const receipt = completeSessionProofStep(authorization, { ...live, completedAt: input.completedAt, evidenceSource });
  return { evidenceSource, receipt };
}
