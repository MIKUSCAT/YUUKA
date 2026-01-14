import { Box, Text } from 'ink'
import * as path from 'node:path'
import { relative } from 'node:path'
import * as React from 'react'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
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

function isWindowsDrivePath(filePath: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(filePath)
}

function isWslMountPath(filePath: string): boolean {
  return /^\/mnt\/[a-zA-Z]\//.test(filePath)
}

function wslMountPathToWindowsPath(filePath: string): string | null {
  if (!isWslMountPath(filePath)) return null
  const driveLetter = filePath[5]
  const rest = filePath.slice('/mnt/x/'.length)
  const windowsRest = rest.split('/').join('\\')
  return `${driveLetter.toUpperCase()}:\\${windowsRest}`
}

function windowsPathToWslMountPath(filePath: string): string | null {
  if (!isWindowsDrivePath(filePath)) return null
  const driveLetter = filePath[0].toLowerCase()
  const rest = filePath
    .slice(2)
    .replace(/^[\\/]+/, '')
    .split('\\')
    .join('/')
  return `/mnt/${driveLetter}/${rest}`
}

function normalizeInputPath(filePath: string): string {
  const trimmed = filePath.trim()
  if (isWindowsDrivePath(trimmed)) return trimmed
  if (isWslMountPath(trimmed)) {
    const windowsPath = wslMountPathToWindowsPath(trimmed)
    return process.platform === 'win32' && windowsPath ? windowsPath : trimmed
  }
  return normalizeFilePath(trimmed)
}

function jsonContentToMarkdown(content: string): string {
  try {
    const parsed = JSON.parse(content) as any

    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.slides)) {
        const slides = parsed.slides as any[]
        const parts: string[] = []
        for (const slide of slides) {
          if (!slide || typeof slide !== 'object') continue
          const slideTitle =
            typeof slide.title === 'string' && slide.title.trim()
              ? slide.title.trim()
              : 'Slide'

          const slideParts: string[] = [`# ${slideTitle}`]

          if (typeof slide.content === 'string' && slide.content.trim()) {
            slideParts.push(slide.content.trim())
          }

          if (Array.isArray(slide.bullets) && slide.bullets.length > 0) {
            for (const bullet of slide.bullets) {
              if (bullet === null || bullet === undefined) continue
              const text = String(bullet).trim()
              if (!text) continue
              slideParts.push(`- ${text}`)
            }
          }

          parts.push(slideParts.join('\n\n'))
        }

        if (parts.length > 0) return parts.join('\n\n---\n\n') + '\n'
      }

      if (Array.isArray(parsed.sections)) {
        const parts: string[] = []
        for (const section of parsed.sections) {
          if (!section || typeof section !== 'object') continue
          if (typeof section.heading === 'string' && section.heading.trim()) {
            parts.push(`## ${section.heading.trim()}`)
          }
          if (typeof section.content === 'string' && section.content.trim()) {
            parts.push(section.content.trim())
          }
        }
        if (parts.length > 0) return parts.join('\n\n') + '\n'
      }

      if (Array.isArray(parsed.table)) {
        const rows = parsed.table as unknown[]
        const normalized = rows
          .filter(row => Array.isArray(row))
          .map(row => (row as unknown[]).map(cell => String(cell ?? '')).map(s => s.replace(/\r?\n/g, ' ')))

        if (normalized.length > 0 && normalized[0]!.length > 0) {
          const header = normalized[0]!
          const separator = header.map(() => '---')
          const body = normalized.slice(1)
          const toRow = (cells: string[]) => `| ${cells.join(' | ')} |`
          return [toRow(header), toRow(separator), ...body.map(toRow)].join('\n') + '\n'
        }
      }
    }
  } catch {
    // ignore and fallback to plain text
  }

  return content
}

function resolvePandocReferencePath(
  templatePath: string | undefined,
  expectedExt: '.docx' | '.pptx',
): { windowsPath: string; localPath: string } | null {
  if (!templatePath || !templatePath.trim()) return null
  const normalized = normalizeInputPath(templatePath)
  if (path.extname(normalized).toLowerCase() !== expectedExt) return null

  const windowsPath = isWindowsDrivePath(normalized)
    ? normalized
    : wslMountPathToWindowsPath(normalized)
  if (!windowsPath) return null

  const localPath =
    process.platform === 'win32'
      ? windowsPath
      : windowsPathToWslMountPath(windowsPath) ?? windowsPath

  return { windowsPath, localPath }
}

function looksLikeMarkdown(text: string): boolean {
  if (/\n\s*\n/.test(text)) return true
  if (/^\s*#{1,6}\s+/m.test(text)) return true
  if (/^\s*[-*+]\s+/m.test(text)) return true
  if (/^\s*\d+\.\s+/m.test(text)) return true
  if (/^\s*```/m.test(text)) return true
  if (/^\s*>/m.test(text)) return true
  if (/\|\s*---\s*\|/.test(text)) return true
  return false
}

function plainTextToMarkdown(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const parts: string[] = []
  for (const line of lines) {
    if (line.trim().length === 0) {
      parts.push('')
      continue
    }
    parts.push(line)
    parts.push('')
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

async function runPandoc(pandocArgs: string[]): Promise<{
  success?: boolean
  error?: string
}> {
  return new Promise(resolve => {
    const proc = spawn('pandoc', pandocArgs)

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code: number) => {
      if (code !== 0) {
        resolve({
          error: (stderr || stdout || `pandoc exited with code ${code}`).trim(),
        })
        return
      }

      resolve({ success: true })
    })

    proc.on('error', (err: Error) => {
      resolve({
        error:
          err.message.includes('ENOENT') || err.message.includes('not found')
            ? '找不到 pandoc。先装：winget install --id JohnMacFarlane.Pandoc -e'
            : err.message,
      })
    })
  })
}

async function writeDocxWithPandoc(args: {
  file_path: string
  content: string
  title?: string
  template?: string
}): Promise<{ success?: boolean; size?: number; error?: string }> {
  const normalizedOutput = normalizeInputPath(args.file_path)

  const windowsOutputPath = isWindowsDrivePath(normalizedOutput)
    ? normalizedOutput
    : wslMountPathToWindowsPath(normalizedOutput)

  if (!windowsOutputPath) {
    return {
      error:
        '导出 .docx 需要写到 Windows 盘（比如 E:\\... 或 /mnt/e/...），你现在的路径我转不成 Windows 路径。',
    }
  }

  const localOutputPath =
    process.platform === 'win32'
      ? windowsOutputPath
      : windowsPathToWslMountPath(windowsOutputPath)

  if (!localOutputPath) {
    return {
      error:
        '导出 .docx 需要写到 /mnt/<盘符>/... 这种路径（让 Windows 侧 pandoc 能访问），你现在的路径不行。',
    }
  }

  const outputDir = path.dirname(localOutputPath)
  await fs.mkdir(outputDir, { recursive: true })

  let markdown = jsonContentToMarkdown(args.content)
  if (!looksLikeMarkdown(markdown)) {
    markdown = plainTextToMarkdown(markdown)
  }

  if (args.title && args.title.trim()) {
    markdown = `# ${args.title.trim()}\n\n${markdown}`
  }

  const baseName = path.basename(localOutputPath, path.extname(localOutputPath))
  const tempMarkdownLocalPath = path.join(
    outputDir,
    `.${baseName}.yuuka-docwrite.${Date.now()}.md`,
  )

  const windowsMarkdownPath =
    process.platform === 'win32'
      ? tempMarkdownLocalPath
      : wslMountPathToWindowsPath(tempMarkdownLocalPath)

  if (!windowsMarkdownPath) {
    return { error: '创建临时 Markdown 文件失败（路径转 Windows 失败）。' }
  }

  const referenceDocx = resolvePandocReferencePath(args.template, '.docx')

  try {
    await fs.writeFile(tempMarkdownLocalPath, markdown, 'utf8')

    const pandocFrom = 'markdown+tex_math_dollars+tex_math_single_backslash+raw_tex'
    const pandocOutputPath =
      process.platform === 'win32' ? windowsOutputPath : localOutputPath
    const pandocInputPath =
      process.platform === 'win32' ? windowsMarkdownPath : tempMarkdownLocalPath

    const pandocArgs = ['-f', pandocFrom, '-t', 'docx']
    if (referenceDocx?.localPath) pandocArgs.push('--reference-doc', referenceDocx.localPath)

    pandocArgs.push('-o', pandocOutputPath, pandocInputPath)

    const pandocRes = await runPandoc(pandocArgs)
    if (pandocRes.error) return pandocRes

    const stat = await fs.stat(localOutputPath)
    return { success: true, size: stat.size }
  } finally {
    try {
      await fs.unlink(tempMarkdownLocalPath)
    } catch {
      // ignore
    }
  }
}

async function writePptxWithPandoc(args: {
  file_path: string
  content: string
  title?: string
  template?: string
}): Promise<{ success?: boolean; size?: number; error?: string }> {
  const normalizedOutput = normalizeInputPath(args.file_path)

  const windowsOutputPath = isWindowsDrivePath(normalizedOutput)
    ? normalizedOutput
    : wslMountPathToWindowsPath(normalizedOutput)

  if (!windowsOutputPath) {
    return {
      error:
        '导出 .pptx 需要写到 Windows 盘（比如 E:\\... 或 /mnt/e/...），你现在的路径我转不成 Windows 路径。',
    }
  }

  const localOutputPath =
    process.platform === 'win32'
      ? windowsOutputPath
      : windowsPathToWslMountPath(windowsOutputPath)

  if (!localOutputPath) {
    return {
      error:
        '导出 .pptx 需要写到 /mnt/<盘符>/... 这种路径（让 Windows 侧 pandoc 能访问），你现在的路径不行。',
    }
  }

  const outputDir = path.dirname(localOutputPath)
  await fs.mkdir(outputDir, { recursive: true })

  let markdown = jsonContentToMarkdown(args.content)
  if (!looksLikeMarkdown(markdown)) {
    markdown = plainTextToMarkdown(markdown)
  }

  if (args.title && args.title.trim()) {
    markdown = `# ${args.title.trim()}\n\n${markdown}`
  }

  const baseName = path.basename(localOutputPath, path.extname(localOutputPath))
  const tempMarkdownLocalPath = path.join(
    outputDir,
    `.${baseName}.yuuka-docwrite.${Date.now()}.md`,
  )

  const windowsMarkdownPath =
    process.platform === 'win32'
      ? tempMarkdownLocalPath
      : wslMountPathToWindowsPath(tempMarkdownLocalPath)

  if (!windowsMarkdownPath) {
    return { error: '创建临时 Markdown 文件失败（路径转 Windows 失败）。' }
  }

  const referencePptx = resolvePandocReferencePath(args.template, '.pptx')

  try {
    await fs.writeFile(tempMarkdownLocalPath, markdown, 'utf8')

    const pandocFrom = 'markdown+tex_math_dollars+tex_math_single_backslash+raw_tex'
    const pandocOutputPath =
      process.platform === 'win32' ? windowsOutputPath : localOutputPath
    const pandocInputPath =
      process.platform === 'win32' ? windowsMarkdownPath : tempMarkdownLocalPath

    const pandocArgs = ['-f', pandocFrom, '-t', 'pptx']
    if (referencePptx?.localPath) pandocArgs.push('--reference-doc', referencePptx.localPath)
    pandocArgs.push('-o', pandocOutputPath, pandocInputPath)

    const pandocRes = await runPandoc(pandocArgs)
    if (pandocRes.error) return pandocRes

    const stat = await fs.stat(localOutputPath)
    return { success: true, size: stat.size }
  } finally {
    try {
      await fs.unlink(tempMarkdownLocalPath)
    } catch {
      // ignore
    }
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
        from openpyxl.styles import Font, Alignment, PatternFill
    except ImportError:
        return {"error": "openpyxl not installed. Run: pip install openpyxl"}

    def beautify_sheet(ws):
        # Freeze header row
        if ws.max_row and ws.max_row >= 2:
            ws.freeze_panes = 'A2'

        # Header styling (keep default font, just make it bold + light fill)
        if ws.max_row and ws.max_row >= 1 and ws.max_column and ws.max_column >= 1:
            header_font = Font(bold=True)
            header_fill = PatternFill(fill_type='solid', fgColor='F2F2F2')
            header_alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
            for col_idx in range(1, ws.max_column + 1):
                cell = ws.cell(row=1, column=col_idx)
                cell.font = header_font
                cell.fill = header_fill
                cell.alignment = header_alignment

            ws.row_dimensions[1].height = 18
            ws.auto_filter.ref = ws.dimensions

        # Wrap text for all cells
        wrap_alignment = Alignment(vertical='top', wrap_text=True)
        for row in ws.iter_rows(min_row=2, max_row=ws.max_row, max_col=ws.max_column):
            for cell in row:
                cell.alignment = wrap_alignment

    def auto_adjust_column_width(ws):
        for col in ws.columns:
            max_length = 0
            column = col[0].column_letter
            for cell in col:
                try:
                    if cell.value is None:
                        continue
                    length = len(str(cell.value))
                    if length > max_length:
                        max_length = length
                except:
                    pass
            ws.column_dimensions[column].width = min(max(max_length + 2, 10), 50)

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

                auto_adjust_column_width(ws)
                beautify_sheet(ws)

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
            auto_adjust_column_width(ws)
            beautify_sheet(ws)
        else:
            ws = wb.active
            ws.cell(row=1, column=1, value=str(data))
            auto_adjust_column_width(ws)
            beautify_sheet(ws)

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
        auto_adjust_column_width(ws)
        beautify_sheet(ws)

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
    const fullFilePath = normalizeInputPath(file_path)
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
    const fullFilePath = normalizeInputPath(file_path)
    const ext = path.extname(fullFilePath).toLowerCase()

    const result =
      ext === '.docx'
        ? await writeDocxWithPandoc({
            file_path: fullFilePath,
            content,
            title,
            template,
          })
        : ext === '.pptx'
          ? await writePptxWithPandoc({
              file_path: fullFilePath,
              content,
              title,
              template,
            })
        : await runPythonScript({
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
