import "dotenv/config";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(scriptDirectory, "..", "database", "schema.sql");
const connectionString = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/junvideo";
const schema = await readFile(schemaPath, "utf8");
const client = new Client({ connectionString });

try {
  await client.connect();
  await client.query(schema);
  // Existing installations created before raw pasted text was retained have
  // a source_url HTTP(S) check. Keep the original input in that column while
  // canonical_url remains the validated URL used by the parser.
  await client.query(`
    ALTER TABLE parse_jobs DROP CONSTRAINT IF EXISTS parse_jobs_source_url_http;
    ALTER TABLE parse_jobs DROP CONSTRAINT IF EXISTS parse_jobs_source_url_present;
    ALTER TABLE parse_jobs ADD CONSTRAINT parse_jobs_source_url_present CHECK (char_length(btrim(source_url)) > 0);
  `);
  console.log(`JunVideo database schema applied from ${schemaPath}`);
} catch (error) {
  console.error("Unable to initialize the JunVideo database.", error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
