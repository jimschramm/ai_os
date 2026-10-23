import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decodeContextPackageSnapshotV1 } from "./assignment.ts";
import { describeDriveSize } from "./drive.ts";

const base = {
  requirements: "Score it.",
  memoryVersions: [],
  repoCommit: "ab".repeat(20),
  authorizationScope: "usba",
  createdAt: "2026-10-23T10:00:00.000Z",
};

const manifest = {
  root: ".ai_os/drive/t1",
  manifestSha256: "c".repeat(64),
  totalFiles: 1,
  totalBytes: 5_000_000_000,
  failedFiles: 0,
  files: [
    {
      id: "abcdefghij",
      name: "Big.pdf",
      drivePath: "RFP/Big.pdf",
      kind: "text",
      bytes: 5_000_000_000,
      text: ".ai_os/drive/t1/0001-Big.pdf.txt",
    },
  ],
  sources: ["https://drive.google.com/drive/folders/abcdefghij"],
};

it.effect("context packages decode with and without a Drive manifest, with no size cap", () =>
  Effect.gen(function* () {
    yield* decodeContextPackageSnapshotV1(base);
    const decoded = yield* decodeContextPackageSnapshotV1({ ...base, driveManifest: manifest });
    assert.strictEqual(decoded.driveManifest?.totalBytes, 5_000_000_000);
  }),
);

it.effect("rejects snapshot paths outside the worktree", () =>
  Effect.gen(function* () {
    for (const root of ["/etc", "../x", ".ai_os/../../x", "a\\b"]) {
      const exit = yield* Effect.exit(
        decodeContextPackageSnapshotV1({ ...base, driveManifest: { ...manifest, root } }),
      );
      assert.equal(Exit.isFailure(exit), true, root);
    }
  }),
);

it("describes Drive totals", () => {
  assert.strictEqual(describeDriveSize(1, 512), "1 file, 512 B");
  assert.strictEqual(describeDriveSize(3, 1_258_291), "3 files, 1.2 MB");
});
