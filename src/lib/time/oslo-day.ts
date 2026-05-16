// Returns the ISO timestamp (UTC) corresponding to 00:00 Europe/Oslo of
// the day that `now` falls into in Oslo. Handles both CET (+01:00) and
// CEST (+02:00) automatically, including DST transition days.

const TZ = "Europe/Oslo";

function osloParts(d: Date): { y: number; m: number; day: number; h: number; min: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    day: Number(parts.day),
    h: Number(parts.hour === "24" ? "0" : parts.hour),
    min: Number(parts.minute),
  };
}

export function osloDayStartISO(now: Date = new Date()): string {
  const { y, m, day } = osloParts(now);
  // First guess: treat Oslo 00:00 as if it were UTC, then correct by the
  // offset implied by that guess.
  const guess = Date.UTC(y, m - 1, day, 0, 0, 0, 0);
  const guessParts = osloParts(new Date(guess));
  const offsetMinutes =
    (guessParts.h * 60 + guessParts.min) -
    0 + // target is 00:00 Oslo
    ((guessParts.y !== y || guessParts.m !== m || guessParts.day !== day) ? 24 * 60 : 0);
  // The "guess" UTC instant, when viewed in Oslo, shows offsetMinutes past
  // 00:00. So real 00:00 Oslo (in UTC) is guess - offsetMinutes.
  const startUtc = guess - offsetMinutes * 60_000;
  return new Date(startUtc).toISOString();
}
