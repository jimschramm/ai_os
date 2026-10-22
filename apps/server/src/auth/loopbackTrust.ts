/**
 * Loopback trust is a local-owner shortcut. The socket address has to be
 * loopback; a proxy header would let a public client claim that address.
 * `Host` and `Origin` stay on localhost names so a DNS-rebinding or
 * cross-site page cannot ride a 127.0.0.1 connection.
 *
 * The dev proxy rewrites `/api` Host to the backend (`localhost:<port>`) and
 * leaves Origin as the page (`http://127.0.0.1:5733`). Both names are
 * loopback, and they do not have to be the same string. The proxy also stamps
 * the peer it accepted onto `X-Forwarded-For`. A non-loopback address in that
 * chain is a remote client, and it does not become the owner.
 */

/** Client label of the session minted for an unproxied loopback socket. */
export const LOOPBACK_OWNER_CLIENT_LABEL = "Loopback owner";

export type LoopbackTrustRejection =
  | "disabled"
  | "not-loopback"
  | "forwarded"
  | "bad-host"
  | "bad-origin";

export type LoopbackTrustDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: LoopbackTrustRejection };

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackAddress(value: string | undefined): boolean {
  const normalized = normalizeIpAddress(value);
  if (normalized === undefined) return false;
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  return isIpv4Loopback(normalized);
}

/** Bind hosts that can only receive loopback peers. Unspecified and `0.0.0.0` listen wider. */
export function isLoopbackBindHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const normalized = host.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]"
  ) {
    return false;
  }
  if (normalized === "[::1]") return true;
  return isLoopbackHostname(normalized) || isIpv4Loopback(normalized);
}

export function evaluateLoopbackTrust(input: {
  readonly trustLoopback: boolean;
  readonly bindHost: string | undefined;
  readonly remoteAddress: string | undefined;
  readonly forwardedFor: string | undefined;
  readonly forwarded: string | undefined;
  readonly host: string | undefined;
  readonly origin: string | undefined;
}): LoopbackTrustDecision {
  if (input.trustLoopback !== true) return { ok: false, reason: "disabled" };

  const remoteIsLoopback = isLoopbackAddress(input.remoteAddress);
  const bindIsLoopback = isLoopbackBindHost(input.bindHost);
  // A loopback peer is enough when the process also listens on other
  // interfaces. A loopback bind covers a socket that did not report a peer.
  // Any other peer still has to pair.
  if (!remoteIsLoopback && !(bindIsLoopback && input.remoteAddress === undefined)) {
    return { ok: false, reason: "not-loopback" };
  }

  // A local browser through the dev proxy is still loopback. Any other
  // forwarded client was accepted by that proxy from somewhere else.
  if (headerPresent(input.forwardedFor) || headerPresent(input.forwarded)) {
    const clients = [
      ...forwardedForAddresses(input.forwardedFor),
      ...forwardedHeaderAddresses(input.forwarded),
    ];
    if (clients.length === 0 || clients.some((address) => !isLoopbackAddress(address))) {
      return { ok: false, reason: "forwarded" };
    }
  }

  if (!isLoopbackHostname(hostnameFromHostHeader(input.host))) {
    return { ok: false, reason: "bad-host" };
  }

  const origin = hostnameFromOrigin(input.origin);
  if (origin === "invalid") return { ok: false, reason: "bad-origin" };
  return { ok: true };
}

export function loopbackTrustDiagnostic(
  reason: Exclude<LoopbackTrustRejection, "disabled" | "not-loopback">,
): string {
  switch (reason) {
    case "forwarded":
      return "Proxied loopback requests are not trusted.";
    case "bad-host":
      return "Loopback trust only accepts a localhost, 127.0.0.1, or ::1 host.";
    case "bad-origin":
      return "Loopback trust only accepts a localhost, 127.0.0.1, or ::1 origin.";
  }
}

export function remoteAddressFromSource(source: unknown): string | undefined {
  if (source === null || typeof source !== "object") return undefined;
  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: { readonly remoteAddress?: string | null };
  };
  return normalizeIpAddress(candidate.socket?.remoteAddress ?? candidate.remoteAddress);
}

function headerPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function forwardedForAddresses(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return value
    .split(",")
    .map((entry) => addressHost(entry))
    .filter((entry): entry is string => entry !== undefined);
}

function forwardedHeaderAddresses(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  const addresses: string[] = [];
  for (const match of value.matchAll(/(?:^|[;,])\s*for\s*=\s*(?:"([^"]+)"|([^;,\s"]+))/gi)) {
    const token = match[1] ?? match[2];
    const host = token === undefined ? undefined : addressHost(token);
    if (host !== undefined) addresses.push(host);
  }
  return addresses;
}

function addressHost(token: string): string | undefined {
  const value = token.trim().toLowerCase();
  if (value.length === 0 || value === "unknown" || value === "hidden" || value === "_hidden") {
    return undefined;
  }
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 1 ? value.slice(1, end) : undefined;
  }
  const colon = value.indexOf(":");
  if (colon > 0 && value.indexOf(":", colon + 1) === -1 && /^\d+$/.test(value.slice(colon + 1))) {
    return value.slice(0, colon);
  }
  return value;
}

function normalizeIpAddress(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

function isIpv4Loopback(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every(isDecimalOctet);
}

function isDecimalOctet(part: string): boolean {
  if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false;
  return Number(part) <= 255;
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  if (hostname === undefined) return false;
  return LOOPBACK_NAMES.has(hostname) || isIpv4Loopback(hostname);
}

function hostnameFromHostHeader(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  if (first === undefined || first.length === 0) return undefined;
  if (first.startsWith("[")) {
    const end = first.indexOf("]");
    return end > 1 ? first.slice(1, end) : undefined;
  }
  const colon = first.indexOf(":");
  if (colon === -1) return first;
  if (first.indexOf(":", colon + 1) !== -1) return undefined;
  const name = first.slice(0, colon);
  const port = first.slice(colon + 1);
  return /^\d+$/.test(port) ? name : undefined;
}

function hostnameFromOrigin(origin: string | undefined): string | "absent" | "invalid" {
  if (origin === undefined || origin.trim().length === 0) return "absent";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid";
  if (url.username.length > 0 || url.password.length > 0) return "invalid";
  // Node reports an IPv6 URL hostname with brackets (`[::1]`).
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return isLoopbackHostname(hostname) ? hostname : "invalid";
}
