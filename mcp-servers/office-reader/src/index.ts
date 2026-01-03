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
import { readFileSync, existsSync, statSync } from 'fs';
import { extname, resolve, basename } from 'path';

// Import document parsers
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

// Constants
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.doc'];

// Tool definitions
const tools: Tool[] = [
  {
    name: 'read_document',
    description: `Read and extract text content from office documents.
Supports: PDF, DOCX, XLSX, XLS, PPTX
Returns extracted text content with metadata.`,
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
            sheet_name: {
              type: 'string',
              description: 'For Excel files: specific sheet name to read',
            },
            max_pages: {
              type: 'number',
              description: 'For PDF files: maximum pages to read (default: all)',
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
];

// Document readers
async function readPDF(filePath: string, options: any = {}): Promise<string> {
  const buffer = readFileSync(filePath);
  const data = await pdfParse(buffer, {
    max: options.max_pages || 0, // 0 = all pages
  });

  let result = '';

  if (options.include_metadata !== false) {
    result += `## Document Info\n`;
    result += `- Pages: ${data.numpages}\n`;
    result += `- Title: ${data.info?.Title || 'N/A'}\n`;
    result += `- Author: ${data.info?.Author || 'N/A'}\n`;
    result += `- Created: ${data.info?.CreationDate || 'N/A'}\n\n`;
  }

  result += `## Content\n\n${data.text}`;

  return result;
}

async function readDOCX(filePath: string, options: any = {}): Promise<string> {
  const buffer = readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });

  let output = '';

  if (options.include_metadata !== false) {
    output += `## Document Info\n`;
    output += `- File: ${basename(filePath)}\n`;
    output += `- Size: ${formatFileSize(statSync(filePath).size)}\n\n`;
  }

  output += `## Content\n\n${result.value}`;

  if (result.messages.length > 0) {
    output += `\n\n## Warnings\n`;
    result.messages.forEach(msg => {
      output += `- ${msg.message}\n`;
    });
  }

  return output;
}

function readXLSX(filePath: string, options: any = {}): string {
  const workbook = XLSX.readFile(filePath);
  const sheetNames = workbook.SheetNames;

  let result = '';

  if (options.include_metadata !== false) {
    result += `## Workbook Info\n`;
    result += `- File: ${basename(filePath)}\n`;
    result += `- Sheets: ${sheetNames.join(', ')}\n\n`;
  }

  // Read specified sheet or all sheets
  const sheetsToRead = options.sheet_name
    ? [options.sheet_name]
    : sheetNames;

  for (const sheetName of sheetsToRead) {
    if (!sheetNames.includes(sheetName)) {
      result += `## Sheet: ${sheetName}\nSheet not found!\n\n`;
      continue;
    }

    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_csv(sheet);

    result += `## Sheet: ${sheetName}\n\n`;
    result += '```csv\n' + data + '\n```\n\n';
  }

  return result;
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
          case '.doc':
            content = await readDOCX(filePath, options);
            break;
          case '.xlsx':
          case '.xls':
            content = readXLSX(filePath, options);
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
              capabilities: ['read text (limited)'],
            },
            {
              extension: '.xlsx',
              name: 'Excel Spreadsheet (OpenXML)',
              capabilities: ['read sheets', 'get as JSON', 'list sheets', 'read ranges'],
            },
            {
              extension: '.xls',
              name: 'Excel Spreadsheet (Legacy)',
              capabilities: ['read sheets', 'get as JSON'],
            },
            {
              extension: '.pptx',
              name: 'PowerPoint (OpenXML)',
              capabilities: ['read text (coming soon)'],
            },
          ],
          max_file_size: formatFileSize(MAX_FILE_SIZE),
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(formats, null, 2) }],
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
