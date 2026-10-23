// @effect-diagnostics nodeBuiltinImport:off - reads fixture files.
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { extractContent } from "./extract.ts";
import { BiffReader, extractDoc, extractPpt, extractXls } from "./legacyOffice.ts";

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

describe("SST strings across CONTINUE records", () => {
  // Builds one SST string split at `cut` characters, with the CONTINUE width byte.
  const split = (text: string, cut: number, firstWide: boolean, secondWide: boolean) => {
    const enc = (s: string, wide: boolean) =>
      wide
        ? [...s].flatMap((ch) => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8])
        : [...s].map((ch) => ch.charCodeAt(0));
    const head = [text.length & 0xff, text.length >> 8, firstWide ? 1 : 0];
    const first = [...head, ...enc(text.slice(0, cut), firstWide)];
    const second = [
      secondWide ? 1 : 0,
      ...enc(text.slice(cut), secondWide),
      2,
      0,
      0,
      ...enc("ok", false),
    ];
    return new BiffReader(new Uint8Array([...first, ...second]), [first.length]);
  };

  it("reads a compressed string ending its first part exactly at the boundary", () => {
    const reader = split("abcdef", 3, false, false);
    expect(reader.string(2)).toBe("abcdef");
    expect(reader.string(2)).toBe("ok");
  });

  it("follows a width change from compressed to UTF-16", () => {
    const reader = split("abcdé€", 4, false, true);
    expect(reader.string(2)).toBe("abcdé€");
    expect(reader.string(2)).toBe("ok");
  });
});

/** A minimal version-3 compound file with regular-sector streams (each padded to 4096+ bytes). */
const makeCfb = (
  name: string,
  stream: Uint8Array,
  more: ReadonlyArray<[string, Uint8Array]> = [],
) => {
  const SECTOR = 512;
  const blocks = [[name, stream] as const, ...more].map(([blockName, bytes]) => {
    const padded = new Uint8Array(Math.max(4096, Math.ceil(bytes.length / SECTOR) * SECTOR));
    padded.set(bytes);
    return { blockName, padded };
  });
  const data = new Uint8Array(blocks.reduce((sum, b) => sum + b.padded.length, 0));
  const starts: number[] = [];
  let filled = 0;
  for (const b of blocks) {
    starts.push(2 + filled / SECTOR);
    data.set(b.padded, filled);
    filled += b.padded.length;
  }
  const dataSectors = data.length / SECTOR;
  const out = new Uint8Array(SECTOR * (3 + dataSectors));
  const dv = new DataView(out.buffer);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  dv.setUint16(0x18, 0x3e, true);
  dv.setUint16(0x1a, 3, true);
  dv.setUint16(0x1c, 0xfffe, true);
  dv.setUint16(0x1e, 9, true);
  dv.setUint16(0x20, 6, true);
  dv.setUint32(0x2c, 1, true);
  dv.setUint32(0x30, 1, true);
  dv.setUint32(0x38, 4096, true);
  dv.setUint32(0x3c, 0xfffffffe, true);
  dv.setUint32(0x44, 0xfffffffe, true);
  for (let i = 0; i < 109; i += 1) dv.setUint32(0x4c + i * 4, i === 0 ? 0 : 0xffffffff, true);
  const fat = SECTOR; // sector 0
  for (let i = 0; i < 128; i += 1) dv.setUint32(fat + i * 4, 0xffffffff, true);
  dv.setUint32(fat, 0xfffffffd, true);
  dv.setUint32(fat + 4, 0xfffffffe, true);
  for (let s = 0; s < dataSectors; s += 1) {
    const last = starts.includes(3 + s) || s === dataSectors - 1;
    dv.setUint32(fat + (2 + s) * 4, last ? 0xfffffffe : 3 + s, true);
  }
  const dir = SECTOR * 2; // sector 1
  const entry = (index: number, entryName: string, type: number, start: number, size: number) => {
    const base = dir + index * 128;
    for (let c = 0; c < entryName.length; c += 1)
      dv.setUint16(base + c * 2, entryName.charCodeAt(c), true);
    dv.setUint16(base + 64, (entryName.length + 1) * 2, true);
    out[base + 66] = type;
    dv.setUint32(base + 116, start, true);
    dv.setUint32(base + 120, size, true);
  };
  entry(0, "Root Entry", 5, 0xfffffffe, 0);
  blocks.forEach((b, i) => entry(1 + i, b.blockName, 2, starts[i]!, b.padded.length));
  out.set(data, SECTOR * 3);
  return out;
};

const record = (type: number, bytes: number[]) => [
  type & 0xff,
  type >> 8,
  bytes.length & 0xff,
  bytes.length >> 8,
  ...bytes,
];
const u16 = (value: number) => [value & 0xff, value >> 8];
const workbook = (cells: number[], sheetCount = 1) => {
  const bof = (kind: number) =>
    record(0x0809, [...u16(0x0600), ...u16(kind), ...new Array(12).fill(0)]);
  const globalsHead = bof(0x05);
  const sheetName = [2, 0, ...[..."S1"].map((ch) => ch.charCodeAt(0))];
  const boundLength = 4 + 6 + sheetName.length;
  const offset = globalsHead.length + sheetCount * boundLength + 4;
  const bound = record(0x0085, [offset & 0xff, (offset >> 8) & 0xff, 0, 0, 0, 0, ...sheetName]);
  return new Uint8Array([
    ...globalsHead,
    ...Array.from({ length: sheetCount }, () => bound).flat(),
    ...record(0x000a, []),
    ...bof(0x10),
    ...cells,
    ...record(0x000a, []),
  ]);
};
const formulaString = (row: number, col: number) =>
  record(0x0006, [...u16(row), ...u16(col), 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0]);

describe("Excel 97 records", () => {
  it("keeps short formula string results", () => {
    const cells = [
      ...formulaString(0, 0),
      ...record(0x0207, [...u16(1), 0, 0x41]), // "A": four bytes
      ...formulaString(0, 1),
      ...record(0x0207, [...u16(0), 0]), // empty result
      ...formulaString(0, 2),
      ...record(0x0207, [...u16(2), 0, 0x42, 0x43]),
    ];
    expect(extractXls(makeCfb("Workbook", workbook(cells)))).toBe("## Sheet: S1\nA\t\tBC");
  });

  it("rejects a cell past column 255 instead of padding the row", () => {
    const number = record(0x0203, [...u16(0), ...u16(300), 0, 0, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f]);
    expect(() => extractXls(makeCfb("Workbook", workbook(number)))).toThrow(/Broken cell record/);
  });
});

describe("record bounds", () => {
  it("rejects worksheets that share records", () => {
    // Two sheet entries at distinct BOFs, but the first sheet has no EOF of its own.
    const bof = record(0x0809, [...u16(0x0600), ...u16(0x10), ...new Array(12).fill(0)]);
    const cell = record(0x0204, [...u16(0), ...u16(0), ...u16(0), ...u16(1), 0, 0x41]);
    const base = workbook([...cell, ...bof, ...cell], 2);
    // Point the second entry at the inner BOF.
    const second = base.length - 4 - cell.length - bof.length;
    const bytes = new Uint8Array(base);
    const firstBound = 4 + 16 + 4; // globals BOF record, then the first BOUNDSHEET header
    const boundLength = 4 + 6 + 4;
    new DataView(bytes.buffer).setUint32(firstBound + boundLength, second, true);
    expect(() => extractXls(makeCfb("Workbook", bytes))).toThrow(/share/);
  });

  it("rejects sheet entries that repeat one worksheet", () => {
    const cells = record(0x0204, [...u16(0), ...u16(0), ...u16(0), ...u16(1), 0, 0x41]);
    expect(extractXls(makeCfb("Workbook", workbook(cells)))).toBe("## Sheet: S1\nA");
    expect(() => extractXls(makeCfb("Workbook", workbook(cells, 3000)))).toThrow(
      /share one worksheet/,
    );
  });

  it("reads a formula string result that goes on in a CONTINUE record", () => {
    const cells = [
      ...formulaString(0, 0),
      ...record(0x0207, [...u16(4), 0, 0x41, 0x42]),
      ...record(0x003c, [0, 0x43, 0x44]),
    ];
    expect(extractXls(makeCfb("Workbook", workbook(cells)))).toBe("## Sheet: S1\nABCD");
  });

  it("keeps the current-edit slide list inside its document and slide list", () => {
    const rec = (verInst: number, type: number, body: number[], declared = body.length) => [
      ...u16(verInst),
      ...u16(type),
      declared & 0xff,
      declared >> 8,
      0,
      0,
      ...body,
    ];
    const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
    const build = (docLen: number | undefined, listLen: number | undefined, slideRefs = [99]) => {
      const slideAtom = slideRefs.flatMap((ref) => rec(0, 0x03f3, u32(ref)));
      const atom = rec(0, 0x0fa8, [0x61, 0x62, 0x63]);
      const list = rec(0x0f, 0x0ff0, [...slideAtom, ...atom], listLen);
      const doc = rec(0x0f, 0x03e8, list, docLen);
      const dirAt = doc.length;
      const directory = rec(0, 0x1772, [...u32((1 << 20) | 1), ...u32(0)]);
      const editAt = dirAt + directory.length;
      const edit = rec(0, 0x0ff5, [...u32(0), ...u32(0), ...u32(0), ...u32(dirAt), ...u32(1)]);
      const current = new Uint8Array(20);
      new DataView(current.buffer).setUint32(16, editAt, true);
      return extractPpt(
        makeCfb("PowerPoint Document", new Uint8Array([...doc, ...directory, ...edit]), [
          ["Current User", current],
        ]),
      );
    };
    const slideAtomLength = 12;
    expect(build(undefined, undefined)).toContain("abc");
    // The list claims more than the document holds.
    expect(build(8, undefined)).not.toContain("abc");
    // The atom runs past its slide list.
    expect(build(undefined, slideAtomLength + 4)).not.toContain("abc");
    // Many slides naming one drawing are refused, not read again and again.
    expect(() => build(undefined, undefined, new Array(500).fill(1))).toThrow(/share one drawing/);
  });

  it("does not let a PowerPoint record run past its container", () => {
    const atom = (text: string) => [
      0,
      0,
      0xa8,
      0x0f,
      text.length,
      0,
      0,
      0,
      ...[...text].map((ch) => ch.charCodeAt(0)),
    ];
    const container = (declared: number, body: number[]) => [
      0x0f,
      0x00,
      0xf0,
      0x0f,
      declared & 0xff,
      declared >> 8,
      0,
      0,
      ...body,
    ];
    const ppt = (bytes: number[]) =>
      extractPpt(makeCfb("PowerPoint Document", new Uint8Array(bytes)));
    expect(ppt(container(11, atom("abc")))).toContain("abc");
    expect(() => ppt(container(4, atom("abc")))).toThrow(/No slide text/);
  });
});
