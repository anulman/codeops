import { runtimeExecutionResultSchema } from "./transport.js";
import type {
  RuntimeExecutionReceipt,
  RuntimeExecutionReceiptStore,
  RuntimeExecutionReservation,
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

function storedReceipt(row: ReceiptRow): RuntimeExecutionReservation {
  if (
    typeof row.dispatch_id !== "string" ||
    typeof row.dispatch_digest !== "string"
  ) {
    throw new Error("runtime execution receipt persistence returned invalid identity");
  }
  return {
    dispatchId: row.dispatch_id,
    dispatchDigest: row.dispatch_digest,
    result:
      row.result_json === null
        ? null
        : runtimeExecutionResultSchema.parse(row.result_json),
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

  async read(dispatchId: string): Promise<RuntimeExecutionReservation | null> {
    const result = await this.#database.query<ReceiptRow>(
      `SELECT dispatch_id::text AS dispatch_id, dispatch_digest, result_json
         FROM codeops.session_runtime_execution_receipts
        WHERE dispatch_id = $1::uuid`,
      [dispatchId],
    );
    return result.rows[0] ? storedReceipt(result.rows[0]) : null;
  }

  async reserve(input: {
    readonly dispatchId: string;
    readonly dispatchDigest: string;
  }): Promise<{
    readonly acquired: boolean;
    readonly reservation: RuntimeExecutionReservation;
  }> {
    const inserted = await this.#database.query<ReceiptRow>(
      `INSERT INTO codeops.session_runtime_execution_receipts
         (dispatch_id, dispatch_digest, status)
       VALUES ($1::uuid, $2, 'started')
       ON CONFLICT (dispatch_id) DO NOTHING
       RETURNING dispatch_id::text AS dispatch_id, dispatch_digest, result_json`,
      [input.dispatchId, input.dispatchDigest],
    );
    if (inserted.rows[0]) {
      return { acquired: true, reservation: storedReceipt(inserted.rows[0]) };
    }
    const stored = await this.read(input.dispatchId);
    if (stored === null) {
      throw new Error("runtime execution reservation was not visible after conflict");
    }
    return { acquired: false, reservation: stored };
  }

  async complete(
    receipt: RuntimeExecutionReceipt,
  ): Promise<RuntimeExecutionReceipt> {
    const result = await this.#database.query<ReceiptRow>(
      `UPDATE codeops.session_runtime_execution_receipts
          SET status = 'completed',
              result_json = $3::jsonb,
              completed_at = clock_timestamp()
        WHERE dispatch_id = $1::uuid
          AND dispatch_digest = $2
          AND status = 'started'
       RETURNING dispatch_id::text AS dispatch_id, dispatch_digest, result_json`,
      [
        receipt.dispatchId,
        receipt.dispatchDigest,
        JSON.stringify(runtimeExecutionResultSchema.parse(receipt.result)),
      ],
    );
    const stored = result.rows[0]
      ? storedReceipt(result.rows[0])
      : await this.read(receipt.dispatchId);
    if (stored === null || stored.result === null) {
      throw new Error("runtime execution receipt was not completed from its reservation");
    }
    return {
      dispatchId: stored.dispatchId,
      dispatchDigest: stored.dispatchDigest,
      result: stored.result,
    };
  }
}
