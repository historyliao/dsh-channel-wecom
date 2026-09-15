/** Provenance and inbound vocabulary for the WeCom robot channel. */

import type {} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Input admitted from one WeCom robot conversation. */
    wecom: {
      readonly kind: 'wecom'
      /** Configured account identity that received the message. */
      readonly accountId: string
      /** Conversation address the reply returns to. */
      readonly conversationId: string
      /** WeCom sender userid. */
      readonly senderId: string
      /** Provider message identity, kept for provenance after deduplication. */
      readonly messageId: string
    }
  }
}

/** One inbound WeCom message resolved into prompt text for one bound conversation. */
export interface WeComInbound {
  /** Conversation address the reply returns to. */
  readonly conversationId: string
  /** WeCom sender userid. */
  readonly senderId: string
  /** Provider message identity used for deduplication. */
  readonly messageId: string
  /** Prompt text after normalization. */
  readonly text: string
}
