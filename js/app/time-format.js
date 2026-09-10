const ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

export function formatAbsoluteTime(value) {
  const timestampMs = normalizeAbsoluteTimeMs(value);
  if (!Number.isFinite(timestampMs)) {
    return "-";
  }
  return ABSOLUTE_TIME_FORMATTER.format(new Date(timestampMs));
}

export function normalizeAbsoluteTimeMs(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (value instanceof Date) {
    const timestampMs = value.getTime();
    return Number.isFinite(timestampMs) ? timestampMs : null;
  }
  if (typeof value === "string") {
    const timestampMs = Date.parse(value);
    return Number.isFinite(timestampMs) ? timestampMs : null;
  }
  return null;
}
