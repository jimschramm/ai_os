import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProjectDriveSettings, parseDriveFolderId } from "./drive.ts";
import { ProjectSettingsOverrides } from "./settings.ts";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-12345";

describe("parseDriveFolderId", () => {
  it.each([
    ID,
    `  ${ID}  `,
    `https://drive.google.com/drive/folders/${ID}`,
    `https://drive.google.com/drive/u/1/folders/${ID}?usp=sharing`,
    `https://drive.google.com/drive/folders/${ID}#x`,
    `https://drive.google.com/open?id=${ID}`,
  ])("accepts %s", (input) => {
    expect(parseDriveFolderId(input)).toBe(ID);
  });

  it.each([
    "",
    "short",
    `https://docs.google.com/document/d/${ID}/edit`,
    `https://drive.google.com/file/d/${ID}/view`,
    `http://drive.google.com/drive/folders/${ID}`,
    `https://evil.example/drive/folders/${ID}`,
    `https://drive.google.com.evil.example/drive/folders/${ID}`,
    "not a url at all !!",
  ])("rejects %s", (input) => {
    expect(parseDriveFolderId(input)).toBeNull();
  });
});

describe("project drive setting", () => {
  it("decodes with only enabled, and with both folders", () => {
    const decode = Schema.decodeUnknownSync(ProjectDriveSettings);
    expect(decode({ enabled: true })).toEqual({ enabled: true });
    expect(decode({ enabled: false, inputFolderId: ID, outputFolderId: ID })).toMatchObject({
      outputFolderId: ID,
    });
    expect(() => decode({ enabled: true, outputFolderId: "bad id!" })).toThrow();
  });

  it("is accepted in project overrides", () => {
    const decoded = Schema.decodeUnknownSync(ProjectSettingsOverrides)({
      drive: { enabled: true, outputFolderId: ID },
    });
    expect(decoded.drive).toEqual({ enabled: true, outputFolderId: ID });
  });
});
