/** WeCom long-connection transport: dial outward, authenticate, heartbeat, reply. */

import { WSClient } from '@wecom/aibot-node-sdk'
import type { BaseMessage, Logger, WsFrame, WsFrameHeaders } from '@wecom/aibot-node-sdk'

/** Status code the gateway returns once a streaming reply channel has expired. */
export const STREAM_EXPIRED_CODE = 846608

/** Connection dials the connector forwards to the SDK. */
export interface WeComTransportOptions {
  /** Robot BotID. */
  readonly botId: string
  /** Robot Secret. */
  readonly secret: string
  /** Heartbeat interval in milliseconds. */
  readonly heartbeatIntervalMs: number
  /** Reconnection attempt ceiling; `-1` retries without bound. */
  readonly maxReconnectAttempts: number
  /** Consecutive authentication-failure ceiling; `-1` retries without bound. */
  readonly maxAuthFailureAttempts: number
  /** Reply queue ceiling for one inbound request id. */
  readonly maxReplyQueueSize: number
}

/** Callbacks the connector handles on the live connection. */
export interface WeComTransportHandlers {
  /** One inbound message frame exactly as the gateway delivered it. */
  onMessage(frame: WsFrame<BaseMessage>): void
  /** The connection reported an error; reconnection remains the SDK's. */
  onError(error: unknown): void
}

/** One authenticated long connection to the WeCom gateway. */
export class WeComTransport {
  private client: WSClient | undefined

  /**
   * @param logger - SDK-facing logger adapter.
   * @param handlers - inbound frame and error callbacks.
   */
  constructor(
    private readonly logger: Logger,
    private readonly handlers: WeComTransportHandlers,
  ) {}

  /** Dial the gateway and start serving frames. */
  start(options: WeComTransportOptions): void {
    const client = new WSClient({
      botId: options.botId,
      secret: options.secret,
      heartbeatInterval: options.heartbeatIntervalMs,
      maxReconnectAttempts: options.maxReconnectAttempts,
      maxAuthFailureAttempts: options.maxAuthFailureAttempts,
      maxReplyQueueSize: options.maxReplyQueueSize,
      logger: this.logger,
    })
    this.client = client
    client.on('message', (frame) => {
      this.handlers.onMessage(frame)
    })
    client.on('error', (error) => {
      this.handlers.onError(error)
    })
    client.connect()
  }

  /** Drop the connection; the SDK stops reconnecting. */
  stop(): void {
    this.client?.disconnect()
    this.client = undefined
  }

  /**
   * Send one streamed reply segment.
   * @param frame - inbound frame whose request id carries this reply.
   * @param streamId - stream identity shared by every segment of one reply.
   * @param content - reply text, or the complete text when `finish` is set.
   * @param finish - whether this segment closes the stream.
   * @returns the gateway status code, absent when the transport is stopped.
   */
  async replyStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish: boolean,
  ): Promise<number | undefined> {
    const client = this.client
    if (client === undefined) return undefined
    const result = await client.replyStream(frame, streamId, content, finish)
    return result?.errcode
  }

  /**
   * Push one Markdown message into a conversation without an inbound frame.
   * @param conversationId - direct-message userid or group chatid.
   * @param content - Markdown body.
   */
  async sendMarkdown(conversationId: string, content: string): Promise<void> {
    const client = this.client
    if (client === undefined) return
    await client.sendMessage(conversationId, { msgtype: 'markdown', markdown: { content } })
  }
}
