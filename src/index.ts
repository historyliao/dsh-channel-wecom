/**
 * @deepseek-ai/dsh-channel-wecom — the WeCom robot channel. One long connection
 * dials outward to the WeCom gateway, admits direct-message text into the
 * conversation's own root Session, and streams the Agent's answer back into the
 * same chat.
 *
 * @module @deepseek-ai/dsh-channel-wecom
 */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import z from '@deepseek-ai/schemastery'
import type { BaseMessage, Logger, TextMessage, VoiceMessage, WsFrame } from '@wecom/aibot-node-sdk'
import { generateReqId } from '@wecom/aibot-node-sdk'
import { WeComReplies } from './outbound.ts'
import { PairingStore } from './pairing.ts'
import { WeComSessionBinder } from './session.ts'
import { WeComTransport } from './transport.ts'
import type { WeComInbound } from './types.ts'

export * from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'channel-wecom'

/** Host services that must exist before this connector can serve traffic. */
export const inject = ['agents', 'credentials', 'permissionPresets', 'sessionPersistence']

/** One robot account served over the WeCom long connection. */
export interface Config {
  /** Stable account identity carried into provenance and logs. */
  accountId: string
  /** Credential reference holding the robot BotID. */
  botIdRef: string
  /** Credential reference holding the robot Secret. */
  secretRef: string
  /** Absolute working directory for Sessions this channel creates. */
  workspacePath: string
  /** Agent preset mounted on every Agent this connector composes. */
  agentPreset?: string
  /** Permission preset applied to a newly created Session. */
  permissionPreset: string
  /** Provider route for every Session this connector creates; set with `modelId`. */
  modelProvider?: string
  /** Model served on that route; set with `modelProvider`. */
  modelId?: string
  /** Output-token ceiling for one root request. */
  maxTokens?: number
  /** Direct-message policy: admit everyone, pair unknown senders, admit listed senders, or admit none. */
  dmPolicy: 'open' | 'pairing' | 'allowlist' | 'disabled'
  /** Sender userids admitted without pairing. */
  allowFrom: string[]
  /** Sender userids allowed to approve pairing requests from the chat. */
  operatorIds: string[]
  /** Pairing document holding approved senders and pending requests. */
  pairingStorePath: string
  /** Heartbeat interval in milliseconds. */
  heartbeatIntervalMs: number
  /** Reconnection attempt ceiling; `-1` retries without bound. */
  maxReconnectAttempts: number
  /** Consecutive authentication-failure ceiling; `-1` retries without bound. */
  maxAuthFailureAttempts: number
  /** Reply queue ceiling for one inbound request id. */
  maxReplyQueueSize: number
  /** Minimum interval between streamed reply updates. */
  streamIntervalMs: number
}

export const Config: z<Config> = z.object({
  accountId: z.string().required(),
  botIdRef: z.string().required(),
  secretRef: z.string().required(),
  workspacePath: z.string().required(),
  agentPreset: z.string(),
  permissionPreset: z.string().default('read-only'),
  modelProvider: z.string(),
  modelId: z.string(),
  maxTokens: z.number().step(1).min(1),
  dmPolicy: z.union(['open', 'pairing', 'allowlist', 'disabled'] as const).default('allowlist'),
  allowFrom: z.array(String).default([]),
  operatorIds: z.array(String).default([]),
  pairingStorePath: z.string().default('.wecom-pairing.json'),
  heartbeatIntervalMs: z.number().step(1).min(1000).default(30_000),
  maxReconnectAttempts: z.number().step(1).default(10),
  maxAuthFailureAttempts: z.number().step(1).default(5),
  maxReplyQueueSize: z.number().step(1).min(1).default(500),
  streamIntervalMs: z.number().step(1).min(50).default(800),
})

/** Bounded memory of provider message ids already admitted. */
const SEEN_LIMIT = 1000

/** Normalize one inbound message into prompt text, or `undefined` when M1 does not admit it. */
function normalize(message: BaseMessage): WeComInbound | undefined {
  if (message.chattype !== 'single') return undefined
  let text: string
  if (message.msgtype === 'text') {
    text = (message as TextMessage).text.content
  } else if (message.msgtype === 'voice') {
    text = (message as VoiceMessage).voice.content
  } else {
    return undefined
  }
  const quote = message.quote
  if (quote?.msgtype === 'text' && quote.text !== undefined) {
    text = `> ${quote.text.content}\n\n${text}`
  }
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return {
    conversationId: message.from.userid,
    senderId: message.from.userid,
    messageId: message.msgid,
    text: trimmed,
  }
}

/** Reply shown to a sender who is waiting for approval. */
function pairingPrompt(senderId: string, code: string): string {
  return `您的企业微信用户ID：${senderId}\n配对码：${code}\n\n请让管理员批准该配对码后再发消息。`
}

/** Resolve one required credential, failing loud when the reference is unset. */
async function resolveCredential(ctx: Context, ref: string): Promise<string> {
  const resolved = await ctx.credentials.resolve(credentialRef(ref))
  if (resolved === undefined) {
    throw new Error(`wecom channel: credential "${ref}" is not set`)
  }
  return resolved.value
}

/**
 * Mount the WeCom channel for one robot account.
 * @param ctx - plugin context that owns every effect this connector registers.
 * @param config - validated account, policy, transport, and routing values.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!isAbsolute(config.workspacePath)) {
    throw new TypeError(`wecom channel: workspacePath must be absolute, got ${JSON.stringify(config.workspacePath)}`)
  }
  if (config.dmPolicy === 'allowlist' && config.allowFrom.length === 0) {
    throw new Error('wecom channel: dmPolicy "allowlist" requires at least one allowFrom entry')
  }
  if (config.dmPolicy === 'pairing' && config.operatorIds.length === 0) {
    throw new Error('wecom channel: dmPolicy "pairing" requires at least one operatorIds entry to approve requests')
  }
  if ((config.modelProvider === undefined) !== (config.modelId === undefined)) {
    throw new Error('wecom channel: modelProvider and modelId must be set together')
  }
  const agentOptions = config.modelProvider === undefined || config.modelId === undefined
    ? undefined
    : {
      provider: config.modelProvider,
      model: config.modelId,
      ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
    }
  const botId = await resolveCredential(ctx, config.botIdRef)
  const secret = await resolveCredential(ctx, config.secretRef)
  const admitted = new Set(config.allowFrom)
  const operators = new Set(config.operatorIds)
  const pairingStorePath = resolve(config.pairingStorePath)
  const pairing = new PairingStore(pairingStorePath)
  const seen = new Set<string>()
  const seenOrder: string[] = []
  const binder = new WeComSessionBinder(ctx, config.accountId, {
    workspacePath: config.workspacePath,
    ...config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset },
    permissionPreset: config.permissionPreset,
    ...agentOptions === undefined ? {} : { agentOptions },
  })
  const logger: Logger = {
    debug: message => { ctx.logger.debug(message) },
    info: message => { ctx.logger.info(message) },
    warn: message => { ctx.logger.warn(message) },
    error: message => { ctx.logger.error(message) },
  }
  const transport = new WeComTransport(logger, {
    onMessage: (frame) => {
      void admit(frame).catch((error: unknown) => {
        ctx.logger.warn(`wecom channel: inbound message failed: ${errorChain(error)}`)
      })
    },
    onError: (error) => {
      ctx.logger.warn(`wecom channel: connection error: ${errorChain(error)}`)
    },
  })
  const replies = new WeComReplies(ctx, transport, config.streamIntervalMs)

  async function admit(frame: WsFrame<BaseMessage>): Promise<void> {
    const message = frame.body
    if (message === undefined) return
    const inbound = normalize(message)
    if (inbound === undefined) return
    if (await handleApproval(frame, inbound)) return
    if (!(await admitSender(frame, inbound))) return
    if (seen.has(inbound.messageId)) return
    seen.add(inbound.messageId)
    seenOrder.push(inbound.messageId)
    if (seenOrder.length > SEEN_LIMIT) {
      const evicted = seenOrder.shift()
      if (evicted !== undefined) seen.delete(evicted)
    }
    const agent = await binder.resolve(inbound.conversationId)
    replies.begin(inbound.conversationId, frame, agent.session.id)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: inbound.text }],
      source: {
        kind: 'wecom',
        accountId: config.accountId,
        conversationId: inbound.conversationId,
        senderId: inbound.senderId,
        messageId: inbound.messageId,
      },
    }))
  }

  async function handleApproval(frame: WsFrame<BaseMessage>, inbound: WeComInbound): Promise<boolean> {
    if (!operators.has(inbound.senderId)) return false
    const match = /^approve\s+(\d{6})$/i.exec(inbound.text)
    if (match === null) return false
    const code = match[1] ?? ''
    const senderId = pairing.approve(code)
    const text = senderId === undefined
      ? `没有待批准的配对码 ${code}。`
      : `已批准 ${senderId}，对方下一条消息即可正常对话。`
    ctx.logger.info(`wecom channel: operator ${inbound.senderId} approved code ${code}: ${text}`)
    try {
      await transport.replyStream(frame, generateReqId('stream'), text, true)
    } catch (error: unknown) {
      ctx.logger.warn(`wecom channel: approval reply failed: ${errorChain(error)}`)
    }
    return true
  }

  async function admitSender(frame: WsFrame<BaseMessage>, inbound: WeComInbound): Promise<boolean> {
    if (config.dmPolicy === 'open') return true
    if (config.dmPolicy === 'disabled') return false
    if (admitted.has(inbound.senderId) || pairing.isApproved(inbound.senderId)) return true
    if (config.dmPolicy === 'allowlist') {
      ctx.logger.warn(`wecom channel: dropped message from unlisted sender "${inbound.senderId}"`)
      return false
    }
    const { code, created } = pairing.request(inbound.senderId)
    if (!created) return false
    ctx.logger.warn(`wecom channel: pairing request ${code} from "${inbound.senderId}"; approve it in ${pairingStorePath}`)
    try {
      await transport.replyStream(frame, generateReqId('stream'), pairingPrompt(inbound.senderId, code), true)
    } catch (error: unknown) {
      ctx.logger.warn(`wecom channel: pairing reply failed: ${errorChain(error)}`)
    }
    return false
  }

  ctx.effect(() => async () => {
    transport.stop()
    replies.dispose()
    await binder.dispose()
  })
  transport.start({
    botId,
    secret,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    maxReconnectAttempts: config.maxReconnectAttempts,
    maxAuthFailureAttempts: config.maxAuthFailureAttempts,
    maxReplyQueueSize: config.maxReplyQueueSize,
  })
  ctx.logger.info(`wecom channel: connected account "${config.accountId}" over the long connection`)
}
