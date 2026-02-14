import { ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Box, Newline, Static, Text } from 'ink'
import ProjectOnboarding, {
  markProjectOnboardingComplete,
} from '@components/ProjectOnboarding'
import { CostThresholdDialog } from '@components/CostThresholdDialog'
import * as React from 'react'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Command } from '@commands'
import { Logo } from '@components/Logo'
import { Message } from '@components/Message'
import { MessageResponse } from '@components/MessageResponse'
import { TASK_PROGRESS_PREFIX, parseTaskProgressText } from '@components/messages/TaskProgressMessage'
import { TaskProgressGroup } from '@components/messages/TaskProgressGroup'
import type { TaskProgressPayload } from '@components/messages/TaskProgressMessage'
import { MessageSelector } from '@components/MessageSelector'
import {
  PermissionRequest,
  type ToolUseConfirm,
} from '@components/permissions/PermissionRequest'
import PromptInput from '@components/PromptInput'
import { Spinner } from '@components/Spinner'
import { getSystemPrompt } from '@constants/prompts'
import { getContext } from '@context'
import { getTotalCost, useCostSummary } from '@costTracker'
import { useLogStartupTime } from '@hooks/useLogStartupTime'
import { addToHistory } from '@history'
import { useApiKeyVerification } from '@hooks/useApiKeyVerification'
import { useCancelRequest } from '@hooks/useCancelRequest'
import useCanUseTool from '@hooks/useCanUseTool'
import { useLogMessages } from '@hooks/useLogMessages'
import { PermissionProvider } from '@context/PermissionContext'
import { ModeIndicator } from '@components/ModeIndicator'
import {
  setMessagesGetter,
  setMessagesSetter,
} from '@messages'
import {
  type AssistantMessage,
  type BinaryFeedbackResult,
  type Message as MessageType,
  type ProgressMessage,
  query,
} from '@query'
import type { Tool } from '@tool'
// Auto-updater removed; only show a new version banner passed from CLI
import { getGlobalConfig, saveGlobalConfig } from '@utils/config'
import { getNextAvailableLogForkNumber } from '@utils/log'
import {
  getErroredToolUseMessages,
  getInProgressToolUseIDs,
  getLastAssistantMessageId,
  getToolUseID,
  getUnresolvedToolUseIDs,
  INTERRUPT_MESSAGE,
  isNotEmptyMessage,
  type NormalizedMessage,
  normalizeMessages,
  normalizeMessagesForAPI,
  processUserInput,
  reorderMessages,
  extractTag,
  createAssistantMessage,
} from '@utils/messages'
import { clearTerminal } from '@utils/terminal'
import { BinaryFeedback } from '@components/binary-feedback/BinaryFeedback'
import { getMaxThinkingTokens } from '@utils/thinking'
import { getOriginalCwd } from '@utils/state'
import { logError } from '@utils/log'

type Props = {
  commands: Command[]
  safeMode?: boolean
  loadMcpToolsInBackground?: boolean
  debug?: boolean
  initialForkNumber?: number | undefined
  initialPrompt: string | undefined
  // A unique name for the message log file, used to identify the fork
  messageLogName: string
  shouldShowPromptInput: boolean
  tools: Tool[]
  verbose: boolean | undefined
  // Initial messages to populate the REPL with
  initialMessages?: MessageType[]
}

export type BinaryFeedbackContext = {
  m1: AssistantMessage
  m2: AssistantMessage
  resolve: (result: BinaryFeedbackResult) => void
}

const EMPTY_TOOL_USE_IDS = new Set<string>()

export function REPL({
  commands,
  safeMode,
  loadMcpToolsInBackground = false,
  debug = false,
  initialForkNumber = 0,
  initialPrompt,
  messageLogName,
  shouldShowPromptInput,
  tools: initialTools,
  verbose: verboseFromCLI,
  initialMessages,
}: Props): React.ReactNode {
  // Keep CLI default permissive unless user explicitly enables --safe.
  const baseSafeMode = safeMode ?? false
  const [autoMode, setAutoMode] = useState(false)
  const effectiveSafeMode = baseSafeMode && !autoMode

  // Cache verbose config to avoid synchronous file reads on every render
  const [verboseConfig] = useState(() => verboseFromCLI ?? getGlobalConfig().verbose)
  const verbose = verboseConfig

  // Used to force the logo to re-render and conversation log to use a new file
  const [forkNumber, setForkNumber] = useState(
    getNextAvailableLogForkNumber(messageLogName, initialForkNumber, 0),
  )

  const [
    forkConvoWithMessagesOnTheNextRender,
    setForkConvoWithMessagesOnTheNextRender,
  ] = useState<MessageType[] | null>(null)

  // Simplified AbortController management - inspired by reference system
  const [abortController, setAbortController] = useState<AbortController | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  // No auto-updater state
  const [toolJSX, setToolJSX] = useState<{
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
  } | null>(null)
  const [toolUseConfirm, setToolUseConfirm] = useState<ToolUseConfirm | null>(
    null,
  )
  const [tools, setTools] = useState<Tool[]>(initialTools)
  const [messages, setMessages] = useState<MessageType[]>(initialMessages ?? [])
  const [inputValue, setInputValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [submitCount, setSubmitCount] = useState(0)
  const [isMessageSelectorVisible, setIsMessageSelectorVisible] =
    useState(false)
  const [showCostDialog, setShowCostDialog] = useState(false)
  const [haveShownCostDialog, setHaveShownCostDialog] = useState(
    getGlobalConfig().hasAcknowledgedCostThreshold,
  )

  const [binaryFeedbackContext, setBinaryFeedbackContext] =
    useState<BinaryFeedbackContext | null>(null)

  const getBinaryFeedbackResponse = useCallback(
    (
      m1: AssistantMessage,
      m2: AssistantMessage,
    ): Promise<BinaryFeedbackResult> => {
      return new Promise<BinaryFeedbackResult>(resolvePromise => {
        setBinaryFeedbackContext({
          m1,
          m2,
          resolve: resolvePromise,
        })
      })
    },
    [],
  )

  const readFileTimestamps = useRef<{
    [filename: string]: number
  }>({})

  const lastSubmittedPromptRef = useRef<string>('')

  const { status: apiKeyStatus, reverify } = useApiKeyVerification()

  useEffect(() => {
    setTools(initialTools)
  }, [initialTools])

  useEffect(() => {
    if (!loadMcpToolsInBackground) {
      return
    }

    let isCancelled = false
    ;(async () => {
      try {
        const { getTools } = await import('@tools')
        const fullTools = await getTools()
        if (!isCancelled) {
          setTools(fullTools)
        }
      } catch (error) {
        logError(error)
      }
    })()

    return () => {
      isCancelled = true
    }
  }, [loadMcpToolsInBackground])

  function onCancel() {
    if (!isLoading) {
      return
    }
    setIsLoading(false)
    if (toolUseConfirm) {
      toolUseConfirm.onAbort()
    } else if (abortController && !abortController.signal.aborted) {
      // Fix: Wrap abort in try-catch to handle DOMException [AbortError]
      // The abort() call triggers rejection of pending promises, which may not
      // be caught if the streaming loop has already exited
      try {
        abortController.abort()
      } catch (e) {
        // Silently ignore AbortError - this is expected behavior
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          console.warn('[onCancel] Unexpected error during abort:', e)
        }
      }
    }

    // 取消后回到干净输入框（不要把上一次的 prompt 塞回来）
    lastSubmittedPromptRef.current = ''
    setInputValue('')
    setCursorOffset(0)
  }

  useCancelRequest(
    setToolJSX,
    setToolUseConfirm,
    setBinaryFeedbackContext,
    onCancel,
    isLoading,
    isMessageSelectorVisible,
    abortController?.signal,
  )

  useEffect(() => {
    if (forkConvoWithMessagesOnTheNextRender) {
      setForkNumber(_ => _ + 1)
      setForkConvoWithMessagesOnTheNextRender(null)
      setMessages(forkConvoWithMessagesOnTheNextRender)
    }
  }, [forkConvoWithMessagesOnTheNextRender])

  useEffect(() => {
    const totalCost = getTotalCost()
    if (totalCost >= 5 /* $5 */ && !showCostDialog && !haveShownCostDialog) {
      
      setShowCostDialog(true)
    }
  }, [messages, showCostDialog, haveShownCostDialog])

  // Update banner is provided by CLI at startup; no async check here.

  const canUseTool = useCanUseTool(setToolUseConfirm)

  async function onInit() {
    reverify()

    if (!initialPrompt) {
      return
    }

    setIsLoading(true)

    const newAbortController = new AbortController()
    setAbortController(newAbortController)
    lastSubmittedPromptRef.current = initialPrompt

    try {
      const newMessages = await processUserInput(
        initialPrompt,
        setToolJSX,
        {
          abortController: newAbortController,
          options: {
            commands,
            forkNumber,
            messageLogName,
            tools,
            verbose,
            maxThinkingTokens: 0,
          },
          messageId: getLastAssistantMessageId(messages),
          setForkConvoWithMessagesOnTheNextRender,
          readFileTimestamps: readFileTimestamps.current,
        },
        null,
      )

      if (newMessages.length) {
        for (const message of newMessages) {
          if (message.type === 'user') {
            addToHistory(initialPrompt)
            // TODO: setHistoryIndex
          }
        }
        setMessages(_ => [..._, ...newMessages])

        // The last message is an assistant message if the user input was a local command
        // or an invalid slash command.
        const lastMessage = newMessages[newMessages.length - 1]!
        if (lastMessage.type === 'assistant') {
          return
        }

        const [systemPrompt, context, maxThinkingTokens] =
          await Promise.all([
            getSystemPrompt(),
            getContext(),
            getMaxThinkingTokens([...messages, ...newMessages]),
          ])

        for await (const message of query(
          [...messages, ...newMessages],
          systemPrompt,
          context,
          canUseTool,
          {
            options: {
              commands,
              forkNumber,
              messageLogName,
              tools,
              verbose,
              safeMode: effectiveSafeMode,
              maxThinkingTokens,
            },
            messageId: getLastAssistantMessageId([...messages, ...newMessages]),
            agentId: 'lead',
            readFileTimestamps: readFileTimestamps.current,
            abortController: newAbortController,
            setToolJSX,
          },
          getBinaryFeedbackResponse,
        )) {
          setMessages(oldMessages => [...oldMessages, message])
        }
      } else {
        addToHistory(initialPrompt)
        // TODO: setHistoryIndex
      }

      setHaveShownCostDialog(
        getGlobalConfig().hasAcknowledgedCostThreshold || false,
      )
    } catch (e) {
      logError(e)
      setMessages(old => [
        ...old,
        createAssistantMessage(`API Error: ${e instanceof Error ? e.message : String(e)}`),
      ])
    } finally {
      // Fix: Clean up state after onInit completion
      setIsLoading(false)
      setAbortController(null)
    }
  }

  async function onQuery(newMessages: MessageType[], passedAbortController?: AbortController) {
    // Use passed AbortController or create new one
    const controllerToUse = passedAbortController || new AbortController()
    if (!passedAbortController) {
      setAbortController(controllerToUse)
    }

    setMessages(oldMessages => [...oldMessages, ...newMessages])

    // Mark onboarding as complete when any user message is sent to the assistant
    markProjectOnboardingComplete()

    // The last message is an assistant message if the user input was a local command
    // or an invalid slash command.
    const lastMessage = newMessages[newMessages.length - 1]!

    // 记录最后一次用户输入，方便取消后恢复
    for (let i = newMessages.length - 1; i >= 0; i--) {
      const m = newMessages[i]
      if (m?.type === 'user' && typeof m.message.content === 'string') {
        lastSubmittedPromptRef.current = m.message.content
        setInputValue('') // 保持现有行为：提交后清空输入框
        setCursorOffset(0)
        break
      }
    }

    // Update terminal title based on user message
    if (
      lastMessage.type === 'user' &&
      typeof lastMessage.message.content === 'string'
    ) {
      // updateTerminalTitle(lastMessage.message.content)
    }
    if (lastMessage.type === 'assistant') {
      setAbortController(null)
      setIsLoading(false)
      return
    }

    const [systemPrompt, context, maxThinkingTokens] =
      await Promise.all([
        getSystemPrompt(),
        getContext(),
        getMaxThinkingTokens([...messages, lastMessage]),
      ])

    // query the API
    try {
      for await (const message of query(
        [...messages, lastMessage],
        systemPrompt,
        context,
        canUseTool,
      {
        options: {
          commands,
          forkNumber,
          messageLogName,
          tools,
          verbose,
          safeMode: effectiveSafeMode,
          maxThinkingTokens,
        },
        messageId: getLastAssistantMessageId([...messages, lastMessage]),
        agentId: 'lead',
        readFileTimestamps: readFileTimestamps.current,
        abortController: controllerToUse,
        setToolJSX,
      },
      getBinaryFeedbackResponse,
    )) {
      setMessages(oldMessages => [...oldMessages, message])
    }
    } catch (e) {
      logError(e)
      setMessages(old => [
        ...old,
        createAssistantMessage(`API Error: ${e instanceof Error ? e.message : String(e)}`),
      ])
    } finally {
      setIsLoading(false)
      setAbortController(null)
    }
  }

  // Register cost summary tracker
  useCostSummary()

  // Register messages getter and setter
  useEffect(() => {
    const getMessages = () => messages
    setMessagesGetter(getMessages)
    setMessagesSetter(setMessages)
  }, [messages])

  // Record transcripts locally, for debugging and conversation recovery
  useLogMessages(messages, messageLogName, forkNumber)

  // Log startup time
  useLogStartupTime()

  // Initial load
  useEffect(() => {
    onInit()
    // TODO: fix this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const normalizedMessages = useMemo(
    () => normalizeMessages(messages).filter(isNotEmptyMessage),
    [messages],
  )

  const unresolvedToolUseIDs = useMemo(
    () => getUnresolvedToolUseIDs(normalizedMessages),
    [normalizedMessages],
  )

  const inProgressToolUseIDs = useMemo(
    () => getInProgressToolUseIDs(normalizedMessages),
    [normalizedMessages],
  )

  const erroredToolUseIDs = useMemo(
    () =>
      new Set(
        getErroredToolUseMessages(normalizedMessages).map(
          _ => (_.message.content[0]! as ToolUseBlockParam).id,
        ),
      ),
    [normalizedMessages],
  )

  const orderedMessages = useMemo(
    () => reorderMessages(normalizedMessages),
    [normalizedMessages],
  )

  const replStaticPrefixLength = useMemo(
    () =>
      getReplStaticPrefixLength(
        orderedMessages,
        normalizedMessages,
        unresolvedToolUseIDs,
      ),
    [orderedMessages, normalizedMessages, unresolvedToolUseIDs],
  )

  const canAnimateMessages =
    !toolJSX && !toolUseConfirm && !isMessageSelectorVisible

  const messagesJSX = useMemo(() => {
    // ── 预处理 pass：收集 Task 分组数据 ──
    const taskToolUses = new Map<string, { description: string; agentType: string }>()
    const taskProgresses = new Map<string, TaskProgressPayload>()
    const taskSiblingMap = new Map<string, Set<string>>()

    for (const msg of orderedMessages) {
      // 识别 Task tool_use
      if (msg.type === 'assistant') {
        const blocks = msg.message?.content
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block?.type === 'tool_use' && block.name === 'Task') {
              taskToolUses.set(block.id, {
                description: (block.input as any)?.description || '',
                agentType: String((block.input as any)?.subagent_type || 'general-purpose'),
              })
            }
          }
        }
      }
      // 识别 Task progress
      if (msg.type === 'progress') {
        const textBlock = msg.content?.message?.content?.[0]
        const text = textBlock?.type === 'text' ? textBlock.text : null
        if (text && text.startsWith(TASK_PROGRESS_PREFIX)) {
          const payload = parseTaskProgressText(text)
          if (payload && msg.toolUseID) {
            taskProgresses.set(msg.toolUseID, payload)
            // 记录兄弟集合（仅保留 Task 类型的兄弟）
            const taskSiblings = new Set(
              [...msg.siblingToolUseIDs].filter(id => taskToolUses.has(id)),
            )
            // 加入自身
            if (taskToolUses.has(msg.toolUseID)) {
              taskSiblings.add(msg.toolUseID)
            }
            if (taskSiblings.size > 1) {
              for (const id of taskSiblings) {
                const existing = taskSiblingMap.get(id)
                if (existing) {
                  for (const s of taskSiblings) existing.add(s)
                } else {
                  taskSiblingMap.set(id, new Set(taskSiblings))
                }
              }
            }
          }
        }
      }
    }

    // 确定组长（每组中排序最靠前的 toolUseId）
    const groupLeaderOf = new Map<string, string>()
    const groupMembers = new Map<string, string[]>()

    for (const [id, siblings] of taskSiblingMap) {
      const sorted = [...siblings].sort()
      const leader = sorted[0]!
      groupLeaderOf.set(id, leader)
      if (!groupMembers.has(leader)) {
        groupMembers.set(leader, sorted)
      }
    }

    // 没有分组的单独 Task tool_use → 也视为一人组
    for (const [id] of taskToolUses) {
      if (!groupLeaderOf.has(id)) {
        groupLeaderOf.set(id, id)
        groupMembers.set(id, [id])
      }
    }

    // 收集被分组吞并的 progress toolUseIDs（多任务组才吞并）
    const groupedProgressIDs = new Set<string>()
    for (const [leaderId, members] of groupMembers) {
      if (members.length > 1) {
        for (const mid of members) {
          groupedProgressIDs.add(mid)
        }
      }
    }

    // ── 渲染 pass ──
    return orderedMessages.map((_, index) => {
        const toolUseID = getToolUseID(_)

        // --- Task tool_use 分组渲染 ---
        if (_.type === 'assistant' && toolUseID && taskToolUses.has(toolUseID)) {
          const leader = groupLeaderOf.get(toolUseID)!
          const memberIds = groupMembers.get(leader)!
          if (memberIds.length > 1) {
            if (toolUseID === leader) {
              // 组长位置：渲染 TaskProgressGroup
              const items = memberIds.map(id => ({
                description: taskToolUses.get(id)!.description,
                agentType: taskToolUses.get(id)!.agentType,
                progress: taskProgresses.get(id) || null,
              }))
              return {
                jsx: (
                  <Box key={_.uuid} width="100%">
                    <TaskProgressGroup items={items} />
                  </Box>
                ),
              }
            }
            // 非组长：渲染空占位
            return { jsx: <Box key={_.uuid} width="100%" /> }
          }
          // 单任务组：下面走正常逻辑，但用 TaskProgressGroup 统一样式
          const items = [{
            description: taskToolUses.get(toolUseID)!.description,
            agentType: taskToolUses.get(toolUseID)!.agentType,
            progress: taskProgresses.get(toolUseID) || null,
          }]
          return {
            jsx: (
              <Box key={_.uuid} width="100%">
                <TaskProgressGroup items={items} />
              </Box>
            ),
          }
        }

        // --- Task progress 分组渲染：已由组长统一渲染，跳过 ---
        if (_.type === 'progress' && _.toolUseID && groupedProgressIDs.has(_.toolUseID)) {
          return { jsx: <Box key={_.uuid} width="100%" /> }
        }
        // 单任务的 progress 也跳过（已在 tool_use 位置由 TaskProgressGroup 渲染）
        if (_.type === 'progress' && _.toolUseID && taskToolUses.has(_.toolUseID)) {
          return { jsx: <Box key={_.uuid} width="100%" /> }
        }

        // --- 其余消息：保持原有渲染逻辑 ---
        const progressToolUseID =
          _.type === 'progress' && _.content?.message?.content?.[0]
            ? (_.content.message.content[0] as ToolUseBlockParam).id
            : null
        const progressUnresolvedToolUseIDs = progressToolUseID
          ? new Set([progressToolUseID])
          : EMPTY_TOOL_USE_IDS
        const message =
          _.type === 'progress' ? (
            _.content?.message?.content?.[0]?.type === 'text' &&
            (_.content?.message?.content?.[0]?.text === INTERRUPT_MESSAGE ||
             _.content?.message?.content?.[0]?.text?.startsWith(TASK_PROGRESS_PREFIX)) ? (
              <Message
                message={_.content}
                messages={_.normalizedMessages}
                addMargin={false}
                tools={_.tools}
                verbose={verbose ?? false}
                debug={debug}
                erroredToolUseIDs={EMPTY_TOOL_USE_IDS}
                inProgressToolUseIDs={EMPTY_TOOL_USE_IDS}
                unresolvedToolUseIDs={EMPTY_TOOL_USE_IDS}
                shouldAnimate={false}
                shouldShowDot={false}
              />
            ) : (
              <MessageResponse children={
                <Message
                  message={_.content}
                  messages={_.normalizedMessages}
                  addMargin={false}
                  tools={_.tools}
                  verbose={verbose ?? false}
                  debug={debug}
                  erroredToolUseIDs={EMPTY_TOOL_USE_IDS}
                  inProgressToolUseIDs={EMPTY_TOOL_USE_IDS}
                  unresolvedToolUseIDs={progressUnresolvedToolUseIDs}
                  shouldAnimate={false}
                  shouldShowDot={false}
                />
              } />
            )
          ) : (
            <Message
              message={_}
              messages={normalizedMessages}
              addMargin={true}
              tools={tools}
              verbose={verbose}
              debug={debug}
              erroredToolUseIDs={erroredToolUseIDs}
              inProgressToolUseIDs={inProgressToolUseIDs}
              shouldAnimate={
                canAnimateMessages &&
                (!toolUseID || inProgressToolUseIDs.has(toolUseID))
              }
              shouldShowDot={true}
              unresolvedToolUseIDs={unresolvedToolUseIDs}
            />
          )

        const isInStaticPrefix = index < replStaticPrefixLength

        if (debug) {
          return {
            jsx: (
              <Box
                borderStyle="single"
                borderColor={isInStaticPrefix ? 'green' : 'red'}
                key={_.uuid}
                width="100%"
              >
                {message}
              </Box>
            ),
          }
        }

        return {
          jsx: (
            <Box key={_.uuid} width="100%">
              {message}
            </Box>
          ),
        }
      })
  }, [
    normalizedMessages,
    orderedMessages,
    tools,
    verbose,
    debug,
    erroredToolUseIDs,
    inProgressToolUseIDs,
    canAnimateMessages,
    unresolvedToolUseIDs,
    replStaticPrefixLength,
  ])

  const staticItems = useMemo(
    () => [
      {
        jsx: (
          <Box flexDirection="column" width="100%" key={`logo${forkNumber}`}>
            <Logo />
            <ProjectOnboarding workspaceDir={getOriginalCwd()} />
          </Box>
        ),
      },
      ...messagesJSX.slice(0, replStaticPrefixLength),
    ],
    [forkNumber, messagesJSX, replStaticPrefixLength],
  )

  const transientItems = useMemo(
    () => messagesJSX.slice(replStaticPrefixLength),
    [messagesJSX, replStaticPrefixLength],
  )

  // only show the dialog once not loading
  const showingCostDialog = !isLoading && showCostDialog

  const toggleAutoMode = useCallback(() => {
    setAutoMode(prev => !prev)
  }, [])

  const toggleMessageSelector = useCallback(() => {
    setIsMessageSelectorVisible(prev => !prev)
  }, [])

  const promptInputContext = useMemo(
    () => ({
      commands,
      forkNumber,
      messageLogName,
      debug,
      verbose,
      messages,
      tools,
      setForkConvoWithMessagesOnTheNextRender,
      readFileTimestamps: readFileTimestamps.current,
    }),
    [
      commands,
      forkNumber,
      messageLogName,
      debug,
      verbose,
      messages,
      tools,
      setForkConvoWithMessagesOnTheNextRender,
    ],
  )

  const promptInputState = useMemo(
    () => ({
      input: inputValue,
      onInputChange: setInputValue,
      cursorOffset,
      setCursorOffset,
      submitCount,
      onSubmitCountChange: setSubmitCount,
    }),
    [inputValue, cursorOffset, submitCount],
  )

  const promptInputRuntime = useMemo(
    () => ({
      isDisabled: apiKeyStatus === 'invalid',
      isLoading,
      abortController,
      autoMode,
    }),
    [apiKeyStatus, isLoading, abortController, autoMode],
  )

  const promptInputActions = useMemo(
    () => ({
      onQuery,
      setToolJSX,
      setIsLoading,
      setAbortController,
      onToggleAutoMode: toggleAutoMode,
      onShowMessageSelector: toggleMessageSelector,
    }),
    [
      onQuery,
      setToolJSX,
      setIsLoading,
      setAbortController,
      toggleAutoMode,
      toggleMessageSelector,
    ],
  )

  return (
    <PermissionProvider 
      isBypassPermissionsModeAvailable={!effectiveSafeMode}
      children={
        <React.Fragment>
        <ModeIndicator />
      <React.Fragment key={`static-messages-${forkNumber}`}>
        <Static
          items={staticItems}
          children={(item: any) => item.jsx}
        />
      </React.Fragment>
      {transientItems.map(_ => _.jsx)}
      <Box
        borderColor="red"
        borderStyle={debug ? 'single' : undefined}
        flexDirection="column"
        width="100%"
      >
        {!toolJSX && !toolUseConfirm && !binaryFeedbackContext && isLoading && (
          <Spinner />
        )}
        {toolJSX ? toolJSX.jsx : null}
        {!toolJSX && binaryFeedbackContext && !isMessageSelectorVisible && (
          <BinaryFeedback
            m1={binaryFeedbackContext.m1}
            m2={binaryFeedbackContext.m2}
            resolve={result => {
              binaryFeedbackContext.resolve(result)
              setTimeout(() => setBinaryFeedbackContext(null), 0)
            }}
            verbose={verbose}
            normalizedMessages={normalizedMessages}
            tools={tools}
            debug={debug}
            erroredToolUseIDs={erroredToolUseIDs}
            inProgressToolUseIDs={inProgressToolUseIDs}
            unresolvedToolUseIDs={unresolvedToolUseIDs}
          />
        )}
        {!toolJSX &&
          toolUseConfirm &&
          !isMessageSelectorVisible &&
          !binaryFeedbackContext && (
            <PermissionRequest
              toolUseConfirm={toolUseConfirm}
              onDone={() => setToolUseConfirm(null)}
              verbose={verbose}
            />
          )}
        {!toolJSX &&
          !toolUseConfirm &&
          !isMessageSelectorVisible &&
          !binaryFeedbackContext &&
          showingCostDialog && (
            <CostThresholdDialog
              onDone={() => {
                setShowCostDialog(false)
                setHaveShownCostDialog(true)
                const projectConfig = getGlobalConfig()
                saveGlobalConfig({
                  ...projectConfig,
                  hasAcknowledgedCostThreshold: true,
                })
                
              }}
            />
          )}

        {!toolUseConfirm &&
          !toolJSX?.shouldHidePromptInput &&
          shouldShowPromptInput &&
          !isMessageSelectorVisible &&
          !binaryFeedbackContext &&
          !showingCostDialog && (
            <>
              <PromptInput
                context={promptInputContext}
                inputState={promptInputState}
                runtime={promptInputRuntime}
                actions={promptInputActions}
              />
            </>
          )}
      </Box>
      {isMessageSelectorVisible && (
        <MessageSelector
          erroredToolUseIDs={erroredToolUseIDs}
          unresolvedToolUseIDs={unresolvedToolUseIDs}
          messages={normalizeMessagesForAPI(messages)}
          onSelect={async message => {
            setIsMessageSelectorVisible(false)

            // If the user selected the current prompt, do nothing
            if (!messages.includes(message)) {
              return
            }

            // Cancel tool use calls/requests
            onCancel()

            // Hack: make sure the "Interrupted by user" message is
            // rendered in response to the cancellation. Otherwise,
            // the screen will be cleared but there will remain a
            // vestigial "Interrupted by user" message at the top.
            setImmediate(async () => {
              // Clear messages, and re-render
              await clearTerminal()
              setMessages([])
              setForkConvoWithMessagesOnTheNextRender(
                messages.slice(0, messages.indexOf(message)),
              )

              // Populate/reset the prompt input
              if (typeof message.message.content === 'string') {
                const content = message.message.content
                const commandName =
                  extractTag(content, 'command-message') ||
                  extractTag(content, 'command-name')
                if (commandName) {
                  const args = extractTag(content, 'command-args')?.trim() || ''
                  const next = `/${commandName}${args ? ` ${args}` : ''}`
                  setInputValue(next)
                  setCursorOffset(next.length)
                  return
                }

                const bashInput = extractTag(content, 'bash-input')?.trim()
                if (bashInput) {
                  setInputValue(bashInput)
                  setCursorOffset(bashInput.length)
                  return
                }

                setInputValue(content)
                setCursorOffset(content.length)
              }
            })
          }}
          onEscape={() => setIsMessageSelectorVisible(false)}
          tools={tools}
        />
      )}
      {/** Fix occasional rendering artifact */}
      <Newline />
        </React.Fragment>
      }
    />
  )
}

function shouldRenderStatically(
  message: NormalizedMessage,
  messages: NormalizedMessage[],
  unresolvedToolUseIDs: Set<string>,
): boolean {
  switch (message.type) {
    case 'user':
    case 'assistant': {
      const toolUseID = getToolUseID(message)
      if (!toolUseID) {
        return true
      }
      if (unresolvedToolUseIDs.has(toolUseID)) {
        return false
      }

      const correspondingProgressMessage = messages.find(
        _ => _.type === 'progress' && _.toolUseID === toolUseID,
      ) as ProgressMessage | null
      if (!correspondingProgressMessage) {
        return true
      }

      return !intersects(
        unresolvedToolUseIDs,
        correspondingProgressMessage.siblingToolUseIDs,
      )
    }
    case 'progress':
      return !intersects(unresolvedToolUseIDs, message.siblingToolUseIDs)
  }
}

function getReplStaticPrefixLength(
  orderedMessages: NormalizedMessage[],
  allMessages: NormalizedMessage[],
  unresolvedToolUseIDs: Set<string>,
): number {
  for (let i = 0; i < orderedMessages.length; i++) {
    const message = orderedMessages[i]!
    if (!shouldRenderStatically(message, allMessages, unresolvedToolUseIDs)) {
      return i
    }
  }
  return orderedMessages.length
}

function intersects<A>(a: Set<A>, b: Set<A>): boolean {
  return a.size > 0 && b.size > 0 && [...a].some(_ => b.has(_))
}
