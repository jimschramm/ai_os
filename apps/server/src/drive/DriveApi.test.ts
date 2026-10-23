// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - drives the plain client with a fake fetch.
import { describe, expect, it } from "vite-plus/test";

import { FOLDER_MIME, makeDriveApi, parseDriveRef, quoteQuery, SHORTCUT_MIME } from "./DriveApi.ts";

const credentials = {
  client: { clientId: "1-a.apps.googleusercontent.com", clientSecret: "client-secret" },
  token: {
    refreshToken: "refresh-1",
    scopes: [],
    clientId: "1-a",
    obtainedAt: "2026-10-01T00:00:00.000Z",
  },
};

type Call = { url: URL; init: RequestInit };

const fakeDrive = (
  tree: Record<string, Array<Record<string, unknown>>>,
  files: Record<string, Record<string, unknown>> = {},
) => {
  const calls: Call[] = [];
  let tokens = 0;
  const fetch = async (raw: string, init: RequestInit) => {
    const url = new URL(raw);
    calls.push({ url, init });
    if (url.hostname === "oauth2.googleapis.com") {
      tokens += 1;
      return new Response(JSON.stringify({ access_token: `access-${tokens}`, expires_in: 3600 }));
    }
    const q = url.searchParams.get("q") ?? "";
    const parent = /^'([^']+)' in parents/.exec(q)?.[1];
    if (url.pathname === "/drive/v3/files" && init.method === "GET" && parent !== undefined) {
      const children = tree[parent] ?? [];
      const page = url.searchParams.get("pageToken");
      // Two pages for folders with more than one child, to exercise pagination.
      const [first, ...rest] = children;
      if (page === null && rest.length > 0) {
        return new Response(JSON.stringify({ files: [first], nextPageToken: "p2" }));
      }
      return new Response(JSON.stringify({ files: page === null ? children : rest }));
    }
    const id = /\/files\/([^/]+)$/.exec(url.pathname)?.[1];
    if (id !== undefined && files[id] !== undefined) return new Response(JSON.stringify(files[id]));
    return new Response(JSON.stringify({ error: { message: "File not found" } }), { status: 404 });
  };
  return { calls, fetch, tokens: () => tokens };
};

describe("parseDriveRef", () => {
  it.each([
    ["https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing", "1AbCdEfGhIjKlMn"],
    ["https://docs.google.com/document/d/1AbCdEfGhIjKlMn/edit", "1AbCdEfGhIjKlMn"],
    ["https://docs.google.com/spreadsheets/u/1/d/1AbCdEfGhIjKlMn/edit#gid=0", "1AbCdEfGhIjKlMn"],
    ["https://docs.google.com/presentation/d/1AbCdEfGhIjKlMn/edit", "1AbCdEfGhIjKlMn"],
    [
      "https://drive.google.com/drive/u/0/folders/1Tnd7Xkg2ZXEhvsBt6KvnJA9_JOvRRdUT",
      "1Tnd7Xkg2ZXEhvsBt6KvnJA9_JOvRRdUT",
    ],
    ["https://drive.google.com/open?id=1AbCdEfGhIjKlMn", "1AbCdEfGhIjKlMn"],
    ["1AbCdEfGhIjKlMn", "1AbCdEfGhIjKlMn"],
  ])("%s", (input, id) => expect(parseDriveRef(input)).toBe(id));

  it("rejects other hosts and junk", () => {
    expect(parseDriveRef("https://evil.example.com/file/d/1AbCdEfGhIjKlMn/view")).toBeNull();
    expect(parseDriveRef("not a link")).toBeNull();
  });

  it("escapes query literals", () => {
    expect(quoteQuery("it's a \\ test")).toBe("'it\\'s a \\\\ test'");
  });
});

describe("makeDriveApi", () => {
  it("refreshes once, sends the bearer, and lists a folder tree recursively with pagination", async () => {
    const drive = fakeDrive(
      {
        root1: [
          { id: "f1", name: "a.txt", mimeType: "text/plain", size: "5" },
          { id: "sub", name: "Sub", mimeType: FOLDER_MIME },
          {
            id: "sc",
            name: "link",
            mimeType: SHORTCUT_MIME,
            shortcutDetails: { targetId: "root1" },
          },
        ],
        sub: [{ id: "f2", name: "b.pdf", mimeType: "application/pdf", size: "10" }],
      },
      { root1: { id: "root1", name: "Root", mimeType: FOLDER_MIME } },
    );
    const api = makeDriveApi(credentials, drive.fetch);
    const files = await api.listRecursive("root1");
    expect(files.map((file) => [file.path, file.size])).toEqual([
      ["a.txt", 5],
      ["Sub/b.pdf", 10],
    ]);
    expect(drive.tokens()).toBe(1);
    const apiCalls = drive.calls.filter((call) => call.url.hostname === "www.googleapis.com");
    for (const call of apiCalls) {
      expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer access-1");
      expect(call.url.searchParams.get("supportsAllDrives")).toBe("true");
      // Read-only: listing never writes.
      expect(call.init.method).toBe("GET");
    }
  });

  it("lists each folder in its own corpus and refuses an incomplete listing", async () => {
    const drive = fakeDrive(
      {
        mine1: [{ id: "shared1", name: "Team", mimeType: FOLDER_MIME, driveId: "sd1" }],
        shared1: [{ id: "f9", name: "c.txt", mimeType: "text/plain", size: "1" }],
      },
      { mine1: { id: "mine1", name: "Mine", mimeType: FOLDER_MIME } },
    );
    const api = makeDriveApi(credentials, drive.fetch);
    expect((await api.listRecursive("mine1")).map((file) => file.path)).toEqual(["Team/c.txt"]);
    const lists = drive.calls.filter((call) => call.url.searchParams.has("q"));
    expect(
      lists.map((call) => [
        call.url.searchParams.get("corpora"),
        call.url.searchParams.get("driveId"),
      ]),
    ).toEqual([
      ["user", null],
      ["drive", "sd1"],
    ]);
    expect(lists[0]!.url.searchParams.get("fields")).toContain("incompleteSearch");

    // Drive says it answered only in part: the listing fails rather than dropping files.
    const partial = async (raw: string, init: RequestInit) => {
      const url = new URL(raw);
      if (url.hostname === "oauth2.googleapis.com") {
        return new Response(JSON.stringify({ access_token: "a", expires_in: 3600 }));
      }
      if (url.searchParams.has("q")) {
        return new Response(
          JSON.stringify({
            incompleteSearch: true,
            files: [{ id: "f1", name: "a.txt", mimeType: "text/plain" }],
          }),
        );
      }
      return drive.fetch(raw, init);
    };
    const incomplete = makeDriveApi(credentials, partial);
    await expect(incomplete.listRecursive("mine1")).rejects.toThrow(/incomplete listing/);
    await expect(incomplete.findChildFolder("mine1", "inputs")).rejects.toThrow(
      /incomplete listing/,
    );
  });

  it("never drops a shortcut it cannot follow silently", async () => {
    const shortcut = (id: string, target: string) => ({
      id,
      name: `link-${target}`,
      mimeType: SHORTCUT_MIME,
      shortcutDetails: { targetId: target },
    });
    const drive = fakeDrive({
      root1: [
        { id: "f1", name: "a.txt", mimeType: "text/plain", size: "5" },
        shortcut("sc1", "gone"),
      ],
      root2: [shortcut("sc2", "flaky")],
    });
    const api = makeDriveApi(credentials, async (raw: string, init: RequestInit) =>
      new URL(raw).pathname.endsWith("/files/flaky")
        ? new Response(JSON.stringify({ error: { message: "Bad request" } }), { status: 400 })
        : drive.fetch(raw, init),
    );
    // Deleted or unshared target: reported with a reason, or the listing fails.
    await expect(api.listRecursive("root1")).rejects.toThrow(/link-gone could not be followed/);
    const unresolved: Array<{ path: string; reason: string }> = [];
    const files = await api.listRecursive("root1", { unresolved: (s) => unresolved.push(s) });
    expect(files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(unresolved).toEqual([
      expect.objectContaining({ path: "link-gone", reason: expect.stringMatching(/deleted/) }),
    ]);
    // Any other failure fails the listing even with the callback.
    await expect(api.listRecursive("root2", { unresolved: () => {} })).rejects.toThrow(
      /Bad request/,
    );
  });

  it("skips shortcuts the caller does not follow, and reports them", async () => {
    const drive = fakeDrive(
      {
        root1: [
          { id: "f1", name: "a.txt", mimeType: "text/plain", size: "5" },
          {
            id: "sc",
            name: "outside",
            mimeType: SHORTCUT_MIME,
            shortcutDetails: { targetId: "ext" },
          },
        ],
      },
      { ext: { id: "ext", name: "Personal.docx", mimeType: "text/plain", size: "3" } },
    );
    const api = makeDriveApi(credentials, drive.fetch);
    const skipped: string[] = [];
    const files = await api.listRecursive("root1", {
      followShortcut: async (target) => target.id !== "ext",
      skipped: (target) => skipped.push(`${target.path} -> ${target.id}`),
    });
    expect(files.map((file) => file.id)).toEqual(["f1"]);
    expect(skipped).toEqual(["outside -> ext"]);
  });

  it("reports Drive errors without the token", async () => {
    const drive = fakeDrive({});
    const api = makeDriveApi(credentials, drive.fetch);
    const error = await api
      .getFile("missing")
      .catch((caught: Error & { status?: number }) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as { status?: number }).status).toBe(404);
    expect((error as Error).message).not.toContain("access-");
  });

  it("asks for a new login when there is no token", async () => {
    const api = makeDriveApi({ ...credentials, token: null }, fakeDrive({}).fetch);
    await expect(api.getFile("x")).rejects.toThrow(/Drive login needed/);
  });
});

describe("writes", () => {
  it("does not retry a create that failed with a transient error", async () => {
    let posts = 0;
    const doFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") {
        return new Response(JSON.stringify({ access_token: "access-1", expires_in: 3600 }));
      }
      if (init.method === "POST") posts += 1;
      return new Response("{}", { status: 503 });
    };
    const api = makeDriveApi(credentials, doFetch as never);
    await expect(api.createFolder("parent", "outputs")).rejects.toThrow(/503/);
    expect(posts).toBe(1);
  });
});
