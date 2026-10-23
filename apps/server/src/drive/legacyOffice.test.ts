// @effect-diagnostics nodeBuiltinImport:off - reads fixture files.
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { extractContent } from "./extract.ts";
import { extractDoc, extractPpt, extractXls } from "./legacyOffice.ts";

const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures", name)));

describe("legacy Office text", () => {
  it("reads a Word 97 document with a table", () => {
    expect(extractDoc(fixture("simple-table.doc"))).toBe(
      [
        "This is a Word document that was created using Word 97 – SR2.  It contains a paragraph, a table consisting of 2 rows and 3 columns and a final paragraph.",
        "Cell 1,1 | Cell 1,2 | Cell 1,3",
        "Cell 2,1 | Cell 2,2 | Cell 2,3",
        "This text is below the table.",
      ].join("\n"),
    );
  });

  it("reads every sheet of an Excel 97 workbook", () => {
    const text = extractXls(fixture("SampleSS.xls"));
    expect(text).toContain("## Sheet: First Sheet\nTest spreadsheet\n2nd row\t2nd row 2nd column");
    expect(text).toContain("## Sheet: Sheet Number 2");
    expect(text).toContain("cb=1\tcb=10\tcb=2\tcb=sum\n1\t10\t2\t13");
    expect(text).toContain("## Sheet: Sheet3");
  });

  it("reads PowerPoint 97 slides once each, in order, then notes, without master text", () => {
    const text = extractPpt(fixture("basic_test_ppt_file.ppt"));
    expect(text).toBe(
      [
        "## Slide 1\nThis is a test title\nThis is a test subtitle\nThis is on page 1",
        "## Slide 2\nThis is the title on page 2\nThis is page two\nIt has several blocks of text\nNone of them have formatting",
        "## Notes\nThese are the notes for page 1\nThese are the notes on page two, again lacking formatting",
      ].join("\n\n"),
    );
    expect(text).not.toContain("Click to edit Master");
  });

  it("routes legacy files through extractContent and records failures", async () => {
    const doc = await extractContent({
      name: "a.doc",
      mimeType: "application/msword",
      bytes: fixture("simple-table.doc"),
    });
    expect(doc).toMatchObject({ kind: "text", method: "doc" });
    const broken = await extractContent({
      name: "b.xls",
      mimeType: "application/vnd.ms-excel",
      bytes: new TextEncoder().encode("<html>not really excel</html>"),
    });
    expect(broken).toMatchObject({
      kind: "file",
      method: "xls",
      error: "Not an Office 97-2003 file.",
    });
    const truncated = await extractContent({
      name: "c.ppt",
      mimeType: "application/vnd.ms-powerpoint",
      bytes: fixture("basic_test_ppt_file.ppt").subarray(0, 600),
    });
    expect(truncated.kind).toBe("file");
    expect(truncated.error).toBeDefined();
  });
});
