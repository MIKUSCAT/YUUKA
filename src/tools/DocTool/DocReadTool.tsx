import { Box, Text } from 'ink'
import * as path from 'node:path'
import { relative } from 'node:path'
import * as React from 'react'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import type { Tool } from '@tool'
import { getCwd } from '@utils/state'
import { normalizeFilePath } from '@utils/file'
import { getTheme } from '@utils/theme'
import { READ_DESCRIPTION, READ_PROMPT } from './prompt'
import { hasReadPermission } from '@utils/permissions/filesystem'
import { secureFileService } from '@utils/secureFile'
import { TREE_END } from '@constants/figures'

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls'])

const inputSchema = z.strictObject({
  file_path: z.string().describe('The absolute path to the document file'),
  format: z.enum(['text', 'json', 'markdown']).optional().default('text')
    .describe('Output format: text (default), json for structured data, markdown for formatted output'),
  sheet: z.string().optional()
    .describe('For Excel files: sheet name or index (e.g., "Sheet1" or "0"). Default reads all sheets'),
  pages: z.string().optional()
    .describe('For PDF files: page range (e.g., "1-5" or "1,3,5"). Default reads all pages'),
})

type DocReadOutput = {
  type: 'document'
  file: {
    filePath: string
    content: string
    format: string
    metadata?: {
      pages?: number
      sheets?: string[]
      slides?: number
    }
  }
}

// Python script for document reading
const PYTHON_SCRIPT = `
import sys
import json
import os

def read_pdf(file_path, pages=None, output_format='text'):
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return {"error": "PyMuPDF not installed. Run: pip install PyMuPDF"}

    doc = fitz.open(file_path)
    result = {"content": "", "metadata": {"pages": len(doc)}}

    page_list = range(len(doc))
    if pages:
        if '-' in pages:
            start, end = map(int, pages.split('-'))
            page_list = range(start - 1, min(end, len(doc)))
        elif ',' in pages:
            page_list = [int(p) - 1 for p in pages.split(',') if int(p) <= len(doc)]
        else:
            page_list = [int(pages) - 1] if int(pages) <= len(doc) else []

    texts = []
    for page_num in page_list:
        page = doc[page_num]
        text = page.get_text()
        if output_format == 'markdown':
            texts.append(f"## Page {page_num + 1}\\n\\n{text}")
        else:
            texts.append(f"--- Page {page_num + 1} ---\\n{text}")

    result["content"] = "\\n\\n".join(texts)
    doc.close()
    return result

def read_docx(file_path, output_format='text'):
    try:
        from docx import Document
    except ImportError:
        return {"error": "python-docx not installed. Run: pip install python-docx"}

    doc = Document(file_path)
    result = {"content": "", "metadata": {}}

    texts = []
    for para in doc.paragraphs:
        if output_format == 'markdown':
            if para.style.name.startswith('Heading'):
                level = int(para.style.name[-1]) if para.style.name[-1].isdigit() else 1
                texts.append('#' * level + ' ' + para.text)
            else:
                texts.append(para.text)
        else:
            texts.append(para.text)

    # Extract tables
    for table in doc.tables:
        rows = []
        for row in table.rows:
            cells = [cell.text for cell in row.cells]
            rows.append(' | '.join(cells))
        if output_format == 'markdown':
            texts.append('\\n' + '\\n'.join(rows))
        else:
            texts.append('\\n[Table]\\n' + '\\n'.join(rows))

    result["content"] = '\\n'.join(texts)
    return result

def read_pptx(file_path, output_format='text'):
    try:
        from pptx import Presentation
    except ImportError:
        return {"error": "python-pptx not installed. Run: pip install python-pptx"}

    prs = Presentation(file_path)
    result = {"content": "", "metadata": {"slides": len(prs.slides)}}

    texts = []
    for idx, slide in enumerate(prs.slides, 1):
        slide_text = []
        if output_format == 'markdown':
            slide_text.append(f"## Slide {idx}")
        else:
            slide_text.append(f"--- Slide {idx} ---")

        for shape in slide.shapes:
            if hasattr(shape, "text") and shape.text:
                slide_text.append(shape.text)

        texts.append('\\n'.join(slide_text))

    result["content"] = '\\n\\n'.join(texts)
    return result

def read_xlsx(file_path, sheet=None, output_format='text'):
    try:
        from openpyxl import load_workbook
    except ImportError:
        return {"error": "openpyxl not installed. Run: pip install openpyxl"}

    wb = load_workbook(file_path, data_only=True)
    result = {"content": "", "metadata": {"sheets": wb.sheetnames}}

    sheets_to_read = wb.sheetnames
    if sheet:
        if sheet.isdigit():
            idx = int(sheet)
            if 0 <= idx < len(wb.sheetnames):
                sheets_to_read = [wb.sheetnames[idx]]
        elif sheet in wb.sheetnames:
            sheets_to_read = [sheet]

    texts = []
    for sheet_name in sheets_to_read:
        ws = wb[sheet_name]
        if output_format == 'markdown':
            texts.append(f"## {sheet_name}")
        else:
            texts.append(f"--- Sheet: {sheet_name} ---")

        rows = []
        for row in ws.iter_rows(values_only=True):
            cells = [str(cell) if cell is not None else '' for cell in row]
            if output_format == 'markdown':
                rows.append('| ' + ' | '.join(cells) + ' |')
            else:
                rows.append('\\t'.join(cells))

        if output_format == 'markdown' and rows:
            header = rows[0]
            separator = '| ' + ' | '.join(['---'] * len(rows[0].split(' | '))) + ' |'
            rows.insert(1, separator)

        texts.append('\\n'.join(rows))

    result["content"] = '\\n\\n'.join(texts)
    wb.close()
    return result

def main():
    args = json.loads(sys.argv[1])
    file_path = args['file_path']
    output_format = args.get('format', 'text')
    sheet = args.get('sheet')
    pages = args.get('pages')

    ext = os.path.splitext(file_path)[1].lower()

    if ext == '.pdf':
        result = read_pdf(file_path, pages, output_format)
    elif ext in ['.docx', '.doc']:
        result = read_docx(file_path, output_format)
    elif ext in ['.pptx', '.ppt']:
        result = read_pptx(file_path, output_format)
    elif ext in ['.xlsx', '.xls']:
        result = read_xlsx(file_path, sheet, output_format)
    else:
        result = {"error": f"Unsupported format: {ext}"}

    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
`

async function runPythonScript(args: Record<string, any>): Promise<{
  content: string
  metadata?: Record<string, any>
  error?: string
}> {
  return new Promise((resolve, reject) => {
    const process = spawn('py', ['-c', PYTHON_SCRIPT, JSON.stringify(args)])

    let stdout = ''
    let stderr = ''

    process.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    process.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    process.on('close', (code: number) => {
      if (code !== 0) {
        resolve({ content: '', error: stderr || `Python process exited with code ${code}` })
        return
      }

      try {
        const result = JSON.parse(stdout)
        resolve(result)
      } catch (e) {
        resolve({ content: stdout, error: undefined })
      }
    })

    process.on('error', (err: Error) => {
      reject(err)
    })
  })
}

export const DocReadTool = {
  name: 'DocRead',
  async description() {
    return READ_DESCRIPTION
  },
  async prompt() {
    return READ_PROMPT
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  userFacingName() {
    return 'DocRead'
  },
  async isEnabled() {
    return true
  },
  needsPermissions({ file_path }: { file_path: string }) {
    return !hasReadPermission(file_path || getCwd())
  },
  renderToolUseMessage(input: z.infer<typeof inputSchema>, { verbose }: { verbose: boolean }) {
    const { file_path, ...rest } = input
    const entries = [
      ['file_path', verbose ? file_path : relative(getCwd(), file_path)],
      ...Object.entries(rest).filter(([_, v]) => v !== undefined),
    ]
    return entries
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ')
  },
  renderToolResultMessage(output: DocReadOutput) {
    const theme = getTheme()
    const { file, type } = output
    const preview = file.content.split('\n').slice(0, 5).join('\n')
    const lineCount = file.content.split('\n').length

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={theme.secondaryText}>{TREE_END} </Text>
          <Text color={theme.success}>Read document ({file.format})</Text>
        </Box>
        {file.metadata && (
          <Text color={theme.secondaryText}>
            {file.metadata.pages && `Pages: ${file.metadata.pages}`}
            {file.metadata.slides && `Slides: ${file.metadata.slides}`}
            {file.metadata.sheets && `Sheets: ${file.metadata.sheets.join(', ')}`}
          </Text>
        )}
        <Text color={theme.secondaryText}>
          {lineCount > 5 ? `... (+${lineCount - 5} lines)` : ''}
        </Text>
      </Box>
    )
  },
  async validateInput({ file_path }: { file_path: string }) {
    const fullFilePath = normalizeFilePath(file_path)
    const ext = path.extname(fullFilePath).toLowerCase()

    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return {
        result: false,
        message: `Unsupported file format: ${ext}. Supported formats: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
      }
    }

    const fileCheck = secureFileService.safeGetFileInfo(fullFilePath)
    if (!fileCheck.success) {
      return {
        result: false,
        message: 'File does not exist.',
      }
    }

    return { result: true }
  },
  async *call(
    { file_path, format = 'text', sheet, pages }: z.infer<typeof inputSchema>,
    context: any,
  ) {
    const fullFilePath = normalizeFilePath(file_path)
    const ext = path.extname(fullFilePath).toLowerCase()

    const result = await runPythonScript({
      file_path: fullFilePath,
      format,
      sheet,
      pages,
    })

    if (result.error) {
      throw new Error(result.error)
    }

    const data: DocReadOutput = {
      type: 'document',
      file: {
        filePath: file_path,
        content: result.content,
        format: ext.slice(1),
        metadata: result.metadata,
      },
    }

    yield {
      type: 'result',
      data,
      resultForAssistant: this.renderResultForAssistant(data),
    }
  },
  renderResultForAssistant(data: DocReadOutput) {
    const { file } = data
    let header = `Document: ${file.filePath}\nFormat: ${file.format}\n`

    if (file.metadata) {
      if (file.metadata.pages) header += `Pages: ${file.metadata.pages}\n`
      if (file.metadata.slides) header += `Slides: ${file.metadata.slides}\n`
      if (file.metadata.sheets) header += `Sheets: ${file.metadata.sheets.join(', ')}\n`
    }

    return `${header}\n---\n\n${file.content}`
  },
} satisfies Tool<typeof inputSchema, DocReadOutput>
