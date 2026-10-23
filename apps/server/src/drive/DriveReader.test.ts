// @effect-diagnostics nodeBuiltinImport:off globalDate:off - uses a temp dir as the content store and worktree.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeContentStore } from "./ContentStore.ts";
import { type DriveApi, type DriveFile, FOLDER_MIME } from "./DriveApi.ts";
import { buildSnapshot, readDriveFile, snapshotDirName, verifySnapshot } from "./DriveReader.ts";
import { DriveJobStore, safeProjectDir } from "./DriveJobStore.ts";
import {
  AIOS_PROJECTS_FOLDER_ID,
  AIOS_ROOT_FOLDER_ID,
  ensureProjectFolders,
  isInsideFolders,
  projectRoots,
} from "./projectFolders.ts";
import { makeZip } from "./testZip.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const temps: string[] = [];
const temp = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "drive-test-"));
  temps.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fs.chmod(dir, 0o700).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const xlsx = makeZip({
  "xl/workbook.xml": '<workbook><sheets><sheet name="S1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  "xl/worksheets/sheet1.xml":
    '<worksheet><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>',
});

/** In-memory Drive. Records every call so tests can prove nothing was written. */
const fakeApi = (
  files: DriveFile[],
  children: Record<string, string[]>,
  bytes: Record<string, Uint8Array>,
) => {
  const calls: string[] = [];
  const byId = new Map(files.map((file) => [file.id, file]));
  const folders: DriveFile[] = [];
  const api: DriveApi = {
    getFile: async (id) => {
      calls.push(`get ${id}`);
      const file = byId.get(id);
      if (file === undefined) throw Object.assign(new Error("File not found"), { status: 404 });
      return file;
    },
    resolve: async (file) => file,
    listChildren: async (id) => (children[id] ?? []).map((child) => byId.get(child)!),
    listRecursive: async (id) => {
      calls.push(`list ${id}`);
      const out: Array<DriveFile & { path: string }> = [];
      const walk = (folder: string, prefix: string) => {
        for (const childId of children[folder] ?? []) {
          const child = byId.get(childId)!;
          if (child.mimeType === FOLDER_MIME) walk(child.id, `${prefix}${child.name}/`);
          else out.push({ ...child, path: `${prefix}${child.name}` });
        }
      };
      walk(id, "");
      return out;
    },
    search: async () => [],
    download: async (id) => {
      calls.push(`download ${id}`);
      return bytes[id] ?? new Uint8Array();
    },
    exportAs: async (id, mime) => {
      calls.push(`export ${id} ${mime}`);
      if (mime === "text/plain") return new TextEncoder().encode(`text of ${id}`);
      if (mime.includes("spreadsheet")) return xlsx;
      return new Uint8Array([80, 75]);
    },
    findChildFolder: async (parent, name) =>
      [...byId.values(), ...folders].find(
        (file) =>
          file.mimeType === FOLDER_MIME && file.name === name && file.parents?.includes(parent),
      ) ?? null,
    createFolder: async (parent, name) => {
      calls.push(`create ${parent}/${name}`);
      const folder = { id: `new-${name}`, name, mimeType: FOLDER_MIME, parents: [parent] };
      folders.push(folder);
      return folder;
    },
  };
  return { api, calls };
};

const tree = () =>
  fakeApi(
    [
      { id: "folder1-0000000", name: "RFP", mimeType: FOLDER_MIME },
      { id: "sub1", name: "Annex", mimeType: FOLDER_MIME },
      {
        id: "doc1",
        name: "Brief",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-10-01T00:00:00Z",
      },
      {
        id: "sheet1",
        name: "Budget",
        mimeType: "application/vnd.google-apps.spreadsheet",
        modifiedTime: "2026-10-01T00:00:00Z",
      },
      { id: "form1", name: "Survey", mimeType: "application/vnd.google-apps.form" },
      {
        id: "png1",
        name: "logo.png",
        mimeType: "image/png",
        modifiedTime: "2026-10-02T00:00:00Z",
        size: 3,
      },
      {
        id: "txt1-0000000",
        name: "notes.md",
        mimeType: "text/markdown",
        modifiedTime: "2026-10-02T00:00:00Z",
        size: 5,
      },
    ],
    { "folder1-0000000": ["doc1", "sub1", "form1"], sub1: ["sheet1", "png1", "txt1-0000000"] },
    { png1: new Uint8Array([137, 80, 78]), "txt1-0000000": new TextEncoder().encode("hello") },
  );

describe("readDriveFile", () => {
  it("stores once per Drive version and reuses it", async () => {
    const { api, calls } = tree();
    const store = makeContentStore(await temp());
    const file = {
      id: "txt1-0000000",
      name: "notes.md",
      mimeType: "text/markdown",
      modifiedTime: "2026-10-02T00:00:00Z",
    };
    const first = await readDriveFile(api, store, file);
    const second = await readDriveFile(api, store, file);
    expect(first.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.meta).toEqual(first.meta);
    expect(calls.filter((call) => call === "download txt1-0000000")).toHaveLength(1);
    expect(await fs.readFile(first.textPath!, "utf8")).toBe("hello");
    expect((await store.list()).map((entry) => entry.fileId)).toEqual(["txt1-0000000"]);
    // A changed file in Drive is a new entry.
    await readDriveFile(api, store, { ...file, modifiedTime: "2026-10-03T00:00:00Z" });
    expect(calls.filter((call) => call === "download txt1-0000000")).toHaveLength(2);
  });

  it("exports Google formats: Docs to docx + text, Sheets to xlsx with every tab", async () => {
    const { api, calls } = tree();
    const store = makeContentStore(await temp());
    const doc = await readDriveFile(api, store, {
      id: "doc1",
      name: "Brief",
      mimeType: "application/vnd.google-apps.document",
    });
    expect(doc.meta.kind).toBe("text");
    expect(path.basename(doc.originalPath!)).toBe("original.docx");
    const sheet = await readDriveFile(api, store, {
      id: "sheet1",
      name: "Budget",
      mimeType: "application/vnd.google-apps.spreadsheet",
    });
    expect(await fs.readFile(sheet.textPath!, "utf8")).toBe("## Sheet: S1\n7");
    const form = await readDriveFile(api, store, {
      id: "form1",
      name: "Survey",
      mimeType: "application/vnd.google-apps.form",
    });
    expect(form.meta.kind).toBe("link");
    expect(calls.some((call) => call.startsWith("download doc1"))).toBe(false);
  });
});

describe("buildSnapshot", () => {
  it("copies a folder (all depths) read-only into the worktree with a manifest and totals", async () => {
    const { api, calls } = tree();
    const worktree = await temp();
    git(worktree, "init", "-q");
    await fs.writeFile(path.join(worktree, ".git", "info", "exclude"), "# local\n");
    const store = makeContentStore(await temp());
    const progress: string[] = [];
    const result = await buildSnapshot({
      api,
      store,
      worktree,
      taskId: "live-task-1",
      refs: ["https://drive.google.com/drive/folders/folder1-0000000", "txt1-0000000"],
      now: () => new Date("2026-10-23T10:00:00Z"),
      onProgress: (done, total, current) => progress.push(`${done}/${total} ${current}`),
    });
    const ref = result.ref;
    expect(ref.root).toBe(".ai_os/drive/live-task-1");
    // txt1-0000000 is in the folder and also picked by id: copied once.
    expect(ref.totalFiles).toBe(5);
    expect(ref.files.map((file) => file.drivePath)).toEqual([
      "RFP/Brief",
      "RFP/Annex/Budget",
      "RFP/Annex/logo.png",
      "RFP/Annex/notes.md",
      "RFP/Survey",
    ]);
    expect(progress.at(-1)).toBe("5/5 RFP/Survey");
    expect(ref.totalBytes).toBe(ref.files.reduce((sum, file) => sum + file.bytes, 0));
    expect(ref.failedFiles).toBe(1); // the Form has no download
    const image = ref.files.find((file) => file.kind === "image")!;
    expect(image.original).toBe(".ai_os/drive/live-task-1/0003-logo.png");
    const stat = await fs.stat(path.join(worktree, image.original!));
    expect(stat.mode & 0o777).toBe(0o444);
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    expect(manifest.readOnly).toBe(true);
    expect(manifest.files[2].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.readFile(path.join(worktree, ".git", "info", "exclude"), "utf8")).toBe(
      "# local\n/.ai_os/drive/\n",
    );
    // Read-only toward Drive.
    expect(calls.some((call) => call.startsWith("create"))).toBe(false);
    expect(await verifySnapshot(worktree, ref)).toBeNull();
    // A changed or missing copy fails the check even with the manifest intact.
    const textCopy = path.join(worktree, ref.files.find((file) => file.text !== undefined)!.text!);
    await fs.chmod(textCopy, 0o644);
    await fs.writeFile(textCopy, "tampered");
    expect(await verifySnapshot(worktree, ref)).toMatch(/file .* was changed/);
    await fs.rm(textCopy);
    expect(await verifySnapshot(worktree, ref)).toMatch(/file .* is missing/);
    await fs.chmod(result.manifestPath, 0o644);
    await fs.appendFile(result.manifestPath, " ");
    expect(await verifySnapshot(worktree, ref)).toMatch(/changed/);
    await fs.rm(path.dirname(result.manifestPath), { recursive: true, force: true });
    expect(await verifySnapshot(worktree, ref)).toMatch(/missing/);
  });

  it("never overwrites an existing snapshot and rejects bad ids", async () => {
    const { api } = tree();
    const worktree = await temp();
    const store = makeContentStore(await temp());
    await buildSnapshot({ api, store, worktree, taskId: "t1", refs: ["txt1-0000000"] });
    await expect(
      buildSnapshot({ api, store, worktree, taskId: "t1", refs: ["txt1-0000000"] }),
    ).rejects.toThrow(/already exists/);
    await expect(
      buildSnapshot({ api, store, worktree, taskId: "../x", refs: ["txt1-0000000"] }),
    ).rejects.toThrow(/Invalid task id/);
    await expect(
      buildSnapshot({ api, store, worktree, taskId: "t2", refs: ["nope nope"] }),
    ).rejects.toThrow(/Not a Google Drive/);
  });
});

describe("ensureProjectFolders", () => {
  const P = AIOS_PROJECTS_FOLDER_ID;
  const aios = () =>
    fakeApi(
      [
        { id: AIOS_ROOT_FOLDER_ID, name: "aios", mimeType: FOLDER_MIME, parents: ["root"] },
        { id: P, name: "projects", mimeType: FOLDER_MIME, parents: [AIOS_ROOT_FOLDER_ID] },
        { id: "existing", name: "Tournament", mimeType: FOLDER_MIME, parents: [P] },
        { id: "existingIn", name: "inputs", mimeType: FOLDER_MIME, parents: ["existing"] },
        { id: "deep", name: "Annex", mimeType: FOLDER_MIME, parents: ["existingIn"] },
        { id: "elsewhere", name: "Personal", mimeType: FOLDER_MIME, parents: ["root"] },
      ],
      {},
      {},
    );

  it("creates only what is missing under the known aios/projects folder", async () => {
    const { api, calls } = aios();
    const first = await ensureProjectFolders(api, "Tournament");
    expect(first.inputFolderId).toBe("existingIn");
    expect(first.created).toEqual(["outputs"]);
    const again = await ensureProjectFolders(api, "Tournament");
    expect(again.created).toEqual([]);
    expect(again.outputFolderId).toBe(first.outputFolderId);
    expect(calls.filter((call) => call.startsWith("create"))).toEqual(["create existing/outputs"]);
    // The aios root is addressed by id, never searched for or created.
    expect(calls.some((call) => call.includes("root"))).toBe(false);
  });

  it("settles on the existing folder when a create fails after it happened", async () => {
    const { api, calls } = aios();
    const uncertain = {
      ...api,
      createFolder: async (parentId: string, name: string) => {
        await api.createFolder(parentId, name);
        throw new Error("Drive request failed (HTTP 503)");
      },
    };
    const made = await ensureProjectFolders(uncertain, "Tournament");
    expect(made.outputFolderId).not.toBe("");
    expect(calls.filter((call) => call.startsWith("create"))).toEqual(["create existing/outputs"]);
  });

  it("gives concurrent runs the same folders", async () => {
    const { api } = aios();
    const [a, b] = await Promise.all([
      ensureProjectFolders(api, "Parallel"),
      ensureProjectFolders(api, "Parallel"),
    ]);
    expect(a.projectFolderId).toBe(b.projectFolderId);
    expect(a.inputFolderId).toBe(b.inputFolderId);
    expect(a.outputFolderId).toBe(b.outputFolderId);
  });

  it("creates the project folder with inputs and outputs under aios/projects", async () => {
    const { api, calls } = aios();
    const made = await ensureProjectFolders(api, " New one ");
    expect(made.created).toEqual(["New one", "inputs", "outputs"]);
    expect(calls.filter((call) => call.startsWith("create"))).toEqual([
      `create ${P}/New one`,
      "create new-New one/inputs",
      "create new-New one/outputs",
    ]);
    await expect(ensureProjectFolders(api, "a/b")).rejects.toThrow(/cannot contain/);
  });

  it("fails clearly, creating nothing, when aios/projects is not reachable", async () => {
    const { api, calls } = fakeApi([], {}, {});
    await expect(ensureProjectFolders(api, "X")).rejects.toThrow(/aios\/projects folder/);
    expect(calls.filter((call) => call.startsWith("create"))).toEqual([]);
  });

  it("scopes folder evaluation to the project's own folders", async () => {
    const { api } = aios();
    const roots = await projectRoots(api, { inputFolderId: "existingIn" });
    expect(roots.sort()).toEqual(["existing", "existingIn"]);
    expect(await isInsideFolders(api, "deep", roots)).toBe(true);
    expect(await isInsideFolders(api, "existingIn", roots)).toBe(true);
    expect(await isInsideFolders(api, "elsewhere", roots)).toBe(false);
    expect(await isInsideFolders(api, P, roots)).toBe(false);
    expect(await isInsideFolders(api, "missing-id", roots)).toBe(false);
    // A configured folder outside aios/projects is not a project folder.
    expect(await projectRoots(api, { inputFolderId: "elsewhere" })).toEqual([]);
    expect(await projectRoots(api, { inputFolderId: P })).toEqual([]);
  });
});

describe("snapshot safety", () => {
  it("refuses to write through a symlinked .ai_os folder", async () => {
    const { api } = tree();
    const worktree = await temp();
    const outside = await temp();
    await fs.symlink(outside, path.join(worktree, ".ai_os"));
    await expect(
      buildSnapshot({
        api,
        store: makeContentStore(await temp()),
        worktree,
        taskId: "t1",
        refs: ["txt1-0000000"],
      }),
    ).rejects.toThrow(/not a plain folder/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("keeps snapshots out of git in a linked worktree too", async () => {
    const main = await temp();
    git(main, "init", "-q");
    git(
      main,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    const linked = path.join(await temp(), "wt");
    git(main, "worktree", "add", "-q", linked);
    const { api } = tree();
    await buildSnapshot({
      api,
      store: makeContentStore(await temp()),
      worktree: linked,
      taskId: "t1",
      refs: ["txt1-0000000"],
    });
    expect(git(linked, "status", "--porcelain")).toBe("");
  });

  it("keeps an original named *.txt apart from its extracted text, even when truncated", async () => {
    const long = `${"n".repeat(120)}.txt`;
    const { api } = fakeApi(
      [{ id: "long1-000000", name: long, mimeType: "text/plain", size: 2 }],
      {},
      { "long1-000000": new TextEncoder().encode("hi") },
    );
    const worktree = await temp();
    const { ref } = await buildSnapshot({
      api,
      store: makeContentStore(await temp()),
      worktree,
      taskId: "t_1",
      refs: ["long1-000000"],
    });
    const [file] = ref.files;
    expect(file!.original).not.toBe(file!.text);
    expect(file!.text).toMatch(/\.text\.txt$/);
    // Task ids map to their own folder: "t_1" and "t:1" never share one.
    expect(ref.root).toBe(".ai_os/drive/t_5f1");
    expect(await verifySnapshot(worktree, ref)).toBeNull();
  });

  it("reads shortcut targets in an attached folder only where the caller allows", async () => {
    const files: DriveFile[] = [
      { id: "fold-000000", name: "In", mimeType: FOLDER_MIME },
      { id: "own1-000000", name: "own.txt", mimeType: "text/plain", size: 1 },
      { id: "ext1-000000", name: "personal.txt", mimeType: "text/plain", size: 1 },
    ];
    const base = fakeApi(files, { "fold-000000": ["own1-000000"] }, {});
    const api: DriveApi = {
      ...base.api,
      // Drive returns the folder's own file plus a shortcut's target.
      listRecursive: async (_id, options) => {
        const out = [{ ...files[1]!, path: "own.txt" }];
        const target = files[2]!;
        if (options?.followShortcut === undefined || (await options.followShortcut(target))) {
          out.push({ ...target, path: "link" });
        } else options.skipped?.({ ...target, path: "link" });
        return out;
      },
    };
    const worktree = await temp();
    const result = await buildSnapshot({
      api,
      store: makeContentStore(await temp()),
      worktree,
      taskId: "t1",
      refs: ["fold-000000"],
      followShortcut: async (target) => target.id !== "ext1-000000",
    });
    expect(result.ref.files.map((file) => file.id)).toEqual(["own1-000000"]);
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    expect(manifest.skippedShortcuts).toEqual([
      { path: "link", id: "ext1-000000", name: "personal.txt" },
    ]);
    expect(base.calls.some((call) => call.includes("ext1"))).toBe(false);
  });

  it("never lets one task's recovery touch another task's snapshot", async () => {
    const { api } = tree();
    const worktree = await temp();
    const store = makeContentStore(await temp());
    await buildSnapshot({ api, store, worktree, taskId: "abc.tmp-x", refs: ["txt1-0000000"] });
    await buildSnapshot({
      api,
      store,
      worktree,
      taskId: "abc",
      refs: ["txt1-0000000"],
      resume: true,
    });
    const names = await fs.readdir(path.join(worktree, ".ai_os", "drive"));
    expect(names.sort()).toEqual([".tmp", "abc", "abc.tmp-x"]);
  });

  it("keeps long multibyte names within the 255-byte filename limit", async () => {
    const name = `${"文".repeat(100)}.docx`;
    const { api } = fakeApi(
      [{ id: "cjk1-0000000", name, mimeType: "text/plain", size: 2 }],
      {},
      { "cjk1-0000000": new TextEncoder().encode("hi") },
    );
    const worktree = await temp();
    const { ref } = await buildSnapshot({
      api,
      store: makeContentStore(await temp()),
      worktree,
      taskId: "t1",
      refs: ["cjk1-0000000"],
    });
    for (const rel of [ref.files[0]!.original, ref.files[0]!.text].filter((r) => r !== undefined)) {
      expect(Buffer.byteLength(path.basename(rel))).toBeLessThanOrEqual(255);
    }
    expect(await verifySnapshot(worktree, ref)).toBeNull();
  });

  it("keeps names with long extensions and long task ids within the filename limit", async () => {
    const name = `${"é".repeat(90)}.${"ü".repeat(110)}`;
    const { api } = fakeApi(
      [{ id: "ext1-0000000", name, mimeType: "application/octet-stream", size: 2 }],
      {},
      { "ext1-0000000": new TextEncoder().encode("hi") },
    );
    const taskId = `a${"_".repeat(127)}`;
    const worktree = await temp();
    const { ref } = await buildSnapshot({
      api,
      store: makeContentStore(await temp()),
      worktree,
      taskId,
      refs: ["ext1-0000000"],
    });
    for (const rel of [ref.root, ...ref.files.flatMap((f) => [f.original, f.text])]) {
      if (rel === undefined) continue;
      for (const part of rel.split("/")) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(255);
    }
    expect(snapshotDirName(taskId)).not.toBe(snapshotDirName(`a${"_".repeat(126)}b`));
    expect(await verifySnapshot(worktree, ref)).toBeNull();
  });

  it("verifies a copy whose name has consecutive dots", async () => {
    const { api } = fakeApi(
      [{ id: "dots-0000000", name: "budget..final.txt", mimeType: "text/plain", size: 2 }],
      {},
      { "dots-0000000": new TextEncoder().encode("hi") },
    );
    const worktree = await temp();
    const { ref } = await buildSnapshot({
      api,
      store: makeContentStore(await temp()),
      worktree,
      taskId: "t1",
      refs: ["dots-0000000"],
    });
    expect(ref.files[0]!.original).toContain("budget..final");
    expect(await verifySnapshot(worktree, ref)).toBeNull();
  });

  it("lets parallel tasks store the same file version", async () => {
    const store = makeContentStore(await temp());
    const put = (text: string) =>
      store.put({
        fileId: "f1",
        version: "v1",
        name: "a.txt",
        mimeType: "text/plain",
        modifiedTime: null,
        md5Checksum: null,
        webViewLink: null,
        kind: "text",
        method: "utf8",
        original: new TextEncoder().encode(text),
        originalExt: "txt",
        text,
        error: null,
      });
    const [first, second] = await Promise.all([put("same"), put("same")]);
    expect(first.meta.sha256).toBe(second.meta.sha256);
    expect(await store.get("f1", "v1")).not.toBeNull();
  });
});

describe("snapshot resume", () => {
  it("reuses a finished snapshot and clears a half-written one", async () => {
    const worktree = await temp();
    const store = makeContentStore(await temp());
    const { api, calls } = fakeApi(
      [
        {
          id: "txt1-0000000",
          name: "a.txt",
          mimeType: "text/plain",
          size: 2,
          modifiedTime: "2026-10-01T00:00:00Z",
        },
      ],
      {},
      { "txt1-0000000": new TextEncoder().encode("hi") },
    );
    // A run cut short by a restart leaves its temp folder behind.
    const stale = path.join(worktree, ".ai_os", "drive", ".tmp", "task-r~1");
    await fs.mkdir(stale, { recursive: true });
    const first = await buildSnapshot({
      api,
      store,
      worktree,
      taskId: "task-r",
      refs: ["txt1-0000000"],
      resume: true,
    });
    expect(
      await fs.stat(stale).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const downloads = calls.filter((call) => call.startsWith("download")).length;
    const again = await buildSnapshot({
      api,
      store,
      worktree,
      taskId: "task-r",
      refs: ["txt1-0000000"],
      resume: true,
    });
    expect(again.ref).toEqual(first.ref);
    expect(calls.filter((call) => call.startsWith("download")).length).toBe(downloads);
    await expect(
      buildSnapshot({ api, store, worktree, taskId: "task-r", refs: ["txt1-0000000"] }),
    ).rejects.toThrow(/already exists/);
    // A different job, or a copy changed since, is never reused.
    await expect(
      buildSnapshot({
        api,
        store,
        worktree,
        taskId: "task-r",
        refs: ["other-000000"],
        resume: true,
      }),
    ).rejects.toThrow(/already exists/);
    const copy = path.join(worktree, first.ref.files[0]!.text!);
    await fs.chmod(copy, 0o644);
    await fs.writeFile(copy, "changed");
    await expect(
      buildSnapshot({
        api,
        store,
        worktree,
        taskId: "task-r",
        refs: ["txt1-0000000"],
        resume: true,
      }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("DriveJobStore", () => {
  it("keeps jobs on disk (mode 600) so running ones resume after a restart", async () => {
    const dir = path.join(await temp(), "drive-jobs");
    const jobs = new DriveJobStore(dir);
    const base = { projectId: "p1", taskId: "t1", refs: ["abcdefghijk"] };
    await jobs.save({
      ...base,
      jobId: "job-aaaaaaaa",
      state: "running",
      done: 1,
      total: 3,
      current: "a",
    });
    await jobs.save({ ...base, jobId: "job-bbbbbbbb", state: "failed", error: "x", status: 502 });
    const reopened = new DriveJobStore(dir);
    expect((await reopened.running()).map((job) => job.jobId)).toEqual(["job-aaaaaaaa"]);
    expect((await fs.stat(path.join(dir, "job-aaaaaaaa.json"))).mode & 0o777).toBe(0o600);
    await reopened.remove("job-bbbbbbbb");
    expect(await reopened.get("job-bbbbbbbb")).toBeNull();
    expect(await reopened.get("../../etc/passwd")).toBeNull();
    expect(() => safeProjectDir("../x")).toThrow(/Invalid project id/);
  });
});
