// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off - tests drive the real loopback listener over HTTP.
import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";

import {
  DRIVE_SCOPES,
  DriveAuthError,
  buildAuthUrl,
  decodeToken,
  encodeToken,
  exchangeCode,
  makePkce,
  parseClientJson,
  readCallback,
  runLoopbackLogin,
} from "./GoogleDriveAuth.ts";

const client = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "shh-secret" };
const grantedScope = DRIVE_SCOPES.join(" ");
const okToken = (body: Record<string, unknown>) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe("PKCE and auth URL", () => {
  it("uses an S256 challenge of the verifier", () => {
    const { verifier, challenge } = makePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("asks for offline Drive access with state and PKCE", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: client.clientId,
        redirectUri: "http://127.0.0.1:5000/oauth2callback",
        state: "s1",
        codeChallenge: "c1",
      }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(grantedScope);
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5000/oauth2callback");
  });
});

describe("callback validation", () => {
  it("accepts matching state and rejects mismatches", () => {
    expect(readCallback("/oauth2callback?state=good&code=c", "good")).toEqual({ code: "c" });
    expect(readCallback("/oauth2callback?state=bad&code=c", "good")).toHaveProperty("error");
    expect(readCallback("/oauth2callback?code=c", "good")).toHaveProperty("error");
    expect(readCallback("/oauth2callback?state=good&error=access_denied", "good")).toEqual({
      error: "Google returned an error: access_denied",
    });
    expect(readCallback("/favicon.ico", "good")).toBe("ignore");
  });
});

describe("client file", () => {
  it("reads a Desktop client and rejects web clients", () => {
    expect(
      parseClientJson(
        JSON.stringify({ installed: { client_id: client.clientId, client_secret: "x" } }),
      ),
    ).toEqual({ clientId: client.clientId, clientSecret: "x" });
    expect(() => parseClientJson(JSON.stringify({ web: {} }))).toThrow(DriveAuthError);
    expect(() => parseClientJson("{")).toThrow(DriveAuthError);
  });
});

describe("token exchange", () => {
  it("sends the verifier and keeps only what is needed", async () => {
    let sent = "";
    const token = await exchangeCode({
      client,
      code: "code1",
      verifier: "ver1",
      redirectUri: "http://127.0.0.1:1/oauth2callback",
      now: () => new Date("2026-10-22T00:00:00Z"),
      fetch: (_url, init) => {
        sent = String(init.body);
        return okToken({ access_token: "at", refresh_token: "rt", scope: grantedScope });
      },
    });
    expect(new URLSearchParams(sent).get("code_verifier")).toBe("ver1");
    expect(token).toEqual({
      refreshToken: "rt",
      scopes: [...DRIVE_SCOPES],
      clientId: client.clientId,
      obtainedAt: "2026-10-22T00:00:00.000Z",
    });
    expect(decodeToken(encodeToken(token))).toEqual(token);
  });

  it("fails without a refresh token or with missing scopes, without echoing secrets", async () => {
    const run = (body: Record<string, unknown>, status = 200) =>
      exchangeCode({
        client,
        code: "c",
        verifier: "v",
        redirectUri: "r",
        fetch: () => Promise.resolve(new Response(JSON.stringify(body), { status })),
      });
    await expect(run({ scope: grantedScope })).rejects.toThrow(/refresh token/);
    await expect(
      run({ refresh_token: "rt", scope: "https://www.googleapis.com/auth/drive.file" }),
    ).rejects.toThrow(/auth\/drive\b/);
    const error = await run({ error: "invalid_grant", error_description: "rt-leak" }, 400).catch(
      (e: Error) => e,
    );
    expect(String(error)).toContain("invalid_grant");
    expect(String(error)).not.toContain("rt-leak");
    expect(String(error)).not.toContain(client.clientSecret);
  });
});

describe("loopback login", () => {
  const start = (fetchImpl: Parameters<typeof runLoopbackLogin>[0]["fetch"]) => {
    let resolveUrl!: (url: URL) => void;
    const shown = new Promise<URL>((resolve) => (resolveUrl = resolve));
    const login = runLoopbackLogin({
      client,
      timeoutMs: 5_000,
      showUrl: (url) => resolveUrl(new URL(url)),
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
    return { shown, login };
  };

  it("listens on 127.0.0.1 only and completes with matching state", async () => {
    const { shown, login } = start((url, init) =>
      url.startsWith("https://oauth2.googleapis.com/token")
        ? okToken({ refresh_token: "rt", scope: grantedScope })
        : fetch(url, init),
    );
    const auth = await shown;
    const redirect = new URL(auth.searchParams.get("redirect_uri")!);
    expect(redirect.hostname).toBe("127.0.0.1");
    const callback = `${redirect}?state=${auth.searchParams.get("state")}&code=abc`;
    const page = await fetch(callback);
    expect(page.status).toBe(200);
    await expect(login).resolves.toMatchObject({ refreshToken: "rt" });
    // The listener is gone after one callback.
    await expect(fetch(callback)).rejects.toThrow();
  });

  it("rejects a forged state and does not exchange the code", async () => {
    let exchanged = false;
    const { shown, login } = start(() => {
      exchanged = true;
      return okToken({ refresh_token: "rt", scope: grantedScope });
    });
    const auth = await shown;
    const redirect = auth.searchParams.get("redirect_uri")!;
    const settled = login.catch((error: Error) => error);
    const page = await fetch(`${redirect}?state=forged&code=abc`);
    expect(page.status).toBe(400);
    expect(String(await settled)).toMatch(/State mismatch/);
    expect(exchanged).toBe(false);
  });
});
