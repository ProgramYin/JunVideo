import { app } from "./app.js";
import { closeDatabase } from "./db.js";
import { config } from "./config.js";

const server = app.listen(config.port, () => {
  console.log(`JunVideo API listening on http://localhost:${config.port}`);
  console.log(`Parser mode: ${config.parserMode}; local quota: ${config.dailyParseLimit} accepted attempts/day`);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down JunVideo API.`);
  server.close(async (error) => {
    if (error) {
      console.error("HTTP server shutdown failed", error);
      process.exitCode = 1;
    }
    try {
      await closeDatabase();
    } catch (databaseError) {
      console.error("Database pool shutdown failed", databaseError);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

