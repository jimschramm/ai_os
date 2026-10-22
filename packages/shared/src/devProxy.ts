/**
 * Two consumers must agree on this list: the Vite proxy map
 * (apps/web/vite.config.ts) that forwards these to the backend, and the
 * server's dev catch-all (apps/server/src/http.ts) that 404s them instead of
 * redirecting back to Vite. Drift is silent and nasty in both directions — a
 * prefix only Vite knows gets answered with index.html; a prefix only the
 * server knows redirect-loops through the proxy.
 */
export const DEV_PROXIED_PATH_PREFIXES = ["/api", "/oauth", "/.well-known", "/ws", "/mcp"] as const;

/**
 * MCP OAuth derives its issuer and resource URLs from the request, and a client
 * rejects metadata naming a different origin than the one it fetched. The
 * server accepts a cookie session on `/ws` only when the page's Origin matches
 * the Host it sees, so whatever origin the page was opened on keeps working.
 */
export const DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES: ReadonlySet<string> = new Set([
  "/oauth",
  "/.well-known",
  "/mcp",
  "/ws",
]);

export function isDevProxiedPath(pathname: string): boolean {
  return DEV_PROXIED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Default Vite bind. `localhost` can follow DNS; an unset host listens on
 * every interface. Remote clients must not reach the dev proxy, because the
 * backend would otherwise see only the proxy's loopback socket.
 */
export const DEV_SERVER_BIND_HOST = "127.0.0.1";

/** Keep any client-supplied chain, then append the peer this proxy accepted. */
export function appendObservedClientAddress(
  existing: string | readonly string[] | undefined,
  socketAddress: string | undefined,
): string | undefined {
  const prior = forwardedForText(existing);
  const observed = socketAddress?.trim() ?? "";
  if (observed.length === 0) return prior.length > 0 ? prior : undefined;
  return prior.length === 0 ? observed : `${prior}, ${observed}`;
}

export function bindDevProxyClientAddress(proxy: {
  on(
    event: "proxyReq" | "proxyReqWs",
    listener: (
      proxyReq: { setHeader(name: string, value: string): void },
      req: {
        readonly headers: { readonly [name: string]: string | readonly string[] | undefined };
        readonly socket: { readonly remoteAddress?: string | undefined };
      },
    ) => void,
  ): void;
}): void {
  const forward = (
    proxyReq: { setHeader(name: string, value: string): void },
    req: {
      readonly headers: { readonly [name: string]: string | readonly string[] | undefined };
      readonly socket: { readonly remoteAddress?: string | undefined };
    },
  ) => {
    const value = appendObservedClientAddress(
      req.headers["x-forwarded-for"],
      req.socket.remoteAddress,
    );
    if (value !== undefined) proxyReq.setHeader("x-forwarded-for", value);
  };
  proxy.on("proxyReq", forward);
  proxy.on("proxyReqWs", forward);
}

function forwardedForText(existing: string | readonly string[] | undefined): string {
  if (typeof existing === "string") return existing.trim();
  if (existing === undefined) return "";
  return existing
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(", ");
}
