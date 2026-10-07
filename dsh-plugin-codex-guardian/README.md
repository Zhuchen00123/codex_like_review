# codexlikereview

DSH 桌面端的独立第三方审批插件，版本 **0.4.0**，目标宿主 **0.2.0-rc.2**。权限模式和控制页名称为 `codexlikereview`；npm 包名 `dsh-plugin-codex-guardian`、loader ID `codex-guardian` 和已有设置目录保留，便于从 0.3.x 升级。

默认审查模型为 `codex-auto-review`，也支持自选 Codex 订阅模型或 DSH 已配置模型。插件复用 Codex 的审批策略快照和浏览器专项策略，不修改官方插件、订阅插件源码或模型注册表。

## 审批模式

在已有会话的权限菜单选择 **Codexlikereview**。模式 ID 为 `codexlikereview`，宿主会把菜单标签的首字母转为大写。该模式使用 `workspace-write + ask`：

- 沙箱内已获宿主允许的操作直接执行，不额外调用审批模型。
- 宿主产生批准请求时，例如一次沙箱越权或被标记为需要批准的工具调用，先交给审查模型。
- 允许仅作用于这一次请求，工具执行后不会把会话改成完整主机访问。
- 模型拒绝时不执行，并向主代理返回原因及禁止绕工具重试的指令。
- 网络、凭据、超时、上下文、预算或判定格式异常时转宿主人工审批；没有人工通道时不执行。
- 其他宿主的执行前拒绝、工具能力限制和人工 `never` 策略保持有效。

新模式是当前会话选项，不列入未来会话的默认权限选项。原有 Auto 选择在会话恢复时迁移为工作区沙箱；其他权限选择保持原状。卸载会取消待审请求，恢复普通工作区权限，并移除该模式。

DSH 的沙箱和网络限制仍由 DSH 实现。未产生批准请求的动作不会触发模型审查；敏感 MCP 或浏览器工具需要宿主自身的批准设置。本插件没有复刻 Codex 的全部执行框架。

## 只读调查

默认允许审查模型调用唯一的 `guardian_inspect` 工具，支持：

- 文件元数据、目录列表、有限文本读取；
- 工作区内的 Git 状态和远程地址信息。

范围仅限当前工作目录及待审参数中明确的路径。解析真实路径后再次检查范围，阻止目录链接逃逸和网络共享路径；拒绝凭据、私钥、环境变量文件、认证及浏览器私有存储内容读取。Git 查询关闭交互、可选写锁、fsmonitor 和 hooks，远程 URL 移除认证和查询信息。

每次审查最多 **3 轮、6 次调查**；文本读取最多 8192 字节，目录最多展示 40 项。工具结果带有不可信来源和截断标记，不能建立用户授权。调查超限、取消或异常不会自动放行。控制页可以关闭调查；关闭后模型只根据传入上下文判断。

Codex 和 DSH 模型使用同样的有限调查接口。不会调用主代理的工具执行器，也不会执行待审命令。

## 被拒绝动作的一次批准重试

在控制页展开 **拒绝动作 · 批准一次重试**：

1. 选择被拒绝的动作，查看会话、工作目录、原因和完整参数。
2. 点击 **批准此动作重试一次**。
3. 回到对应会话发送“重试”，让代理重试完全相同的动作。

点击批准本身不会执行动作。批准绑定会话、工作目录、工具、完整参数和原有授权上下文，只能消费一次；重试仍交给模型审查。单独的“重试”或“继续”等简短恢复消息不改变授权范围；其他新增指令会使原批准失效。参数、目录或会话变化后也不能复用。它不能跳过 critical 风险或策略的绝对拒绝。

每个会话保留最近 10 个拒绝动作，全局最多 100 个，10 分钟后失效；只存在内存，重启或卸载即清空。审查历史文件不保存这些参数。

## 模型与控制页

插件在“已安装”区域显示 **codexlikereview**，打开详情页配置：

1. 选择 **Codex 订阅模型** 或 **DSH 已配置模型**；DSH 来源需要供应商。两种来源都支持手动输入模型 ID。
2. 选择推理强度、是否启用审批及只读调查，设置超时、预算、额度保护和拒绝阈值。
3. 点击 **保存配置**，从下一次审查生效。运行中的请求保留配置快照；旧窗口草稿不能覆盖新配置。
4. **测试已保存模型**仅发送合成的 git status 审查请求，不执行命令。允许或拒绝均代表取得了合法判定；不代表准确率。测试占用一次预算，5 秒内禁止重复测试。

暂停后模式仍保留工作区沙箱，需要批准的动作转人工。恢复默认仅填写草稿，保存后才生效。

设置位于 `$DSH_HOME/guardian/settings.json`；最近 200 条决策元数据位于 `reviews.json`。历史记录包含工具、结果、模型、耗时、token 数和调查次数，不包含工具参数、会话正文、原始模型回复或凭据。界面显示最近 20 条；预算按插件实例统计。

## 安装与升级

停用官方 `@deepseek-ai/dsh-experimental-auto-review`，将本包作为 profile dependency 和 bundle 安装/启用。控制页挂载到 `plugins.bundle.config`，由宿主归入第三方“已安装”区域。

本地接入需要在 profile 的 `dependencies` 和 `dsh.profile.bundles` 中注册本包，并提供指向包目录的 node_modules 链接。bundle 已插入 `codex-guardian`，profile patch 只用 `id: codex-guardian` 覆盖配置，不要重复插入。参见 `desktop-replace.patch.yml`。

从 0.3.x 更新 dependency 的安装目录及对应链接后，重启 DSH。已保存模型和预算设置会保留，新增的调查开关默认开启。源码升级不会自动修改正式 profile；本机正式配置的迁移按用户授权另行完成。

准备全新隔离 home（在插件源码目录运行）：

```powershell
node scripts/prepare-desktop.mjs F:/your-workspace/codexlike-test-home
```

脚本拒绝覆盖已有 profile 或写入正式 `~/.dsh`，使用本地 dependency、bundle 和目录链接（Windows 使用 junction），无需 pnpm 安装。完全退出 DSH 后运行生成的 `launch-desktop.ps1`。不要使用旧系统 CLI 的 `dsh --profile desktop` 启动桌面配置。

## 策略与模型路由

提示词由包内 `data/guardian-policy.json` 的 `policy_template` 填入 `policy` 后组成，并追加 JSON 判定输出约定。浏览器、Computer Use 和 node_repl 相关动作额外加入 `node_repl_policy`；一次批准重试额外提供由控制服务验证的用户批准标记。策略是固定快照，不会自动下载更新；高级配置可用 `policyFile` 替换，重新加载后生效。

真实人类消息及来源正确的直接父代理指令建立授权；项目指令限制范围；工具结果、助手说明和压缩摘要不能扩大授权。待审参数与授权上下文超过限制时转人工；普通证据截断或省略会明确标记。

low/medium 的允许按策略执行；high 的允许需达到 medium 或 high 授权，并满足提示词的范围及专项规则；critical 不自动允许。冲突或无效判定转人工。同轮次连续拒绝 3 次，或最近 50 次中拒绝 10 次，中断本轮自动审批。

Codex 来源直接使用 `POST https://chatgpt.com/backend-api/codex/responses`，`stream:true`、`store:false`，要求完整完成事件和准确的模型回显。只读现有 access token，不使用 refresh token、刷新凭据或写回凭据库。DSH 来源通过宿主 `llm` 和供应商认证，要求流正常结束。两种来源仅向模型提供有限调查工具。

第三方直连 Guardian 的免费计费和长期稳定性尚未确认。模型费用与额度按账号/供应商规则计算；可启用 usageGuard 和每小时预算。

## 验证

```powershell
npm test
npm run test:legacy
node test/live-codexlike.mjs
```

自动回归覆盖旧兼容入口、新模式、一次批准重试、只读范围、链接逃逸、凭据保护和两种模型的工具循环。真实 Codex 模型测试包含允许、拒绝及两次只读调查后允许；所有待审命令均未执行。原版 DSH ToolRuntime、人工审批、PTC 与 filesystem 沙箱已验证。

记录见 [notes/CODEXLIKE-VERIFICATION.md](notes/CODEXLIKE-VERIFICATION.md)。先前版本的控制页与执行链证据保留在其他验证记录中。Electron 原生窗口内的人工批准按钮尚未点击验证。
