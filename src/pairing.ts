/** Local JSON store of WeCom pairing requests and approvals. */

import { randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** One sender waiting for approval. */
export interface PairingRequest {
  /** Six-digit code the requester is shown. */
  readonly code: string
  /** Sender userid the request belongs to. */
  readonly senderId: string
  /** ISO timestamp of the first request. */
  readonly requestedAt: string
}

/** The persisted document. */
interface PairingFile {
  /** Approved sender userids, admitted without further configuration. */
  approved: string[]
  /** Senders awaiting approval. */
  pending: PairingRequest[]
}

/** Why a pairing document could not be used. */
function parsePairingFile(path: string): PairingFile {
  if (!existsSync(path)) return { approved: [], pending: [] }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`wecom channel: pairing store ${path} must hold a JSON object`)
  }
  const record = parsed as Record<string, unknown>
  const approved = record['approved']
  const pending = record['pending']
  if (!Array.isArray(approved) || approved.some(entry => typeof entry !== 'string')
    || !Array.isArray(pending) || pending.some(entry => entry === null || typeof entry !== 'object')) {
    throw new TypeError(`wecom channel: pairing store ${path} must hold { approved: string[], pending: object[] }`)
  }
  return { approved: approved as string[], pending: pending as PairingRequest[] }
}

/** Pairing state owned by one connector instance. */
export class PairingStore {
  private state: PairingFile

  /** @param path - JSON document path; created on first write. */
  constructor(private readonly path: string) {
    this.state = parsePairingFile(path)
  }

  /**
   * Whether a sender may talk to the robot.
   * @param senderId - WeCom sender userid.
   * @returns true when the sender was approved.
   */
  isApproved(senderId: string): boolean {
    return this.state.approved.includes(senderId)
  }

  /**
   * Record a pairing request, reusing the code an earlier request minted.
   * @param senderId - WeCom sender userid.
   * @returns the code to show the requester and whether it is new.
   */
  request(senderId: string): { code: string; created: boolean } {
    const existing = this.state.pending.find(entry => entry.senderId === senderId)
    if (existing !== undefined) return { code: existing.code, created: false }
    const request: PairingRequest = {
      code: randomInt(100_000, 1_000_000).toString(),
      senderId,
      requestedAt: new Date().toISOString(),
    }
    this.state.pending.push(request)
    this.persist()
    return { code: request.code, created: true }
  }

  /**
   * Approve one pending request by its code.
   * @param code - code shown to the requester.
   * @returns the approved userid, or undefined when no request carries that code.
   */
  approve(code: string): string | undefined {
    const index = this.state.pending.findIndex(entry => entry.code === code)
    if (index === -1) return undefined
    const [request] = this.state.pending.splice(index, 1)
    if (request === undefined) return undefined
    if (!this.state.approved.includes(request.senderId)) this.state.approved.push(request.senderId)
    this.persist()
    return request.senderId
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
