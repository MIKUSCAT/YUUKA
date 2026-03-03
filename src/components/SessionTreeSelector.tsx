import { Box, Text, useInput } from 'ink'
import * as React from 'react'
import { useMemo, useState } from 'react'
import figures from 'figures'
import { getTheme } from '@utils/theme'
import { extractTag } from '@utils/messages'
import type { SessionManager, SessionEntry } from '@utils/sessionManager'
import { useExitOnCtrlCD } from '@hooks/useExitOnCtrlCD'

type TreeItem = {
  id: string | null
  label: string
  isCurrent: boolean
}

type Props = {
  sessionManager: SessionManager
  onSelect: (entryId: string | null) => void
  onEscape: () => void
}

const MAX_VISIBLE_ITEMS = 11

function normalizePreview(text: string): string {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) return '(empty)'
  if (normalized.length <= 96) return normalized
  return normalized.slice(0, 96) + '…'
}

function previewFromMessage(message: any): string {
  if (!message || typeof message !== 'object') {
    return '(unknown)'
  }

  const type = (message as any).type
  const content = (message as any)?.message?.content

  if (type === 'user') {
    if (typeof content === 'string') {
      const cmd =
        extractTag(content, 'command-message') ||
        extractTag(content, 'command-name')
      if (cmd) {
        const args = extractTag(content, 'command-args')?.trim() || ''
        return normalizePreview(`/${cmd}${args ? ` ${args}` : ''}`)
      }
      const bash = extractTag(content, 'bash-input')?.trim()
      if (bash) {
        return normalizePreview(`!${bash}`)
      }
      return normalizePreview(content)
    }

    if (Array.isArray(content)) {
      const text = content
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => String(b.text ?? ''))
        .join('\n')
      const hasImage = content.some((b: any) => b?.type === 'image')
      const prefix = hasImage ? '[image] ' : ''
      return normalizePreview(prefix + text)
    }

    return '(user)'
  }

  if (type === 'assistant') {
    if (typeof content === 'string') {
      return normalizePreview(content)
    }
    if (Array.isArray(content)) {
      const text = content
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => String(b.text ?? ''))
        .join('\n')
      if (text.trim()) {
        return normalizePreview(text)
      }
      const toolUses = content
        .filter((b: any) => b?.type === 'tool_use' && typeof b?.name === 'string')
        .map((b: any) => String(b.name))
        .filter(Boolean)
      if (toolUses.length > 0) {
        return normalizePreview(`[tools] ${toolUses.join(', ')}`)
      }
    }
    return '(assistant)'
  }

  return '(message)'
}

function buildTreeItems(sessionManager: SessionManager): TreeItem[] {
  const entries = sessionManager.getEntries()
  const byId = new Map<string, SessionEntry>()
  for (const entry of entries) {
    byId.set(entry.id, entry)
  }

  const messageEntries = entries.filter(
    (e): e is SessionEntry & { type: 'message'; message: any } => e.type === 'message',
  )

  const messageById = new Map<string, (typeof messageEntries)[number]>()
  const orderById = new Map<string, number>()
  for (let i = 0; i < messageEntries.length; i++) {
    const entry = messageEntries[i]!
    messageById.set(entry.id, entry)
    orderById.set(entry.id, i)
  }

  const toParentMessageId = (parentId: string | null): string | null => {
    let currentId = parentId
    for (let depth = 0; depth < 200 && currentId; depth++) {
      const parent = byId.get(currentId)
      if (!parent) return null
      if (parent.type === 'message') return parent.id
      currentId = parent.parentId
    }
    return null
  }

  const parentByMessageId = new Map<string, string | null>()
  for (const entry of messageEntries) {
    parentByMessageId.set(entry.id, toParentMessageId(entry.parentId))
  }

  const children = new Map<string | null, string[]>()
  const addChild = (parent: string | null, child: string) => {
    if (!children.has(parent)) {
      children.set(parent, [])
    }
    children.get(parent)!.push(child)
  }

  for (const [id, parentId] of parentByMessageId) {
    addChild(parentId, id)
  }

  for (const [parent, list] of children) {
    list.sort((a, b) => (orderById.get(a)! - orderById.get(b)!))
    children.set(parent, list)
  }

  const leafIdRaw = sessionManager.getLeafId()
  const leafMessageId =
    leafIdRaw && messageById.has(leafIdRaw) ? leafIdRaw : toParentMessageId(leafIdRaw)

  const items: TreeItem[] = []
  items.push({
    id: null,
    label: '(root) 从头开始',
    isCurrent: leafMessageId === null,
  })

  const walk = (nodeId: string, prefixFlags: boolean[]) => {
    const entry = messageById.get(nodeId)
    if (!entry) return

    const parent = parentByMessageId.get(nodeId) ?? null
    const siblings = children.get(parent) ?? []
    const isLast = siblings[siblings.length - 1] === nodeId
    const prefix = prefixFlags
      .map(hasMore => (hasMore ? '│  ' : '   '))
      .join('')
    const connector = isLast ? '└─ ' : '├─ '
    const role = (entry as any)?.message?.type === 'assistant' ? 'A' : 'U'
    const label = `${prefix}${connector}[${role}] ${previewFromMessage((entry as any).message)}`

    items.push({
      id: nodeId,
      label,
      isCurrent: nodeId === leafMessageId,
    })

    const kids = children.get(nodeId) ?? []
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i]!
      walk(kid, [...prefixFlags, !isLast])
    }
  }

  const roots = children.get(null) ?? []
  for (let i = 0; i < roots.length; i++) {
    const rootId = roots[i]!
    walk(rootId, [])
  }

  return items
}

export function SessionTreeSelector({
  sessionManager,
  onSelect,
  onEscape,
}: Props): React.ReactNode {
  const theme = getTheme()

  const items = useMemo(() => buildTreeItems(sessionManager), [sessionManager])
  const currentIndex = Math.max(0, items.findIndex(item => item.isCurrent))
  const [selectedIndex, setSelectedIndex] = useState(
    currentIndex >= 0 ? currentIndex : items.length - 1,
  )

  const exitState = useExitOnCtrlCD(() => process.exit(0))

  useInput((input, key) => {
    if (key.tab || key.escape) {
      onEscape()
      return
    }
    if (key.return) {
      const selected = items[selectedIndex]
      onSelect(selected?.id ?? null)
      return
    }
    if (key.upArrow) {
      if (key.ctrl || key.shift || key.meta) {
        setSelectedIndex(0)
      } else {
        setSelectedIndex(prev => Math.max(0, prev - 1))
      }
    }
    if (key.downArrow) {
      if (key.ctrl || key.shift || key.meta) {
        setSelectedIndex(items.length - 1)
      } else {
        setSelectedIndex(prev => Math.min(items.length - 1, prev + 1))
      }
    }

    const num = Number(input)
    if (!Number.isNaN(num) && num >= 1 && num <= Math.min(9, items.length)) {
      const idx = num - 1
      if (!items[idx]) return
      setSelectedIndex(idx)
      onSelect(items[idx]!.id ?? null)
    }
  })

  const firstVisibleIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(MAX_VISIBLE_ITEMS / 2),
      items.length - MAX_VISIBLE_ITEMS,
    ),
  )

  const visible = items.slice(firstVisibleIndex, firstVisibleIndex + MAX_VISIBLE_ITEMS)

  return (
    <>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.secondaryBorder}
        paddingX={1}
        paddingY={1}
        marginTop={1}
      >
        <Box flexDirection="column" minHeight={2} marginBottom={1}>
          <Text bold>Session tree</Text>
          <Text dimColor>选择一个节点继续（同一 session 文件内分支）</Text>
        </Box>

        {visible.map((item, index) => {
          const actualIndex = firstVisibleIndex + index
          const isSelected = actualIndex === selectedIndex
          const marker = item.isCurrent ? ' (current)' : ''

          return (
            <Box key={`${item.id ?? 'root'}:${actualIndex}`} flexDirection="row">
              <Box width={7}>
                {isSelected ? (
                  <Text color="blue" bold>
                    {figures.pointer} {actualIndex + 1}{' '}
                  </Text>
                ) : (
                  <Text>
                    {'  '}
                    {actualIndex + 1}{' '}
                  </Text>
                )}
              </Box>
              <Box flexGrow={1} overflow="hidden">
                <Text color={isSelected ? theme.text : theme.secondaryText}>
                  {item.label}
                  {marker}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>
      <Box marginLeft={3}>
        <Text dimColor>
          {exitState.pending ? (
            <>Press {exitState.keyName} again to exit</>
          ) : (
            <>↑/↓ 选择 · Enter 确认 · Tab/Esc 取消</>
          )}
        </Text>
      </Box>
    </>
  )
}

