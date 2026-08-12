import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor } from "./db.js";
import { localDateKey, getUsageSnapshot, reserveParseAttempt } from "./usage.js";

test("local quota date follows the configured timezone", () => {
  const beforeMidnightUtc = new Date("2026-08-10T15:59:59.000Z");
  const afterMidnightUtc = new Date("2026-08-10T16:00:00.000Z");
  assert.equal(localDateKey(beforeMidnightUtc, "Asia/Shanghai"), "2026-08-10");
  assert.equal(localDateKey(afterMidnightUtc, "Asia/Shanghai"), "2026-08-11");
});

test("the quota reservation accepts ten attempts and rejects the eleventh", async () => {
  let acceptedCount = 0;
  const executor = {
    async query<T extends { accepted_count?: number }>(sql: string) {
      if (sql.includes("UPDATE usage_daily")) {
        if (acceptedCount < 10) {
          acceptedCount += 1;
          return { rows: [{ accepted_count: acceptedCount }] } as { rows: T[] };
        }
        return { rows: [] } as { rows: T[] };
      }
      if (sql.includes("SELECT accepted_count")) {
        return { rows: [{ accepted_count: acceptedCount }] } as { rows: T[] };
      }
      return { rows: [] } as { rows: T[] };
    },
  } as unknown as DbExecutor;

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const reservation = await reserveParseAttempt(executor, {
      userId: "00000000-0000-0000-0000-000000000001",
      isVip: false,
      now: new Date("2026-08-10T03:00:00.000Z"),
      limit: 10,
    });
    assert.equal(reservation.accepted, true);
    assert.equal(reservation.used, attempt);
  }

  const rejected = await reserveParseAttempt(executor, {
    userId: "00000000-0000-0000-0000-000000000001",
    isVip: false,
    now: new Date("2026-08-10T03:00:00.000Z"),
    limit: 10,
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.used, 10);

  const snapshot = await getUsageSnapshot(executor, {
    userId: "00000000-0000-0000-0000-000000000001",
    isVip: false,
    now: new Date("2026-08-10T03:00:00.000Z"),
    limit: 10,
  });
  assert.deepEqual(snapshot, { usageDate: "2026-08-10", isVip: false, limit: 10, used: 10, remaining: 0 });
});
