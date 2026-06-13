export const ANCHOR_UNTIL_TIMESTAMP_FORMAT =
  "full ISO-8601 timestamp with timezone, for example 2026-06-11T11:00:00.000Z or 2026-06-11T07:00:00-04:00";

const ANCHOR_UNTIL_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/;

export function parseAnchorUntilTimestamp(value: string): string | null {
  const trimmed = value.trim();
  const match = ANCHOR_UNTIL_TIMESTAMP_PATTERN.exec(trimmed);
  if (match === null) {
    return null;
  }

  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  const hour = Number.parseInt(match[4] ?? "", 10);
  const minute = Number.parseInt(match[5] ?? "", 10);
  const second = Number.parseInt(match[6] ?? "", 10);
  const offsetHour = match[8] === "Z" ? 0 : Number.parseInt(match[9] ?? "", 10);
  const offsetMinute =
    match[8] === "Z" ? 0 : Number.parseInt(match[10] ?? "", 10);

  if (
    !isFiniteCalendarTimestamp({
      year,
      month,
      day,
      hour,
      minute,
      second,
      offsetHour,
      offsetMinute,
    })
  ) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function isFiniteCalendarTimestamp(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetHour: number;
  offsetMinute: number;
}): boolean {
  if (
    input.month < 1 ||
    input.month > 12 ||
    input.hour < 0 ||
    input.hour > 23 ||
    input.minute < 0 ||
    input.minute > 59 ||
    input.second < 0 ||
    input.second > 59 ||
    input.offsetHour < 0 ||
    input.offsetHour > 23 ||
    input.offsetMinute < 0 ||
    input.offsetMinute > 59
  ) {
    return false;
  }

  return input.day >= 1 && input.day <= daysInMonth(input.year, input.month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
