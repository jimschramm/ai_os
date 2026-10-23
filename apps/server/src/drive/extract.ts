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

const stripTags = (xml: string) => decodeEntities(xml.replace(/<[^>]+>/g, ""));

const tidy = (text: string) =>
  text
    .replace(/[ \t]+\n/g, "\n")
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

const wordXmlToText = (xml: string) =>
  stripTags(
    xml
      .replace(/<w:tab\/>/g, "\t")
      .replace(/<w:(?:br|cr)\/>/g, "\n")
      // Paragraphs inside a table cell stay on the cell's line.
      .replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (cell) =>
        cell.replace(/<\/w:p>(?![\s\S]*<\/w:p>)/, "").replace(/<\/w:p>/g, " "),
      )
      .replace(/<\/w:tc>/g, " | ")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      // Only run text; drop instructions such as field codes.
      .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, ""),
  );

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
  const rels = new Map<string, string>();
  for (const match of (parts.get("xl/_rels/workbook.xml.rels") ?? "").matchAll(
    /<Relationship\b[^>]*>/g,
  )) {
    const id = /\bId="([^"]+)"/.exec(match[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[0])?.[1];
    if (id !== undefined && target !== undefined) {
      rels.set(id, target.replace(/^\/?(xl\/)?/, "xl/"));
    }
  }
  const shared: string[] = [];
  for (const match of (parts.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(
      decodeEntities(
        [...(match[1] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1] ?? "").join(""),
      ),
    );
  }
  const sheets: string[] = [];
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeEntities(/\bname="([^"]*)"/.exec(match[0])?.[1] ?? "Sheet");
    const relId = /\br:id="([^"]+)"/.exec(match[0])?.[1];
    const state = /\bstate="([^"]+)"/.exec(match[0])?.[1];
    const xml = relId === undefined ? undefined : parts.get(rels.get(relId) ?? "");
    const rows: string[] = [];
    for (const row of (xml ?? "").matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] ?? "";
        const inner = cell[2] ?? "";
        const ref = /\br="([A-Z]+)\d*"/.exec(attrs)?.[1] ?? "";
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value: string;
        if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr")
          value = stripTags(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "");
        else if (type === "b") value = raw === "1" ? "TRUE" : raw === undefined ? "" : "FALSE";
        else value = raw === undefined ? "" : decodeEntities(raw);
        const index = ref === "" ? cells.length : columnIndex(ref);
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

export const extractPptx = async (bytes: Uint8Array) => {
  const parts = await readZipText(bytes, (name) =>
    /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(name),
  );
  const slides = [...parts.keys()]
    .filter((name) => name.startsWith("ppt/slides/"))
    .sort((a, b) => numberIn(a) - numberIn(b));
  if (slides.length === 0) throw new Error("No slides in this file.");
  return slides
    .map((name) => {
      const number = numberIn(name);
      const notes = parts.get(`ppt/notesSlides/notesSlide${number}.xml`);
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
