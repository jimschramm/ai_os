import { describe, expect, it } from "vite-plus/test";
import { ProjectId, applyProjectDriveUpdate, resolveProjectDriveUpdate } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-12345";
const OTHER = "0ZyXwVuTsRqPoNmLkJiHgFeDcBa_-98765";
const change = (
  over: Partial<Parameters<typeof resolveProjectDriveUpdate>[0]> = {},
): Parameters<typeof resolveProjectDriveUpdate>[0] => ({
  clearInput: false,
  clearOutput: false,
  disable: false,
  ...over,
});
const apply = (
  current: Parameters<typeof applyProjectDriveUpdate>[0],
  over: Partial<Parameters<typeof resolveProjectDriveUpdate>[0]> = {},
) => {
  const resolved = resolveProjectDriveUpdate(change(over));
  if ("invalidLink" in resolved) throw new Error(resolved.invalidLink);
  return applyProjectDriveUpdate(current, resolved);
};

describe("drive project flags", () => {
  it("parses pasted links and turns Drive on", () => {
    expect(
      apply(undefined, { output: `https://drive.google.com/drive/folders/${ID}?usp=sharing` }),
    ).toEqual({ enabled: true, outputFolderId: ID });
  });

  it("keeps folders it was not told to change, and input stays optional", () => {
    const current = { enabled: true, outputFolderId: ID, inputFolderId: OTHER };
    expect(apply(current, { clearInput: true })).toEqual({ enabled: true, outputFolderId: ID });
    expect(apply(current, { clearOutput: true })).toEqual({ enabled: true, inputFolderId: OTHER });
    expect(apply(current, { disable: true })).toEqual({ ...current, enabled: false });
  });

  it("rejects links that are not Drive folders before anything is applied", () => {
    expect(
      resolveProjectDriveUpdate(
        change({ output: `https://docs.google.com/document/d/${ID}/edit` }),
      ),
    ).toEqual({ invalidLink: `https://docs.google.com/document/d/${ID}/edit` });
  });
});

describe("ServerSettingsService.updateProjectDrive", () => {
  it("changes only drive, and concurrent drive changes never overwrite each other", async () => {
    const project = ProjectId.make("p-drive-test");
    const base = { clearInput: false, clearOutput: false, disable: false };
    const entry = await Effect.runPromise(
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({
          projectSettingsOverrides: { [project]: { defaultAutoPull: true } },
        });
        yield* Effect.all(
          [
            settings.updateProjectDrive(project, { ...base, outputFolderId: ID }),
            settings.updateProjectDrive(project, { ...base, inputFolderId: OTHER }),
          ],
          { concurrency: "unbounded" },
        );
        return (yield* settings.getSettings).projectSettingsOverrides[project];
      }).pipe(Effect.provide(ServerSettings.layerTest())),
    );
    expect(entry).toEqual({
      defaultAutoPull: true,
      drive: { enabled: true, outputFolderId: ID, inputFolderId: OTHER },
    });
  });
});
