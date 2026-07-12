// ── Memory date formatting ───────────────────────────────────────────────────
// A collection's "memory date" is stored as a plain ISO date string
// (YYYY-MM-DD, no time component — it's a day, not a moment) in the
// `collections` table. Everything here is pure date-math for turning that
// into something worth looking at: a full readable date, a friendly
// "X years ago"-style relative label, and a flag for the one flourish that
// makes this genuinely delightful — recognizing when today happens to be
// the anniversary of the memory.

export type MemoryDateInfo = {
  iso: string;
  /** e.g. "July 15, 2019" */
  full: string;
  /** e.g. "5 years ago", "3 months ago", "Yesterday", "Today" */
  relative: string;
  /** True only when today is the same month+day, and it's a real anniversary (1+ years on) */
  isAnniversaryToday: boolean;
};

// Accepts the loose "YYYY-MM-DD" shape Postgres `date` columns come back
// as over the wire. Constructing with explicit Y/M/D (rather than handing
// the raw string to `new Date()`) sidesteps the classic "date parses as
// UTC midnight, then renders as the previous day in a negative-UTC-offset
// timezone" bug.
function parseIsoDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return isNaN(date.getTime()) ? null : date;
}

export function getMemoryDateInfo(
  memoryDate: string | null | undefined,
): MemoryDateInfo | null {
  if (!memoryDate) return null;
  const target = parseIsoDate(memoryDate);
  if (!target) return null;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((today.getTime() - target.getTime()) / msPerDay);

  const full = target.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  let relative: string;
  if (diffDays === 0) {
    relative = "Today";
  } else if (diffDays < 0) {
    const daysAhead = Math.abs(diffDays);
    relative =
      daysAhead === 1 ? "Tomorrow" : `In ${daysAhead.toLocaleString()} days`;
  } else if (diffDays === 1) {
    relative = "Yesterday";
  } else if (diffDays < 31) {
    relative = `${diffDays} days ago`;
  } else {
    // Whole years, accounting for whether this year's anniversary has
    // happened yet — a naive `now.getFullYear() - target.getFullYear()`
    // overcounts by one for any date whose month/day hasn't occurred yet
    // this year.
    let years = today.getFullYear() - target.getFullYear();
    let months = today.getMonth() - target.getMonth();
    if (today.getDate() < target.getDate()) months -= 1;
    if (months < 0) {
      years -= 1;
      months += 12;
    }

    if (years >= 1) {
      relative = years === 1 ? "1 year ago" : `${years} years ago`;
    } else {
      relative = months <= 1 ? "1 month ago" : `${months} months ago`;
    }
  }

  const isAnniversaryToday =
    diffDays > 0 &&
    today.getMonth() === target.getMonth() &&
    today.getDate() === target.getDate();

  return { iso: memoryDate, full, relative, isAnniversaryToday };
}

// ── Validation for the day/month/year entry fields ───────────────────────────
// Used by the plain TextInput trio in the "set a memory date" UI — kept
// dependency-free (no native date-picker module) so it works identically
// on web, iOS, and Android without a native rebuild.
//
// Three distinct outcomes, since "all fields blank" is a valid choice
// (the date is optional) rather than a validation failure:
//   - { status: "empty" }        — nothing entered, treat as "no date"
//   - { status: "error", ... }   — something entered, but not a real date
//   - { status: "ok", iso }      — a complete, valid date
export type DatePartsResult =
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ok"; iso: string };

export function buildIsoDateFromParts(
  day: string,
  month: string,
  year: string,
): DatePartsResult {
  if (!day.trim() && !month.trim() && !year.trim()) {
    return { status: "empty" };
  }

  const d = parseInt(day, 10);
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);

  if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y)) {
    return { status: "error", message: "Please fill in day, month, and year." };
  }
  if (y < 1900 || y > 2100) {
    return {
      status: "error",
      message: "Please enter a year between 1900 and 2100.",
    };
  }
  if (m < 1 || m > 12) {
    return { status: "error", message: "Month must be between 1 and 12." };
  }

  const daysInMonth = new Date(y, m, 0).getDate();
  if (d < 1 || d > daysInMonth) {
    return {
      status: "error",
      message: `That month only has ${daysInMonth} days.`,
    };
  }

  const iso = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d
    .toString()
    .padStart(2, "0")}`;
  return { status: "ok", iso };
}

// Splits an ISO date back into day/month/year strings for pre-filling the
// edit fields when a memory date is already set.
export function splitIsoDateToParts(iso: string): {
  day: string;
  month: string;
  year: string;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return { day: "", month: "", year: "" };
  const [, y, m, d] = match;
  return { day: String(Number(d)), month: String(Number(m)), year: y };
}
