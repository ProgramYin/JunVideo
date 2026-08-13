import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { config } from "./config.js";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  application_name: "junvideo-api",
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error", error);
});

export type DbExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export function query<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<Row>> {
  return pool.query<Row>(text, values as unknown[] | undefined);
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("PostgreSQL rollback failed", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDatabase(): Promise<{ ok: true; latencyMs: number } | { ok: false; message: string }> {
  const startedAt = Date.now();
  try {
    await pool.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    console.error("JunVideo database health check failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
      message: error instanceof Error ? error.message : "Database connection failed.",
    });
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Database connection failed.",
    };
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
