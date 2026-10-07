# dsh-plugin-codex-guardian

独立替代 DSH 官方 Auto review 的插件。停用 `@deepseek-ai/dsh-experimental-auto-review` 后，由本插件注册桌面端的 Auto 权限入口，在工具执行前使用 Codex Guardian 策略审查。默认模型为 `codex-auto-review`，也可以选择 Codex 订阅模型或 DSH 已配置模型。

版本 **0.3.1**；目标宿主为桌面端 **0.2.0-rc.2**。审查传输使用 Node 内置模块，控制页复用宿主的协议服务、React 和连接；不修改官方插件、订阅插件或模型注册表。

## 快速测试

本工作区已经准备好隔离的桌面测试配置。完全退出 DSH（包括托盘进程），运行：

```powershell
powershell -ExecutionPolicy Bypass -File F:/codexprojects/codex_like_review/.dsh-guardian-desktop/launch-desktop.ps1
```

它把 DSH_HOME 指向工作区内的 `.dsh-guardian-desktop`。该配置未启用官方 Auto 插件。启动后，在权限菜单选择 Auto；主模型仍由 DSH 的账号/模型设置决定，审查模型在本插件控制页选择。隔离 home 不复制主会话模型的登录信息，需要时在测试配置中登录主模型。

其他目录可通过下面的命令准备一个全新的测试 home；脚本拒绝覆盖已有 profile，也拒绝写入正式 `~/.dsh`：

```powershell
node scripts/prepare-desktop.mjs F:/your-workspace/guardian-test-home
```

脚本使用绝对路径加载 `src/index.js`，不需要 pnpm 或符号链接。桌面 profile 由 Electron 管理，不要用系统旧版 CLI 的 `dsh --profile desktop` 启动或安装。

## 插件控制页

已接入本地源码的配置升级到 0.3.1 后，退出并重启 DSH 即可加载控制页。插件作为 profile 的已安装第三方 bundle 出现在插件页的“已安装”区域；打开 **Codex Guardian** 详情页即可进入控制页。

1. 选择 **Codex 订阅模型** 或 **DSH 已配置模型**。DSH 来源需要选择供应商；模型列表读取宿主已注册模型，Codex 列表优先读取本机目录缓存，可点击刷新。两种来源都允许手动填写模型 ID。
2. 推理强度默认使用模型默认值。模型不支持所选强度时会回退人工，建议先使用默认并测试。
3. 点击 **保存配置**；更改从下一次审查生效，已开始的请求保留原配置。多窗口同时编辑会检查版本，旧草稿不会覆盖新配置。
4. 点击 **测试已保存模型**。它发送合成的 `git status` 审查请求，不执行命令。允许或拒绝都表示拿到了合法判定；这个按钮验证连接与输出格式，不评估模型准确率。每次测试占用一次预算，5 秒内不允许重复测试。

页面支持暂停审查、请求/总超时、重试次数、每小时预算、额度检查、拒绝阈值、恢复默认草稿和放弃修改。暂停时 Auto 继续存在，实际工具调用转人工审批；卸载插件会恢复工作区权限。

配置保存在 `$DSH_HOME/guardian/settings.json`，已保存的可编辑值覆盖 loader 的对应配置；使用原子写入并在重启后恢复。恢复默认值仅填写草稿，需要保存才生效。订阅凭据、策略路径、代理和认证配置不通过控制页编辑。

最近 200 条审查元数据保存在 `$DSH_HOME/guardian/reviews.json`，页面显示最近 20 条。记录工具名、决策、模型、耗时和 token 数，不保存参数、原始回复、授权消息或凭据。预算按插件实例统计，重启实例后重新计数。连接测试不记入实际工具审查历史。

## 替换方式

在 DSH 的插件设置中停用官方 `@deepseek-ai/dsh-experimental-auto-review`，将本包作为 profile dependency 和 bundle 安装/启用。包内的 `dsh.bundle.patch` 插入 `codex-guardian` 行，注册 Auto；客户端控制页挂载到 `plugins.bundle.config`，这样 DSH 会按已安装第三方 bundle 分类。官方与本插件不能同时拥有 Auto；重复注册会明确报错。

本地源码接入时，先把 `dsh-plugin-codex-guardian` 写入 profile 的 `dependencies` 和 `dsh.profile.bundles`，再在 profile patch 中用 `id: codex-guardian` 修改配置。bundle 已负责插入工具审查入口，不要再次插入同一行。控制页通过 `plugins.bundle.config` 关联该包；`plugins.item` 则固定进入宿主的“官方”区域。`desktop-replace.patch.yml` 提供官方 Auto 禁用与 bundle 配置覆盖示例。

正式桌面配置尚未自动切换。本次宿主测试与新状态都位于工作区中。

## 审查行为

- 普通工具与 `run_code` 内层工具逐次审查。外层 PTC 传输使用 DSH 自身的能力约束，避免内外重复审查。
- Guardian allow：继续经过其他宿主策略，然后执行。其他插件的 deny/ask/cancel 始终有效。
- Guardian deny：不执行，返回理由与禁止换工具绕过的指令。
- 网络、凭据、超时、上下文不足、额度或响应异常：请求人工审批。没有人工通道时，由 DSH 拒绝执行。
- 取消：废弃迟到的允许结果。卸载：中止 Auto 代理和待审请求，恢复 workspace-write，移除 Auto 入口。
- 工具过滤不形成免审白名单：被过滤的工具转人工确认。
- 宿主策略 hook 本身抛错时阻止执行，要求修复集成；人工回退不会跳过未完成的宿主策略检查。

DSH Auto 使用完整主机访问并逐次审查；Codex 原生 Auto-review 通常保留沙箱并审查越界操作。本插件保留 DSH 的 Auto 入口和执行方式，使用 Codex 的策略与审查模型，不复制 Codex 整个运行框架。

## 策略、授权与网络

策略使用 `data/guardian-policy.json` 中保存的 OpenAI 原文：`auto_review.policy_template` 填入 `auto_review.policy`，再追加 JSON 输出约定。该文件是策略快照，不会自动更新。

输入包含真实工具 schema、完整参数、工作目录和按来源标记的可见上下文。宿主标记的人类消息、正确归属的直接父代理指令可以建立授权；项目指令约束范围，工具结果、插件文本、助手说明和压缩摘要不能扩大授权。超过参数/上下文上限时转人工，不截断待审动作后自动允许。

Codex 来源每次审查重新只读获取 access token：配置文件、DSH_HOME store、原始 DSH store、Codex auth.json。不会使用 refresh token、刷新凭据或写回 store。DSH 来源通过宿主 `llm` 服务使用供应商自身配置和认证。

Codex 请求为 `POST https://chatgpt.com/backend-api/codex/responses`，使用所选模型、`stream:true`、`store:false`。只有完整 SSE 完成事件且模型回显匹配时才接受判定。DSH 流必须正常完成，审查请求不提供执行工具。多个冲突判定、critical allow 或缺乏明确授权的 high allow 转人工。

**免费计费尚未确认。** 直连可用不等于第三方调用免费或接口长期稳定；测试配置启用了额度保护和调用预算。

## 配置

配置放在 `codex-guardian` loader 行的 `config` 中。配置替换整个 config，不做深合并。

| 参数 | 默认值 | 用途 |
|---|---|---|
| enabled | true | 是否挂载 Auto 集成 |
| reviewEnabled | true | 暂停后转人工，保留 Auto 入口 |
| reviewerSource | codex | codex / dsh |
| reviewModel / reviewProvider | codex-auto-review / 空 | 审查模型；DSH 来源必填供应商 |
| reasoningEffort | default | 使用模型默认或指定推理强度 |
| policyFile | 包内策略 | 策略文件 |
| credentialFile | 自动发现 | 只读凭据文件 |
| transport | auto | auto / tunnel / fetch |
| proxy | 127.0.0.1:7897 | CONNECT 代理 |
| timeoutMs / totalTimeoutMs | 20000 / 28000 | 单次 / 整个审查期限 |
| retries | 1 | 最多重试一次 |
| maxArgsChars / maxContextChars | 32000 / 100000 | 完整参数 / 授权上下文上限 |
| onlyTools / skipTools | [] / [] | 被过滤工具转人工 |
| maxReviewsPerHour | 120 | 每个插件实例的每小时审查预算 |
| usageGuard / usageStopPercent | false / 90 | 可选订阅额度检查；测试配置开启 |
| breakerConsecutiveDenials | 3 | 同一会话轮次连续拒绝阈值 |
| breakerWindow / breakerDenialsInWindow | 50 / 10 | 同轮次滚动拒绝阈值 |

Codex 来源启用 usageGuard 后，额度未知、查询失败或窗口达到阈值都转人工；DSH 来源由供应商管理额度。日志只记录动作指纹、工具名和判定标签，不记录参数、凭据或原始模型回复。

## 验证与文件

下面的测试命令在项目源码目录运行；安装包仅包含运行代码、配置、准备脚本和验证记录。

```powershell
npm test
npm run test:legacy
node test/live-review.mjs   # 真模型审批测试；不会执行待审命令
```

44 项自动测试及 20 项历史回归测试通过。0.3.0 控制页已在 rc2 原版桌面 profile 的浏览器界面验证，并实测 `deepseek-flash` 与自选 `gpt-6-luna` 两条审查来源；0.3.1 已改为已安装第三方 bundle 分类并完成正式 profile 的原子迁移。0.2.0 的普通工具、PTC、人工审批和真实 Guardian allow/deny 记录保留。

控制页证据和限制见 [notes/CONTROL-VERIFICATION.md](notes/CONTROL-VERIFICATION.md)；先前的执行链验证见 [notes/REPLACEMENT-VERIFICATION.md](notes/REPLACEMENT-VERIFICATION.md)。当前测试使用桌面原版运行时副本和浏览器界面；Electron 窗口内的人工批准按钮尚未点击验证。

| 文件 | 职责 |
|---|---|
| src/index.js | 独立 Auto 插件入口与配置 |
| src/auto-review.js | 执行闸口、取消、熔断、人工回退和卸载 |
| src/review-context.js | 普通/PTC 动作验证、上下文来源归属 |
| src/reviewer.js / transport.js | 固定 Guardian 路由、SSE 与代理 |
| src/host-reviewer.js / model-catalog.js | DSH 模型路由与可选模型目录 |
| src/control-state.js / control-service.js | 持久化配置、元数据记录和宿主认证 RPC |
| client.js | DSH 原生插件控制页 |
| src/prompt.js / data/guardian-policy.json | 策略原文与请求/判定格式 |
| scripts/prepare-desktop.mjs | 全新隔离桌面配置和启动器 |
| src/approvals.js | 保留的 0.1 审批 answerer，非 Auto 替代入口 |

旧 CLI 0.1.7-alpha.2 的 Auto 使用 never 策略，无法提供本替代版要求的人工回退，插件拒绝在这种宿主上注册。历史审批-only 入口仍可通过 `dsh-plugin-codex-guardian/approvals` 使用。
