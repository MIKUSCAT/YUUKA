import * as React from 'react'
import { Box, Text } from 'ink'
import stringWidth from 'string-width'
import stripAnsi from 'strip-ansi'
import wrapAnsi from 'wrap-ansi'
import chalk from 'chalk'
import { getTheme } from '@utils/theme'
import { renderInlineAnsi } from './inlineAnsi'

type Props = {
  headers: string[]
  rows: string[][]
  terminalWidth: number
}

function visibleWidth(s: string): number {
  return stringWidth(stripAnsi(s))
}

function padRightAnsi(s: string, targetWidth: number): string {
  const w = visibleWidth(s)
  if (w >= targetWidth) return s
  return s + ' '.repeat(targetWidth - w)
}

function normalizeRow(row: string[], count: number): string[] {
  const cells = row.map(c => String(c ?? '').trim())
  while (cells.length < count) cells.push('')
  if (cells.length > count) cells.length = count
  return cells
}

function fitContentWidths(desired: number[], availableTotal: number): number[] {
  const count = desired.length
  const min = Math.max(1, Math.min(3, Math.floor(availableTotal / Math.max(1, count))))
  const widths = desired.map(w => Math.max(min, w))

  let sum = widths.reduce((a, b) => a + b, 0)
  if (sum <= availableTotal) return widths

  // 逐步从“最宽的列”里扣，直到塞下为止（简单但稳定）
  while (sum > availableTotal) {
    let idx = -1
    let maxW = -1
    for (let i = 0; i < widths.length; i++) {
      if (widths[i]! > min && widths[i]! > maxW) {
        maxW = widths[i]!
        idx = i
      }
    }
    if (idx === -1) break
    widths[idx] = (widths[idx] || 0) - 1
    sum--
  }

  return widths
}

export function TableRenderer({ headers, rows, terminalWidth }: Props): React.ReactNode {
  const theme = getTheme()
  const colCount = Math.max(1, headers.length)

  const formattedHeaders = normalizeRow(headers, colCount).map(h =>
    chalk.bold(renderInlineAnsi(h, { defaultColor: theme.text })),
  )
  const formattedRows = rows.map(r => normalizeRow(r, colCount))

  const formattedCells = formattedRows.map(r =>
    r.map(cell => renderInlineAnsi(cell, { defaultColor: theme.text })),
  )

  const desiredContentWidths = new Array(colCount).fill(0).map((_, i) => {
    const headerW = visibleWidth(formattedHeaders[i] ?? '')
    const maxCellW = Math.max(
      0,
      ...formattedCells.map(r => visibleWidth(r[i] ?? '')),
    )
    return Math.max(headerW, maxCellW)
  })

  // 预留：每列左右各 1 个空格（padding=2），加上边框/分隔符
  const availableForContent = Math.max(1, terminalWidth - (3 * colCount + 1))
  const contentWidths = fitContentWidths(desiredContentWidths, availableForContent)
  const columnWidths = contentWidths.map(w => w + 2) // 含左右 padding

  const border = (type: 'top' | 'middle' | 'bottom') => {
    const chars = {
      top: { left: '┌', mid: '┬', right: '┐', h: '─' },
      middle: { left: '├', mid: '┼', right: '┤', h: '─' },
      bottom: { left: '└', mid: '┴', right: '┘', h: '─' },
    } as const
    const c = chars[type]
    const parts = columnWidths.map(w => c.h.repeat(Math.max(0, w)))
    return c.left + parts.join(c.mid) + c.right
  }

  const renderRowLines = (cellsAnsi: string[], isHeader = false): string[] => {
    const wrappedCells = cellsAnsi.map((cell, idx) => {
      const contentW = Math.max(1, (columnWidths[idx] ?? 2) - 2)
      const wrapped = wrapAnsi(cell, contentW, { hard: false, trim: false })
      const lines = wrapped.split('\n')
      return lines.map(line => padRightAnsi(line, contentW))
    })

    const height = Math.max(1, ...wrappedCells.map(lines => lines.length))
    const lines: string[] = []
    for (let rowLine = 0; rowLine < height; rowLine++) {
      const parts = wrappedCells.map((cellLines, idx) => {
        const contentW = Math.max(1, (columnWidths[idx] ?? 2) - 2)
        const line = cellLines[rowLine] ?? ' '.repeat(contentW)
        return ` ${line} `
      })
      let out = `│${parts.join('│')}│`
      if (isHeader) out = chalk.bold(out)
      lines.push(out)
    }
    return lines
  }

  const headerLines = renderRowLines(formattedHeaders, true)
  const bodyLines = formattedCells.flatMap(r => renderRowLines(r, false))

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={theme.secondaryBorder}>{border('top')}</Text>
      <Text>{headerLines.join('\n')}</Text>
      <Text color={theme.secondaryBorder}>{border('middle')}</Text>
      <Text>{bodyLines.join('\n')}</Text>
      <Text color={theme.secondaryBorder}>{border('bottom')}</Text>
    </Box>
  )
}
