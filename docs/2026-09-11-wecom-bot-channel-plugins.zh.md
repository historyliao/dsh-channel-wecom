# Agent Note: 作为可安装 Cordis 插件的企业微信机器人通道

Status: proposed

[English](2026-09-11-wecom-bot-channel-plugins.md) | 中文

## 问题

DSH 目前通过 Web 应用、SDK 和 ACP 触达用户。一个在企业微信内工作的团队，无法在那里发起或继续 Agent 对话。

把外部事件转成 Agent 工作的既有扩展点 `ctx.webhookRuntime` 明确不适用：它对每一次已验证投递都新建一个 root Session，从不读取回复，也不持有任何出站通道（[Webhook 子系统](../../../../docs/subsystems/webhook.zh.md)）。聊天通道需要的恰好相反——每个会话一个稳定 Session，外加一条把答复送回同一聊天的路径。

企业微信的 API 模式机器人提供长连接模式（[帮助文档 21661](https://open.work.weixin.qq.com/help2/pc/cat?doc_id=21661)）。运维方的服务器主动向外拨号 `wss://`，用机器人的 BotID 与 Secret 发送 `aibot_subscribe` 完成认证，以约三十秒一次的心跳保活，并分段推送回复直到设置 `finish`。该模式不需要公网 URL、不需要签名校验、也不需要消息解密，因此可以部署在内网。

## 提案

### 以插件形式交付

这项能力是一个 bundle 及其若干插件行，装载到运维方运行的长生命周期 profile 中。它不新增应用启动器、不修改任何核心包、也不新增 `ctx` 键：每一项注册都是 effect，在该行卸载时回卷。代码位于 `packages/channel/wecom` 和 `packages/bundle/wecom`。

当前只存在一个通道，因此 `packages/channel/wecom` 把传输、策略、路由与投递放在一起。当第二个通道需要同一套 Service Definition、provider 与 consumer 角色时，`ctx.channels` 能力接缝才获得存在的理由；那时再抽取，比现在猜测它的接口更便宜。

既有的 webhook 运行时及其 GitHub 适配器保持已发布的契约不变。本提案不取代任何活跃 Agent Note，落地时也不会移动任何已归档记录。

### 包布局

| 包 | 职责 | 注册内容 |
|---|---|---|
| `@deepseek-ai/dsh-channel-wecom` | 长连接、策略、Session 绑定、入站归一化、流式回复 | 连接器自身的 effect 树 |
| `@deepseek-ai/dsh-bundle-wecom` | 承载各插件行及其校验后默认值的分发层 | `dsh.bundle` patch |
| `@deepseek-ai/dsh-tool-wecom-cli` | 后置：面向模型的 `wecom_cli` 工具 | `ctx.tools` |
| `@deepseek-ai/dsh-skill-wecom-cli` | 后置：wecom-cli 说明书 provider | `ctx.skills` |

### 传输

连接器包装 `@wecom/aibot-node-sdk`，而不自行实现线上协议。该 SDK 已覆盖订阅、带丢包确认计数的心跳、有界重连、认证失败重试上限、回复排队、分片媒体上传与流式回复，因此插件负责的是配置与生命周期，而不是报文分帧。

机器人的 BotID 与 Secret 只以凭证引用的形式出现，由 `ctx.credentials` 按次解析（[credentials 包组](../../../../packages/credentials/README.zh.md)）；轮换后的取值在下一条消息即生效，无需重启。

### 会话绑定

一个会话映射到由账号与会话地址确定性推导出的单一 Session 身份，因此绑定不需要旁路映射表，也能跨重启存活。收到入站消息时，连接器按该身份查找活跃 Agent，若无活跃者则恢复已持久化的 Session，否则新建：新建时把配置的工作目录作为 Session cwd，通过 `setup` 挂载 agent preset，并把可选的模型路由交给 `agentOptions`（[Agent 句柄](../../../../packages/core/agent/README.zh.md)）。

连接器持有返回的句柄，而句柄是唯一能拆除其 Agent 的对象。因此卸载该行会释放它创建的 Agent，同时把对应的 Session 留在磁盘上供下一次恢复。

### 入站

M1 只接受文本、语音转写文本和被引用的文本。每条被接受的消息都成为一条携带通道来源信息的普通持久化 user 角色 followup。群聊、图片、文件、视频、图文混排以及模板卡片事件都不在 M1 范围内。

入站帧在任何 Agent 工作开始之前按请求 id 去重，因此重复投递的同一帧不会产生第二个 turn。单聊策略（白名单或停用）在任何 Session 创建之前完成判定。

### 出站

连接器为自己拥有的 Session 订阅 `agent/assistant-stream`，按节流间隔把文本增量经 `replyStream` 转发出去，并以已提交的 `assistant/message` 关闭流，而不是以瞬时帧为依据。流式帧属于展示数据，持久化消息才是回复的事实来源。

企业微信的流式消息在约六分钟后失效并返回 `846608`。此时连接器用一次主动消息投递剩余文本，并且不重复已投递过的内容。媒体发送不在 M1 范围内。

### 来源与会话格式

followup 携带的消息来源会写明通道、账号、会话、发送者与提供方消息 id。连接器通过在 `MessageSourceMap` 上做声明合并来新增该变体，而该类型正是 LLM 词汇表公开的可合并扩展联合（[消息来源](../../../../packages/llm/llm/src/message.ts)）。

本方案不新增任何 session event，也不改动会话格式。已发布格式迁移中的封闭来源列表描述的是**已发布世代可能包含什么**，因此新的生产者变体不属于那里（[迁移来源列表](../../../../packages/session/session-format-v2-to-v3/src/payload.ts)）。

### 配置

| 字段 | 含义 |
|---|---|
| `accountId` | 单个机器人的稳定身份，进入来源信息与日志 |
| `botIdRef` | 存放机器人 BotID 的凭证引用 |
| `secretRef` | 存放机器人 Secret 的凭证引用 |
| `workspacePath` | 该通道各 Session 使用的绝对工作目录 |
| `agentPreset` | 新建 Agent 时挂载的 agent preset |
| `permissionPreset` | 新建 Session 时应用的权限 preset |
| `model` | 可选的显式 provider 与 model 路由 |
| `dmPolicy` | `allowlist` 或 `disabled` |
| `allowFrom` | 白名单策略下允许的发送者 id |
| `heartbeatIntervalMs`、`maxReconnectAttempts`、`maxAuthFailureAttempts`、`replyQueueSize` | 转发给 SDK 的传输参数 |
| `streamIntervalMs` | 流式回复更新的最小间隔 |

### 组合

bundle 的 patch 只插入连接器行；部署取值来自 profile 自身的 `cordis.patch.yml` 或 `--patch` 覆盖层（[插件安装](../../../../docs/user/develop/basic/publish.zh.md)）。从 `web` 模板创建的 profile 无需改动代码即可同时承载浏览器界面与该通道。

该行只需要[基础 bundle](../../../../packages/bundle/base/cordis.patch.yml) 已提供的服务，既不要求 HTTP 服务器，也不要求 Workspace 注册表：长连接主动向外拨号，工作目录由连接器自行提供。缺少必需服务的 profile 会在加载时报错。

### 生命周期与热插拔

在 `patchReload: live` 下，任一 patch 文件的有效编辑都会事务性重组，Loader 会对每个条目做差分：配置未变的行继续运行，被编辑的行则重启其插件 fiber（[应用引导](../../../../packages/boot/app-boot/README.zh.md)）。因此连接器把卸载与重新 apply 当作正常路径：卸载时断开 socket、停止心跳、释放它创建的 Agent 句柄；重新 apply 时重连，并在下一条入站消息处恢复同一批 Session。被拒绝的编辑会让应用继续运行上一份可用配置树。

通过 `dsh plugin` 安装新的 bundle 会改动 profile manifest 的 bundle 列表，而 patch 监听器不观察该文件，因此这一步需要重启进程。

### 控制面与数据面

连接器把“治理链路”与“承载消息”分开。控制面负责配置、认证、策略与会话生命周期；它只在启动、配置变更、链路异常与退出时流转，并且从不承载消息正文。

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

数据面负责一条消息从入站帧到送达答复的完整载荷，每条被接受的消息都完整走一遍。它读取控制面的结果，自身不做任何策略判断。

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

两面之间只有四条单向耦合：数据面读取策略判定与会话绑定结果；控制面决定会话是新建、恢复还是复用；控制面读取 Session header 以决定是否恢复，而数据面追加消息内容；热插拔只打断控制面，但其后果落在数据面上。

### 交付计划

| 阶段 | 范围 | 完成判据 |
|---|---|---|
| M1 | 单账号、长连接、单聊文本与语音转写、流式回复、稳定 Session、白名单 | 一条企业微信单聊消息建立一个 Session、收到流式答复，并在 DSH 重启后仍在该 Session 中继续 |
| M2 | 带发送者标注的群聊、图片与文件入站、媒体出站、模板卡片 | 群成员可对话，且 Agent 产出的文件能回到该聊天 |
| M3 | `wecom_cli` 工具及其说明书技能 | 模型通过专用工具触达企业微信业务能力 |
| M4 | 审批与提问转接到聊天、多账号、空闲 Agent 释放 | 工具审批可以在企业微信内作答 |

## 备选方案

**用独立进程经 TypeScript SDK 桥接运行时。** 这样做不用改 DSH，但它不是插件，无法注册审批或提问的应答者，而且它的通知流携带的是持久化 Session 事件，而不是流式回复所依赖的瞬时 assistant 帧。

**给 `ctx.webhookRuntime` 增加回复通道。** 该运行时已发布的契约是即发即忘、每次投递一个 Session，且不保存投递与完成状态（[即发即忘的 webhook Session](../../../../.agents/notes/implemented/feature/2026-08-22-fire-and-forget-webhook-sessions.zh.md)）。会话连续性与出站通道会给一个刻意不持有任何生命周期的包增加第二套生命周期。

**现在就引入 `ctx.channels` 能力接缝。** 当前只有一个通道，consumer 角色不会有第二个实现者，接口会固化关于传输、策略与投递的猜测，而第二个通道很可能推翻这些猜测。

**自行实现 WebSocket 协议。** 官方 SDK 已实现订阅、心跳、重连与流式回复；手写客户端会重复一份已被审阅的代码，且在没有其维护者的情况下继承协议的全部故障模式。

**改用 HTTP webhook 入口。** Bot 的 JSON 回调与 Agent 模式的加密 XML 回调都需要公网 URL 与入站 HTTP 路由，Agent 模式还额外需要业务层解密。长连接模式一次性去掉了这三项要求。

**从助手文本里解析媒体指令。** 在模型散文中识别标记不是工具契约。当发送媒体成为需求时，它属于 `ctx.tools`：在那里参数会被校验，调用也会在 Session 日志中可见。

## 验收标准

- 把该 bundle 装入长生命周期 profile 后连接器被挂载，且 `dsh --profile <name> --dump-config` 显示的该行带有解析后的配置。
- 一条单聊文本消息恰好建立一个普通 root Session，其 cwd 为配置的工作目录，答复回到同一聊天。
- 同一会话中的第二条消息延续同一 Session 身份，DSH 重启后也一样，重启通过恢复已持久化的 Session 完成。
- 重复投递的入站帧不会产生第二个 turn。
- 返回 `846608` 的流以恰好一次剩余文本投递结束，且没有重复内容。
- 最终回复等于已提交的持久化 assistant 消息，而不是累积的瞬时帧。
- 在支持热加载的 profile 下，编辑无关的行不会断开连接；编辑连接器自身的行会重启它，且下一条消息恢复同一 Session。
- 本次改动不新增 session event、不提升会话格式版本，并用无密钥快照测试固定被接受的 user 消息及其来源信息。

## 风险

socket 重连期间或插件重启期间到达的消息可能丢失。企业微信不承诺重投，SDK 也只负责自己的重连。补偿队列会引入本提案刻意排除的持久化投递语义。

重启插件会取消进行中的工作：该行重启时正在跑的 turn 不会恢复。

M1 在进程生命周期内为每个会话保留一个活跃 Agent，因此内存会随会话数量增长，直到空闲释放被设计出来。交付计划把它后置，而不是先交付一个临时清理逻辑。

流式回复绑定在入站帧上，因此超出回复窗口的答复必须降级为主动消息，而企业微信只允许对近期交互过的会话主动推送。

群聊被排除，因为多个成员共享一个 Session 需要发送者标注与隐私方面的决策，而该决策尚未作出。

连接器依赖腾讯发布的 SDK。profile 的 pnpm 项目锁定已审阅的版本，升级它属于普通依赖变更，检查依据是插件自身的测试。
