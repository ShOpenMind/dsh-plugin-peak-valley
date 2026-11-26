# 波峰波谷 (dsh-plugin-peak-valley)

DeepSeek API 的高峰时段（工作日北京时间 09:00–12:00、14:00–18:00，法定节假日除外）提交消息时，在输入区弹出三选一：

1. **暂不进行，到最近的空闲时段进行** — 把这条消息存成一次性定时任务，到最近的低谷时段自动重新提交到同一会话，然后关闭本回合；
2. **路由到本地模型进行** — 只把这一回合切到配置的本地模型，回合结束后自动切回原模型；
3. **继续进行** — 按高峰价立即执行。

低谷时段完全不打扰，也不会拦截定时任务、子代理或系统注入的消息。

## 安装

```powershell
# 在 DSH 里用 plugin_manager 安装本地包目录
# action: install_bundle, target: C:\path\to\peak-valley
```

安装是 `link:` 目录，改完源码后生效方式取决于 Host 是否热重载；最稳妥是重启应用。

## 配置

默认值即可用。要改配置，在 profile 的补丁里给 `peak-valley` 行加 `config:`（或在包内 `cordis.patch.yml` 改完后重装）：

```yaml
- id: peak-valley
  name: dsh-plugin-peak-valley
  config:
    enabled: true
    providers: [deepseek-official, deepseek-account]   # 按高峰价计费的 provider
    local:
      provider: freetoken-local
      model: Qwen3.6-35B-A3B-NVFP4
    deferTitle: 波峰波谷：低谷重新提交
    askTimeoutMs: 600000
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时整条 gate 不注册 |
| `providers` | `[deepseek-official, deepseek-account]` | 只有当前模型路由的 provider 在此列表里才拦 |
| `local.provider` / `local.model` | `freetoken-local` / `Qwen3.6-35B-A3B-NVFP4` | 「路由到本地模型」用的路由；可加 `reasoningEffort` |
| `deferTitle` | `波峰波谷：低谷重新提交` | 定时任务标题前缀 |
| `askTimeoutMs` | `600000`（10 分钟） | 卡片最多等多久；超时按「继续进行」放行，`0` 表示无限等 |

峰谷规则写死在 `lib/peak.js`：2026 年国务院节假日表、周末全天低谷、窗口为半开区间 `[09:00, 12:00) [14:00, 18:00)`。规则年份见 `HOLIDAY_COVERAGE`，该年的表用完后 `holidayTableCovers()` 返回 false。

## 已知限制

- **只重发文本**：选「暂不进行」时，定时任务只能带上消息文本，图片/附件不会重发；无文本的消息会直接继续当前回合。
- **本地模型要先起服务**：选「路由到本地模型」只是把这一回合的路由切到 `local`，本地 provider（`http://127.0.0.1:1919/v1`）没启动时这一回合会失败。建议先验证本地服务再选。
- **卡片需要能作答的客户端**：Host 侧没有界面时（headless/API 会话、子代理）问不到答案，gate 会 fail-open 直接继续，不会卡住回合。
- **每条消息问一次**：同一回合的后续步骤（step > 1）不再询问。
- **无人作答 10 分钟后放行**：卡片一直没被点（例如你在别的会话）时，`askTimeoutMs` 到点按「继续进行」执行，避免回合永久挂起。
- 消息被「暂不进行」时本回合会被 reject，这条用户消息不会留在会话记录里；低谷重发后会以定时消息的形式出现。

## 结构

```
index.js          Host 插件入口：注册 agent/pre-step gate
lib/peak.js       峰谷判定、节假日表、最近低谷时刻（零依赖纯函数）
lib/gate.js       三选一问题、答案映射、消息文本提取（零依赖纯函数）
test/             node --test 单元测试
locale/           meta.title / meta.description
docs/DETAIL.md    设计细节与验证清单
```

## 测试

```powershell
node --test "test/*.test.mjs"
```
