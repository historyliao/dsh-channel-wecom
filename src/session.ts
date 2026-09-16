/** Conversation-to-Session binding for one WeCom robot account. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { brandString } from '@deepseek-ai/dsh-brand'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

/** Creation-time composition shared by the create and resume paths. */
export interface WeComBindingOptions {
  /** Absolute working directory for Sessions this connector creates. */
  readonly workspacePath: string
  /** Agent preset mounted on every Agent this connector composes. */
  readonly agentPreset?: string
  /** Permission preset applied to a newly created Session. */
  readonly permissionPreset: string
  /** Explicit model route; omission keeps the deployment default. */
  readonly agentOptions?: {
    readonly provider: string
    readonly model: string
    readonly maxTokens?: number
  }
}

/** One resolved conversation: the live Agent plus the handle this connector owns. */
interface Binding {
  readonly agent: Agent
  /** Absent when the Agent was already live under another owner. */
  readonly handle: AgentHandle | undefined
}

/** Agent composition shared by the create and resume paths. */
interface Composition {
  /** Preset id recorded on a created Session; absent when no preset applies. */
  readonly presetId: string | undefined
  /** Pre-publication setup mounting that preset. */
  readonly setup: AgentSetup
}

/**
 * Derive the durable Session identity of one robot conversation.
 * @param accountId - configured account identity.
 * @param conversationId - conversation address within that account.
 * @returns a filesystem-safe identity that a later resume recomputes.
 */
export function wecomSessionId(accountId: string, conversationId: string): SessionId {
  const digest = createHash('sha256').update(`${accountId}\u0000${conversationId}`).digest('hex').slice(0, 32)
  return brandString<SessionId>(`wecom-${digest}`)
}

/** Resolve, resume, or create the one Session bound to each conversation. */
export class WeComSessionBinder {
  private readonly bindings = new Map<string, Binding>()
  private composition: Promise<Composition> | undefined

  /**
   * @param ctx - plugin context that owns Agents this binder creates.
   * @param accountId - configured account identity, part of the Session identity.
   * @param options - creation-time composition for this account.
   */
  constructor(
    private readonly ctx: Context,
    private readonly accountId: string,
    private readonly options: WeComBindingOptions,
  ) {}

  /**
   * Resolve the Agent serving one conversation.
   * @param conversationId - conversation address from the inbound message.
   * @returns the live Agent, created or resumed when this process has none.
   */
  async resolve(conversationId: string): Promise<Agent> {
    const bound = this.bindings.get(conversationId)
    if (bound !== undefined) return bound.agent
    const sessionId = wecomSessionId(this.accountId, conversationId)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      this.bindings.set(conversationId, { agent: live, handle: undefined })
      return live
    }
    const { presetId, setup } = await this.composed()
    const stored = await this.ctx.sessionPersistence.stat(sessionId)
    const handle = stored === undefined
      ? await this.create(sessionId, presetId, setup)
      : await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        ...this.options.agentOptions === undefined ? {} : { agentOptions: this.options.agentOptions },
        setup,
      })
    this.bindings.set(conversationId, { agent: handle.agent, handle })
    return handle.agent
  }

  /** Dispose every Agent this binder created; already-live Agents stay with their owner. */
  async dispose(): Promise<void> {
    const handles = [...this.bindings.values()].flatMap(binding => binding.handle === undefined ? [] : [binding.handle])
    this.bindings.clear()
    const results = await Promise.allSettled(handles.map(handle => handle.dispose()))
    for (const result of results) {
      if (result.status === 'rejected') {
        this.ctx.logger.warn(`wecom channel: Agent disposal failed: ${errorChain(result.reason)}`)
      }
    }
  }

  private async create(sessionId: SessionId, presetId: string | undefined, setup: AgentSetup): Promise<AgentHandle> {
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: {
        cwd: this.options.workspacePath,
        ...presetId === undefined ? {} : { agentPreset: presetId },
      },
      ...this.options.agentOptions === undefined ? {} : { agentOptions: this.options.agentOptions },
      setup,
    })
    this.ctx.permissionPresets.set(handle.agent.session, this.options.permissionPreset)
    return handle
  }

  private async composed(): Promise<Composition> {
    this.composition ??= this.buildComposition()
    return this.composition
  }

  private async buildComposition(): Promise<Composition> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      if (this.options.agentPreset !== undefined) {
        throw new Error('wecom channel: agentPreset requires the agent-presets service (mount @deepseek-ai/dsh-agent-presets)')
      }
      return { presetId: undefined, setup: () => {} }
    }
    const presetId = (await presets.resolve(this.options.agentPreset)).id
    return {
      presetId,
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, presetId)
      },
    }
  }
}
