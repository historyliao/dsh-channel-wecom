# Install the WeCom channel

This guide installs `@ezreal_lyy/dsh-channel-wecom` into a running DeepSeek Harness and connects one WeCom API-mode robot over its long connection.

## Before you start

- A DeepSeek Harness installation that boots a **long-lived profile** (`web`, or a custom profile created from the `web` template). One-shot surfaces exit at the end of their task and cannot hold the connection.
- A WeCom API-mode robot with its **BotID** and **Secret**, from the WeCom admin console. The long-connection mode needs no public URL, no inbound route, and no message decryption.
- The profile's `$DSH_HOME` path, so you can edit the profile patch file.

## Step 1 — Install the package into a profile

Pick the profile that should serve the channel. The examples use `web`.

**From npm:**

```sh
dsh plugin --profile web add @ezreal_lyy/dsh-channel-wecom
```

**From a local checkout** (use this before the package is published, or to run your own build):

```sh
cd /path/to/dsh-channel-wecom
pnpm install
pnpm run build
dsh plugin --profile web add -w link:/path/to/dsh-channel-wecom
```

Two details matter here. `link:` installs the package without resolving its dependencies, which is what lets the host harness provide the `@deepseek-ai/*` peer packages at runtime. `-w` is required because the profile directory is its own pnpm workspace root; without it pnpm refuses with `ERR_PNPM_ADDING_TO_ROOT`.

The install prints a warning that the package declares no `dsh.bundle` and is installed as a plain dependency. That is expected: this package carries no configuration layer, so Step 3 adds its row by hand.

## Step 2 — Provide the credentials

The configuration names credential references rather than secret values. Set both, using the same names you will put in the row:

```sh
export WECOM_BOT_ID='<your BotID>'
export WECOM_BOT_SECRET='<your Secret>'
```

Harness resolves a reference from the inherited environment, then `$DSH_HOME/.credentials.yaml`, then the project `.env`, then `$DSH_HOME/.env`. A missing reference fails at load with `wecom channel: credential "<name>" is not set`.

## Step 3 — Add the channel row

Edit `$DSH_HOME/profiles/web/cordis.patch.yml` and insert:

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

`workspacePath` must be absolute and is the working directory of every Session this channel creates. `allowFrom` lists the WeCom userids allowed to talk to the robot; an empty list under the `allowlist` policy refuses to load, so a half-configured install fails at boot instead of silently ignoring messages.

Optional keys, with their defaults:

| Key | Default | Meaning |
|---|---|---|
| `permissionPreset` | `read-only` | Permission preset applied to a newly created Session |
| `agentPreset` | — | Agent preset mounted on every Agent this connector composes; requires the agent-presets service |
| `model` | deployment default | Explicit `provider`, `model`, and optional `maxTokens` |
| `heartbeatIntervalMs` | `30000` | Heartbeat interval |
| `maxReconnectAttempts` | `10` | Reconnection ceiling; `-1` retries without bound |
| `maxAuthFailureAttempts` | `5` | Consecutive authentication-failure ceiling; `-1` retries without bound |
| `maxReplyQueueSize` | `500` | Reply queue ceiling for one inbound request id |
| `streamIntervalMs` | `800` | Minimum interval between streamed reply updates |

To configure a different account, add another row with its own `id`, `accountId`, and credentials.

### Direct-message policies

`dmPolicy` decides who may talk to the robot. It applies to direct messages only; the message text of a rejected sender never reaches the model.

| Value | Behavior |
|---|---|
| `open` | Admit every sender. |
| `pairing` | Admit senders in `allowFrom` or already approved in the pairing document. An unknown sender gets one reply naming their own WeCom userid and a six-digit pairing code, and their message is dropped. |
| `allowlist` | Admit senders in `allowFrom` or already approved in the pairing document; drop everyone else. |
| `disabled` | Drop every direct message. |

Under `pairing`, approvals live in the pairing document rather than in configuration: the connector writes each request into `pairingStorePath` and logs a line naming the code and the file. To approve someone, add their userid to that document's `approved` array (or simply add it to `allowFrom`); they are admitted on their next message without a restart.

## Step 4 — Restart the profile

```sh
dsh web
```

The restart is required: a newly installed package is not observed by the patch-file watcher. Once the process is running, later edits to `cordis.patch.yml` do hot-reload — an edit to an unrelated row leaves the connection up, while an edit to this row restarts the plugin, which reconnects and resumes the same Sessions on the next inbound message.

## Step 5 — Verify

1. Boot logs contain `wecom channel: connected account "<accountId>" over the long connection`.
2. Send a direct message to the robot in WeCom. The reply streams into the same chat.
3. Send a second message. It continues the same Session, which is visible in the Web UI as an ordinary conversation.
4. Restart `dsh` and send another message. The Session resumes; the conversation's history is intact.

Inspect the composed tree without booting:

```sh
dsh --profile web --dump-config
```

## Disable or remove

Remove the `channel-wecom` row from `cordis.patch.yml` and restart to stop serving the channel while leaving the package installed. To uninstall the package as well:

```sh
dsh plugin --profile web remove @ezreal_lyy/dsh-channel-wecom
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ERR_PNPM_ADDING_TO_ROOT` | The package spec points outside the profile directory. Re-run the install with `-w`. |
| `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND: ... @workspace:^ ...` | You installed with `file:` instead of `link:`. The profile is a separate workspace and cannot resolve the host repository's `workspace:` specs. |
| Boot fails with `workspacePath must be absolute` | Set an absolute path in the row. |
| Boot fails with `dmPolicy "allowlist" requires at least one allowFrom entry` | Add the admitted WeCom userids, or switch to `dmPolicy: disabled`. |
| Boot fails with `credential "..." is not set` | Export the variable or add it to `$DSH_HOME/.credentials.yaml`. |
| No reply arrives, connection logs look healthy | The sender is not in `allowFrom`, the message is not a direct-message text or voice message, or the message was a duplicate frame. |
