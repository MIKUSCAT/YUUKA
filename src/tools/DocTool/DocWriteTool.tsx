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
import { WRITE_DESCRIPTION, WRITE_PROMPT } from './prompt'
import { TREE_END } from '@constants/figures'

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx'])

const inputSchema = z.strictObject({
  file_path: z.string().describe('The absolute path for the output document'),
  content: z.string().describe('Content to write. Can be plain text, markdown, or JSON for structured documents'),
  title: z.string().optional().describe('Document title (optional)'),
  template: z.string().optional().describe('Path to template file (optional)'),
})

type DocWriteOutput = {
  type: 'document_created'
  file: {
    filePath: string
    format: string
    size: number
  }
}

// Python script for document writing
const PYTHON_SCRIPT = `
import sys
import json
import os

def write_pdf(file_path, content, title=None):
    try:
        from reportlab.lib.pagesizes import letter, A4
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
        from reportlab.lib.units import inch
    except ImportError:
        return {"error": "reportlab not installed. Run: pip install reportlab"}

    doc = SimpleDocTemplate(file_path, pagesize=A4)
    styles = getSampleStyleSheet()
    story = []

    # Add title if provided
    if title:
        title_style = ParagraphStyle(
            'CustomTitle',
            parent=styles['Heading1'],
            fontSize=24,
            spaceAfter=30
        )
        story.append(Paragraph(title, title_style))
        story.append(Spacer(1, 12))

    # Parse content - handle JSON or plain text
    try:
        data = json.loads(content)
        if isinstance(data, dict) and 'sections' in data:
            for section in data['sections']:
                if 'heading' in section:
                    story.append(Paragraph(section['heading'], styles['Heading2']))
                    story.append(Spacer(1, 6))
                if 'content' in section:
                    for para in section['content'].split('\\n\\n'):
                        if para.strip():
                            story.append(Paragraph(para, styles['Normal']))
                            story.append(Spacer(1, 6))
        else:
            # Plain JSON content
            story.append(Paragraph(str(data), styles['Normal']))
    except json.JSONDecodeError:
        # Plain text content - handle markdown-like formatting
        lines = content.split('\\n')
        for line in lines:
            if line.startswith('# '):
                story.append(Paragraph(line[2:], styles['Heading1']))
            elif line.startswith('## '):
                story.append(Paragraph(line[3:], styles['Heading2']))
            elif line.startswith('### '):
                story.append(Paragraph(line[4:], styles['Heading3']))
            elif line.strip():
                story.append(Paragraph(line, styles['Normal']))
            story.append(Spacer(1, 3))

    doc.build(story)
    return {"success": True, "size": os.path.getsize(file_path)}

def write_docx(file_path, content, title=None):
    try:
        from docx import Document
        from docx.shared import Inches, Pt
    except ImportError:
        return {"error": "python-docx not installed. Run: pip install python-docx"}

    doc = Document()

    # Add title
    if title:
        doc.add_heading(title, 0)

    # Parse content
    try:
        data = json.loads(content)
        if isinstance(data, dict) and 'sections' in data:
            for section in data['sections']:
                if 'heading' in section:
                    doc.add_heading(section['heading'], level=1)
                if 'content' in section:
                    doc.add_paragraph(section['content'])
        elif isinstance(data, dict) and 'table' in data:
            # Handle table data
            table_data = data['table']
            if table_data:
                table = doc.add_table(rows=len(table_data), cols=len(table_data[0]))
                table.style = 'Table Grid'
                for i, row in enumerate(table_data):
                    for j, cell in enumerate(row):
                        table.rows[i].cells[j].text = str(cell)
        else:
            doc.add_paragraph(str(data))
    except json.JSONDecodeError:
        # Handle markdown-like text
        lines = content.split('\\n')
        for line in lines:
            if line.startswith('# '):
                doc.add_heading(line[2:], level=1)
            elif line.startswith('## '):
                doc.add_heading(line[3:], level=2)
            elif line.startswith('### '):
                doc.add_heading(line[4:], level=3)
            elif line.startswith('- '):
                doc.add_paragraph(line[2:], style='List Bullet')
            elif line.startswith('1. ') or line.startswith('2. ') or line.startswith('3. '):
                doc.add_paragraph(line[3:], style='List Number')
            elif line.strip():
                doc.add_paragraph(line)

    doc.save(file_path)
    return {"success": True, "size": os.path.getsize(file_path)}

def write_pptx(file_path, content, title=None):
    try:
        from pptx import Presentation
        from pptx.util import Inches, Pt
    except ImportError:
        return {"error": "python-pptx not installed. Run: pip install python-pptx"}

    prs = Presentation()

    # Parse content
    try:
        data = json.loads(content)
        if isinstance(data, dict) and 'slides' in data:
            for slide_data in data['slides']:
                slide_layout = prs.slide_layouts[1]  # Title and Content
                slide = prs.slides.add_slide(slide_layout)

                if 'title' in slide_data:
                    slide.shapes.title.text = slide_data['title']
                if 'content' in slide_data:
                    body = slide.shapes.placeholders[1]
                    tf = body.text_frame
                    tf.text = slide_data['content']
                if 'bullets' in slide_data:
                    body = slide.shapes.placeholders[1]
                    tf = body.text_frame
                    for i, bullet in enumerate(slide_data['bullets']):
                        if i == 0:
                            tf.text = bullet
                        else:
                            p = tf.add_paragraph()
                            p.text = bullet
        else:
            # Simple text - create title slide + content slide
            title_slide = prs.slides.add_slide(prs.slide_layouts[0])
            title_slide.shapes.title.text = title or "Presentation"

            content_slide = prs.slides.add_slide(prs.slide_layouts[1])
            content_slide.shapes.title.text = "Content"
            content_slide.shapes.placeholders[1].text = str(data) if isinstance(data, dict) else content

    except json.JSONDecodeError:
        # Parse markdown-like slides
        slides = content.split('---')
        for slide_content in slides:
            slide_layout = prs.slide_layouts[1]
            slide = prs.slides.add_slide(slide_layout)

            lines = slide_content.strip().split('\\n')
            if lines:
                # First line as title
                slide_title = lines[0].lstrip('#').strip()
                slide.shapes.title.text = slide_title

                # Rest as content
                if len(lines) > 1:
                    body = slide.shapes.placeholders[1]
                    body.text = '\\n'.join(lines[1:])

    prs.save(file_path)
    return {"success": True, "size": os.path.getsize(file_path)}

def write_xlsx(file_path, content, title=None):
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, Alignment
    except ImportError:
        return {"error": "openpyxl not installed. Run: pip install openpyxl"}

    wb = Workbook()

    try:
        data = json.loads(content)
        if isinstance(data, dict) and 'sheets' in data:
            # Multiple sheets
            first = True
            for sheet_name, rows in data['sheets'].items():
                if first:
                    ws = wb.active
                    ws.title = sheet_name
                    first = False
                else:
                    ws = wb.create_sheet(sheet_name)

                for row_idx, row in enumerate(rows, 1):
                    for col_idx, value in enumerate(row, 1):
                        ws.cell(row=row_idx, column=col_idx, value=value)

                # Auto-adjust column widths
                for col in ws.columns:
                    max_length = 0
                    column = col[0].column_letter
                    for cell in col:
                        try:
                            if len(str(cell.value)) > max_length:
                                max_length = len(str(cell.value))
                        except:
                            pass
                    ws.column_dimensions[column].width = min(max_length + 2, 50)

        elif isinstance(data, list):
            # Single sheet with list of rows
            ws = wb.active
            ws.title = title or "Data"
            for row_idx, row in enumerate(data, 1):
                if isinstance(row, list):
                    for col_idx, value in enumerate(row, 1):
                        ws.cell(row=row_idx, column=col_idx, value=value)
                else:
                    ws.cell(row=row_idx, column=1, value=str(row))
        else:
            ws = wb.active
            ws.cell(row=1, column=1, value=str(data))

    except json.JSONDecodeError:
        # Parse CSV-like or tab-separated content
        ws = wb.active
        ws.title = title or "Data"
        lines = content.strip().split('\\n')
        for row_idx, line in enumerate(lines, 1):
            # Try tab first, then comma
            cells = line.split('\\t') if '\\t' in line else line.split(',')
            for col_idx, value in enumerate(cells, 1):
                ws.cell(row=row_idx, column=col_idx, value=value.strip())

    wb.save(file_path)
    return {"success": True, "size": os.path.getsize(file_path)}

def main():
    args = json.loads(sys.argv[1])
    file_path = args['file_path']
    content = args['content']
    title = args.get('title')

    ext = os.path.splitext(file_path)[1].lower()

    # Create directory if it doesn't exist
    os.makedirs(os.path.dirname(file_path), exist_ok=True)

    if ext == '.pdf':
        result = write_pdf(file_path, content, title)
    elif ext == '.docx':
        result = write_docx(file_path, content, title)
    elif ext == '.pptx':
        result = write_pptx(file_path, content, title)
    elif ext == '.xlsx':
        result = write_xlsx(file_path, content, title)
    else:
        result = {"error": f"Unsupported format: {ext}"}

    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
`

async function runPythonScript(args: Record<string, any>): Promise<{
  success?: boolean
  size?: number
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
        resolve({ error: stderr || `Python process exited with code ${code}` })
        return
      }

      try {
        const result = JSON.parse(stdout)
        resolve(result)
      } catch (e) {
        resolve({ error: `Failed to parse output: ${stdout}` })
      }
    })

    process.on('error', (err: Error) => {
      reject(err)
    })
  })
}

export const DocWriteTool = {
  name: 'DocWrite',
  async description() {
    return WRITE_DESCRIPTION
  },
  async prompt() {
    return WRITE_PROMPT
  },
  inputSchema,
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return false
  },
  userFacingName() {
    return 'DocWrite'
  },
  async isEnabled() {
    return true
  },
  needsPermissions() {
    return true // Always needs permission for writing
  },
  renderToolUseMessage(input: z.infer<typeof inputSchema>, { verbose }: { verbose: boolean }) {
    const { file_path, content, ...rest } = input
    const contentPreview = content.length > 100 ? content.slice(0, 100) + '...' : content
    const entries = [
      ['file_path', verbose ? file_path : relative(getCwd(), file_path)],
      ['content', `(${content.length} chars)`],
      ...Object.entries(rest).filter(([_, v]) => v !== undefined),
    ]
    return entries
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ')
  },
  renderToolResultMessage(output: DocWriteOutput) {
    const theme = getTheme()
    const { file } = output

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={theme.secondaryText}>{TREE_END} </Text>
          <Text color={theme.success}>Created {file.format.toUpperCase()} document</Text>
        </Box>
        <Text color={theme.secondaryText}>
          Size: {(file.size / 1024).toFixed(1)} KB
        </Text>
      </Box>
    )
  },
  async validateInput({ file_path, content }: { file_path: string; content: string }) {
    const fullFilePath = normalizeFilePath(file_path)
    const ext = path.extname(fullFilePath).toLowerCase()

    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return {
        result: false,
        message: `Unsupported file format: ${ext}. Supported formats: ${[...SUPPORTED_EXTENSIONS].join(', ')}. If you want to write a plain Markdown file (.md), use the Write tool instead.`,
      }
    }

    if (!content || content.trim().length === 0) {
      return {
        result: false,
        message: 'Content cannot be empty.',
      }
    }

    return { result: true }
  },
  async *call(
    { file_path, content, title, template }: z.infer<typeof inputSchema>,
    context: any,
  ) {
    const fullFilePath = normalizeFilePath(file_path)
    const ext = path.extname(fullFilePath).toLowerCase()

    const result = await runPythonScript({
      file_path: fullFilePath,
      content,
      title,
      template,
    })

    if (result.error) {
      throw new Error(result.error)
    }

    const data: DocWriteOutput = {
      type: 'document_created',
      file: {
        filePath: file_path,
        format: ext.slice(1),
        size: result.size || 0,
      },
    }

    yield {
      type: 'result',
      data,
      resultForAssistant: this.renderResultForAssistant(data),
    }
  },
  renderResultForAssistant(data: DocWriteOutput) {
    return `Document created successfully:
- Path: ${data.file.filePath}
- Format: ${data.file.format.toUpperCase()}
- Size: ${(data.file.size / 1024).toFixed(1)} KB`
  },
} satisfies Tool<typeof inputSchema, DocWriteOutput>
