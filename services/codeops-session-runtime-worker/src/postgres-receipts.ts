import { runtimeExecutionResultSchema } from "./transport.js";
import type {
  RuntimeExecutionReceipt,
  RuntimeExecutionReceiptStore,
} from "./lifecycle.js";

interface ReceiptRow extends Record<string, unknown> {
  readonly dispatch_id: unknown;
  readonly dispatch_digest: unknown;
  readonly result_json: unknown;
}

export interface RuntimeReceiptQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
}

function storedReceipt(row: ReceiptRow): RuntimeExecutionReceipt {
  if (
    typeof row.dispatch_id !== "string" ||
    typeof row.dispatch_digest !== "string"
  ) {
    throw new Error("runtime execution receipt persistence returned invalid identity");
  }
  return {
    dispatchId: row.dispatch_id,
    dispatchDigest: row.dispatch_digest,
    result: runtimeExecutionResultSchema.parse(row.result_json),
  };
}

/**
 * PostgreSQL-backed compare-and-create storage for immutable execution results.
 * The database primary key is the serialization point: after a conflicting
 * insert finishes, the following read observes and returns the winner.
 */
export class PostgresRuntimeExecutionReceiptStore
  implements RuntimeExecutionReceiptStore
{
  readonly #database: RuntimeReceiptQueryClient;

  constructor(database: RuntimeReceiptQueryClient) {
    this.#database = database;
  }

  async read(dispatchId: string): Promise<RuntimeExecutionReceipt | null> {
    const result = await this.#database.query<ReceiptRow>(
      `SELECT dispatch_id::text AS dispatch_id, dispatch_digest, result_json
         FROM codeops.session_runtime_execution_receipts
        WHERE dispatch_id = $1::uuid`,
      [dispatchId],
    );
    return result.rows[0] ? storedReceipt(result.rows[0]) : null;
  }

  async create(
    receipt: RuntimeExecutionReceipt,
  ): Promise<RuntimeExecutionReceipt> {
    await this.#database.query(
      `INSERT INTO codeops.session_runtime_execution_receipts
         (dispatch_id, dispatch_digest, result_json)
       VALUES ($1::uuid, $2, $3::jsonb)
       ON CONFLICT (dispatch_id) DO NOTHING`,
      [
        receipt.dispatchId,
        receipt.dispatchDigest,
        JSON.stringify(runtimeExecutionResultSchema.parse(receipt.result)),
      ],
    );
    const stored = await this.read(receipt.dispatchId);
    if (stored === null) {
      throw new Error("runtime execution receipt was not visible after create");
    }
    return stored;
  }
}
