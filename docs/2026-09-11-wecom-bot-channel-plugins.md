# Agent Note: WeCom bot channel as installable Cordis plugins

Status: proposed

English | [中文](2026-09-11-wecom-bot-channel-plugins.zh.md)

## Problem

DSH reaches people through the Web application, the SDK, and ACP. A team that works inside WeCom cannot start or continue an Agent conversation there.

The extension point that already turns external events into Agent work, `ctx.webhookRuntime`, deliberately does not fit. It creates a new root Session per verified delivery, never reads the reply, and owns no outbound channel ([Webhook subsystem](../../../../docs/subsystems/webhook.md)). A chat channel needs one stable Session per conversation plus a path that carries the answer back into the same chat.

WeCom's API-mode robot provides a long-connection mode ([help document 21661](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21661)). The operator's server dials `wss://` outward, authenticates with `aibot_subscribe` using the robot's BotID and Secret, keeps the link alive with a heartbeat of roughly thirty seconds, and pushes reply segments until it sets `finish`. The mode needs no public URL, no signature verification, and no message decryption, so an internal-network deployment can host it.

## Proposal

### Ship as plugins

The capability is one bundle plus its plugin rows, mounted into whichever long-lived profile an operator runs. It adds no application launcher, edits no core package, and takes no new `ctx` key: every registration is an effect that unwinds when its row unloads. The code lives under `packages/channel/wecom` and `packages/bundle/wecom`.

Only one channel exists, so `packages/channel/wecom` keeps transport, policy, routing, and delivery together. A `ctx.channels` capability seam earns its place when a second channel needs the same Service Definition, provider, and consumer roles; extracting it then is cheaper than guessing its interface now.

The webhook runtime and its GitHub adapter keep their published contracts unchanged. This proposal supersedes no active Agent Note, and landing it moves no archived note.

### Package layout

| Package | Role | Registers |
|---|---|---|
| `@deepseek-ai/dsh-channel-wecom` | Long connection, policy, Session binding, inbound normalization, streamed replies | the connector's effect tree |
| `@deepseek-ai/dsh-bundle-wecom` | Distribution layer carrying the rows and their validated defaults | `dsh.bundle` patch |
| `@deepseek-ai/dsh-tool-wecom-cli` | Deferred model-facing `wecom_cli` tool | `ctx.tools` |
| `@deepseek-ai/dsh-skill-wecom-cli` | Deferred wecom-cli instruction provider | `ctx.skills` |

### Transport

The connector wraps `@wecom/aibot-node-sdk` instead of implementing the wire protocol. The SDK already covers subscription, heartbeat with missed-acknowledgement tracking, bounded reconnection, auth-failure retry bounds, reply queueing, chunked media upload, and streamed replies, so the plugin owns configuration and lifecycle rather than framing.

The robot's BotID and Secret appear only as credential references, which `ctx.credentials` resolves per operation ([credentials group](../../../../packages/credentials/README.md)); a rotated value applies to the next message without a restart.

### Session binding

A conversation maps to one Session identity derived deterministically from the account and the conversation address, so binding needs no side table and survives a restart. On an inbound message the connector resolves a live Agent by that identity, resumes a persisted Session when none is live, and creates one otherwise; creation supplies the configured workspace as the Session cwd, mounts the agent preset through `setup`, and passes the optional model route to `agentOptions` ([Agent handle](../../../../packages/core/agent/README.md)).

The connector holds the returned handle, which is the only object that can tear its Agent down. Unloading the row therefore disposes the Agents it created while leaving their Sessions on disk for the next resume.

### Inbound

M1 admits text, voice transcription text, and quoted text. Each admitted message becomes one ordinary durable user-role followup carrying channel provenance. Group chat, images, files, video, mixed content, and template-card events stay out of M1.

Inbound frames are deduplicated by request id before any Agent work starts, so a repeated frame cannot create a second turn. A direct-message policy of allowlist or disabled is evaluated before any Session is created.

### Outbound

The connector subscribes to `agent/assistant-stream` for the Sessions it owns, forwards text deltas through `replyStream` on a throttle, and closes the stream from the committed `assistant/message` rather than from the transient frames. Stream frames are presentation data; the durable message is the reply of record.

A WeCom stream becomes unusable after roughly six minutes and reports `846608`. When that happens the connector delivers the remaining text once through a proactive message and never repeats text it already delivered. Media sending stays out of M1.

### Provenance and session format

The followup carries a message source naming the channel, account, conversation, sender, and provider message id. The connector adds that variant by declaration merging on `MessageSourceMap`, the merge-extensible union the LLM vocabulary publishes ([message source](../../../../packages/llm/llm/src/message.ts)).

No session event is added and the session format is unchanged. The released-format migration's closed source list describes what an already-published generation can contain, so a new producer variant does not belong in it ([migration source list](../../../../packages/session/session-format-v2-to-v3/src/payload.ts)).

### Configuration

| Field | Meaning |
|---|---|
| `accountId` | Stable identity of one robot, carried into provenance and logs |
| `botIdRef` | Credential reference holding the robot's BotID |
| `secretRef` | Credential reference holding the robot's Secret |
| `workspacePath` | Absolute working directory for this channel's Sessions |
| `agentPreset` | Agent preset mounted on created Agents |
| `permissionPreset` | Permission preset applied to created Sessions |
| `model` | Optional explicit provider and model route |
| `dmPolicy` | `allowlist` or `disabled` |
| `allowFrom` | Sender ids admitted by the allowlist policy |
| `heartbeatIntervalMs`, `maxReconnectAttempts`, `maxAuthFailureAttempts`, `replyQueueSize` | Transport dials forwarded to the SDK |
| `streamIntervalMs` | Minimum interval between streamed reply updates |

### Composition

The bundle patch inserts the connector row; deployment values arrive from the profile's own `cordis.patch.yml` or a `--patch` overlay ([plugin installation](../../../../docs/user/develop/basic/publish.md)). A profile created from the `web` template carries the browser surface and the channel side by side without a code change.

The row needs only services the [base bundle](../../../../packages/bundle/base/cordis.patch.yml) already provides, and requires neither the HTTP server nor the Workspace registry: the long connection dials outward, and the connector supplies each Session's working directory. A profile missing a required service fails while loading.

### Lifecycle and hot swap

Under `patchReload: live`, a valid edit to either patch file recomposes transactionally, and the Loader diffs each entry: unchanged rows keep running, while an edited row restarts its plugin fiber ([app boot](../../../../packages/boot/app-boot/README.md)). The connector therefore treats unload and re-apply as an ordinary path. Disposal disconnects the socket, stops the heartbeat, and releases the Agent handles it created; re-application reconnects and resumes the same Sessions on the next inbound message. A rejected edit leaves the last good tree running.

Installing a new bundle changes the profile manifest's bundle list, which the patch watcher does not observe, so that step needs a process restart.

### Control plane and data plane

The connector separates what governs the link from what carries a message. The control plane owns configuration, authentication, policy, and Session lifecycle; it turns only on boot, configuration change, link failure, and shutdown, and it never carries message text.

```text
Control plane: the link and its governance
Turns only on boot, configuration change, link failure, and shutdown.

  Configuration sources
      |
      | profile/cordis.patch.yml (bundle layers, then profile layer, then --patch)
      | dsh plugin --profile wecom add <bundle>
      v
  dsh launcher and Loader
      |
      | per-entry diff: unchanged rows stay mounted, changed rows restart their fiber
      | a rejected edit leaves the last good tree running
      v
  Connector plugin (effect tree)
      |
      | credentials  botIdRef / secretRef -> ctx.credentials, resolved per operation
      | policy       dmPolicy / allowFrom
      | routing      chatid -> deterministic SessionId
      | sessions     ctx.agents.get / resume / create
      v
  wss dial outward
      |
      | aibot_subscribe(bot_id, secret)
      | ping about every 30 s, pong counting, reconnect backoff
      v
  WeCom gateway (authenticated long connection)

  Unload and restart path: dispose -> drop socket, stop heartbeat, release Agent handles
                           (Sessions stay on disk for the next resume)
```

The data plane owns one message's payload from the inbound frame to the delivered reply, and every admitted message walks it once. It reads control-plane results and decides nothing on its own.

```text
Data plane: the payload path of one message
Every admitted user message walks this path once.

  WeCom user
      |
      | sends a message
      v
  WeCom gateway
      |
      | WS frame
      v
  Connector inbound
      |
      | (1) normalize: text, voice transcription, quoted text
      | (2) deduplicate by req_id, so a repeat is not a second turn
      | (3) read control-plane results: policy verdict, SessionId binding
      v
  handle.agent.followup(message + source: channel)
      |
      v
  +--------------------------------------+
  | Session log (durable, the authority) |
  | model-visible <=> reconstructable    |
  +------------------+-------------------+
                     |
                     | deriveMessages
                     v
  Agent loop
      |
      |-- model request ----------> LLM / model
      |      <-- streamed chunks
      |-- tool calls -------------> tools / subprocess
      |
      v
  agent/assistant-stream (start / chunk / end)
      |
      | throttled
      v
  replyStream(streamId, text, false)
      |
      +-----------------------------+
      |                             |
      v                             v
      committed assistant/message   846608: stream expired
      -> replyStream(finish=true)   -> one proactive send with the rest
      |                             |
      +--------------+--------------+
                     |
                     v
                     WeCom user (same conversation)
```

Four one-directional couplings connect the planes: the data plane reads the policy verdict and the Session binding; the control plane decides whether a Session is created, resumed, or reused; the control plane reads Session headers to decide a resume while the data plane appends message content; and a hot swap interrupts only the control plane, though its consequences land on the data plane.

### Delivery plan

| Stage | Scope | Done when |
|---|---|---|
| M1 | One account, long connection, direct-message text and transcribed voice, streamed replies, stable Sessions, allowlist | A WeCom direct message starts one Session, receives a streamed answer, and continues in that Session after a DSH restart |
| M2 | Group chat with sender attribution, inbound images and files, outbound media, template cards | Group members converse, and a file the Agent produces returns to the chat |
| M3 | The `wecom_cli` tool and its instruction skills | The model reaches WeCom business operations through the dedicated tool |
| M4 | Approval and question relay into the chat, multiple accounts, idle Agent release | A tool approval can be answered from WeCom |

## Alternatives considered

**Bridge the runtime from a separate process over the TypeScript SDK.** This keeps DSH untouched, but it is not a plugin, it cannot register approval or question answerers, and its notification stream carries durable Session events rather than the transient assistant frames a streamed reply depends on.

**Extend `ctx.webhookRuntime` with a reply path.** The runtime's published contract is fire-and-forget with one Session per delivery and no stored delivery or completion state ([fire-and-forget webhook Sessions](../../../../.agents/notes/implemented/feature/2026-08-22-fire-and-forget-webhook-sessions.md)). Conversation continuity and an outbound channel would add a second lifecycle to a package that deliberately owns none.

**Introduce a `ctx.channels` capability seam now.** One channel exists, so the Consumer role would have no second implementer and the interface would encode guesses about transports, policies, and delivery that the second channel may contradict.

**Implement the WebSocket protocol directly.** The official SDK already implements subscription, heartbeat, reconnection, and streamed replies; a hand-rolled client duplicates reviewed code and inherits the protocol's failure modes without its maintainers.

**Use HTTP webhook ingress instead.** Bot JSON callbacks and Agent-mode encrypted XML callbacks both require a public URL and an inbound HTTP route, and the Agent mode adds business-layer decryption. The long-connection mode removes all three requirements.

**Parse a media directive out of the assistant text.** Recognizing a marker inside model prose is not a tool contract. When sending media becomes a requirement it belongs on `ctx.tools`, where arguments are validated and the call is visible in the Session log.

## Acceptance criteria

- Loading the bundle into a long-lived profile mounts the connector, and `dsh --profile <name> --dump-config` shows the row with its resolved configuration.
- A direct-message text message creates exactly one ordinary root Session whose cwd is the configured workspace, and the answer returns to the same chat.
- A second message in the same conversation continues that Session identity, including after a DSH restart, which resumes the persisted Session.
- A duplicated inbound frame produces no second turn.
- A stream reporting `846608` ends with exactly one remaining-text delivery and no repeated text.
- The final reply equals the committed durable assistant message rather than the accumulated transient frames.
- Under a live-reload profile, editing an unrelated row leaves the connection up, while editing the connector's own row restarts it and the next message resumes the same Session.
- The change adds no session event and no session-format version bump, and keyless snapshot tests pin the admitted user message with its provenance.

## Risks

A message that arrives while the socket is reconnecting, or while the plugin is restarting, can be lost. WeCom does not promise redelivery, and the SDK owns only its own reconnection. A compensating queue would introduce durable delivery semantics that this proposal deliberately excludes.

Restarting the plugin cancels work in flight. A turn that is running when the row restarts does not resume.

M1 keeps one live Agent per conversation for the lifetime of the process, so memory grows with the number of distinct conversations until idle release is designed. The delivery plan defers that rather than shipping an ad-hoc sweep.

Streamed replies bind to the inbound frame, so an answer that outlives the reply window must fall back to a proactive message, which WeCom permits only for conversations that recently interacted with the robot.

Group chat is excluded because several members sharing one Session needs a sender-attribution and privacy decision that has not been made.

The connector depends on a Tencent-published SDK. The profile's pnpm project pins the reviewed version, and upgrading it is an ordinary dependency change with the plugin's tests as the check.
