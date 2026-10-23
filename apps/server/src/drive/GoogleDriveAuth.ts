// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - the one-shot loopback listener and token exchange run as plain Node code; the CLI wraps them in Effect.tryPromise.
/**
 * Google Drive sign-in for ai_os: OAuth 2.0 installed-app flow with PKCE (S256),
 * a random `state`, and a one-shot listener bound to 127.0.0.1 only.
 *
 * Secrets live in the server secret store (<stateDir>/secrets, dir 700, files
 * 600). Nothing here logs, prints or returns a token or client secret.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Full `drive` scope. Reading is unlimited (anything in Jim's Drive), and ai_os
 * writes its `<name>_aios_vN` copies next to originals in folders it did not
 * create, which `drive.file` cannot do. The no-modify rule is enforced by
 * ai_os's own write path (PR 3): originals are never changed, only new
 * `_aios_vN` files are created, and nothing is deleted.
 */
export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"] as const;

/**
 * Fixed secret-store key; never derived from user input. Client and token live
 * in one record so one atomic write always keeps them paired.
 */
export const DRIVE_CREDENTIALS_SECRET_NAME = "google-drive-oauth";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CALLBACK_PATH = "/oauth2callback";
/** Network deadline for Google token calls, so a stalled request can't hang the CLI. */
export const GOOGLE_REQUEST_TIMEOUT_MS = 30_000;

export class DriveAuthError extends Error {
  override readonly name = "DriveAuthError";
}

export interface DriveClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface StoredDriveToken {
  readonly refreshToken: string;
  readonly scopes: readonly string[];
  readonly clientId: string;
  readonly obtainedAt: string;
}

const base64Url = (bytes: Buffer) => bytes.toString("base64url");

export const makePkce = () => {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

/** Reads the JSON Google gives you for a Desktop OAuth client. */
export const parseClientJson = (text: string): DriveClient => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DriveAuthError("The client file is not valid JSON.");
  }
  const installed = (parsed as { installed?: unknown } | null)?.installed;
  if (installed === undefined || installed === null || typeof installed !== "object") {
    throw new DriveAuthError(
      'Expected a Desktop app client file with an "installed" section (Google Cloud > Clients > Desktop app > Download JSON).',
    );
  }
  const { client_id: clientId, client_secret: clientSecret } = installed as Record<string, unknown>;
  if (typeof clientId !== "string" || !clientId.endsWith(".apps.googleusercontent.com")) {
    throw new DriveAuthError("The client file has no valid client_id.");
  }
  if (typeof clientSecret !== "string" || clientSecret.length === 0) {
    throw new DriveAuthError("The client file has no client_secret.");
  }
  return { clientId, clientSecret };
};

export const buildAuthUrl = (input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}) => {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DRIVE_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
};

/** OAuth error codes are reported only from a fixed list; anything else is "unknown". */
const KNOWN_OAUTH_ERRORS = new Set([
  "access_denied",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_grant_type",
  "server_error",
  "temporarily_unavailable",
  "admin_policy_enforced",
  "org_internal",
]);
export const safeOAuthError = (value: unknown): string =>
  typeof value === "string" && KNOWN_OAUTH_ERRORS.has(value) ? value : "unknown error";

type CallbackResult = { readonly code: string } | { readonly error: string };

/**
 * Validates one callback request. A wrong path is ignored (favicon etc.); a
 * wrong or missing state is a hard failure, never a retry.
 */
export const readCallback = (
  requestUrl: string,
  expectedState: string,
): CallbackResult | "ignore" => {
  let url: URL;
  try {
    url = new URL(requestUrl, "http://127.0.0.1");
  } catch {
    return "ignore";
  }
  if (url.pathname !== CALLBACK_PATH) return "ignore";
  const state = url.searchParams.get("state");
  if (state === null || state !== expectedState) {
    return { error: "State mismatch: this sign-in response was not started by ai_os." };
  }
  const error = url.searchParams.get("error");
  if (error !== null) return { error: `Google returned an error: ${safeOAuthError(error)}.` };
  const code = url.searchParams.get("code");
  if (code === null || code.length === 0) return { error: "Google returned no code." };
  return { code };
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const exchangeCode = async (input: {
  readonly client: DriveClient;
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}): Promise<StoredDriveToken> => {
  const doFetch = input.fetch ?? fetch;
  const response = await doFetch(TOKEN_ENDPOINT, {
    method: "POST",
    // Never let a redirect forward the secret, code or verifier elsewhere.
    redirect: "error",
    signal: AbortSignal.timeout(input.timeoutMs ?? GOOGLE_REQUEST_TIMEOUT_MS),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
      code_verifier: input.verifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    // Only Google's error code goes into the message, never the body.
    const code = body.error === undefined ? `HTTP ${response.status}` : safeOAuthError(body.error);
    throw new DriveAuthError(`Token exchange failed: ${code}.`);
  }
  if (typeof body.refresh_token !== "string" || body.refresh_token.length === 0) {
    throw new DriveAuthError(
      "Google did not return a refresh token. Remove ai_os at myaccount.google.com/permissions and sign in again.",
    );
  }
  const scopes = typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [];
  const missing = DRIVE_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) {
    throw new DriveAuthError(
      `Drive access was not fully granted (missing ${missing.join(", ")}). Sign in again and tick every Drive box.`,
    );
  }
  return {
    refreshToken: body.refresh_token,
    scopes,
    clientId: input.client.clientId,
    obtainedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
};

const PAGE = (title: string, detail: string) =>
  `<!doctype html><meta charset="utf-8"><title>ai_os</title><body style="font-family:sans-serif;padding:2rem"><h2>${title}</h2><p>${detail}</p></body>`;

/**
 * Runs the browser sign-in. Listens on 127.0.0.1 only, on a random port, for
 * at most `timeoutMs`, and closes after the first callback that carries state.
 */
export const runLoopbackLogin = async (input: {
  readonly client: DriveClient;
  readonly showUrl: (url: string) => void;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}): Promise<StoredDriveToken> => {
  const { verifier, challenge } = makePkce();
  const state = base64Url(randomBytes(24));
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  try {
    // The browser tab only hears "signed in" after the token exchange succeeds.
    const { code, respond } = await new Promise<{
      readonly code: string;
      readonly respond: (ok: boolean) => Promise<void>;
    }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new DriveAuthError("Timed out waiting for Google sign-in.")),
        input.timeoutMs ?? 5 * 60_000,
      );
      let settled = false;
      server.on("request", (request, response) => {
        const result = settled ? ("ignore" as const) : readCallback(request.url ?? "/", state);
        if (result === "ignore") {
          response.writeHead(404).end();
          return;
        }
        settled = true;
        clearTimeout(timer);
        // Resolves once the page is fully written or the browser has gone,
        // so closing the listener afterwards never cuts a response short and
        // a browser that disconnects early never leaves login hanging.
        const gone = new Promise<void>((done) => response.once("close", () => done()));
        const respond = (ok: boolean) =>
          response.destroyed || response.writableEnded
            ? Promise.resolve()
            : new Promise<void>((done) => {
                void gone.then(done);
                response
                  .writeHead(ok ? 200 : 400, {
                    "content-type": "text/html; charset=utf-8",
                    connection: "close",
                  })
                  .end(
                    ok
                      ? PAGE(
                          "Signed in to Google Drive",
                          "You can close this tab and go back to the terminal.",
                        )
                      : PAGE("Sign-in failed", "Go back to the terminal for details."),
                    () => done(),
                  );
              });
        if ("code" in result) {
          resolve({ code: result.code, respond });
        } else {
          void respond(false).then(() => reject(new DriveAuthError(result.error)));
        }
      });
      input.showUrl(
        buildAuthUrl({
          clientId: input.client.clientId,
          redirectUri,
          state,
          codeChallenge: challenge,
        }),
      );
    });
    try {
      const token = await exchangeCode({
        client: input.client,
        code,
        verifier,
        redirectUri,
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      await respond(true);
      return token;
    } catch (error) {
      await respond(false);
      throw error;
    }
  } finally {
    // Stop accepting first; only idle or finished sockets remain to drop.
    server.close();
    server.closeAllConnections();
  }
};

export interface StoredDriveCredentials {
  readonly client: DriveClient;
  /** null after logout: the client stays so the next login needs no file. */
  readonly token: StoredDriveToken | null;
}

export const encodeCredentials = (credentials: StoredDriveCredentials) =>
  new TextEncoder().encode(JSON.stringify(credentials));

const isToken = (value: unknown): value is StoredDriveToken => {
  if (typeof value !== "object" || value === null) return false;
  const token = value as Partial<StoredDriveToken>;
  return (
    typeof token.refreshToken === "string" &&
    typeof token.clientId === "string" &&
    typeof token.obtainedAt === "string" &&
    Array.isArray(token.scopes) &&
    token.scopes.every((scope) => typeof scope === "string")
  );
};

/** Returns null for anything that is not a well-formed, matching pair. */
export const decodeCredentials = (bytes: Uint8Array): StoredDriveCredentials | null => {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<StoredDriveCredentials>;
    const client = value.client as Partial<DriveClient> | undefined;
    if (typeof client?.clientId !== "string" || typeof client.clientSecret !== "string") {
      return null;
    }
    if (value.token === null) return { client: client as DriveClient, token: null };
    return isToken(value.token) && value.token.clientId === client.clientId
      ? { client: client as DriveClient, token: value.token }
      : null;
  } catch {
    return null;
  }
};

/** Best effort: revoking at Google can fail offline; the local token is removed regardless. */
export const revokeToken = async (
  refreshToken: string,
  doFetch: FetchLike = fetch,
  timeoutMs = GOOGLE_REQUEST_TIMEOUT_MS,
) => {
  try {
    const response = await doFetch(REVOKE_ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
};
