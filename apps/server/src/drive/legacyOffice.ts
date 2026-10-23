/**
 * Text from legacy binary Office files (.doc, .xls, .ppt): Compound File
 * Binary containers read in plain TypeScript, no dependencies. Pure functions
 * over bytes; malformed input throws an Error with a short message, which
 * extractContent records on the file.
 */

const ENDOFCHAIN = 0xfffffffe;
const MAX_REGULAR_SECTOR = 0xfffffffa;

export interface CompoundFile {
  readonly streams: ReadonlyMap<string, Uint8Array>;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Reads every stream of a CFB file into memory, keyed by stream name. */
export const readCompoundFile = (bytes: Uint8Array): CompoundFile => {
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length < 512 || signature.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("Not an Office 97-2003 file.");
  }
  const dv = view(bytes);
  const sectorShift = dv.getUint16(0x1e, true);
  const miniShift = dv.getUint16(0x20, true);
  if ((sectorShift !== 9 && sectorShift !== 12) || miniShift !== 6) {
    throw new Error("Bad sector size.");
  }
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const sectorCount = Math.ceil(bytes.length / sectorSize);
  const sector = (id: number) => {
    const start = (id + 1) * sectorSize;
    if (id > MAX_REGULAR_SECTOR || start >= bytes.length) throw new Error("Sector out of range.");
    return bytes.subarray(start, Math.min(start + sectorSize, bytes.length));
  };
  const perSector = sectorSize / 4;
  // DIFAT: 109 entries in the header, then a chain of DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i += 1) {
    const id = dv.getUint32(0x4c + i * 4, true);
    if (id <= MAX_REGULAR_SECTOR) fatSectors.push(id);
  }
  let difat = dv.getUint32(0x44, true);
  const difatSeen = new Set<number>();
  while (difat <= MAX_REGULAR_SECTOR) {
    if (difatSeen.has(difat)) throw new Error("Broken sector chain.");
    difatSeen.add(difat);
    const data = view(sector(difat));
    for (let i = 0; i < perSector - 1; i += 1) {
      const id = data.getUint32(i * 4, true);
      if (id <= MAX_REGULAR_SECTOR) fatSectors.push(id);
    }
    difat = data.getUint32((perSector - 1) * 4, true);
  }
  // Each FAT sector once, and no more of them than the file holds.
  if (new Set(fatSectors).size !== fatSectors.length || fatSectors.length > sectorCount) {
    throw new Error("Broken sector table.");
  }
  const fat: number[] = [];
  for (const id of fatSectors) {
    const data = view(sector(id));
    for (let i = 0; i < data.byteLength / 4; i += 1) fat.push(data.getUint32(i * 4, true));
  }
  /**
   * Sector ids of a chain; loops, over-long chains and sectors past the end of
   * the data (`limit` sectors exist) are errors, found before anything is allocated.
   */
  const chain = (start: number, table: readonly number[], limit: number) => {
    const ids: number[] = [];
    const seen = new Set<number>();
    for (let id = start; id !== ENDOFCHAIN; id = table[id] ?? ENDOFCHAIN) {
      if (id > MAX_REGULAR_SECTOR || id >= limit || seen.has(id) || ids.length > table.length) {
        throw new Error("Broken sector chain.");
      }
      seen.add(id);
      ids.push(id);
    }
    return ids;
  };
  // Every sector belongs to one stream: shared chains would let a small file
  // expand into many copies of the same data.
  const owned = new Set<number>();
  const ownedMini = new Set<number>();
  const claim = (ids: readonly number[], set: Set<number>) => {
    for (const id of ids) {
      if (set.has(id)) throw new Error("Overlapping streams.");
      set.add(id);
    }
  };
  const readRegular = (start: number, size?: number) => {
    // Sector n starts at (n + 1) * sectorSize, after the header.
    const ids = chain(start, fat, Math.ceil(bytes.length / sectorSize) - 1);
    claim(ids, owned);
    const out = new Uint8Array(ids.length * sectorSize);
    ids.forEach((id, index) => out.set(sector(id), index * sectorSize));
    return size === undefined ? out : out.subarray(0, Math.min(size, out.length));
  };
  const directory = readRegular(dv.getUint32(0x30, true));
  const cutoff = dv.getUint32(0x38, true);
  const miniFatStart = dv.getUint32(0x3c, true);
  const miniFat: number[] = [];
  if (miniFatStart <= MAX_REGULAR_SECTOR) {
    const data = view(readRegular(miniFatStart));
    for (let i = 0; i < data.byteLength / 4; i += 1) miniFat.push(data.getUint32(i * 4, true));
  }
  const dirView = view(directory);
  const entries = Math.floor(directory.length / 128);
  // The root entry (always first) holds the mini stream.
  let miniStream = new Uint8Array(0);
  const streams = new Map<string, Uint8Array>();
  for (let i = 0; i < entries; i += 1) {
    const base = i * 128;
    const type = directory[base + 66];
    const nameLength = dirView.getUint16(base + 64, true);
    if (nameLength < 2 || nameLength > 64) continue;
    let name = "";
    for (let c = 0; c < nameLength / 2 - 1; c += 1) {
      name += String.fromCharCode(dirView.getUint16(base + c * 2, true));
    }
    const start = dirView.getUint32(base + 116, true);
    const size = dirView.getUint32(base + 120, true);
    if (type === 5) {
      if (start <= MAX_REGULAR_SECTOR) miniStream = readRegular(start, size);
    } else if (type === 2 && !streams.has(name)) {
      if (size === 0) streams.set(name, new Uint8Array(0));
      else if (size < cutoff) {
        const ids = chain(start, miniFat, Math.floor(miniStream.length / miniSize));
        claim(ids, ownedMini);
        const out = new Uint8Array(ids.length * miniSize);
        ids.forEach((id, index) =>
          out.set(miniStream.subarray(id * miniSize, (id + 1) * miniSize), index * miniSize),
        );
        streams.set(name, out.subarray(0, size));
      } else {
        streams.set(name, readRegular(start, size));
      }
    }
  }
  return { streams };
};

const cp1252 = new TextDecoder("windows-1252");

/** Throws unless no two byte ranges overlap (one sort, then neighbours only). */
const assertDisjoint = (ranges: ReadonlyArray<readonly [number, number]>, message: string) => {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]![0] < sorted[i - 1]![1]) throw new Error(message);
  }
};

/**
 * BIFF8 "compressed" strings and PowerPoint TextBytesAtoms store the low byte
 * of each UTF-16 character, so a byte is its code point (not Windows-1252).
 */
const latin1 = {
  decode: (bytes: Uint8Array) => {
    let out = "";
    for (let at = 0; at < bytes.length; at += 8192) {
      out += String.fromCharCode(...bytes.subarray(at, at + 8192));
    }
    return out;
  },
};
const utf16 = new TextDecoder("utf-16le");

const need = (file: CompoundFile, ...names: string[]) => {
  for (const name of names) {
    const stream = file.streams.get(name);
    if (stream !== undefined) return stream;
  }
  throw new Error(`No ${names[0]} stream in this file.`);
};

const tidy = (text: string) =>
  text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Word 97-2003 text via the piece table; field instructions are dropped, results kept. */
export const extractDoc = (bytes: Uint8Array) => {
  const file = readCompoundFile(bytes);
  const word = need(file, "WordDocument");
  const fib = view(word);
  if (word.length < 0x1aa || fib.getUint16(0, true) !== 0xa5ec) {
    throw new Error("Not a Word 97-2003 document (older Word versions are not supported).");
  }
  const flags = fib.getUint16(0x0a, true);
  if ((flags & 0x0100) !== 0) throw new Error("The document is password-protected.");
  const table = need(file, (flags & 0x0200) !== 0 ? "1Table" : "0Table");
  const fcClx = fib.getUint32(0x01a2, true);
  const lcbClx = fib.getUint32(0x01a6, true);
  if (fcClx + lcbClx > table.length) throw new Error("Broken piece table.");
  const clx = view(table.subarray(fcClx, fcClx + lcbClx));
  let at = 0;
  while (at + 3 <= clx.byteLength && clx.getUint8(at) === 0x01) {
    at += 3 + clx.getUint16(at + 1, true);
  }
  if (at + 5 > clx.byteLength || clx.getUint8(at) !== 0x02) throw new Error("Broken piece table.");
  const lcb = clx.getUint32(at + 1, true);
  const plc = at + 5;
  const pieces = (lcb - 4) / 12;
  if (!Number.isInteger(pieces) || pieces < 1 || plc + lcb > clx.byteLength) {
    throw new Error("Broken piece table.");
  }
  // Pieces run in order over the text, each over its own bytes of the stream;
  // anything else is a broken (or hostile) table, not something to clamp.
  const ranges: Array<{ start: number; end: number; compressed: boolean }> = [];
  for (let i = 0; i < pieces; i += 1) {
    const cpStart = clx.getUint32(plc + i * 4, true);
    const cpEnd = clx.getUint32(plc + (i + 1) * 4, true);
    if (cpEnd < cpStart || (i > 0 && cpStart < clx.getUint32(plc + (i - 1) * 4, true))) {
      throw new Error("Broken piece table.");
    }
    const fcValue = clx.getUint32(plc + (pieces + 1) * 4 + i * 8 + 2, true);
    const compressed = (fcValue & 0x40000000) !== 0;
    const start = compressed ? (fcValue & 0x3fffffff) / 2 : fcValue;
    const end = start + (cpEnd - cpStart) * (compressed ? 1 : 2);
    if (end > word.length) throw new Error("Broken piece table.");
    ranges.push({ start, end, compressed });
  }
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.start < sorted[i - 1]!.end) throw new Error("Broken piece table.");
  }
  let raw = "";
  for (const range of ranges) {
    raw += (range.compressed ? cp1252 : utf16).decode(word.subarray(range.start, range.end));
  }
  // Field codes: 0x13 instruction 0x14 result 0x15; keep only the result.
  let text = "";
  // A stack of open fields, plus how many of them are still in their instruction part.
  const fields: Array<{ inResult: boolean }> = [];
  let hiding = 0;
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code === 0x13) {
      fields.push({ inResult: false });
      hiding += 1;
      continue;
    }
    if (code === 0x14) {
      const top = fields.at(-1);
      if (top !== undefined && !top.inResult) {
        top.inResult = true;
        hiding -= 1;
      }
      continue;
    }
    if (code === 0x15) {
      const top = fields.pop();
      if (top !== undefined && !top.inResult) hiding -= 1;
      continue;
    }
    if (hiding > 0) continue;
    if (code === 0x0d || code === 0x0b || code === 0x0c) text += "\n";
    else if (code === 0x07) text += "\u0007";
    else if (code === 0x09 || code >= 0x20) text += char;
  }
  // Cell marks: one ends a cell, two in a row end a table row.
  return tidy(
    text
      .replace(/\u0007\u0007/g, "\n")
      .replace(/\u0007\n/g, "\n")
      .replace(/\u0007/g, " | "),
  );
};

/** BIFF8 reader that follows strings across CONTINUE record boundaries. */
/** Exported for tests. */
export class BiffReader {
  pos = 0;
  readonly data: Uint8Array;
  readonly dv: DataView;
  readonly boundaries: readonly number[];
  readonly boundarySet: ReadonlySet<number>;
  constructor(data: Uint8Array, boundaries: readonly number[]) {
    this.data = data;
    this.dv = view(data);
    this.boundaries = boundaries;
    this.boundarySet = new Set(boundaries);
  }
  u8() {
    return this.dv.getUint8(this.pos++);
  }
  u16() {
    const value = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  }
  u32() {
    const value = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }
  /** The first boundary after the read position (binary search; boundaries are sorted). */
  nextBoundary() {
    let low = 0;
    let high = this.boundaries.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.boundaries[mid]! > this.pos) high = mid;
      else low = mid + 1;
    }
    return this.boundaries[low] ?? this.data.length;
  }
  /** XLUnicodeRichExtendedString / XLUnicodeString with a 1- or 2-byte length. */
  string(lengthBytes: 1 | 2) {
    const count = lengthBytes === 2 ? this.u16() : this.u8();
    let flags = this.u8();
    let runs = 0;
    let ext = 0;
    if ((flags & 0x08) !== 0) runs = this.u16();
    if ((flags & 0x04) !== 0) ext = this.u32();
    let out = "";
    let left = count;
    while (left > 0) {
      // Characters that reach a CONTINUE record go on after its width byte.
      if (this.boundarySet.has(this.pos)) {
        flags = this.u8();
        continue;
      }
      const wide = (flags & 0x01) !== 0;
      const room = Math.floor((this.nextBoundary() - this.pos) / (wide ? 2 : 1));
      const take = Math.min(left, Math.max(room, 0));
      if (take === 0) {
        if (this.pos >= this.data.length) throw new Error("Truncated string.");
        flags = this.u8(); // a CONTINUE record restates the character width
        continue;
      }
      const end = this.pos + take * (wide ? 2 : 1);
      out += (wide ? utf16 : latin1).decode(this.data.subarray(this.pos, end));
      this.pos = end;
      left -= take;
    }
    this.pos += runs * 4 + ext;
    return out;
  }
}

interface BiffRecord {
  readonly type: number;
  readonly offset: number;
  readonly data: Uint8Array;
}

/** A record and its CONTINUE records as one buffer, with where each part starts. */
const joinParts = (parts: readonly Uint8Array[]) => {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  const boundaries: number[] = [];
  let at = 0;
  for (const part of parts) {
    if (at > 0) boundaries.push(at);
    joined.set(part, at);
    at += part.length;
  }
  return { joined, boundaries };
};

const biffRecords = (stream: Uint8Array) => {
  const dv = view(stream);
  const records: BiffRecord[] = [];
  for (let at = 0; at + 4 <= stream.length;) {
    const type = dv.getUint16(at, true);
    const length = dv.getUint16(at + 2, true);
    if (type === 0 && length === 0) break;
    records.push({ type, offset: at, data: stream.subarray(at + 4, at + 4 + length) });
    at += 4 + length;
  }
  return records;
};

const rkValue = (rk: number) => {
  let value: number;
  if ((rk & 0x02) !== 0) value = rk >> 2;
  else {
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setUint32(4, rk & 0xfffffffc, true);
    value = buffer.getFloat64(0, true);
  }
  return (rk & 0x01) !== 0 ? value / 100 : value;
};

const formatNumber = (value: number) =>
  Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));

/** Excel 97-2003 cell values, every sheet (hidden ones marked), tab-separated. */
export const extractXls = (bytes: Uint8Array) => {
  const file = readCompoundFile(bytes);
  const stream = need(file, "Workbook", "Book");
  const records = biffRecords(stream);
  const first = records[0];
  if (
    first?.type !== 0x0809 ||
    first.data.length < 2 ||
    view(first.data).getUint16(0, true) !== 0x0600
  ) {
    throw new Error("Not an Excel 97-2003 workbook (older Excel versions are not supported).");
  }
  if (records.some((record) => record.type === 0x002f)) {
    throw new Error("The workbook is password-protected.");
  }
  const sheets: Array<{ name: string; hidden: boolean; offset: number }> = [];
  const shared: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (record.type === 0x0085) {
      const reader = new BiffReader(record.data, []);
      const offset = reader.u32();
      const hidden = (reader.u8() & 0x03) !== 0;
      const kind = reader.u8();
      if (kind === 0) sheets.push({ name: reader.string(1), hidden, offset });
    } else if (record.type === 0x00fc) {
      // SST plus its CONTINUE records, joined with the record boundaries kept.
      const parts = [record.data];
      while (records[i + 1]?.type === 0x003c) parts.push(records[++i]!.data);
      const { joined, boundaries } = joinParts(parts);
      const reader = new BiffReader(joined, boundaries);
      reader.u32();
      const unique = reader.u32();
      for (let s = 0; s < unique && reader.pos < joined.length; s += 1)
        shared.push(reader.string(2));
    } else if (record.type === 0x000a) {
      break; // end of the workbook globals
    }
  }
  const byOffset = new Map(records.map((record, index) => [record.offset, index]));
  const out: string[] = [];
  const used = new Set<number>();
  // Every worksheet record belongs to one sheet at most, so work stays linear.
  const owner = new Set<number>();
  const claim = (index: number) => {
    if (owner.has(index)) throw new Error("Broken workbook: two sheets share records.");
    owner.add(index);
  };
  for (const sheet of sheets) {
    // Each sheet entry must point at its own worksheet BOF; repeats would
    // render one large sheet over and over.
    if (used.has(sheet.offset)) throw new Error("Broken workbook: two sheets share one worksheet.");
    used.add(sheet.offset);
    const start = byOffset.get(sheet.offset);
    if (start === undefined || records[start]!.type !== 0x0809) continue;
    const cells = new Map<number, Map<number, string>>();
    const put = (row: number, col: number, value: string) => {
      if (value === "") return;
      // BIFF8 has 256 columns; a larger index is a broken record, not a wide sheet.
      if (col > 0xff) throw new Error("Broken cell record.");
      let line = cells.get(row);
      if (line === undefined) {
        line = new Map();
        cells.set(row, line);
      }
      line.set(col, value.replace(/[\t\n\r]+/g, " "));
    };
    let pendingFormula: { row: number; col: number } | null = null;
    claim(start);
    for (let i = start + 1; i < records.length; i += 1) {
      claim(i);
      const record = records[i]!;
      if (record.type === 0x000a) break;
      if (record.type === 0x0207) {
        // STRING: the text result of the formula before it (may be shorter than a cell record).
        // A long result goes on in CONTINUE records.
        const parts = [record.data];
        while (records[i + 1]?.type === 0x003c) parts.push(records[++i]!.data);
        if (pendingFormula !== null && record.data.length >= 3) {
          const { joined, boundaries } = joinParts(parts);
          const reader = new BiffReader(joined, boundaries);
          put(pendingFormula.row, pendingFormula.col, reader.string(2));
        }
        pendingFormula = null;
        continue;
      }
      if (record.data.length < 6) continue;
      const dv = view(record.data);
      const row = dv.getUint16(0, true);
      const col = dv.getUint16(2, true);
      switch (record.type) {
        case 0x00fd: // LABELSST
          if (record.data.length >= 10) put(row, col, shared[dv.getUint32(6, true)] ?? "");
          break;
        case 0x0204: {
          // LABEL
          const reader = new BiffReader(record.data, []);
          reader.pos = 6;
          put(row, col, reader.string(2));
          break;
        }
        case 0x0203: // NUMBER
          if (record.data.length >= 14) put(row, col, formatNumber(dv.getFloat64(6, true)));
          break;
        case 0x027e: // RK
          if (record.data.length >= 10) put(row, col, formatNumber(rkValue(dv.getUint32(6, true))));
          break;
        case 0x00bd: {
          // MULRK
          const last = dv.getUint16(record.data.length - 2, true);
          for (let c = col; c <= last && 4 + (c - col) * 6 + 6 <= record.data.length - 2; c += 1) {
            put(row, c, formatNumber(rkValue(dv.getUint32(4 + (c - col) * 6 + 2, true))));
          }
          break;
        }
        case 0x0205: {
          // BOOLERR
          if (record.data.length < 8) break;
          const value = dv.getUint8(6);
          put(row, col, dv.getUint8(7) === 0 ? (value === 0 ? "FALSE" : "TRUE") : "#ERROR");
          break;
        }
        case 0x0006: {
          // FORMULA: cached result
          if (record.data.length < 14) break;
          if (dv.getUint16(12, true) === 0xffff) {
            const kind = dv.getUint8(6);
            if (kind === 0) pendingFormula = { row, col };
            else if (kind === 1) put(row, col, dv.getUint8(8) === 0 ? "FALSE" : "TRUE");
          } else put(row, col, formatNumber(dv.getFloat64(6, true)));
          break;
        }
      }
    }
    const lines = [...cells.keys()]
      .sort((a, b) => a - b)
      .map((row) => {
        const line = cells.get(row)!;
        const width = Math.max(...line.keys()) + 1;
        return Array.from({ length: width }, (_, c) => line.get(c) ?? "").join("\t");
      });
    out.push(`## Sheet: ${sheet.name}${sheet.hidden ? " (hidden)" : ""}\n${lines.join("\n")}`);
  }
  return out.join("\n\n").trim();
};

/**
 * PowerPoint 97-2003 text, per slide in presentation order, then speaker notes.
 * Follows the current edit's persist directory so text from older saves left
 * in the file is not repeated; master and template text is skipped.
 */
export const extractPpt = (bytes: Uint8Array) => {
  const file = readCompoundFile(bytes);
  const stream = need(file, "PowerPoint Document");
  const dv = view(stream);
  const header = (at: number) =>
    at + 8 <= stream.length
      ? {
          version: dv.getUint16(at, true) & 0x0f,
          instance: dv.getUint16(at, true) >> 4,
          type: dv.getUint16(at + 2, true),
          body: at + 8,
          next: Math.min(at + 8 + dv.getUint32(at + 4, true), stream.length),
        }
      : null;
  const textOf = (type: number, body: number, next: number) =>
    (type === 0x0fa0 ? utf16 : latin1)
      .decode(stream.subarray(body, next))
      .replace(/[\r\v]/g, "\n")
      .trim();
  /** Text atoms inside a container, in order. */
  const textsIn = (start: number, end: number, depth = 0): string[] => {
    const out: string[] = [];
    for (let at = start; at + 8 <= end && depth < 64;) {
      const record = header(at);
      // A record may not run past its container.
      if (record === null || record.next <= at || record.next > end) break;
      if (record.version === 0x0f) out.push(...textsIn(record.body, record.next, depth + 1));
      else if (record.type === 0x0fa0 || record.type === 0x0fa8) {
        const text = textOf(record.type, record.body, record.next);
        if (text.length > 0) out.push(text);
      }
      at = record.next;
    }
    return out;
  };
  // Persist directory of the live edit chain (the newest entry per id wins).
  const persist = new Map<number, number>();
  let documentRef: number | null = null;
  const current = file.streams.get("Current User");
  if (current !== undefined && current.length >= 20) {
    let edit = view(current).getUint32(16, true);
    const visited = new Set<number>();
    // First the chain, newest edit first; then its directories.
    const directories: Array<{ at: number; body: number; next: number }> = [];
    const named = new Set<number>();
    for (let guard = 0; guard < 4096 && edit > 0; guard += 1) {
      // Each edit once: a cycle would rescan the same directories.
      if (visited.has(edit)) throw new Error("Broken presentation: the edit chain loops.");
      visited.add(edit);
      const record = header(edit);
      if (record === null || record.type !== 0x0ff5 || record.body + 20 > stream.length) break;
      const directoryAt = dv.getUint32(record.body + 12, true);
      // Each persist directory is read once; an older edit naming the same one adds nothing.
      const directory = named.has(directoryAt) ? null : header(directoryAt);
      named.add(directoryAt);
      if (directory !== null && directory.type === 0x1772) {
        directories.push({ at: directoryAt, body: directory.body, next: directory.next });
      }
      if (documentRef === null) documentRef = dv.getUint32(record.body + 16, true);
      const previous = dv.getUint32(record.body + 8, true);
      if (previous === 0 || previous === edit) break;
      edit = previous;
    }
    // Directories may not overlap, so all of them together scan the stream at most once.
    assertDisjoint(
      directories.map((d) => [d.at, d.next] as const),
      "Broken presentation: persist directories overlap.",
    );
    for (const directory of directories) {
      {
        for (let at = directory.body; at + 4 <= directory.next;) {
          const word = dv.getUint32(at, true);
          const firstId = word & 0xfffff;
          const count = word >>> 20;
          for (let k = 0; k < count && at + 8 + k * 4 <= directory.next; k += 1) {
            if (!persist.has(firstId + k))
              persist.set(firstId + k, dv.getUint32(at + 4 + k * 4, true));
          }
          at += 4 + count * 4;
        }
      }
    }
  }
  const documentOffset = documentRef === null ? undefined : persist.get(documentRef);
  const doc = documentOffset === undefined ? null : header(documentOffset);
  if (doc === null || doc.type !== 0x03e8) {
    // No usable edit chain: every text atom outside masters, in file order.
    const texts: string[] = [];
    const walk = (start: number, end: number, depth: number) => {
      for (let at = start; at + 8 <= end && depth < 64;) {
        const record = header(at);
        if (record === null || record.next <= at || record.next > end) break;
        if (record.type === 0x03f8 || record.type === 0x0fc8 || record.type === 0x0fc4) {
          // masters: template text, not content
        } else if (record.version === 0x0f) walk(record.body, record.next, depth + 1);
        else if (record.type === 0x0fa0 || record.type === 0x0fa8) {
          const text = textOf(record.type, record.body, record.next);
          if (text.length > 0 && texts.at(-1) !== text) texts.push(text);
        }
        at = record.next;
      }
    };
    walk(0, stream.length, 0);
    if (texts.length === 0) throw new Error("No slide text found.");
    return tidy(texts.join("\n"));
  }
  // Slides and notes name their drawings; drawings are read after the lists.
  const slides: Array<{ listed: string[]; drawing: number }> = [];
  const noteDrawings: number[] = [];
  const drawingAt = (persistId: number) => {
    const offset = persist.get(persistId);
    return offset === undefined ? null : header(offset);
  };
  for (let at = doc.body; at + 8 <= doc.next;) {
    const list = header(at);
    if (list === null || list.next <= at || list.next > doc.next) break;
    // SlideListWithText: instance 0 lists slides, 2 lists notes pages.
    if (list.type === 0x0ff0 && (list.instance === 0 || list.instance === 2)) {
      for (let inner = list.body; inner + 8 <= list.next;) {
        const record = header(inner);
        if (record === null || record.next <= inner || record.next > list.next) break;
        if (record.type === 0x03f3 && record.body + 4 <= record.next) {
          // Older files keep slide text in this list; newer ones in each slide's drawing.
          const drawing = dv.getUint32(record.body, true);
          if (list.instance === 2) noteDrawings.push(drawing);
          else slides.push({ listed: [], drawing });
        } else if ((record.type === 0x0fa0 || record.type === 0x0fa8) && list.instance === 0) {
          const text = textOf(record.type, record.body, record.next);
          if (text.length > 0) slides.at(-1)?.listed.push(text);
        }
        inner = record.next;
      }
    }
    at = list.next;
  }
  // Drawings may not overlap (or repeat), so all of them together read the stream once.
  const targets = new Map<number, ReturnType<typeof header>>();
  for (const ref of [...slides.map((slide) => slide.drawing), ...noteDrawings]) {
    if (targets.has(ref)) throw new Error("Broken presentation: two slides share one drawing.");
    targets.set(ref, drawingAt(ref));
  }
  const ranges: Array<readonly [number, number]> = [];
  for (const target of targets.values())
    if (target !== null) ranges.push([target.body - 8, target.next]);
  assertDisjoint(ranges, "Broken presentation: two slides share one drawing.");
  const textOfDrawing = (ref: number) => {
    const target = targets.get(ref) ?? null;
    return target !== null && (target.type === 0x03ee || target.type === 0x03f0)
      ? textsIn(target.body, target.next)
      : [];
  };
  const notes = noteDrawings.flatMap(textOfDrawing);
  const parts = slides.map(
    (slide, index) =>
      `## Slide ${index + 1}\n${(slide.listed.length > 0 ? slide.listed : textOfDrawing(slide.drawing)).join("\n")}`,
  );
  if (notes.length > 0) parts.push(`## Notes\n${[...new Set(notes)].join("\n")}`);
  return tidy(parts.join("\n\n"));
};
