#!/usr/bin/env node
/**
 * MCP Office Reader Server
 *
 * Provides tools for reading office documents:
 * - PDF files
 * - Word documents (DOCX)
 * - Excel spreadsheets (XLSX)
 * - PowerPoint presentations (PPTX)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdtempSync,
  rmSync,
} from 'fs';
import { extname, resolve, basename, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

// Import document parsers
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

// Constants
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.doc'];
const DEFAULT_PREVIEW_CHARS = 2000;
const PPTX_P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const PPTX_A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

// Tool definitions
const tools: Tool[] = [
  {
    name: 'read_document',
    description: `Read and extract text content from office documents.
Supports: PDF, DOCX, XLSX, XLS, PPTX, DOC (best-effort).
Returns Markdown content with basic metadata.`,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the document file',
        },
        options: {
          type: 'object',
          description: 'Optional parsing options',
          properties: {
            include_metadata: {
              type: 'boolean',
              description: 'Include document metadata (default: true)',
            },
            // PDF
            sheet_name: {
              type: 'string',
              description: 'For Excel files: specific sheet name to read',
            },
            max_pages: {
              type: 'number',
              description: 'For PDF files: maximum pages to read (default: all)',
            },
            // PPTX
            max_slides: {
              type: 'number',
              description:
                'For PowerPoint files: maximum slides to read (default: all)',
            },
            include_notes: {
              type: 'boolean',
              description:
                'For PowerPoint files: include speaker notes (default: false)',
            },
            // Excel
            max_sheets: {
              type: 'number',
              description:
                'For Excel files: maximum number of sheets to output (default: all)',
            },
            max_rows: {
              type: 'number',
              description:
                'For Excel files: maximum data rows per sheet in preview (default: 50)',
            },
            max_cols: {
              type: 'number',
              description:
                'For Excel files: maximum columns per sheet in preview (default: 20)',
            },
            range: {
              type: 'string',
              description:
                'For Excel files: cell range to read, e.g., "A1:D10" (optional, defaults to all data)',
            },
            // DOCX
            raw_text: {
              type: 'boolean',
              description:
                'For DOCX files: extract raw text only (default: false, uses Markdown conversion)',
            },
          },
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'get_document_info',
    description: `Get metadata and structure information about a document without reading full content.
Returns: file size, page count, sheet names (Excel), etc.`,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the document file',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'read_excel_sheet',
    description: `Read a specific sheet from an Excel file and return as structured data.
Returns: JSON array of rows with column headers.`,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the Excel file',
        },
        sheet_name: {
          type: 'string',
          description: 'Name of the sheet to read (optional, defaults to first sheet)',
        },
        range: {
          type: 'string',
          description: 'Cell range to read, e.g., "A1:D10" (optional, defaults to all data)',
        },
        as_json: {
          type: 'boolean',
          description: 'Return as JSON objects with headers as keys (default: true)',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'list_supported_formats',
    description: 'List all supported document formats and their capabilities',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'analyze_document',
    description: `Analyze a document and return a Markdown report with structure, stats and a short preview.
Supports: PDF, DOCX, XLSX/XLS, PPTX, DOC (best-effort).`,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the document file',
        },
        options: {
          type: 'object',
          description: 'Optional analysis options',
          properties: {
            preview_chars: {
              type: 'number',
              description: `Max characters to include in preview (default: ${DEFAULT_PREVIEW_CHARS})`,
            },
            max_pages: {
              type: 'number',
              description:
                'For PDF files: maximum pages to analyze (default: 10)',
            },
            max_slides: {
              type: 'number',
              description:
                'For PowerPoint files: maximum slides to analyze (default: 30)',
            },
            max_sheets: {
              type: 'number',
              description:
                'For Excel files: maximum sheets to analyze (default: all)',
            },
          },
        },
      },
      required: ['file_path'],
    },
  },
];

// Document readers
function clampInt(
  value: unknown,
  {
    min,
    max,
  }: {
    min: number;
    max: number;
  },
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  if (n < min || n > max) return undefined;
  return n;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function cleanupExtractedText(text: string): string {
  const normalized = normalizeNewlines(text);
  return normalized
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeMarkdownTableCell(value: unknown): string {
  const str = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, ' ')
    .trim();
  return str.replace(/\|/g, '\\|');
}

function renderMarkdownTable(rows: unknown[][]): string {
  if (rows.length === 0) return '_No data_';

  const columnCount = Math.max(...rows.map(r => r.length), 0);
  if (columnCount === 0) return '_No data_';

  const headerRowRaw = rows[0] ?? [];
  const headerRow: string[] = Array.from({ length: columnCount }, (_, i) => {
    const v = headerRowRaw[i];
    const cleaned = escapeMarkdownTableCell(v);
    return cleaned ? cleaned : `Column ${i + 1}`;
  });

  const lines: string[] = [];
  lines.push(`| ${headerRow.join(' | ')} |`);
  lines.push(`| ${headerRow.map(() => '---').join(' | ')} |`);

  for (const row of rows.slice(1)) {
    const cells = Array.from({ length: columnCount }, (_, i) =>
      escapeMarkdownTableCell(row?.[i]),
    );
    lines.push(`| ${cells.join(' | ')} |`);
  }

  return lines.join('\n');
}

async function parsePdf(
  filePath: string,
  options: any = {},
): Promise<{
  numpages: number;
  info: any;
  textByPage: string[];
  rawText: string;
}> {
  const buffer = readFileSync(filePath);
  const maxPages = clampInt(options.max_pages, { min: 0, max: 10_000 }) ?? 0;

  let pageIndex = 0;
  const textByPage: string[] = [];
  const data = await pdfParse(buffer, {
    max: maxPages, // 0 = all pages
    pagerender: (pageData: any) => {
      pageIndex += 1;
      const renderOptions = {
        normalizeWhitespace: true,
        disableCombineTextItems: false,
      };
      return pageData.getTextContent(renderOptions).then((textContent: any) => {
        let lastY: number | undefined;
        let pageText = '';

        for (const item of textContent.items ?? []) {
          const str = typeof item?.str === 'string' ? item.str : '';
          const y = Array.isArray(item?.transform) ? item.transform[5] : undefined;
          if (typeof y === 'number' && typeof lastY === 'number' && y !== lastY) {
            pageText += '\n';
          }
          pageText += str;
          lastY = typeof y === 'number' ? y : lastY;
        }

        const cleaned = cleanupExtractedText(pageText);
        textByPage.push(cleaned);
        return cleaned;
      });
    },
  });

  return {
    numpages: data.numpages,
    info: data.info,
    textByPage,
    rawText: cleanupExtractedText(String(data.text ?? '')),
  };
}

async function readPDF(filePath: string, options: any = {}): Promise<string> {
  const parsed = await parsePdf(filePath, options);

  const includeMetadata = options.include_metadata !== false;
  let result = '';

  if (includeMetadata) {
    result += `## Document Info\n`;
    result += `- Type: PDF\n`;
    result += `- File: ${basename(filePath)}\n`;
    result += `- Pages: ${parsed.numpages}\n`;
    result += `- Title: ${parsed.info?.Title || 'N/A'}\n`;
    result += `- Author: ${parsed.info?.Author || 'N/A'}\n`;
    result += `- Created: ${parsed.info?.CreationDate || 'N/A'}\n\n`;
  }

  const pages = parsed.textByPage.length > 0 ? parsed.textByPage : [parsed.rawText];
  const analyzedPages = pages.length;

  result += `## Content\n\n`;
  pages.forEach((text, i) => {
    const pageNo = i + 1;
    result += `### Page ${pageNo}\n\n`;
    result += text ? `${text}\n\n` : `_No text extracted on this page._\n\n`;
  });

  if (
    parsed.rawText.replace(/\s/g, '').length <
    Math.max(50, analyzedPages * 20)
  ) {
    result += `## Notes\n- 内容很少：如果这是扫描版 PDF，可能需要先做 OCR。\n`;
  }

  return result.trim();
}

async function readDOCX(filePath: string, options: any = {}): Promise<string> {
  const includeMetadata = options.include_metadata !== false;
  const useRawText = options.raw_text === true;

  let output = '';
  if (includeMetadata) {
    output += `## Document Info\n`;
    output += `- Type: Word (DOCX)\n`;
    output += `- File: ${basename(filePath)}\n`;
    output += `- Size: ${formatFileSize(statSync(filePath).size)}\n\n`;
  }

  const mammothAny = mammoth as any;
  const result = useRawText
    ? await mammothAny.extractRawText({ path: filePath })
    : await mammothAny.convertToMarkdown(
        { path: filePath },
        {
          convertImage: mammothAny.images.imgElement(
            async () => ({ src: 'about:blank' }),
          ),
        },
      );

  output += `## Content\n\n${cleanupExtractedText(String(result.value ?? ''))}`;

  if (Array.isArray(result.messages) && result.messages.length > 0) {
    output += `\n\n## Warnings\n`;
    result.messages.forEach((msg: any) => {
      const m = typeof msg?.message === 'string' ? msg.message : String(msg);
      output += `- ${m}\n`;
    });
  }

  return output.trim();
}

function readExcelAsJSON(filePath: string, options: any = {}): any {
  const workbook = XLSX.readFile(filePath);
  const sheetName = options.sheet_name || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found`);
  }

  const jsonOpts: XLSX.Sheet2JSONOpts = {
    header: options.as_json === false ? 1 : undefined,
    range: options.range,
    defval: '',
  };

  const data = XLSX.utils.sheet_to_json(sheet, jsonOpts);

  return {
    sheet_name: sheetName,
    row_count: data.length,
    data: data,
  };
}

function getSheetRowsForPreview(sheet: XLSX.WorkSheet, options: any = {}): {
  allRows: unknown[][];
  previewRows: unknown[][];
  truncated: boolean;
  rowCount: number;
  colCount: number;
} {
  const allRows = (XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    range: options.range,
    blankrows: false,
    defval: '',
  }) ?? []) as unknown[][];

  const nonEmpty = allRows.filter(r =>
    Array.isArray(r) ? r.some(cell => String(cell ?? '').trim() !== '') : false,
  );

  const rowCount = nonEmpty.length;
  const colCount = Math.max(...nonEmpty.map(r => (Array.isArray(r) ? r.length : 0)), 0);

  const maxRows = clampInt(options.max_rows, { min: 1, max: 10_000 }) ?? 50;
  const maxCols = clampInt(options.max_cols, { min: 1, max: 200 }) ?? 20;

  const limitedRows = nonEmpty.slice(0, Math.max(1, maxRows + 1)); // +1 for header row
  const previewRows = limitedRows.map(r =>
    Array.isArray(r) ? r.slice(0, maxCols) : [],
  );

  const truncated = rowCount > maxRows + 1 || colCount > maxCols;

  return { allRows: nonEmpty, previewRows, truncated, rowCount, colCount };
}

function readXLSXAsMarkdown(filePath: string, options: any = {}): string {
  const workbook = XLSX.readFile(filePath);
  const sheetNames = workbook.SheetNames;

  const includeMetadata = options.include_metadata !== false;
  const maxSheets = clampInt(options.max_sheets, { min: 1, max: 200 }) ?? sheetNames.length;
  const requestedSheets = options.sheet_name ? [options.sheet_name] : sheetNames;
  const sheetsToRead = requestedSheets.slice(0, maxSheets);

  let result = '';

  if (includeMetadata) {
    result += `## Workbook Info\n`;
    result += `- Type: Excel\n`;
    result += `- File: ${basename(filePath)}\n`;
    result += `- Sheets: ${sheetNames.join(', ')}\n\n`;
  }

  result += `## Content\n\n`;

  for (const sheetName of sheetsToRead) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      result += `### Sheet: ${sheetName}\n\n_Sheet not found._\n\n`;
      continue;
    }

    const { previewRows, truncated, rowCount, colCount } = getSheetRowsForPreview(
      sheet,
      options,
    );

    result += `### Sheet: ${sheetName}\n\n`;
    result += `- Rows (non-empty): ${rowCount}\n`;
    result += `- Columns (max): ${colCount}\n\n`;
    result += renderMarkdownTable(previewRows);
    result += `\n\n`;

    if (truncated) {
      result += `_Preview truncated. Use options.max_rows/max_cols or read_excel_sheet for full data._\n\n`;
    }
  }

  return result.trim();
}

function commandExists(command: string): boolean {
  try {
    const result =
      process.platform === 'win32'
        ? spawnSync('where', [command], { stdio: 'ignore' })
        : spawnSync('which', [command], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function findAvailableCommand(candidates: string[]): string | null {
  for (const cmd of candidates) {
    if (commandExists(cmd)) return cmd;
  }
  return null;
}

async function readDOC(filePath: string, options: any = {}): Promise<string> {
  const includeMetadata = options.include_metadata !== false;
  const base = basename(filePath);

  const libreOfficeCmd = findAvailableCommand(['soffice', 'libreoffice']);
  if (libreOfficeCmd) {
    const outDir = mkdtempSync(join(tmpdir(), 'mcp-office-reader-'));
    try {
      const res = spawnSync(
        libreOfficeCmd,
        ['--headless', '--convert-to', 'docx', '--outdir', outDir, filePath],
        { encoding: 'utf8', timeout: 90_000 },
      );

      if (res.status !== 0) {
        const err = String(res.stderr || res.stdout || '').trim();
        throw new Error(err || `LibreOffice convert failed (exit ${res.status})`);
      }

      const outGuess = join(outDir, `${base.replace(/\.[^.]+$/i, '')}.docx`);
      const convertedPath = existsSync(outGuess)
        ? outGuess
        : (() => {
            // Best-effort: find first docx in outDir
            try {
              const files: string[] = readdirSync(outDir);
              const first = files.find(f => f.toLowerCase().endsWith('.docx'));
              return first ? join(outDir, first) : null;
            } catch {
              return null;
            }
          })();

      if (!convertedPath) {
        throw new Error('Converted DOCX not found after LibreOffice conversion');
      }

      let output = '';
      if (includeMetadata) {
        output += `## Document Info\n`;
        output += `- Type: Word (DOC)\n`;
        output += `- File: ${base}\n`;
        output += `- Conversion: ${libreOfficeCmd} -> DOCX\n\n`;
      }

      // Avoid duplicated headers: reuse DOCX reader but hide its metadata section.
      const convertedContent = await readDOCX(convertedPath, {
        ...options,
        include_metadata: false,
      });
      const contentOnly = convertedContent.replace(/^## Document Info[\s\S]*?^## Content\n\n/m, '## Content\n\n');
      output += contentOnly;
      return output.trim();
    } finally {
      try {
        rmSync(outDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  const antiwordCmd = findAvailableCommand(['antiword']);
  if (antiwordCmd) {
    const res = spawnSync(antiwordCmd, [filePath], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const text = cleanupExtractedText(String(res.stdout || ''));
    let output = '';
    if (includeMetadata) {
      output += `## Document Info\n`;
      output += `- Type: Word (DOC)\n`;
      output += `- File: ${base}\n`;
      output += `- Extraction: antiword\n\n`;
    }
    output += `## Content\n\n${text || '_No text extracted._'}`;
    if (res.status !== 0) {
      const err = cleanupExtractedText(String(res.stderr || ''));
      output += `\n\n## Warnings\n- antiword exited with ${res.status}${err ? `: ${err}` : ''}\n`;
    }
    return output.trim();
  }

  const catdocCmd = findAvailableCommand(['catdoc']);
  if (catdocCmd) {
    const res = spawnSync(catdocCmd, [filePath], {
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const text = cleanupExtractedText(String(res.stdout || ''));
    let output = '';
    if (includeMetadata) {
      output += `## Document Info\n`;
      output += `- Type: Word (DOC)\n`;
      output += `- File: ${base}\n`;
      output += `- Extraction: catdoc\n\n`;
    }
    output += `## Content\n\n${text || '_No text extracted._'}`;
    if (res.status !== 0) {
      const err = cleanupExtractedText(String(res.stderr || ''));
      output += `\n\n## Warnings\n- catdoc exited with ${res.status}${err ? `: ${err}` : ''}\n`;
    }
    return output.trim();
  }

  return [
    `## Document Info`,
    `- Type: Word (DOC)`,
    `- File: ${base}`,
    ``,
    `## Content`,
    ``,
    `_暂不支持直接解析 .doc（需要 LibreOffice/antiword/catdoc）。建议另存为 .docx 再读。_`,
  ].join('\n').trim();
}

function extractSlideNumber(path: string): number {
  const m = /slide(\d+)\.xml$/i.exec(path);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function extractPptxParagraphText(p: Element): string {
  const parts: string[] = [];
  const childNodes = (p as any).childNodes as any[];
  if (Array.isArray(childNodes) && childNodes.length > 0) {
    for (const node of childNodes) {
      const localName = typeof node?.localName === 'string' ? node.localName : '';
      if (localName === 'br') {
        parts.push('\n');
        continue;
      }
      if (localName === 'r') {
        const tNodes = (node as Element).getElementsByTagNameNS(PPTX_A_NS, 't');
        for (let i = 0; i < tNodes.length; i++) {
          const t = tNodes.item(i) as Element | null;
          const txt = t?.textContent ?? '';
          if (txt) parts.push(txt);
        }
      }
    }
  } else {
    const tNodes = p.getElementsByTagNameNS(PPTX_A_NS, 't');
    for (let i = 0; i < tNodes.length; i++) {
      const t = tNodes.item(i) as Element | null;
      const txt = t?.textContent ?? '';
      if (txt) parts.push(txt);
    }
  }

  return cleanupExtractedText(parts.join(''));
}

function extractPptxTextFromShape(sp: Element): string[] {
  const paragraphs = sp.getElementsByTagNameNS(PPTX_A_NS, 'p');
  const lines: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs.item(i) as Element | null;
    if (!p) continue;
    const line = extractPptxParagraphText(p);
    if (line) lines.push(line);
  }
  return lines;
}

function isPptxTitleShape(sp: Element): boolean {
  const ph = sp.getElementsByTagNameNS(PPTX_P_NS, 'ph');
  for (let i = 0; i < ph.length; i++) {
    const el = ph.item(i) as Element | null;
    const type = el?.getAttribute('type')?.toLowerCase();
    if (type === 'title' || type === 'ctrtitle') return true;
  }
  return false;
}

function collectSlideShapesInOrder(node: Element, out: Element[]): void {
  const children = (node as any).childNodes as any[];
  if (!Array.isArray(children)) return;
  for (const child of children) {
    const localName =
      typeof child?.localName === 'string' ? child.localName : '';
    if (localName === 'sp') {
      out.push(child as Element);
      continue;
    }
    if (localName === 'grpSp') {
      collectSlideShapesInOrder(child as Element, out);
      continue;
    }
  }
}

function extractPptxSlideContent(xml: string): {
  title: string | null;
  lines: string[];
} {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const spTree = doc.getElementsByTagNameNS(PPTX_P_NS, 'spTree').item(0) as Element | null;
  const shapes: Element[] = [];

  if (spTree) {
    collectSlideShapesInOrder(spTree, shapes);
  } else {
    const fallback = doc.getElementsByTagNameNS(PPTX_P_NS, 'sp');
    for (let i = 0; i < fallback.length; i++) {
      const sp = fallback.item(i) as Element | null;
      if (sp) shapes.push(sp);
    }
  }

  let title: string | null = null;
  const lines: string[] = [];

  for (const sp of shapes) {
    const shapeLines = extractPptxTextFromShape(sp);
    if (shapeLines.length === 0) continue;

    if (!title && isPptxTitleShape(sp)) {
      title = shapeLines.find(l => l.trim()) ?? null;
      continue;
    }

    lines.push(...shapeLines);
  }

  // Fallback: some files don't mark title placeholders; use first line as title if it looks like one.
  if (!title && lines.length > 0) {
    const first = lines[0]?.trim();
    if (first && first.length <= 120) {
      title = first;
      lines.shift();
    }
  }

  return { title, lines };
}

async function readPPTX(filePath: string, options: any = {}): Promise<string> {
  const includeMetadata = options.include_metadata !== false;
  const includeNotes = options.include_notes === true;
  const maxSlides = clampInt(options.max_slides, { min: 0, max: 10_000 }) ?? 0;

  const buffer = readFileSync(filePath);
  const zip = await JSZip.loadAsync(buffer);

  const slidePaths = Object.keys(zip.files)
    .filter(p => /^ppt\/slides\/slide\d+\.xml$/i.test(p) && !zip.files[p]?.dir)
    .sort((a, b) => extractSlideNumber(a) - extractSlideNumber(b));

  let result = '';
  if (includeMetadata) {
    result += `## Document Info\n`;
    result += `- Type: PowerPoint (PPTX)\n`;
    result += `- File: ${basename(filePath)}\n`;
    result += `- Slides: ${slidePaths.length}\n\n`;
  }

  result += `## Slides\n\n`;

  const limit =
    maxSlides > 0 ? Math.min(maxSlides, slidePaths.length) : slidePaths.length;
  for (let i = 0; i < limit; i++) {
    const slidePath = slidePaths[i];
    const slideXml = await zip.file(slidePath)?.async('string');
    if (!slideXml) continue;

    const { title, lines } = extractPptxSlideContent(slideXml);
    const slideNo = i + 1;
    const heading = title ? `### Slide ${slideNo}: ${title}` : `### Slide ${slideNo}`;
    result += `${heading}\n\n`;

    if (lines.length === 0) {
      result += `_No text found._\n\n`;
    } else {
      result += lines.map(l => `- ${l}`).join('\n') + '\n\n';
    }

    if (includeNotes) {
      const notesPath = `ppt/notesSlides/notesSlide${slideNo}.xml`;
      const notesXml = await zip.file(notesPath)?.async('string');
      if (notesXml) {
        const { lines: noteLines } = extractPptxSlideContent(notesXml);
        const filtered = noteLines
          .map(l => l.trim())
          .filter(Boolean)
          .slice(0, 200);
        if (filtered.length > 0) {
          result += `#### Notes\n\n`;
          result += filtered.map(l => `- ${l}`).join('\n') + '\n\n';
        }
      }
    }
  }

  if (limit < slidePaths.length) {
    result += `_Slides truncated. Set options.max_slides=0 to read all slides._\n`;
  }

  return result.trim();
}

function truncateForPreview(text: string, maxChars: number): {
  preview: string;
  truncated: boolean;
} {
  const cleaned = normalizeNewlines(text).trim();
  if (maxChars <= 0) return { preview: '', truncated: false };
  if (cleaned.length <= maxChars) return { preview: cleaned, truncated: false };

  // Try to cut on a newline boundary for readability.
  const slice = cleaned.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf('\n');
  const cutAt = lastNewline > maxChars * 0.6 ? lastNewline : maxChars;
  return {
    preview: cleaned.slice(0, cutAt).trimEnd() + '\n…(truncated)…',
    truncated: true,
  };
}

function getBasicTextStats(text: string): {
  chars: number;
  nonWhitespaceChars: number;
  approxWordCount: number;
  approxCjkCharCount: number;
} {
  const normalized = normalizeNewlines(text);
  const nonWhitespaceChars = normalized.replace(/\s/g, '').length;
  const approxWordCount = (normalized.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) ?? [])
    .length;
  const approxCjkCharCount = (normalized.match(/[\u3400-\u4DBF\u4E00-\u9FFF]/g) ?? [])
    .length;
  return {
    chars: normalized.length,
    nonWhitespaceChars,
    approxWordCount,
    approxCjkCharCount,
  };
}

function extractMarkdownHeadings(
  markdown: string,
  maxHeadings: number,
): Array<{ level: number; text: string }> {
  const lines = normalizeNewlines(markdown).split('\n');
  const headings: Array<{ level: number; text: string }> = [];
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    const text = m[2].replace(/\s+#+\s*$/, '').trim();
    if (!text) continue;
    headings.push({ level, text });
    if (headings.length >= maxHeadings) break;
  }
  return headings;
}

function getSheetRangeStats(sheet: XLSX.WorkSheet): {
  approxRows: number | null;
  approxCols: number | null;
} {
  const ref = (sheet as any)['!ref'] as string | undefined;
  if (!ref) return { approxRows: null, approxCols: null };
  try {
    const r = XLSX.utils.decode_range(ref);
    return {
      approxRows: r.e.r - r.s.r + 1,
      approxCols: r.e.c - r.s.c + 1,
    };
  } catch {
    return { approxRows: null, approxCols: null };
  }
}

async function analyzeDocument(filePath: string, options: any = {}): Promise<string> {
  const stats = statSync(filePath);
  const ext = extname(filePath).toLowerCase();

  const previewChars =
    clampInt(options.preview_chars, { min: 200, max: 200_000 }) ??
    DEFAULT_PREVIEW_CHARS;

  const lines: string[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  let previewSource = '';

  lines.push('## Analysis');
  lines.push(`- File: ${basename(filePath)}`);
  lines.push(`- Path: ${filePath}`);
  lines.push(`- Size: ${formatFileSize(stats.size)}`);
  lines.push(`- Modified: ${stats.mtime.toISOString()}`);

  switch (ext) {
    case '.pdf': {
      const maxPages = clampInt(options.max_pages, { min: 0, max: 10_000 }) ?? 10;
      const parsed = await parsePdf(filePath, { ...options, max_pages: maxPages });
      lines.push(`- Type: PDF`);
      lines.push(`- Pages (total): ${parsed.numpages}`);
      lines.push(`- Pages (analyzed): ${parsed.textByPage.length}`);
      previewSource = parsed.textByPage.join('\n\n');
      if (
        parsed.rawText.replace(/\s/g, '').length <
        Math.max(50, Math.max(1, parsed.textByPage.length) * 20)
      ) {
        notes.push('内容很少：如果这是扫描版 PDF，可能需要 OCR。');
      }
      break;
    }

    case '.docx': {
      const mammothAny = mammoth as any;
      const result = await mammothAny.convertToMarkdown(
        { path: filePath },
        {
          convertImage: mammothAny.images.imgElement(
            async () => ({ src: 'about:blank' }),
          ),
        },
      );
      const markdown = cleanupExtractedText(String(result.value ?? ''));
      lines.push(`- Type: Word (DOCX)`);

      const headings = extractMarkdownHeadings(markdown, 50);
      if (headings.length > 0) {
        lines.push(`- Headings (top ${headings.length}):`);
        for (const h of headings) {
          const indent = '  '.repeat(Math.max(0, h.level - 1));
          lines.push(`  - ${indent}${h.text}`);
        }
      }

      previewSource = markdown;

      if (Array.isArray(result.messages) && result.messages.length > 0) {
        result.messages.forEach((msg: any) => {
          const m = typeof msg?.message === 'string' ? msg.message : String(msg);
          warnings.push(m);
        });
      }
      break;
    }

    case '.doc': {
      lines.push(`- Type: Word (DOC)`);
      const content = await readDOC(filePath, { ...options, include_metadata: false });
      previewSource = cleanupExtractedText(content);
      if (previewSource.includes('暂不支持直接解析 .doc')) {
        notes.push('建议把 .doc 另存为 .docx，会更稳定也更准。');
      }
      break;
    }

    case '.xlsx':
    case '.xls': {
      lines.push(`- Type: Excel (${ext.toUpperCase().replace('.', '')})`);
      const workbook = XLSX.readFile(filePath);
      const sheetNames = workbook.SheetNames;
      const maxSheets =
        clampInt(options.max_sheets, { min: 1, max: 200 }) ?? sheetNames.length;
      const sheetsToAnalyze = sheetNames.slice(0, maxSheets);
      lines.push(`- Sheets: ${sheetNames.length}${maxSheets < sheetNames.length ? ` (analyzed ${maxSheets})` : ''}`);

      if (sheetsToAnalyze.length > 0) {
        lines.push(`- Sheet stats:`);
        for (const name of sheetsToAnalyze) {
          const sheet = workbook.Sheets[name];
          if (!sheet) continue;
          const { approxRows, approxCols } = getSheetRangeStats(sheet);
          lines.push(
            `  - ${name}: approx ${approxRows ?? '?'} rows × ${approxCols ?? '?'} cols`,
          );
        }

        // Small preview from the first sheet
        const firstSheet = workbook.Sheets[sheetsToAnalyze[0]];
        if (firstSheet) {
          const { previewRows } = getSheetRowsForPreview(firstSheet, {
            max_rows: 10,
            max_cols: 10,
          });
          previewSource = renderMarkdownTable(previewRows);
        }
      }
      break;
    }

    case '.pptx': {
      lines.push(`- Type: PowerPoint (PPTX)`);
      const maxSlides =
        clampInt(options.max_slides, { min: 1, max: 10_000 }) ?? 30;
      const buffer = readFileSync(filePath);
      const zip = await JSZip.loadAsync(buffer);
      const slidePaths = Object.keys(zip.files)
        .filter(p => /^ppt\/slides\/slide\d+\.xml$/i.test(p) && !zip.files[p]?.dir)
        .sort((a, b) => extractSlideNumber(a) - extractSlideNumber(b));

      lines.push(`- Slides (total): ${slidePaths.length}`);
      const limit = Math.min(maxSlides, slidePaths.length);
      lines.push(`- Slides (analyzed): ${limit}${limit < slidePaths.length ? ' (truncated)' : ''}`);

      if (limit > 0) {
        lines.push(`- Slide outline:`);
        const previewParts: string[] = [];
        for (let i = 0; i < limit; i++) {
          const slideNo = i + 1;
          const slideXml = await zip.file(slidePaths[i])?.async('string');
          if (!slideXml) continue;
          const { title, lines: slideLines } = extractPptxSlideContent(slideXml);
          const titleText = title ? title : '(No title)';
          lines.push(`  - ${slideNo}. ${titleText} (lines: ${slideLines.length})`);
          const sample = slideLines.slice(0, 3).filter(Boolean);
          if (sample.length > 0) {
            previewParts.push(`Slide ${slideNo}: ${titleText}\n- ${sample.join('\n- ')}`);
          }
        }
        previewSource = previewParts.join('\n\n');
      }
      break;
    }

    default:
      lines.push(`- Type: Unknown (${ext})`);
      previewSource = '';
      notes.push('未识别的格式（可能需要先转成 PDF/DOCX/XLSX/PPTX）。');
  }

  const statsSummary = getBasicTextStats(previewSource);
  lines.push(`- Preview chars: ${statsSummary.chars} (non-whitespace: ${statsSummary.nonWhitespaceChars})`);
  lines.push(`- Approx words (A-Z/0-9): ${statsSummary.approxWordCount}`);
  lines.push(`- Approx CJK chars: ${statsSummary.approxCjkCharCount}`);

  const { preview, truncated } = truncateForPreview(previewSource, previewChars);
  lines.push('');
  lines.push('## Preview');
  lines.push('```text');
  lines.push(preview || '(empty)');
  lines.push('```');
  if (truncated) {
    lines.push(`_Preview truncated at ${previewChars} chars._`);
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    warnings.slice(0, 20).forEach(w => lines.push(`- ${w}`));
    if (warnings.length > 20) lines.push(`- ...(and ${warnings.length - 20} more)`);
  }

  if (notes.length > 0) {
    lines.push('');
    lines.push('## Notes');
    notes.forEach(n => lines.push(`- ${n}`));
  }

  return lines.join('\n').trim();
}

function getDocumentInfo(filePath: string): any {
  const stats = statSync(filePath);
  const ext = extname(filePath).toLowerCase();

  const info: any = {
    file_name: basename(filePath),
    file_path: filePath,
    file_size: stats.size,
    file_size_formatted: formatFileSize(stats.size),
    extension: ext,
    modified: stats.mtime.toISOString(),
  };

  try {
    switch (ext) {
      case '.pdf':
        // PDF info requires async, so we return basic info
        info.type = 'PDF Document';
        break;

      case '.docx':
      case '.doc':
        info.type = 'Word Document';
        break;

      case '.xlsx':
      case '.xls':
        const workbook = XLSX.readFile(filePath);
        info.type = 'Excel Spreadsheet';
        info.sheet_names = workbook.SheetNames;
        info.sheet_count = workbook.SheetNames.length;
        break;

      case '.pptx':
        info.type = 'PowerPoint Presentation';
        break;

      default:
        info.type = 'Unknown';
    }
  } catch (error: any) {
    info.error = error.message;
  }

  return info;
}

function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function validateFilePath(filePath: string): void {
  const fullPath = resolve(filePath);

  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }

  const stats = statSync(fullPath);

  if (!stats.isFile()) {
    throw new Error(`Path is not a file: ${fullPath}`);
  }

  if (stats.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${formatFileSize(stats.size)} (max: ${formatFileSize(MAX_FILE_SIZE)})`);
  }

  const ext = extname(fullPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file format: ${ext}. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
  }
}

// Create and run the server
const server = new Server(
  {
    name: 'mcp-office-reader',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'read_document': {
        const filePath = resolve(args?.file_path as string);
        validateFilePath(filePath);

        const ext = extname(filePath).toLowerCase();
        const options = args?.options || {};
        let content: string;

        switch (ext) {
          case '.pdf':
            content = await readPDF(filePath, options);
            break;
          case '.docx':
            content = await readDOCX(filePath, options);
            break;
          case '.doc':
            content = await readDOC(filePath, options);
            break;
          case '.xlsx':
          case '.xls':
            content = readXLSXAsMarkdown(filePath, options);
            break;
          case '.pptx':
            content = await readPPTX(filePath, options);
            break;
          default:
            throw new Error(`Reading not implemented for: ${ext}`);
        }

        return {
          content: [{ type: 'text', text: content }],
        };
      }

      case 'get_document_info': {
        const filePath = resolve(args?.file_path as string);
        validateFilePath(filePath);

        const info = getDocumentInfo(filePath);

        return {
          content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
        };
      }

      case 'read_excel_sheet': {
        const filePath = resolve(args?.file_path as string);
        validateFilePath(filePath);

        const data = readExcelAsJSON(filePath, args);

        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'list_supported_formats': {
        const formats = {
          supported_formats: [
            {
              extension: '.pdf',
              name: 'PDF Document',
              capabilities: ['read text', 'get metadata', 'page count'],
            },
            {
              extension: '.docx',
              name: 'Word Document (OpenXML)',
              capabilities: ['read text', 'extract content'],
            },
            {
              extension: '.doc',
              name: 'Word Document (Legacy)',
              capabilities: [
                'read text (best-effort via LibreOffice/antiword/catdoc)',
              ],
            },
            {
              extension: '.xlsx',
              name: 'Excel Spreadsheet (OpenXML)',
              capabilities: [
                'read sheets',
                'get as JSON',
                'list sheets',
                'read ranges',
              ],
            },
            {
              extension: '.xls',
              name: 'Excel Spreadsheet (Legacy)',
              capabilities: ['read sheets', 'get as JSON'],
            },
            {
              extension: '.pptx',
              name: 'PowerPoint (OpenXML)',
              capabilities: ['read slide text', 'read notes (optional)'],
            },
          ],
          max_file_size: formatFileSize(MAX_FILE_SIZE),
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(formats, null, 2) }],
        };
      }

      case 'analyze_document': {
        const filePath = resolve(args?.file_path as string);
        validateFilePath(filePath);

        const report = await analyzeDocument(filePath, args?.options || {});
        return {
          content: [{ type: 'text', text: report }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Office Reader server running on stdio');
}

main().catch(console.error);
