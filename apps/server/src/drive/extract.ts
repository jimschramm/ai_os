// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - plain Node module (worker thread, zip reader) so the RFP app can reuse it; callers wrap it in Effect.tryPromise.
/**
 * Text extraction for Drive files. Pure functions over bytes: no network, no
 * disk. Office files are zip+XML and are read with yauzl; PDFs run in a worker
 * thread with unpdf so a hostile or huge PDF can be stopped (180 s).
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import * as yauzl from "yauzl";

import { extractDoc, extractPpt, extractXls } from "./legacyOffice.ts";

export type ExtractKind = "text" | "image" | "file";

export interface Extracted {
  /** "text" has `text`; "image" and "file" are kept as-is for the agent. */
  readonly kind: ExtractKind;
  readonly text?: string;
  /** Short reason when text could not be extracted, e.g. a PDF timeout. */
  readonly error?: string;
  readonly method: string;
}

export const PDF_TIMEOUT_MS = 180_000;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const TEXT_EXTENSIONS = new Set(
  "txt md markdown csv tsv json jsonl xml html htm yaml yml toml ini cfg conf log sql py js mjs cjs ts tsx jsx java c h cpp hpp cs go rs rb php sh ps1 bat css scss svg rtf tex srt vtt eml".split(
    " ",
  ),
);

export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, code: string) => {
    switch (code) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const value = code.startsWith("#x")
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
        return Number.isFinite(value) && value <= 0x10ffff ? String.fromCodePoint(value) : "";
      }
    }
  });

/**
 * Linear scans (each byte is looked at a bounded number of times); regexes
 * like <[^>]+> or lazy spans rescan the rest of the text from every unclosed
 * opener, which a crafted file can turn quadratic.
 */
const stripTags = (xml: string) => {
  let out = "";
  let at = 0;
  for (;;) {
    const open = xml.indexOf("<", at);
    if (open === -1) {
      out += xml.slice(at);
      break;
    }
    out += xml.slice(at, open);
    const close = xml.indexOf(">", open + 1);
    // An unclosed "<" is text, as with the old /<[^>]+>/ (and "<>" too).
    if (close === -1) {
      out += xml.slice(open);
      break;
    }
    if (close === open + 1) out += "<>";
    at = close + 1;
  }
  return decodeEntities(out);
};

const isWordChar = (ch: string | undefined) => ch !== undefined && /\w/.test(ch);

/** Index of the `>` ending a tag, skipping quoted attribute values (which may hold `>`); -1 if none. */
const endOfTag = (xml: string, from: number) => {
  let quote: string | null = null;
  for (let i = from; i < xml.length; i += 1) {
    const ch = xml[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
};

/** Start-tag attributes of every `<name ...>` (`name` whole), in order. */
function* startTags(xml: string, name: string): Generator<string> {
  const open = `<${name}`;
  let at = 0;
  for (;;) {
    let start = xml.indexOf(open, at);
    while (start !== -1 && isWordChar(xml[start + open.length])) {
      start = xml.indexOf(open, start + open.length);
    }
    if (start === -1) return;
    const end = endOfTag(xml, start + open.length);
    if (end === -1) return;
    const attrs = xml.slice(start + open.length, end);
    yield attrs.endsWith("/") ? attrs.slice(0, -1) : attrs;
    at = end + 1;
  }
}

/** Every `<name ...>inner</name>` (inner null when self-closed), in order; nesting of one name is not supported. */
function* elements(xml: string, name: string): Generator<{ attrs: string; inner: string | null }> {
  const open = `<${name}`;
  const close = `</${name}>`;
  let at = 0;
  for (;;) {
    let start = xml.indexOf(open, at);
    while (start !== -1 && isWordChar(xml[start + open.length])) {
      start = xml.indexOf(open, start + open.length);
    }
    if (start === -1) return;
    const tagEnd = endOfTag(xml, start + open.length);
    if (tagEnd === -1) return;
    const attrs = xml.slice(start + open.length, tagEnd);
    if (attrs.endsWith("/")) {
      yield { attrs: attrs.slice(0, -1), inner: null };
      at = tagEnd + 1;
      continue;
    }
    const end = xml.indexOf(close, tagEnd + 1);
    if (end === -1) return;
    yield { attrs, inner: xml.slice(tagEnd + 1, end) };
    at = end + close.length;
  }
}

const firstInner = (xml: string, name: string) => {
  for (const element of elements(xml, name)) return element.inner ?? "";
  return undefined;
};

const isSpace = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

/**
 * The value of attribute `key` in a tag's attributes. Parsed name by name, so
 * attribute-like text inside a quoted value never matches; XML allows either
 * quote and space around `=`.
 */
const attr = (attrs: string, key: string): string | undefined => {
  let i = 0;
  for (;;) {
    while (isSpace(attrs[i])) i += 1;
    const nameStart = i;
    while (i < attrs.length && !isSpace(attrs[i]) && attrs[i] !== "=") i += 1;
    if (i === nameStart) return undefined;
    const name = attrs.slice(nameStart, i);
    while (isSpace(attrs[i])) i += 1;
    if (attrs[i] !== "=") return undefined;
    i += 1;
    while (isSpace(attrs[i])) i += 1;
    const quote = attrs[i];
    if (quote !== '"' && quote !== "'") return undefined;
    const end = attrs.indexOf(quote, i + 1);
    if (end === -1) return undefined;
    if (name === key) return attrs.slice(i + 1, end);
    i = end + 1;
  }
};

/**
 * Replaces each span from `open` (a whole tag name) to the first `close`
 * after it. Without a close, the rest is left as it is.
 */
const replaceSpans = (xml: string, open: string, close: string, fn: (span: string) => string) => {
  let out = "";
  let at = 0;
  for (;;) {
    let start = xml.indexOf(open, at);
    while (start !== -1 && isWordChar(xml[start + open.length])) {
      start = xml.indexOf(open, start + open.length);
    }
    if (start === -1) break;
    const end = xml.indexOf(close, start + open.length);
    if (end === -1) break;
    out += xml.slice(at, start) + fn(xml.slice(start, end + close.length));
    at = end + close.length;
  }
  return out + xml.slice(at);
};

const tidy = (text: string) =>
  text
    // One match per whitespace run (dropped only before a newline): a regex
    // ending in \n would rescan a long run from every position.
    .replace(/[ \t]+/g, (run: string, at: number, all: string) =>
      all[at + run.length] === "\n" ? "" : run,
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Reads the zip entries whose names pass `want`, as UTF-8 strings. */
export const readZipText = (bytes: Uint8Array, want: (name: string) => boolean) =>
  new Promise<Map<string, string>>((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (openError, zip) => {
      if (openError || zip === undefined) {
        reject(openError ?? new Error("Not a zip file."));
        return;
      }
      const out = new Map<string, string>();
      zip.on("error", reject);
      zip.on("end", () => resolve(out));
      zip.on("entry", (entry: yauzl.Entry) => {
        if (!want(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || stream === undefined) {
            reject(streamError ?? new Error("Unreadable zip entry."));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            out.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });

const numberIn = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

const wordXmlToText = (xml: string) => {
  const marked = xml.replace(/<w:tab\/>/g, "\t").replace(/<w:(?:br|cr)\/>/g, "\n");
  // Paragraphs inside a table cell stay on the cell's line.
  const cells = replaceSpans(marked, "<w:tc", "</w:tc>", (cell) => {
    const last = cell.lastIndexOf("</w:p>");
    const kept = last === -1 ? cell : cell.slice(0, last) + cell.slice(last + "</w:p>".length);
    return kept.split("</w:p>").join(" ");
  });
  const lines = cells
    .split("</w:tc>")
    .join(" | ")
    .split("</w:tr>")
    .join("\n")
    .split("</w:p>")
    .join("\n");
  // Only run text; drop instructions such as field codes.
  return stripTags(replaceSpans(lines, "<w:instrText", "</w:instrText>", () => ""));
};

export const extractDocx = async (bytes: Uint8Array) => {
  const parts = await readZipText(bytes, (name) =>
    /^word\/(document|footnotes|endnotes|comments|header\d*|footer\d*)\.xml$/.test(name),
  );
  const body = parts.get("word/document.xml");
  if (body === undefined) throw new Error("No word/document.xml in this file.");
  const sections = [wordXmlToText(body)];
  for (const [name, xml] of [...parts].sort(([a], [b]) => a.localeCompare(b))) {
    if (name === "word/document.xml") continue;
    const text = tidy(wordXmlToText(xml));
    if (text.length > 0) sections.push(`## ${name.slice(5, -4)}\n${text}`);
  }
  return tidy(sections.join("\n\n"));
};

const columnIndex = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  // XLSX columns run A..XFD; anything longer is a malformed reference.
  if (letters.length > 3) throw new Error(`Malformed cell reference ${ref}.`);
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
};

/** Every tab, labelled, as tab-separated rows. */
export const extractXlsx = async (bytes: Uint8Array) => {
  const parts = await readZipText(bytes, (name) =>
    /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(
      name,
    ),
  );
  const workbook = parts.get("xl/workbook.xml");
  if (workbook === undefined) throw new Error("No xl/workbook.xml in this file.");
  // Targets resolved against xl/ (dot segments and absolute paths included).
  const rels = new Map(
    [...relTargets(parts.get("xl/_rels/workbook.xml.rels") ?? "", "xl/")].map(
      ([id, rel]) => [id, rel.target] as const,
    ),
  );
  const shared: string[] = [];
  for (const item of elements(parts.get("xl/sharedStrings.xml") ?? "", "si")) {
    shared.push(
      decodeEntities([...elements(item.inner ?? "", "t")].map((t) => t.inner ?? "").join("")),
    );
  }
  const sheets: string[] = [];
  // Each worksheet once: repeated references would re-render one part many times.
  const seenSheets = new Set<string>();
  for (const attrs of startTags(workbook, "sheet")) {
    const name = decodeEntities(attr(attrs, "name") ?? "Sheet");
    const relId = attr(attrs, "r:id") || undefined;
    const state = attr(attrs, "state") || undefined;
    const target = relId === undefined ? undefined : rels.get(relId);
    // Every listed sheet must resolve: none is shown as empty by mistake.
    if (target === undefined) {
      throw new Error(`Malformed workbook: sheet ${name} has no relationship.`);
    }
    {
      if (seenSheets.has(target)) throw new Error(`Malformed workbook: ${target} is listed twice.`);
      seenSheets.add(target);
    }
    const xml = parts.get(target);
    if (xml === undefined) {
      throw new Error(`Malformed workbook: sheet ${name} points to missing part ${target}.`);
    }
    const rows: string[] = [];
    for (const row of elements(xml ?? "", "row")) {
      const cells: string[] = [];
      for (const cell of elements(row.inner ?? "", "c")) {
        const attrs = cell.attrs;
        const inner = cell.inner ?? "";
        const ref = /^([A-Z]+)\d*$/.exec(attr(attrs, "r") ?? "")?.[1] ?? "";
        const type = attr(attrs, "t") || undefined;
        const raw = firstInner(inner, "v");
        let value: string;
        if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") value = stripTags(firstInner(inner, "is") ?? "");
        else if (type === "b") value = raw === "1" ? "TRUE" : raw === undefined ? "" : "FALSE";
        else value = raw === undefined ? "" : decodeEntities(raw);
        const index = ref === "" ? cells.length : columnIndex(ref);
        if (index >= 16_384) throw new Error(`Malformed cell reference ${ref}.`);
        while (cells.length < index) cells.push("");
        cells[index] = value.replace(/[\t\n\r]+/g, " ");
      }
      if (cells.some((value) => value.length > 0)) rows.push(cells.join("\t"));
    }
    sheets.push(
      `## Sheet: ${name}${state !== undefined && state !== "visible" ? ` (${state})` : ""}\n${rows.join("\n")}`,
    );
  }
  return sheets.join("\n\n").trim();
};

const drawingXmlToText = (xml: string) =>
  stripTags(xml.replace(/<a:br\/>/g, "\n").replace(/<\/a:p>/g, "\n"));

/** Relationship id -> { target part name, type }, with targets resolved against `base`. */
const relTargets = (xml: string, base: string) => {
  const out = new Map<string, { target: string; type: string }>();
  for (const attrs of startTags(xml, "Relationship")) {
    const id = attr(attrs, "Id");
    const target = attr(attrs, "Target");
    if (id === undefined || id === "" || target === undefined || target === "") continue;
    const parts = (target.startsWith("/") ? target.slice(1) : `${base}${target}`).split("/");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "..") resolved.pop();
      else if (part !== "." && part !== "") resolved.push(part);
    }
    out.set(id, { target: resolved.join("/"), type: attr(attrs, "Type") ?? "" });
  }
  return out;
};

export const extractPptx = async (bytes: Uint8Array) => {
  const parts = await readZipText(bytes, (name) =>
    /^ppt\/(slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|notesSlides\/notesSlide\d+\.xml|presentation\.xml|_rels\/presentation\.xml\.rels)$/.test(
      name,
    ),
  );
  const fileSlides = [...parts.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => numberIn(a) - numberIn(b));
  // Show order comes from presentation.xml; file numbers change when slides move.
  const presentationRels = relTargets(parts.get("ppt/_rels/presentation.xml.rels") ?? "", "ppt/");
  // Every listed slide must resolve to a part: none is dropped silently. File
  // order is used only when the presentation lists no slides.
  const ordered = [...startTags(parts.get("ppt/presentation.xml") ?? "", "p:sldId")].map(
    (attrs, position) => {
      const id = attr(attrs, "r:id");
      const target = id === undefined || id === "" ? undefined : presentationRels.get(id)?.target;
      if (target === undefined) {
        throw new Error(`Malformed presentation: slide ${position + 1} has no relationship.`);
      }
      if (!parts.has(target)) {
        throw new Error(
          `Malformed presentation: slide ${position + 1} points to missing part ${target}.`,
        );
      }
      return target;
    },
  );
  // Each slide once: repeated references would re-render one part many times.
  if (new Set(ordered).size !== ordered.length) {
    throw new Error("Malformed presentation: a slide is listed twice.");
  }
  const slides = ordered.length > 0 ? ordered : fileSlides;
  if (slides.length === 0) throw new Error("No slides in this file.");
  // Each notes part once: slides sharing one would re-render it many times.
  const seenNotes = new Set<string>();
  return slides
    .map((name, position) => {
      const number = ordered.length > 0 ? position + 1 : numberIn(name);
      // Notes are found through the slide's own relationships.
      const slideRels = relTargets(
        parts.get(name.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels")) ?? "",
        "ppt/slides/",
      );
      const notesName =
        [...slideRels.values()].find((rel) => rel.type.endsWith("/notesSlide"))?.target ??
        `ppt/notesSlides/notesSlide${numberIn(name)}.xml`;
      const notes = parts.get(notesName);
      if (notes !== undefined) {
        if (seenNotes.has(notesName)) {
          throw new Error(`Malformed presentation: ${notesName} is shared by two slides.`);
        }
        seenNotes.add(notesName);
      }
      const noteText =
        notes === undefined ? "" : tidy(drawingXmlToText(notes)).replace(/^\d+$/m, "");
      return `## Slide ${number}\n${tidy(drawingXmlToText(parts.get(name) ?? ""))}${noteText.trim().length > 0 ? `\n### Notes\n${noteText.trim()}` : ""}`;
    })
    .join("\n\n");
};

const unpdfUrl = () => {
  try {
    return import.meta.resolve("unpdf");
  } catch {
    return pathToFileURL(createRequire(import.meta.url).resolve("unpdf")).href;
  }
};

const PDF_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.url)
  .then(async ({ extractText, getDocumentProxy }) => {
    const pdf = await getDocumentProxy(workerData.bytes);
    const { text } = await extractText(pdf, { mergePages: false });
    parentPort.postMessage({ ok: true, pages: text });
  })
  .catch((error) => parentPort.postMessage({ ok: false, error: String((error && error.message) || error) }));
`;

/** PDF text per page, in a worker that is terminated after `timeoutMs`. */
export const extractPdf = (bytes: Uint8Array, timeoutMs = PDF_TIMEOUT_MS) =>
  new Promise<string>((resolve, reject) => {
    const worker = new Worker(PDF_WORKER, {
      eval: true,
      workerData: { url: unpdfUrl(), bytes: new Uint8Array(bytes) },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`PDF text extraction timed out after ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      void worker.terminate();
    };
    worker.once("message", (message: { ok: boolean; pages?: string[]; error?: string }) => {
      finish();
      if (message.ok) {
        resolve(
          (message.pages ?? [])
            .map((page, index) => `## Page ${index + 1}\n${tidy(page)}`)
            .join("\n\n"),
        );
      } else {
        reject(new Error(`PDF could not be read: ${message.error ?? "unknown error"}`));
      }
    });
    worker.once("error", (error) => {
      finish();
      reject(error);
    });
  });

const isTextLike = (mimeType: string, name: string) =>
  mimeType.startsWith("text/") ||
  /^application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|rtf|x-ndjson)$/.test(mimeType) ||
  mimeType.endsWith("+json") ||
  mimeType.endsWith("+xml") ||
  TEXT_EXTENSIONS.has(extensionOf(name));

const decodeUtf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/**
 * Text for any file. Never throws: a file that cannot be read becomes
 * kind "file" (kept as-is) with an `error`, so one bad file never stops a batch.
 */
export const extractContent = async (input: {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly pdfTimeoutMs?: number;
}): Promise<Extracted> => {
  const { name, mimeType, bytes } = input;
  const ext = extensionOf(name);
  const attempt = async (method: string, run: () => Promise<string>): Promise<Extracted> => {
    try {
      return { kind: "text", text: await run(), method };
    } catch (error) {
      return { kind: "file", method, error: (error as Error).message.slice(0, 300) };
    }
  };
  if (mimeType === DOCX || ext === "docx") return attempt("docx", () => extractDocx(bytes));
  if (mimeType === XLSX || ext === "xlsx" || ext === "xlsm") {
    return attempt("xlsx", () => extractXlsx(bytes));
  }
  if (mimeType === PPTX || ext === "pptx") return attempt("pptx", () => extractPptx(bytes));
  if (mimeType === "application/msword" || ext === "doc" || ext === "dot") {
    return attempt("doc", async () => extractDoc(bytes));
  }
  if (mimeType === "application/vnd.ms-excel" || ext === "xls" || ext === "xlt") {
    return attempt("xls", async () => extractXls(bytes));
  }
  if (
    mimeType === "application/vnd.ms-powerpoint" ||
    ext === "ppt" ||
    ext === "pps" ||
    ext === "pot"
  ) {
    return attempt("ppt", async () => extractPpt(bytes));
  }
  if (mimeType === "application/pdf" || ext === "pdf") {
    return attempt("pdf", () => extractPdf(bytes, input.pdfTimeoutMs));
  }
  if (mimeType.startsWith("image/") && mimeType !== "image/svg+xml") {
    return { kind: "image", method: "image" };
  }
  if (isTextLike(mimeType, name)) {
    const text = decodeUtf8(bytes);
    return text === null
      ? { kind: "file", method: "text", error: "Not valid UTF-8 text." }
      : { kind: "text", text, method: "text" };
  }
  return { kind: "file", method: "none" };
};
