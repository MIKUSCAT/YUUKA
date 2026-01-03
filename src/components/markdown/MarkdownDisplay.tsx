import * as React from 'react'
import { Box, Text } from 'ink'
import chalk from 'chalk'
import { EOL } from 'os'
import { highlight, supportsLanguage } from 'cli-highlight'
import wrapAnsi from 'wrap-ansi'
import stripAnsi from 'strip-ansi'
import { stripSystemMessages } from '@utils/messages'
import { getTheme } from '@utils/theme'
import { renderInlineAnsi } from './inlineAnsi'
import { formatLatexMath } from './latex'
import { TableRenderer } from './TableRenderer'

type Props = {
  text: string
  terminalWidth: number
}

const EMPTY_LINE_HEIGHT = 1
const CODE_BLOCK_PADDING_LEFT = 1

const headerRegex = /^ *(#{1,4}) +(.*)/
const codeFenceRegex = /^ *(`{3,}|~{3,}) *(\w*?) *$/
const ulItemRegex = /^([ \t]*)([-*+]) +(.*)/
const olItemRegex = /^([ \t]*)(\d+)\. +(.*)/
const hrRegex = /^ *([-*_] *){3,} *$/
const tableRowRegex = /^\s*\|(.+)\|\s*$/
const tableSeparatorRegex = /^\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)+\|?\s*$/
const blockquoteRegex = /^ *>\s?(.*)$/

function isMathBlockStart(line: string): { kind: 'dollar' | 'bracket' | 'env'; envName?: string } | null {
  const trimmed = line.trim()
  if (trimmed === '$$' || trimmed.startsWith('$$')) return { kind: 'dollar' }
  if (trimmed === '\\[' || trimmed.startsWith('\\[')) return { kind: 'bracket' }
  const envMatch = trimmed.match(/^\\begin\{([A-Za-z*]+)\}/)
  if (envMatch) return { kind: 'env', envName: envMatch[1] }
  return null
}

function isMathBlockEnd(line: string, state: { kind: 'dollar' | 'bracket' | 'env'; envName?: string }): boolean {
  const trimmed = line.trim()
  if (state.kind === 'dollar') return trimmed.endsWith('$$') || trimmed === '$$'
  if (state.kind === 'bracket') return trimmed.endsWith('\\]') || trimmed === '\\]'
  if (state.kind === 'env') {
    const name = state.envName ?? ''
    return trimmed.includes(`\\end{${name}}`)
  }
  return false
}

function stripMathDelimiters(
  lines: string[],
  state: { kind: 'dollar' | 'bracket' | 'env'; envName?: string },
): string {
  const joined = lines.join('\n')
  if (state.kind === 'dollar') {
    // 支持 $$...$$ 单行与多行
    return joined.replace(/^\s*\$\$\s*/m, '').replace(/\s*\$\$\s*$/m, '')
  }
  if (state.kind === 'bracket') {
    return joined.replace(/^\s*\\\[\s*/m, '').replace(/\s*\\\]\s*$/m, '')
  }
  // env：去掉 begin/end 行
  const envName = state.envName ?? ''
  return joined
    .replace(new RegExp(`^\\s*\\\\begin\\{${envName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\}\\s*$`, 'm'), '')
    .replace(new RegExp(`^\\s*\\\\end\\{${envName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\}\\s*$`, 'm'), '')
    .trim()
}

function renderCodeBlock(code: string, lang: string | null): string {
  const language = lang && supportsLanguage(lang) ? lang : 'markdown'
  return highlight(code, { language }) + EOL
}

export function MarkdownDisplay({ text, terminalWidth }: Props): React.ReactNode {
  const theme = getTheme()
  const cleaned = stripSystemMessages(text)
  if (!cleaned) return null

  const lines = cleaned.split(/\r?\n/)
  const contentBlocks: React.ReactNode[] = []

  let lastLineEmpty = true

  let inCodeBlock = false
  let codeFence = ''
  let codeLang: string | null = null
  let codeLines: string[] = []

  let inTable = false
  let tableHeaders: string[] = []
  let tableRows: string[][] = []

  let mathState: { kind: 'dollar' | 'bracket' | 'env'; envName?: string } | null = null
  let mathLines: string[] = []

  const pushSpacer = (key: string) => {
    contentBlocks.push(<Box key={key} height={EMPTY_LINE_HEIGHT} />)
    lastLineEmpty = true
  }

  const pushLine = (key: string, line: string, dim = false) => {
    const ansi = renderInlineAnsi(line, { defaultColor: theme.text })
    contentBlocks.push(
      <Box key={key}>
        <Text wrap="wrap" dimColor={dim}>
          {ansi}
        </Text>
      </Box>,
    )
    lastLineEmpty = false
  }

  const flushTable = () => {
    if (tableHeaders.length > 0 && tableRows.length > 0) {
      const tableKey = `table-${contentBlocks.length}`
      contentBlocks.push(
        <React.Fragment key={tableKey}>
          <TableRenderer
            headers={tableHeaders}
            rows={tableRows}
            terminalWidth={terminalWidth}
          />
        </React.Fragment>,
      )
      lastLineEmpty = false
    }
    inTable = false
    tableHeaders = []
    tableRows = []
  }

  const flushMath = () => {
    if (!mathState) return
    const raw = stripMathDelimiters(mathLines, mathState)
    const formatted = formatLatexMath(raw, {
      mode: 'block',
      envName: mathState.kind === 'env' ? mathState.envName : undefined,
    })
    if (!formatted.trim()) {
      mathState = null
      mathLines = []
      return
    }
    const innerWidth = Math.max(10, terminalWidth - 4)
    const wrapped = wrapAnsi(formatted, innerWidth, { hard: false, trim: false })
      .split('\n')
      .map(l => chalk.hex(theme.kode)(l))
      .join('\n')
    contentBlocks.push(
      <Box
        key={`math-${contentBlocks.length}`}
        borderStyle="round"
        borderColor={theme.secondaryBorder}
        paddingLeft={1}
        paddingRight={1}
        marginY={1}
      >
        <Text>{wrapped}</Text>
      </Box>,
    )
    lastLineEmpty = false
    mathState = null
    mathLines = []
  }

  lines.forEach((line, index) => {
    const key = `line-${index}`

    // Code block mode
    if (inCodeBlock) {
      const fenceMatch = line.match(codeFenceRegex)
      if (
        fenceMatch &&
        fenceMatch[1].startsWith(codeFence[0]) &&
        fenceMatch[1].length >= codeFence.length
      ) {
        const code = codeLines.join('\n')
        const rendered = renderCodeBlock(code, codeLang)
        contentBlocks.push(
          <Box key={`code-${index}`} paddingLeft={CODE_BLOCK_PADDING_LEFT} flexDirection="column">
            <Text>{rendered}</Text>
          </Box>,
        )
        inCodeBlock = false
        codeFence = ''
        codeLang = null
        codeLines = []
      } else {
        codeLines.push(line)
      }
      return
    }

    // Math block mode
    if (mathState) {
      mathLines.push(line)
      if (isMathBlockEnd(line, mathState)) {
        flushMath()
      }
      return
    }

    const codeFenceMatch = line.match(codeFenceRegex)
    if (codeFenceMatch) {
      flushTable()
      inCodeBlock = true
      codeFence = codeFenceMatch[1]
      codeLang = codeFenceMatch[2] || null
      return
    }

    // Table start detection
    const tableRowMatch = line.match(tableRowRegex)
    const tableSeparatorMatch = line.match(tableSeparatorRegex)

    if (tableRowMatch && !inTable) {
      if (index + 1 < lines.length && lines[index + 1]!.match(tableSeparatorRegex)) {
        flushMath()
        inTable = true
        tableHeaders = tableRowMatch[1].split('|').map(c => c.trim())
        tableRows = []
        return
      }
    }

    if (inTable) {
      if (tableSeparatorMatch) {
        return
      }
      if (tableRowMatch) {
        const cells = tableRowMatch[1].split('|').map(c => c.trim())
        while (cells.length < tableHeaders.length) cells.push('')
        if (cells.length > tableHeaders.length) cells.length = tableHeaders.length
        tableRows.push(cells)
        return
      }
      // table ends
      flushTable()
      // continue processing current line normally
    }

    // Math block start (non-code)
    const maybeMath = isMathBlockStart(line)
    if (maybeMath) {
      flushTable()
      const trimmed = line.trim()

      // 单行块：$$...$$ / \[...\]
      if (
        (maybeMath.kind === 'dollar' && /^\s*\$\$.+\$\$\s*$/.test(trimmed) && trimmed !== '$$') ||
        (maybeMath.kind === 'bracket' && /^\s*\\\[.+\\\]\s*$/.test(trimmed) && trimmed !== '\\[')
      ) {
        mathState = maybeMath
        mathLines = [line]
        flushMath()
        return
      }

      // 多行块：起始行仅分隔符时，不要立刻判定为 end
      mathState = maybeMath
      mathLines = [line]
      // env 可能是单行：\\begin{cases} ... \\end{cases}
      if (maybeMath.kind === 'env' && isMathBlockEnd(line, maybeMath)) {
        flushMath()
      }
      return
    }

    // hr
    if (hrRegex.test(line)) {
      flushTable()
      contentBlocks.push(
        <Box key={`hr-${index}`}>
          <Text dimColor>{chalk.hex(theme.secondaryText)('---')}</Text>
        </Box>,
      )
      lastLineEmpty = false
      return
    }

    // header
    const headerMatch = line.match(headerRegex)
    if (headerMatch) {
      flushTable()
      const level = headerMatch[1].length
      const headerText = headerMatch[2] ?? ''
      const renderedBase = renderInlineAnsi(headerText, { defaultColor: theme.text })
      let rendered = renderedBase
      if (level <= 2) rendered = chalk.bold(chalk.hex(theme.kode)(stripAnsi(renderedBase)))
      else if (level === 3) rendered = chalk.bold(renderedBase)
      else rendered = chalk.italic(renderedBase)

      contentBlocks.push(
        <Box key={`h-${index}`}>
          <Text>{rendered}</Text>
        </Box>,
      )
      lastLineEmpty = false
      return
    }

    // blockquote
    const quoteMatch = line.match(blockquoteRegex)
    if (quoteMatch) {
      flushTable()
      const quoteText = quoteMatch[1] ?? ''
      const rendered = chalk.dim.italic(renderInlineAnsi(quoteText, { defaultColor: theme.secondaryText }))
      contentBlocks.push(
        <Box key={`q-${index}`} paddingLeft={1}>
          <Text>{rendered}</Text>
        </Box>,
      )
      lastLineEmpty = false
      return
    }

    // list
    const ulMatch = line.match(ulItemRegex)
    if (ulMatch) {
      flushTable()
      const leading = ulMatch[1] ?? ''
      const marker = ulMatch[2] ?? '-'
      const itemText = ulMatch[3] ?? ''
      const indent = leading.length
      contentBlocks.push(
        <Box key={`ul-${index}`} paddingLeft={indent + 1} flexDirection="row">
          <Box width={2}>
            <Text>{chalk.hex(theme.secondaryText)(`${marker}`)}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text wrap="wrap">{renderInlineAnsi(itemText, { defaultColor: theme.text })}</Text>
          </Box>
        </Box>,
      )
      lastLineEmpty = false
      return
    }

    const olMatch = line.match(olItemRegex)
    if (olMatch) {
      flushTable()
      const leading = olMatch[1] ?? ''
      const marker = olMatch[2] ?? '1'
      const itemText = olMatch[3] ?? ''
      const indent = leading.length
      const prefix = `${marker}.`
      contentBlocks.push(
        <Box key={`ol-${index}`} paddingLeft={indent + 1} flexDirection="row">
          <Box width={prefix.length + 1}>
            <Text>{chalk.hex(theme.secondaryText)(`${prefix} `)}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text wrap="wrap">{renderInlineAnsi(itemText, { defaultColor: theme.text })}</Text>
          </Box>
        </Box>,
      )
      lastLineEmpty = false
      return
    }

    // blank line
    if (line.trim().length === 0) {
      flushTable()
      if (!lastLineEmpty) {
        pushSpacer(`spacer-${index}`)
      }
      return
    }

    // default: text line
    flushTable()
    pushLine(key, line)
  })

  // flush at end
  if (inCodeBlock) {
    const rendered = renderCodeBlock(codeLines.join('\n'), codeLang)
    contentBlocks.push(
      <Box key="code-eof" paddingLeft={CODE_BLOCK_PADDING_LEFT} flexDirection="column">
        <Text>{rendered}</Text>
      </Box>,
    )
  }
  flushTable()
  flushMath()

  return <>{contentBlocks}</>
}
