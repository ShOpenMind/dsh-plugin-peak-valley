# 波峰波谷：设计细节与验证清单

## 为什么是 agent/pre-step

DSH 客户端没有「提交输入」的拦截入口：`conversation.composer` 是 chain 槽，`ComposerChainProps` 只有 `sessionId / session / pendingInteraction`，没有 `onSubmit`；Client 事件也只有 `connection/reset`、`locale/change`、`slots/changed`、`theme/change`。所以拦截只能放在 Host 侧。

Host 侧可选的点：

- `agent/pre-step` waterfall：在模型请求前拿到本步要进入的消息，可以 `reject` 整步，也可以替换消息。这是唯一「不花 token 就能拦住并询问」的位置。
- `tools/pre-execute`：只能拦工具，不拦首轮请求。
- `llm/stream`：能偷换路由，但 `buildRequest` 已经先写了 `request/header`（记录 provider/model），偷换会让会话记录和成本账记错，否决。

`agent/pre-step` 有两个必须知道的语义：

1. 它在 `inbox.claim()` **之后**运行，而且本步的 `modelSelection` 在 waterfall **之前**就固定了。所以 pre-step 里改不了当前步的路由，只能 `agent.model.select()` 改**下一步**。
2. 返回 `{ kind: 'reject' }` 会关闭本回合且不产生 step。被 claim 的用户消息不会写成 `user/message`，也不会被重新投递——它直接从 transcript 消失。所以「暂不进行」和「路由本地」都得自己把消息重新送回去：前者用 `ctx.schedule.create`，后者用 `agent.followup(message)`。

## 三次路由的时序

「路由到本地模型」是唯一跨回合的操作：

1. 收到选择 local 后，记下 `previous = { provider, model, reasoningEffort? }`，按 `message.id` 存进 `pendingLocal`；
2. `agent.model.select(local)` 写入一条 durable `model/selection`，但只影响**下一个** request；
3. `agent.whenIdle()` 之后再 `agent.followup(message)`——此时本回合已 reject、driver 已 idle，followup 会唤醒新回合；
4. 新回合的 pre-step 看到同一个 `message.id` 在 `pendingLocal` 里，消费标记、直接 `next()`（不再提问）；
5. 这个本地回合跑完后 `agent.whenIdle()` 回调里 `agent.model.select(previous)`，把会话恢复原路由。

时序风险：不能在 reject 后立即 `setTimeout(0)` 就 followup。0ms 定时器可能赶在 Host 离开 `running` 之前触发，而 running 期间的 `followup` 只会把消息放进 next-turn 队列、**不唤醒**（`wakeDriver` 在 running 期间只对 maintenance/abort 生效），本地回合就不会起来。等 `whenIdle()` 是确定性的：reject 关闭的回合结束时 promise resolve，followup 再起新回合。

## 「暂不进行」的排队

`ctx.schedule.create({ title, prompt: text, timing: { kind: 'at', at: ISO }, target: { kind: 'session', sessionId } }, sessionId, signal)`。

- `at` 取 `max(nextOffPeak(now), now + 5000)`，格式是带毫秒的 UTC ISO（`LocalAtInput` 也可以，但 ISO 更不容易踩时区坑）。
- 定时消息的 `source.kind` 是 `schedule`，所以它到点重新进入 pre-step 时不会被再次拦截。
- 附件不重发：schedule 的 `prompt` 只有文本；无文本的消息直接继续当前回合，避免把消息吞掉。
- 投递只是 durable inbox ack，真正跑起来要目标 Session 的 driver 被唤醒（schedule 投递会唤醒）。

## 峰谷判定

`lib/peak.js` 与已装插件 dsh-provider-peak 的判定保持一致：

- 北京时间固定 UTC+8，无夏令时；
- 高峰窗口 `[[540,720],[840,1080]]`（零点后分钟），半开区间：09:00 属于高峰，12:00 不属于；
- 周末全天低谷；
- 2026 年国务院节假日表 7 段共 33 天，`HOLIDAY_COVERAGE = '2026'`；跨年后 `holidayTableCovers()` 会提示 false；
- `nextOffPeak` 从下一分钟起逐分钟扫，最多 8 天，足够跨过长假；返回第一个非高峰分钟。

价格事实（用于卡片文案，不参与计算）：工作日高峰价为低谷两倍；缓存命中的输入价比未命中便宜约 50 倍，所以「低谷重发」本身并不保证省钱——如果重发时上下文缓存已经失效，省下的 2 倍可能被 50 倍的缓存差抵消。这个取舍留给用户，不自动决定。

## 失败模式（全部 fail-open）

| 场景 | 行为 |
| --- | --- |
| 没有可作答的客户端（headless/API、子代理 origin） | `ask` 抛错 → 直接继续回合 |
| 卡片 10 分钟无人作答（`askTimeoutMs`） | 按「继续进行」放行，卡片成为过期瀑布；之后再点无效 |
| `userQuestions`/`schedule` 服务缺失 | `inject` 不满足，整条插件不加载 |
| 排队失败（schedule 抛错） | 继续当前回合，不吞消息 |
| `agent.model.select` 抛错（未知 provider 等） | 不记录待重驱标记、不 followup，继续当前回合 |
| 回答被跳过/自定义/结构不认识 | 视为「继续进行」 |
| 消息无文本 | 不排队，继续当前回合 |
| 非高峰 / 非配置 provider / step > 1 / 非人类消息 | 直接 `next()` |

## 验证清单

1. `node --test "test/*.test.mjs"` 全绿（30 个用例）。
2. 安装后 `plugin_manager` 列出 `peak-valley` 行、无 warnings。
3. 高峰时段在 Web GUI 发一条消息：输入区出现三选项卡片，标题「高峰时段」。
4. 选「继续进行」：本回合照常执行，无重复消息。
5. 选「暂不进行」：本回合关闭、消息从 transcript 消失；到低谷时刻出现一条定时消息并开始执行。
6. 选「路由到本地模型」：本回合关闭；本地回合启动（本地服务需在 1919 端口）；该回合结束后下一个回合恢复 DeepSeek 路由（看下次请求的 provider）。
7. 低谷时段发消息：不弹卡片。
8. 定时任务在低谷投递时不弹卡片（source 为 schedule）。
9. 取消回合（Esc）时卡片消失，不残留 pending。

## 后续（未实现）

- 「本会话今天不再询问」/「永久记住选择」；
- 成本账：订阅 `llm/stream` 的 `usage` chunk，按峰谷价累计「今夜省了 ¥x」；
- 夜间批跑：把队列里的多条消息合并到一个常驻会话连续跑，复用缓存；
- 本地分诊：低谷前的轻量判断（本地 9B/35B 做摘要/去重/值不值得跑），目前只做整条路由。
