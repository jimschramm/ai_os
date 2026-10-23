// @effect-diagnostics nodeBuiltinImport:off globalDate:off - uses a temp dir as the content store and worktree.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeContentStore } from "./ContentStore.ts";
import { type DriveApi, type DriveFile, FOLDER_MIME } from "./DriveApi.ts";
import { buildSnapshot, readDriveFile, verifySnapshot } from "./DriveReader.ts";
import { ensureProjectFolders } from "./projectFolders.ts";
import { makeZip } from "./testZip.ts";

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
    await fs.mkdir(path.join(worktree, ".git", "info"), { recursive: true });
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
  const aios = () =>
    fakeApi(
      [
        { id: "aios1", name: "aios", mimeType: FOLDER_MIME, parents: ["root"] },
        { id: "projects1", name: "projects", mimeType: FOLDER_MIME, parents: ["aios1"] },
        { id: "existing", name: "Tournament", mimeType: FOLDER_MIME, parents: ["projects1"] },
        { id: "existingIn", name: "inputs", mimeType: FOLDER_MIME, parents: ["existing"] },
      ],
      {},
      {},
    );

  it("creates only what is missing and reuses the rest", async () => {
    const { api, calls } = aios();
    const first = await ensureProjectFolders(api, "Tournament");
    expect(first.inputFolderId).toBe("existingIn");
    expect(first.created).toEqual(["outputs"]);
    const again = await ensureProjectFolders(api, "Tournament");
    expect(again.created).toEqual([]);
    expect(again.outputFolderId).toBe(first.outputFolderId);
    expect(calls.filter((call) => call.startsWith("create"))).toEqual(["create existing/outputs"]);
  });

  it("creates the project folder with inputs and outputs under aios/projects", async () => {
    const { api, calls } = aios();
    const made = await ensureProjectFolders(api, " New one ");
    expect(made.created).toEqual(["New one", "inputs", "outputs"]);
    expect(calls).toEqual([
      "create projects1/New one",
      "create new-New one/inputs",
      "create new-New one/outputs",
    ]);
  });

  it("fails clearly when the aios folder is missing", async () => {
    const { api } = fakeApi([], {}, {});
    await expect(ensureProjectFolders(api, "X")).rejects.toThrow(/No "aios" folder/);
  });
});
