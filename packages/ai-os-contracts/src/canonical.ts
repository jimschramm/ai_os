import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const isDisallowedConversationChar = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0x1f || code === 0x7f || /\s/u.test(char)) {
    return true;
  }
  return (
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x206f) ||
    code === 0xfeff
  );
};

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [0, 31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month] ?? 0;
};

/**
 * RFC3339 UTC instant with a `Z` suffix. Month, day (including leap years),
 * hour, minute, and second are range-checked, then formatted back to the same
 * string. `.1` stays `.1`. Leap second 60 and hour 24 are rejected here so
 * `Date.UTC` cannot roll them into the next unit.
 */
export const canonicalInstant = (value: string): string | null => {
  const match = INSTANT.exec(value);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const fractionText = fraction === undefined ? "" : `.${fraction}`;
  const canonical = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${fractionText}Z`;
  return canonical === value ? canonical : null;
};

/** Fractional seconds are 1–3 digits. `.1` and `.100` are the same millisecond. */
export const epochMs = (value: string): number | null => {
  if (canonicalInstant(value) === null) {
    return null;
  }
  const match = INSTANT.exec(value);
  if (match === null) {
    return null;
  }
  const fraction = match[7];
  const millis = fraction === undefined ? 0 : Number(fraction.padEnd(3, "0"));
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    millis,
  );
};

export const timeBefore = (left: string, right: string): boolean => {
  const earlier = epochMs(left);
  const later = epochMs(right);
  return earlier !== null && later !== null && earlier < later;
};

export const timeAtOrBefore = (left: string, right: string): boolean => {
  const earlier = epochMs(left);
  const later = epochMs(right);
  return earlier !== null && later !== null && earlier <= later;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) {
        canonical[key] = canonicalize(record[key]);
      }
    }
    return canonical;
  }
  return value;
};

/** Canonical payload identity. Key order does not change the fingerprint. */
export const fingerprintOf = (value: unknown): string => JSON.stringify(canonicalize(value));

export const PayloadFingerprint = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(32_000),
);
export type PayloadFingerprint = typeof PayloadFingerprint.Type;

export const leaseIdFor = (generation: number): string => `lease-${generation}`;

export const canonicalConversationId = (value: string): string | null => {
  const id = value.trim();
  if (id.length === 0 || id.length > 128 || Array.from(id).some(isDisallowedConversationChar)) {
    return null;
  }
  return id;
};

export const ConversationId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((value: string) =>
    canonicalConversationId(value) !== null ? true : "Expected a conversation id.",
  ),
).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (value) => canonicalConversationId(value) ?? value.trim(),
      encode: (value) => value,
    }),
  ),
);
export type ConversationId = typeof ConversationId.Type;
