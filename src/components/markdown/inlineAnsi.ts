import chalk from 'chalk'
import { getTheme } from '@utils/theme'
import { formatLatexMath } from './latex'

type InlineRenderOptions = {
  defaultColor?: string
}

const BOLD_MARKER_LENGTH = 2
const ITALIC_MARKER_LENGTH = 1
const STRIKETHROUGH_MARKER_LENGTH = 2

function themeColor(text: string, color?: string): string {
  const theme = getTheme()
  const c = color ?? theme.text
  return chalk.hex(c)(text)
}

function renderMathInline(raw: string): string {
  const theme = getTheme()
  const formatted = formatLatexMath(raw)
  // Inline math: use kode color for visibility
  return chalk.hex(theme.kode)(formatted)
}

function renderLink(text: string, url: string, baseColor?: string): string {
  const theme = getTheme()
  return (
    themeColor(text, baseColor) + chalk.hex(theme.kode)(` (${url})`)
  )
}

function renderInlineCode(code: string): string {
  const theme = getTheme()
  return chalk.hex(theme.suggestion)(code)
}

function renderImage(alt: string, url: string, baseColor?: string): string {
  const theme = getTheme()
  const label = alt?.trim() ? `Image: ${alt}` : 'Image'
  return (
    chalk.hex(theme.secondaryText)(`[${label}] `) +
    chalk.hex(theme.kode)(url)
  )
}

/**
 * 把一行文本做“终端友好”的 inline 渲染：
 * - Markdown：粗体/斜体/删除线/行内代码/链接/URL
 * - LaTeX：$...$、\\(...\\)
 *
 * 这是 best-effort：不追求 100% Markdown 规范，但要稳定、好看、不炸。
 */
export function renderInlineAnsi(text: string, options: InlineRenderOptions = {}): string {
  const baseColor = options.defaultColor ?? getTheme().text

  // 纯文本快捷路径（含 $/\\( 也走慢路径）
  if (!/[*_~`<[!$\\]|https?:]/.test(text)) {
    return themeColor(text, baseColor)
  }

  const parts: string[] = []
  let lastIndex = 0

  const inlineRegex =
    /(\$\$.*?\$\$|\$[^$\n]+?\$|\\\(.+?\\\)|\*\*.*?\*\*|\*.*?\*|_.*?_|~~.*?~~|!\[.*?\]\(.*?\)|\[.*?\]\(.*?\)|`+.+?`+|<u>.*?<\/u>|https?:\/\/\S+)/g

  let match: RegExpExecArray | null
  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(themeColor(text.slice(lastIndex, match.index), baseColor))
    }

    const fullMatch = match[0]
    let rendered: string | null = null

    // $$...$$：当作 inline math（真正的块公式在 MarkdownDisplay 里处理）
    if (fullMatch.startsWith('$$') && fullMatch.endsWith('$$') && fullMatch.length > 4) {
      rendered = renderMathInline(fullMatch.slice(2, -2))
    }

    // $...$
    if (!rendered && fullMatch.startsWith('$') && fullMatch.endsWith('$') && fullMatch.length > 2) {
      rendered = renderMathInline(fullMatch.slice(1, -1))
    }

    // \( ... \)
    if (
      !rendered &&
      fullMatch.startsWith('\\(') &&
      fullMatch.endsWith('\\)') &&
      fullMatch.length > 4
    ) {
      rendered = renderMathInline(fullMatch.slice(2, -2))
    }

    // **bold**
    if (
      !rendered &&
      fullMatch.startsWith('**') &&
      fullMatch.endsWith('**') &&
      fullMatch.length > BOLD_MARKER_LENGTH * 2
    ) {
      rendered = chalk.bold(themeColor(fullMatch.slice(2, -2), baseColor))
    }

    // *italic* 或 _italic_
    if (
      !rendered &&
      fullMatch.length > ITALIC_MARKER_LENGTH * 2 &&
      ((fullMatch.startsWith('*') && fullMatch.endsWith('*')) ||
        (fullMatch.startsWith('_') && fullMatch.endsWith('_')))
    ) {
      rendered = chalk.italic(themeColor(fullMatch.slice(1, -1), baseColor))
    }

    // ~~strike~~
    if (
      !rendered &&
      fullMatch.startsWith('~~') &&
      fullMatch.endsWith('~~') &&
      fullMatch.length > STRIKETHROUGH_MARKER_LENGTH * 2
    ) {
      rendered = chalk.strikethrough(themeColor(fullMatch.slice(2, -2), baseColor))
    }

    // `code`
    if (!rendered && fullMatch.startsWith('`') && fullMatch.endsWith('`')) {
      const codeMatch = fullMatch.match(/^(`+)(.+?)\1$/s)
      if (codeMatch && codeMatch[2]) {
        rendered = renderInlineCode(codeMatch[2])
      }
    }

    // ![alt](url)
    if (!rendered && fullMatch.startsWith('![') && fullMatch.includes('](') && fullMatch.endsWith(')')) {
      const imgMatch = fullMatch.match(/!\[(.*?)\]\((.*?)\)/)
      if (imgMatch) {
        rendered = renderImage(imgMatch[1] ?? '', imgMatch[2] ?? '', baseColor)
      }
    }

    // [text](url)
    if (!rendered && fullMatch.startsWith('[') && fullMatch.includes('](') && fullMatch.endsWith(')')) {
      const linkMatch = fullMatch.match(/\[(.*?)\]\((.*?)\)/)
      if (linkMatch) {
        rendered = renderLink(linkMatch[1] ?? '', linkMatch[2] ?? '', baseColor)
      }
    }

    // <u>text</u>
    if (!rendered && fullMatch.startsWith('<u>') && fullMatch.endsWith('</u>')) {
      rendered = chalk.underline(themeColor(fullMatch.slice(3, -4), baseColor))
    }

    // URL
    if (!rendered && /^https?:\/\//.test(fullMatch)) {
      rendered = chalk.hex(getTheme().kode)(fullMatch)
    }

    parts.push(rendered ?? themeColor(fullMatch, baseColor))
    lastIndex = inlineRegex.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(themeColor(text.slice(lastIndex), baseColor))
  }

  return parts.join('')
}
