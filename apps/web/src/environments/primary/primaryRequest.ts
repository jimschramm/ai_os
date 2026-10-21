import { readDesktopPrimaryBearerToken } from "./desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "./target";

/**
 * Cookie sessions are only valid on a page served by its own T3 server.
 * Desktop and cross-origin clients send the desktop bearer instead, matching
 * `layerForCurrentOrigin`.
 */
export function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }

  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

/** Request init for a primary-environment fetch, including the board event stream. */
export async function primaryFetchInit(): Promise<RequestInit> {
  if (isSameOriginBrowserPrimary()) {
    return { credentials: "include" };
  }

  const bearerToken = await readDesktopPrimaryBearerToken();
  if (!bearerToken) {
    return { credentials: "omit" };
  }
  return {
    credentials: "omit",
    headers: { authorization: `Bearer ${bearerToken}` },
  };
}
