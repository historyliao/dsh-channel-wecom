/** Streamed Agent replies delivered back into their WeCom conversations. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { generateReqId } from '@wecom/aibot-node-sdk'
import type { WsFrameHeaders } from '@wecom/aibot-node-sdk'
import { STREAM_EXPIRED_CODE } from './transport.ts'
import type { WeComTransport } from './transport.ts'

/** Committed assistant text of one durable message. */
type CommittedMessage = SessionEvent<'assistant/message'>['data']['message']

/** Reply state for one conversation, owned until its turn settles. */
interface OpenReply {
  readonly frame: WsFrameHeaders
  readonly conversationId: string
  readonly streamId: string
  /** Text streamed since the current turn started. */
  text: string
  /** Text of the most recent committed assistant message. */
  committed: string
  timer: ReturnType<typeof setTimeout> | undefined
  /** Serializes gateway calls for this reply in submission order. */
  chain: Promise<void>
  /** Set once the gateway reports the streaming channel is unusable. */
  expired: boolean
  closed: boolean
}

/** Join the text blocks of one committed assistant message. */
function assistantText(message: CommittedMessage): string {
  return message.content
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('')
}

/** Forwards live assistant text to WeCom and closes each reply once its turn ends. */
export class WeComReplies {
  private readonly bySession = new Map<SessionId, string>()
  private readonly open = new Map<string, OpenReply>()
  private readonly disposers: (() => void)[] = []

  /**
   * @param ctx - plugin context carrying the live Agent and Session feeds.
   * @param transport - connection that carries replies to the gateway.
   * @param throttleMs - minimum interval between streamed reply updates.
   */
  constructor(
    private readonly ctx: Context,
    private readonly transport: WeComTransport,
    private readonly throttleMs: number,
  ) {
    this.disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (frame.type === 'start') {
        this.reset(agent)
        return
      }
      if (frame.type === 'end') return
      if (frame.chunk.type !== 'text-delta' || frame.chunk.text === '') return
      this.append(agent, frame.chunk.text)
    }))
    this.disposers.push(ctx.on('session/event', (session, event) => {
      if (event.type === 'assistant/message') {
        this.commit(session, assistantText(event.data.message))
        return
      }
      if (event.type === 'turn/end') void this.close(session)
    }))
  }

  /**
   * Start the reply for one admitted message, closing any reply still open.
   * @param conversationId - conversation the reply returns to.
   * @param frame - inbound frame whose request id carries this reply.
   * @param sessionId - Session the Agent serves.
   */
  begin(conversationId: string, frame: WsFrameHeaders, sessionId: SessionId): void {
    const previous = this.open.get(conversationId)
    if (previous !== undefined) void this.close(previous)
    this.bySession.set(sessionId, conversationId)
    this.open.set(conversationId, {
      frame,
      conversationId,
      streamId: generateReqId('stream'),
      text: '',
      committed: '',
      timer: undefined,
      chain: Promise.resolve(),
      expired: false,
      closed: false,
    })
  }

  /** Stop throttling and drop every reply this instance owns. */
  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers.length = 0
    for (const reply of this.open.values()) {
      if (reply.timer !== undefined) clearTimeout(reply.timer)
      reply.closed = true
    }
    this.open.clear()
    this.bySession.clear()
  }

  private live(conversationId: string | undefined): OpenReply | undefined {
    if (conversationId === undefined) return undefined
    const reply = this.open.get(conversationId)
    return reply === undefined || reply.closed ? undefined : reply
  }

  private reset(agent: Agent): void {
    const reply = this.live(this.bySession.get(agent.session.id))
    if (reply === undefined) return
    reply.text = ''
  }

  private append(agent: Agent, text: string): void {
    const reply = this.live(this.bySession.get(agent.session.id))
    if (reply === undefined) return
    reply.text += text
    if (reply.timer !== undefined) return
    reply.timer = setTimeout(() => {
      reply.timer = undefined
      this.enqueue(reply, reply.text, false)
    }, this.throttleMs)
  }

  private commit(session: Session, text: string): void {
    const reply = this.live(this.bySession.get(session.id))
    if (reply === undefined) return
    reply.committed = text
  }

  private async close(target: OpenReply | Session): Promise<void> {
    const reply = 'closed' in target ? target : this.live(this.bySession.get(target.id))
    if (reply === undefined || reply.closed) return
    reply.closed = true
    this.open.delete(reply.conversationId)
    if (reply.timer !== undefined) {
      clearTimeout(reply.timer)
      reply.timer = undefined
    }
    const text = reply.committed !== '' ? reply.committed : reply.text
    if (text === '') return
    if (reply.expired) {
      this.enqueueProactive(reply, text)
      return
    }
    this.enqueue(reply, text, true)
  }

  private enqueue(reply: OpenReply, content: string, finish: boolean): void {
    reply.chain = reply.chain
      .then(async () => {
        const status = await this.transport.replyStream(reply.frame, reply.streamId, content, finish)
        if (status === STREAM_EXPIRED_CODE) {
          reply.expired = true
          if (finish) await this.transport.sendMarkdown(reply.conversationId, content)
        }
      })
      .catch((error: unknown) => {
        this.ctx.logger.warn(`wecom channel: reply delivery failed: ${errorChain(error)}`)
        if (finish) this.enqueueProactive(reply, content)
      })
  }

  private enqueueProactive(reply: OpenReply, content: string): void {
    reply.chain = reply.chain
      .then(async () => {
        await this.transport.sendMarkdown(reply.conversationId, content)
      })
      .catch((error: unknown) => {
        this.ctx.logger.warn(`wecom channel: proactive reply failed: ${errorChain(error)}`)
      })
  }
}
