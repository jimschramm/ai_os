import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";

import { nextProjectDriveSettings } from "./drive.ts";

const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-12345";
const OTHER = "0ZyXwVuTsRqPoNmLkJiHgFeDcBa_-98765";
const flags = (over: Partial<Parameters<typeof nextProjectDriveSettings>[1]> = {}) => ({
  output: Option.none<string>(),
  input: Option.none<string>(),
  clearInput: false,
  disable: false,
  ...over,
});

describe("drive project flags", () => {
  it("parses pasted links and turns Drive on", () => {
    expect(
      nextProjectDriveSettings(
        undefined,
        flags({ output: Option.some(`https://drive.google.com/drive/folders/${ID}?usp=sharing`) }),
      ),
    ).toEqual({ enabled: true, outputFolderId: ID });
  });

  it("keeps folders it was not told to change, and input stays optional", () => {
    const current = { enabled: true, outputFolderId: ID, inputFolderId: OTHER };
    expect(nextProjectDriveSettings(current, flags({ clearInput: true }))).toEqual({
      enabled: true,
      outputFolderId: ID,
    });
    expect(nextProjectDriveSettings(current, flags({ disable: true }))).toEqual({
      ...current,
      enabled: false,
    });
  });

  it("rejects links that are not Drive folders", () => {
    expect(
      nextProjectDriveSettings(
        undefined,
        flags({ output: Option.some(`https://docs.google.com/document/d/${ID}/edit`) }),
      ),
    ).toMatch(/Not a Google Drive folder/);
  });
});
