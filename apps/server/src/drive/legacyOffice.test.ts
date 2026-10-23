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
  /** A stream inside an embedded "ObjectPool" storage, listed before the root's own. */
  nested?: [string, Uint8Array],
) => {
  const SECTOR = 512;
  const blocks = [...(nested === undefined ? [] : [nested]), [name, stream] as const, ...more].map(
    ([blockName, bytes]) => {
      const padded = new Uint8Array(Math.max(4096, Math.ceil(bytes.length / SECTOR) * SECTOR));
      padded.set(bytes);
      return { blockName, padded };
    },
  );
  const data = new Uint8Array(blocks.reduce((sum, b) => sum + b.padded.length, 0));
  const dataSectors = data.length / SECTOR;
  // As many FAT sectors as the file needs (up to the 109 the header lists).
  let fatSectors = 1;
  while (fatSectors * 128 < fatSectors + 1 + dataSectors) fatSectors += 1;
  if (fatSectors > 109) throw new Error("test file too large");
  const dirSector = fatSectors;
  const firstData = fatSectors + 1;
  const starts: number[] = [];
  let filled = 0;
  for (const b of blocks) {
    starts.push(firstData + filled / SECTOR);
    data.set(b.padded, filled);
    filled += b.padded.length;
  }
  const out = new Uint8Array(SECTOR * (1 + firstData + dataSectors));
  const dv = new DataView(out.buffer);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  dv.setUint16(0x18, 0x3e, true);
  dv.setUint16(0x1a, 3, true);
  dv.setUint16(0x1c, 0xfffe, true);
  dv.setUint16(0x1e, 9, true);
  dv.setUint16(0x20, 6, true);
  dv.setUint32(0x2c, fatSectors, true);
  dv.setUint32(0x30, dirSector, true);
  dv.setUint32(0x38, 4096, true);
  dv.setUint32(0x3c, 0xfffffffe, true);
  dv.setUint32(0x44, 0xfffffffe, true);
  for (let i = 0; i < 109; i += 1)
    dv.setUint32(0x4c + i * 4, i < fatSectors ? i : 0xffffffff, true);
  const fat = SECTOR; // FAT sectors start at sector 0
  for (let i = 0; i < fatSectors * 128; i += 1) dv.setUint32(fat + i * 4, 0xffffffff, true);
  for (let i = 0; i < fatSectors; i += 1) dv.setUint32(fat + i * 4, 0xfffffffd, true);
  dv.setUint32(fat + dirSector * 4, 0xfffffffe, true);
  for (let s = 0; s < dataSectors; s += 1) {
    const sector = firstData + s;
    const last = starts.includes(sector + 1) || s === dataSectors - 1;
    dv.setUint32(fat + sector * 4, last ? 0xfffffffe : sector + 1, true);
  }
  const dir = SECTOR * (1 + dirSector);
  const NONE = 0xffffffff;
  const entry = (
    index: number,
    entryName: string,
    type: number,
    start: number,
    size: number,
    links: { right?: number; child?: number } = {},
  ) => {
    const base = dir + index * 128;
    dv.setUint32(base + 68, NONE, true);
    dv.setUint32(base + 72, links.right ?? NONE, true);
    dv.setUint32(base + 76, links.child ?? NONE, true);
    for (let c = 0; c < entryName.length; c += 1)
      dv.setUint16(base + c * 2, entryName.charCodeAt(c), true);
    dv.setUint16(base + 64, (entryName.length + 1) * 2, true);
    out[base + 66] = type;
    dv.setUint32(base + 116, start, true);
    dv.setUint32(base + 120, size, true);
  };
  // Root's children chained through right-sibling links.
  const top = blocks.length - (nested === undefined ? 0 : 1);
  const firstTop = nested === undefined ? 1 : 3;
  if (firstTop + top > 4) throw new Error("test directory holds four entries");
  entry(0, "Root Entry", 5, 0xfffffffe, 0, { child: nested === undefined ? 1 : 2 });
  if (nested !== undefined) {
    entry(1, nested[0], 2, starts[0]!, blocks[0]!.padded.length);
    entry(2, "ObjectPool", 1, 0, 0, { child: 1, right: 3 });
  }
  blocks.slice(nested === undefined ? 0 : 1).forEach((b, i) =>
    entry(
      firstTop + i,
      b.blockName,
      2,
      starts[i + (nested === undefined ? 0 : 1)]!,
      b.padded.length,
      {
        ...(i + 1 < top ? { right: firstTop + i + 1 } : {}),
      },
    ),
  );
  out.set(data, SECTOR * (1 + firstData));
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

  it("rejects a sheet whose offset does not land on a worksheet BOF", () => {
    const good = workbook([]);
    const offsetAt = 20 + 4; // globals BOF, then the BOUNDSHEET record header
    const offset = good[offsetAt]! | (good[offsetAt + 1]! << 8);
    const off = good.slice();
    off[offsetAt] = (offset + 1) & 0xff;
    expect(() => extractXls(makeCfb("Workbook", off))).toThrow(/points to no worksheet/);
    const chart = good.slice();
    chart[offset + 4 + 2] = 0x20; // BOF dt: chart, not a worksheet
    expect(() => extractXls(makeCfb("Workbook", chart))).toThrow(/does not point to a worksheet/);
  });

  it("reads the root storage's Workbook, not an embedded document's", () => {
    const cell = (text: string) => [
      ...formulaString(0, 0),
      ...record(0x0207, [...u16(text.length), 0, ...[...text].map((ch) => ch.charCodeAt(0))]),
    ];
    const bytes = makeCfb(
      "Workbook",
      workbook(cell("ROOT")),
      [],
      ["Workbook", workbook(cell("EMBED"))],
    );
    expect(extractXls(bytes)).toBe("## Sheet: S1\nROOT");
  });

  it("rejects a cell past column 255 instead of padding the row", () => {
    const number = record(0x0203, [...u16(0), ...u16(300), 0, 0, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f]);
    expect(() => extractXls(makeCfb("Workbook", workbook(number)))).toThrow(/Broken cell record/);
  });
});

describe("record bounds", () => {
  it("rejects a sector chain that points past the end of the file", () => {
    const cells = record(0x0204, [...u16(0), ...u16(0), ...u16(0), ...u16(1), 0, 0x41]);
    const bytes = makeCfb("Workbook", workbook(cells));
    // FAT entry of the first data sector -> a sector far beyond the file.
    new DataView(bytes.buffer).setUint32(512 + 2 * 4, 5_000_000, true);
    expect(() => extractXls(bytes)).toThrow(/Broken sector chain/);
  });

  it("reads many short strings across many CONTINUE boundaries in linear time", () => {
    const count = 40_000;
    const parts: number[] = [];
    const boundaries: number[] = [];
    for (let i = 0; i < count; i += 1) {
      if (i > 0) boundaries.push(parts.length);
      parts.push(1, 0, 0, 0x61);
    }
    const reader = new BiffReader(new Uint8Array(parts), boundaries);
    const started = performance.now();
    for (let i = 0; i < count; i += 1) expect(reader.string(2)).toBe("a");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("reads compressed BIFF bytes 0x80-0x9f as their own code points across a CONTINUE", () => {
    const first = [...u16(2), 0, 0x80];
    const second = [0, 0x9f];
    const reader = new BiffReader(new Uint8Array([...first, ...second]), [first.length]);
    expect(reader.string(2)).toBe("\u0080\u009f");
  });

  it("refuses slides whose drawings overlap", () => {
    const rec = (verInst: number, type: number, body: number[]) => [
      ...u16(verInst),
      ...u16(type),
      body.length & 0xff,
      body.length >> 8,
      0,
      0,
      ...body,
    ];
    const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
    // Drawing B sits inside drawing A; slide 1 names A, slide 2 names B.
    const inner = rec(0x0f, 0x03ee, rec(0, 0x0fa8, [0x61]));
    const outer = rec(0x0f, 0x03ee, inner);
    const slides = rec(0x0f, 0x0ff0, [...rec(0, 0x03f3, u32(2)), ...rec(0, 0x03f3, u32(3))]);
    const doc = rec(0x0f, 0x03e8, slides);
    const outerAt = doc.length;
    const dirAt = outerAt + outer.length;
    const directory = rec(0, 0x1772, [
      ...u32((3 << 20) | 1),
      ...u32(0),
      ...u32(outerAt),
      ...u32(outerAt + 8),
    ]);
    const editAt = dirAt + directory.length;
    const edit = rec(0, 0x0ff5, [...u32(0), ...u32(0), ...u32(0), ...u32(dirAt), ...u32(1)]);
    const current = new Uint8Array(20);
    new DataView(current.buffer).setUint32(16, editAt, true);
    expect(() =>
      extractPpt(
        makeCfb("PowerPoint Document", new Uint8Array([...doc, ...outer, ...directory, ...edit]), [
          ["Current User", current],
        ]),
      ),
    ).toThrow(/share one drawing/);
  });

  it("reads a thousand separate slide drawings in linear time", () => {
    const rec = (verInst: number, type: number, body: number[]) => [
      ...u16(verInst),
      ...u16(type),
      body.length & 0xff,
      (body.length >> 8) & 0xff,
      (body.length >> 16) & 0xff,
      0,
      ...body,
    ];
    const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
    // The test compound file has one FAT sector (about 60 KB of streams).
    const count = 1000;
    const drawing = rec(0x0f, 0x03ee, rec(0, 0x0fa8, [0x61]));
    const slides = rec(
      0x0f,
      0x0ff0,
      Array.from({ length: count }, (_, k) => rec(0, 0x03f3, u32(k + 2))).flat(),
    );
    const doc = rec(0x0f, 0x03e8, slides);
    const drawingsAt = doc.length;
    const drawings = new Array(count).fill(drawing).flat();
    const dirAt = drawingsAt + drawings.length;
    const directory = rec(0, 0x1772, [
      ...u32(((count + 1) << 20) | 1),
      ...u32(0),
      ...Array.from({ length: count }, (_, k) => u32(drawingsAt + k * drawing.length)).flat(),
    ]);
    const edit = rec(0, 0x0ff5, [...u32(0), ...u32(0), ...u32(0), ...u32(dirAt), ...u32(1)]);
    const current = new Uint8Array(20);
    new DataView(current.buffer).setUint32(16, dirAt + directory.length, true);
    const started = performance.now();
    const text = extractPpt(
      makeCfb("PowerPoint Document", new Uint8Array([...doc, ...drawings, ...directory, ...edit]), [
        ["Current User", current],
      ]),
    );
    expect(text).toContain(`## Slide ${count}\na`);
    expect(performance.now() - started).toBeLessThan(2_000);
    // Drawings stored in reverse slide order are checked as fast (one sort, not inserts).
    const reversed = rec(0, 0x1772, [
      ...u32(((count + 1) << 20) | 1),
      ...u32(0),
      ...Array.from({ length: count }, (_, k) =>
        u32(drawingsAt + (count - 1 - k) * drawing.length),
      ).flat(),
    ]);
    const startedReverse = performance.now();
    const reverseText = extractPpt(
      makeCfb("PowerPoint Document", new Uint8Array([...doc, ...drawings, ...reversed, ...edit]), [
        ["Current User", current],
      ]),
    );
    expect(reverseText).toContain(`## Slide ${count}\na`);
    expect(performance.now() - startedReverse).toBeLessThan(2_000);
  });

  it("rejects a PowerPoint edit chain that loops", () => {
    const rec = (type: number, body: number[]) => [
      0,
      0,
      ...u16(type),
      body.length & 0xff,
      body.length >> 8,
      0,
      0,
      ...body,
    ];
    const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
    const directory = rec(0x1772, [...u32((1 << 20) | 1), ...u32(0)]);
    const editA = directory.length;
    const editB = editA + 28;
    const edit = (previous: number) =>
      rec(0x0ff5, [...u32(0), ...u32(0), ...u32(previous), ...u32(0), ...u32(1)]);
    const current = new Uint8Array(20);
    new DataView(current.buffer).setUint32(16, editA, true);
    const stream = new Uint8Array([...directory, ...edit(editB), ...edit(editA)]);
    expect(() =>
      extractPpt(makeCfb("PowerPoint Document", stream, [["Current User", current]])),
    ).toThrow(/edit chain loops/);
    // Two edits naming overlapping directories (one starts inside the other).
    const innerBody = new Array(64).fill(0);
    const outer = rec(0x1772, [0, 0, 0x72, 0x17, 56, 0, 0, 0, ...innerBody.slice(8)]);
    const overlapEdits = [
      rec(0x0ff5, [...u32(0), ...u32(0), ...u32(outer.length + 28), ...u32(0), ...u32(1)]),
      rec(0x0ff5, [...u32(0), ...u32(0), ...u32(0), ...u32(8), ...u32(1)]),
    ].flat();
    const top = new Uint8Array(20);
    new DataView(top.buffer).setUint32(16, outer.length, true);
    expect(() =>
      extractPpt(
        makeCfb("PowerPoint Document", new Uint8Array([...outer, ...overlapEdits]), [
          ["Current User", top],
        ]),
      ),
    ).toThrow(/directories overlap/);
    // Thousands of distinct edits sharing one large directory: it is read once.
    const big = rec(0x1772, [
      ...u32((4000 << 20) | 1),
      ...new Array(4000).fill(0).flatMap(() => u32(0)),
    ]);
    const edits = 3000;
    const chainAt = (k: number) => big.length + k * 28;
    const chainEdits = Array.from({ length: edits }, (_, k) =>
      rec(0x0ff5, [
        ...u32(0),
        ...u32(0),
        ...u32(k + 1 < edits ? chainAt(k + 1) : 0),
        ...u32(0),
        ...u32(1),
      ]),
    ).flat();
    const head = new Uint8Array(20);
    new DataView(head.buffer).setUint32(16, chainAt(0), true);
    const started = performance.now();
    expect(() =>
      extractPpt(
        makeCfb("PowerPoint Document", new Uint8Array([...big, ...chainEdits]), [
          ["Current User", head],
        ]),
      ),
    ).toThrow(/No slide text/);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

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

  it("follows a long PowerPoint edit chain to the directory that resolves the document", () => {
    const rec = (verInst: number, type: number, body: number[]) => [
      ...u16(verInst),
      ...u16(type),
      body.length & 0xff,
      body.length >> 8,
      0,
      0,
      ...body,
    ];
    const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
    const atom = rec(0, 0x0fa8, [0x61, 0x62, 0x63]);
    const doc = rec(0x0f, 0x03e8, rec(0x0f, 0x0ff0, [...rec(0, 0x03f3, u32(99)), ...atom]));
    // Text no current record reaches: only a fallback scan would show it.
    const stale = rec(0x0f, 0x0ff0, rec(0, 0x0fa8, [0x6f, 0x6c, 0x64]));
    const dirAt = doc.length + stale.length;
    const directory = rec(0, 0x1772, [...u32((1 << 20) | 1), ...u32(0)]);
    const emptyAt = dirAt + directory.length;
    const empty = rec(0, 0x1772, []);
    const firstEdit = emptyAt + empty.length;
    const count = 5_000;
    const edits: number[] = [];
    for (let k = 0; k < count; k += 1) {
      const previous = k === 0 ? 0 : firstEdit + (k - 1) * 28;
      edits.push(
        ...rec(0, 0x0ff5, [
          ...u32(0),
          ...u32(0),
          ...u32(previous),
          ...u32(k === 0 ? dirAt : emptyAt),
          ...u32(1),
        ]),
      );
    }
    const current = new Uint8Array(20);
    new DataView(current.buffer).setUint32(16, firstEdit + (count - 1) * 28, true);
    const text = extractPpt(
      makeCfb(
        "PowerPoint Document",
        new Uint8Array([...doc, ...stale, ...directory, ...empty, ...edits]),
        [["Current User", current]],
      ),
    );
    expect(text).toContain("abc");
    expect(text).not.toContain("old");
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
    // No depth cutoff: text 200 containers deep is still read.
    let deep = atom("deep");
    for (let level = 0; level < 200; level += 1) deep = container(deep.length, deep);
    expect(ppt(deep)).toContain("deep");
  });

  it("reads a container holding more text atoms than a call can take as arguments", () => {
    const count = 300_000;
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    // Four distinct letters per atom, so no two atoms repeat.
    const word = (k: number) =>
      [0, 1, 2, 3].map((d) => letters[Math.floor(k / 52 ** d) % 52]!).join("");
    const body = new Uint8Array(count * 12);
    for (let k = 0; k < count; k += 1) {
      // TextBytesAtom (0x0fa8) of four characters.
      body.set([0, 0, 0xa8, 0x0f, 4, 0, 0, 0, ...[...word(k)].map((c) => c.charCodeAt(0))], k * 12);
    }
    const stream = new Uint8Array(8 + body.length);
    new DataView(stream.buffer).setUint32(4, body.length, true);
    stream.set([0x0f, 0x00, 0xf0, 0x0f], 0);
    stream.set(body, 8);
    const text = extractPpt(makeCfb("PowerPoint Document", stream));
    expect(text).toContain(word(0));
    expect(text).toContain(word(count - 1));
    expect(text.split("\n").filter((line) => line.length === 4).length).toBe(count);
  });
});
