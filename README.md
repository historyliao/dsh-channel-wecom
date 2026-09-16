# @ezreal_lyy/dsh-channel-wecom

WeCom (企业微信) robot channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). One long connection dials outward to the WeCom gateway, admits direct-message text into the conversation's own root Session, and streams the Agent's answer back into the same chat. The connection is outbound, so no public URL, inbound route, or message decryption is needed.

The transport follows WeCom's API-mode long-connection mode: `wss://` dial, `aibot_subscribe` with the robot BotID and Secret, a roughly thirty-second heartbeat, and streamed replies that end with `finish`.

## Install

Requires DeepSeek Harness `0.1.5-rc.2` (the `next` dist-tag), the SDK line this package is built against. Mount it into a long-lived profile — `web`, or a custom profile created from the `web` template:

```sh
dsh plugin --profile web add @ezreal_lyy/dsh-channel-wecom
```

If the default registry is a mirror that has not synced the release yet, add `--registry https://registry.npmjs.org/` to that command.

## Configure

The package carries no configuration layer, so its row goes into the profile's own patch file, `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: channel-wecom
      name: '@ezreal_lyy/dsh-channel-wecom'
      config:
        accountId: wecom-default
        botIdRef: WECOM_BOT_ID
        secretRef: WECOM_BOT_SECRET
        workspacePath: /absolute/path/to/workspace
        dmPolicy: pairing
        allowFrom: []
        pairingStorePath: /absolute/path/wecom-pairing.json
```

`workspacePath` must be an absolute, existing directory; it becomes the working directory of every Session this channel creates. The two credential references name secrets rather than holding them, so put the values in the environment, `$DSH_HOME/.credentials.yaml`, or a project `.env`:

```yaml
version: 1
refs:
  WECOM_BOT_ID: 'your BotID'
  WECOM_BOT_SECRET: 'your Secret'
```

Restart `dsh` after installing the package. Later edits to the patch file hot-reload.

## Pair

With `dmPolicy: pairing`, the first message from an unknown sender gets one reply naming that sender's own WeCom userid and a six-digit code, and the message itself is not admitted. Reply in the same chat with `approve <code>` and the connector records the approval; the next message reaches the model. Approvals live in `pairingStorePath`, and a requester can only approve their own code — so pairing identifies who connected rather than restricting who may connect. Use `dmPolicy: allowlist` with `allowFrom` when access must be gated on a list the operator controls.

## Verify

1. Boot logs contain `wecom channel: connected account "<accountId>" over the long connection`.
2. A direct-message text receives a streamed answer in the same chat.
3. A second message continues the same Session, visible in the Web UI as an ordinary conversation.
4. Restart `dsh` and send again: the Session resumes with its history intact.

Sessions use the deployment's model by default — the same selection the Web UI shows. Set `modelProvider` and `modelId` in the row to pin a different route for this channel.

Full step-by-step instructions, including the local-checkout install path and troubleshooting, are in [docs/install.md](docs/install.md).

## How it works

A conversation maps to a Session identity derived deterministically from the account and the conversation address, so binding needs no side table and survives restarts. The connector holds each Agent handle, so unloading the row disposes the Agents it created while their Sessions stay on disk. Answers stream from `agent/assistant-stream` and close from the committed `assistant/message`; a stream the gateway reports as expired (`846608`) falls back to one proactive message. Inbound frames are deduplicated by provider message id.

## Configuration

| Key | Meaning |
|---|---|
| `accountId` | Stable identity of one robot, carried into provenance and logs |
| `botIdRef` / `secretRef` | Credential references holding the robot BotID and Secret |
| `workspacePath` | Absolute working directory for this channel's Sessions |
| `agentPreset` | Agent preset mounted on every Agent this connector composes |
| `permissionPreset` | Permission preset applied to a newly created Session; defaults to `read-only` |
| `modelProvider` / `modelId` / `maxTokens` | Optional explicit model route; set the first two together |
| `dmPolicy` / `allowFrom` | `open`, `pairing`, `allowlist`, or `disabled`, plus the sender userids admitted without pairing |
| `pairingStorePath` | JSON document holding approved senders and pending requests; defaults to `.wecom-pairing.json` |
| `heartbeatIntervalMs`, `maxReconnectAttempts`, `maxAuthFailureAttempts`, `maxReplyQueueSize` | Transport dials forwarded to the SDK |
| `streamIntervalMs` | Minimum interval between streamed reply updates |

## Build

The DeepSeek Harness packages this plugin compiles against are published at the `0.1.5-rc.2` line, so a clean checkout builds on its own:

```sh
pnpm install
pnpm run build
```

## Known limitations

- Direct messages only: group chat, images, files, video, mixed content, and template-card events are not admitted.
- Replying `approve` to a pairing prompt admits that sender; anyone who can reach the robot can therefore pair themselves under `dmPolicy: pairing`.
- No approval relay: tool approvals have no WeCom answerer, so `read-only` is the shipped default.
- Messages can be lost while the connection is down; the connector adds no queue.
- A restart cancels work in flight.
- One live Agent per conversation; memory grows with the number of distinct conversations.
