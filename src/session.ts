/** Conversation-to-Session binding for one WeCom robot account. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
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

/**
 * Derive the durable Session identity of one robot conversation.
 * @param accountId - configured account identity.
 * @param conversationId - conversation address within that account.
 * @returns a filesystem-safe identity that a later resume recomputes.
 */
export function wecomSessionId(accountId: string, conversationId: string): SessionId {
  const digest = createHash('sha256').update(`${accountId}\u0000${conversationId}`).digest('hex').slice(0, 32)
  // Branding is a compile-time device; the runtime value is the plain string.
  return `wecom-${digest}` as SessionId
}

/** Resolve, resume, or create the one Session bound to each conversation. */
export class WeComSessionBinder {
  private readonly bindings = new Map<string, Binding>()
  private setup: Promise<AgentSetup> | undefined

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
    const setup = await this.composedSetup()
    const handle = await this.isStored(sessionId)
      ? await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        ...this.options.agentOptions === undefined ? {} : { agentOptions: this.options.agentOptions },
        setup,
      })
      : await this.create(sessionId, setup)
    this.bindings.set(conversationId, { agent: handle.agent, handle })
    return handle.agent
  }

  /**
   * Whether a stored Session exists, across persistence backend versions.
   * `stat` answers directly where the backend provides it; older backends
   * answer through `list`.
   * @param sessionId - durable identity to look up.
   * @returns true when the Session can be resumed instead of created.
   */
  private async isStored(sessionId: SessionId): Promise<boolean> {
    const persistence = this.ctx.sessionPersistence
    if (typeof persistence.stat === 'function') {
      return await persistence.stat(sessionId) !== undefined
    }
    const snapshots = await persistence.list()
    return snapshots.some(snapshot => snapshot.header.id === sessionId)
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

  private async create(sessionId: SessionId, setup: AgentSetup): Promise<AgentHandle> {
    const preset = this.options.agentPreset
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: {
        cwd: this.options.workspacePath,
        ...preset === undefined ? {} : { agentPreset: preset },
      },
      ...this.options.agentOptions === undefined ? {} : { agentOptions: this.options.agentOptions },
      setup,
    })
    this.ctx.permissionPresets.set(handle.agent.session, this.options.permissionPreset)
    return handle
  }

  private async composedSetup(): Promise<AgentSetup> {
    this.setup ??= this.buildSetup()
    return this.setup
  }

  private async buildSetup(): Promise<AgentSetup> {
    const presetId = this.options.agentPreset
    if (presetId === undefined) return () => {}
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      throw new Error('wecom channel: agentPreset requires the agent-presets service (mount @deepseek-ai/dsh-agent-presets)')
    }
    const resolved = (await presets.resolve(presetId)).id
    return async (agentCtx) => {
      await presets.mount(agentCtx, resolved)
    }
  }
}
