import { randomUUID } from 'crypto'
import {
  appendMailboxMessage,
  readMailboxMessages,
} from '@services/mailbox'
import {
  readTeamTask,
  TeamTaskProgress,
  updateTeamTask,
} from '@services/teamManager'
import { runAgentTaskExecution } from '@tools/TaskTool/runAgentTaskExecution'

export async function runTeammateTask(taskFilePath: string): Promise<number> {
  const initialTask = readTeamTask(taskFilePath)
  if (!initialTask) {
    console.error(`Invalid teammate task file: ${taskFilePath}`)
    return 1
  }

  const abortController = new AbortController()
  let isCancelled = false
  let isFinished = false
  let mailboxWatcher: NodeJS.Timeout | null = null

  const markCancelled = (reason: string) => {
    if (isCancelled || isFinished) return
    isCancelled = true
    abortController.abort(reason)
    try {
      updateTeamTask(taskFilePath, current => {
        if (
          current.status === 'completed' ||
          current.status === 'failed' ||
          current.status === 'cancelled'
        ) {
          return current
        }
        return {
          ...current,
          status: 'cancelled',
          endedAt: Date.now(),
          error: reason,
        }
      })
    } catch {
      // ignore
    }
  }

  const onSigInt = () => markCancelled('teammate interrupted by SIGINT')
  const onSigTerm = () => markCancelled('teammate interrupted by SIGTERM')
  process.on('SIGINT', onSigInt)
  process.on('SIGTERM', onSigTerm)

  try {
    const workerStartTime = Date.now()
    updateTeamTask(taskFilePath, current => ({
      ...current,
      status: 'running',
      startedAt: workerStartTime,
    }))

    let inboxLineOffset = 0
    mailboxWatcher = setInterval(() => {
      try {
        const inboxMessages = readMailboxMessages(
          'inbox',
          initialTask.teamName,
          initialTask.agentName,
          inboxLineOffset,
        )
        if (inboxMessages.length === 0) return
        inboxLineOffset += inboxMessages.length

        for (const message of inboxMessages) {
          if (message.taskId && message.taskId !== initialTask.id) {
            continue
          }
          if (message.type === 'shutdown_request') {
            const responsePayload = {
              id: randomUUID(),
              teamName: initialTask.teamName,
              from: initialTask.agentName,
              to: message.from || 'lead',
              type: 'shutdown_response' as const,
              content: 'approve',
              requestId: message.requestId,
              approve: true,
              createdAt: Date.now(),
            }
            appendMailboxMessage(
              'outbox',
              initialTask.teamName,
              initialTask.agentName,
              responsePayload,
            )
            appendMailboxMessage(
              'inbox',
              initialTask.teamName,
              responsePayload.to,
              responsePayload,
            )
            markCancelled(`shutdown requested by ${message.from || 'lead'}`)
            continue
          }

          const content = String(message.content ?? '').trim()
          if (!content) continue

          if (content.toLowerCase() === 'cancel' || content.toLowerCase() === '/cancel') {
            markCancelled(`cancelled by ${message.from} via mailbox`)
            continue
          }

          const progressMessage: TeamTaskProgress = {
            status: '收到消息',
            model: initialTask.model_name || 'task',
            toolCount: 0,
            elapsedMs: Date.now() - workerStartTime,
            lastAction:
              content.length > 100
                ? `来自 ${message.from}: ${content.slice(0, 100)}...`
                : `来自 ${message.from}: ${content}`,
            createdAt: Date.now(),
          }
          updateTeamTask(taskFilePath, current => ({
            ...current,
            progress: [...(current.progress ?? []), progressMessage].slice(-200),
          }))
        }
      } catch {
        // ignore mailbox polling failures
      }
    }, 400)

    const result = await runAgentTaskExecution(
      {
        description: initialTask.description,
        prompt: initialTask.prompt,
        model_name: initialTask.model_name,
        subagent_type: initialTask.subagent_type,
        team_name: initialTask.teamName,
        name: initialTask.agentName,
        agent_id: initialTask.agentName,
        safeMode: initialTask.safeMode,
        forkNumber: initialTask.forkNumber,
        messageLogName: initialTask.messageLogName,
        verbose: initialTask.verbose,
        abortController,
        readFileTimestamps: {},
      },
      async progress => {
        const progressMessage: TeamTaskProgress = {
          ...progress,
          createdAt: Date.now(),
        }
        updateTeamTask(taskFilePath, current => ({
          ...current,
          progress: [...(current.progress ?? []), progressMessage].slice(-200),
        }))

        appendMailboxMessage(
          'outbox',
          initialTask.teamName,
          initialTask.agentName,
          {
            id: randomUUID(),
            teamName: initialTask.teamName,
            from: initialTask.agentName,
            to: 'lead',
            type: 'progress',
            taskId: initialTask.id,
            content: JSON.stringify(progress),
            createdAt: Date.now(),
          },
        )
      },
    )

    isFinished = true
    updateTeamTask(taskFilePath, current => ({
      ...current,
      status: result.interrupted ? 'cancelled' : 'completed',
      endedAt: Date.now(),
      resultText: result.resultForAssistant,
      tokenCount: result.tokenCount,
      toolUseCount: result.toolUseCount,
      durationMs: result.durationMs,
    }))

    appendMailboxMessage(
      'outbox',
      initialTask.teamName,
      initialTask.agentName,
      {
        id: randomUUID(),
        teamName: initialTask.teamName,
        from: initialTask.agentName,
        to: 'lead',
        type: 'result',
        taskId: initialTask.id,
        content: result.resultForAssistant,
        createdAt: Date.now(),
      },
    )

    return result.interrupted ? 130 : 0
  } catch (error) {
    isFinished = true
    const message = error instanceof Error ? error.message : String(error)
    const wasAborted = abortController.signal.aborted || isCancelled
    updateTeamTask(taskFilePath, current => ({
      ...current,
      status: wasAborted ? 'cancelled' : 'failed',
      endedAt: Date.now(),
      error: message,
    }))
    appendMailboxMessage('outbox', initialTask.teamName, initialTask.agentName, {
      id: randomUUID(),
      teamName: initialTask.teamName,
      from: initialTask.agentName,
      to: 'lead',
      type: 'status',
      taskId: initialTask.id,
      content: `${wasAborted ? 'cancelled' : 'failed'}: ${message}`,
      createdAt: Date.now(),
    })
    return wasAborted ? 130 : 1
  } finally {
    if (mailboxWatcher) {
      clearInterval(mailboxWatcher)
      mailboxWatcher = null
    }
    process.off('SIGINT', onSigInt)
    process.off('SIGTERM', onSigTerm)
  }
}
