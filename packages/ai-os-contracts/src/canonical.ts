import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const CONVERSATION_ID = /^[a-z0-9][a-z0-9._:-]*$/;

/** Fractional seconds are 1–3 digits. `.1` and `.100` are the same millisecond. */
export const epochMs = (value: string): number | null => {
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
  const millis = fraction === undefined ? 0 : Number(fraction.padEnd(3, "0"));
  const instant = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  return Number.isNaN(instant) ? null : instant;
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
  const id = value.trim().toLowerCase();
  return id.length > 0 && id.length <= 128 && CONVERSATION_ID.test(id) ? id : null;
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
      decode: (value) => canonicalConversationId(value) ?? value.trim().toLowerCase(),
      encode: (value) => value,
    }),
  ),
);
export type ConversationId = typeof ConversationId.Type;
