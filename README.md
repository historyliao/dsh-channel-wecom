# @ezreal_lyy/dsh-channel-wecom

WeCom (企业微信) robot channel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). One long connection dials outward to the WeCom gateway, admits direct-message text into the conversation's own root Session, and streams the Agent's answer back into the same chat. The connection is outbound, so no public URL, inbound route, or message decryption is needed.

The transport follows WeCom's API-mode long-connection mode: `wss://` dial, `aibot_subscribe` with the robot BotID and Secret, a roughly thirty-second heartbeat, and streamed replies that end with `finish`.

## Install

Publish the package and mount it into a long-lived profile:

```sh
dsh plugin --profile web add @ezreal_lyy/dsh-channel-wecom
```

Then insert the row into `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: channel-wecom
      name: '@ezreal_lyy/dsh-channel-wecom'
      config:
        accountId: wecom-default
        botIdRef: WECOM_BOT_ID
        secretRef: WECOM_BOT_SECRET
        workspacePath: /absolute/path/to/workspace
        dmPolicy: allowlist
        allowFrom:
          - <allowed wecom userid>
```

Set `WECOM_BOT_ID` and `WECOM_BOT_SECRET` in the environment, `$DSH_HOME/.credentials.yaml`, or a project `.env`, then restart `dsh`. The row refuses to load while the allowlist is empty, so a half-configured install fails at boot instead of silently ignoring messages.

## Configuration

| Key | Meaning |
|---|---|
| `accountId` | Stable identity of one robot, carried into provenance and logs |
| `botIdRef` / `secretRef` | Credential references holding the robot BotID and Secret |
| `workspacePath` | Absolute working directory for this channel's Sessions |
| `agentPreset` | Agent preset mounted on every Agent this connector composes |
| `permissionPreset` | Permission preset applied to a newly created Session; defaults to `read-only` |
| `model` | Optional explicit `provider`, `model`, and `maxTokens` |
| `dmPolicy` / `allowFrom` | `allowlist` or `disabled`, plus the admitted sender userids |
| `heartbeatIntervalMs`, `maxReconnectAttempts`, `maxAuthFailureAttempts`, `maxReplyQueueSize` | Transport dials forwarded to the SDK |
| `streamIntervalMs` | Minimum interval between streamed reply updates |

## Build

`devDependencies` link to a local DeepSeek Harness checkout because the `@deepseek-ai/*` packages are not published at a matching version line. Point them at your own checkout, then:

```sh
pnpm install
pnpm run build
```

## Known limitations

- Direct messages only: group chat, images, files, video, mixed content, and template-card events are not admitted.
- No approval relay: tool approvals have no WeCom answerer, so `read-only` is the shipped default.
- Messages can be lost while the connection is down; the connector adds no queue.
- A restart cancels work in flight.
- One live Agent per conversation; memory grows with the number of distinct conversations.
