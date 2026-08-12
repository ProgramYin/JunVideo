import { config } from "./config.js";
import type { DbExecutor } from "./db.js";

export interface UsageSnapshot {
  usageDate: string;
  isVip: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
}

export interface ReservationResult {
  accepted: boolean;
  usageDate: string;
  used: number;
  limit: number | null;
}

export function localDateKey(date = new Date(), timeZone = config.localTimeZone): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error(`Unable to format local date for time zone ${timeZone}.`);
  }
  return `${year}-${month}-${day}`;
}

export async function reserveParseAttempt(
  executor: DbExecutor,
  options: { userId: string; isVip: boolean; now?: Date; timeZone?: string; limit?: number },
): Promise<ReservationResult> {
  const usageDate = localDateKey(options.now, options.timeZone ?? config.localTimeZone);
  if (options.isVip) {
    return { accepted: true, usageDate, used: 0, limit: null };
  }

  const limit = options.limit ?? config.dailyParseLimit;
  await executor.query(
    `INSERT INTO usage_daily (user_id, usage_date, accepted_count)
     VALUES ($1, $2, 0)
     ON CONFLICT (user_id, usage_date) DO NOTHING`,
    [options.userId, usageDate],
  );

  const updated = await executor.query<{ accepted_count: number }>(
    `UPDATE usage_daily
        SET accepted_count = accepted_count + 1,
            updated_at = NOW()
      WHERE user_id = $1
        AND usage_date = $2
        AND accepted_count < $3
      RETURNING accepted_count`,
    [options.userId, usageDate, limit],
  );

  if (updated.rows[0]) {
    return {
      accepted: true,
      usageDate,
      used: Number(updated.rows[0].accepted_count),
      limit,
    };
  }

  const current = await executor.query<{ accepted_count: number }>(
    `SELECT accepted_count
       FROM usage_daily
      WHERE user_id = $1 AND usage_date = $2`,
    [options.userId, usageDate],
  );
  return {
    accepted: false,
    usageDate,
    used: Number(current.rows[0]?.accepted_count ?? limit),
    limit,
  };
}

export async function getUsageSnapshot(
  executor: DbExecutor,
  options: { userId: string; isVip: boolean; now?: Date; timeZone?: string; limit?: number },
): Promise<UsageSnapshot> {
  const usageDate = localDateKey(options.now, options.timeZone ?? config.localTimeZone);
  if (options.isVip) {
    return { usageDate, isVip: true, limit: null, used: 0, remaining: null };
  }

  const limit = options.limit ?? config.dailyParseLimit;
  const result = await executor.query<{ accepted_count: number }>(
    `SELECT accepted_count
       FROM usage_daily
      WHERE user_id = $1 AND usage_date = $2`,
    [options.userId, usageDate],
  );
  const used = Number(result.rows[0]?.accepted_count ?? 0);
  return { usageDate, isVip: false, limit, used, remaining: Math.max(0, limit - used) };
}

