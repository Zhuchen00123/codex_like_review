# codexlikereview 0.4.0 验证记录

2026-10-07。源码改动与测试在项目目录进行；按用户授权升级已安装的独立第三方插件。包名与设置位置保留，权限模式及控制页改名为 `codexlikereview`。

## 自动回归

`npm test`：64/64；`npm run test:legacy`：20/20；客户端语法检查通过。

新增覆盖：仅批准请求触发审查、普通动作不调用模型、其他宿主拒绝保持有效、人工回退、取消及卸载、旧 Auto 恢复迁移、当前会话目录与未来默认选项区分、high/medium 授权阈值、浏览器专项提示词、精确动作/工具定义/会话/目录/授权范围绑定、一次消费、过期、10 条上限、简短重试消息与新增限制区分、只读路径范围、目录链接逃逸、凭据保护、输出/调用次数限制，以及两种模型的调查工具循环。

## 原版宿主执行链

使用安装桌面 0.2.0-rc.2 的原版运行时副本，隔离 home `.dsh-codexlike-ui`。非 Electron 测试进程停用测试遥测；宿主 filesystem、ToolRuntime、approval 和 PTC 代码保持原版。测试代理显式挂载原版 filesystem 工具集；审查与人工答复使用可控制的测试替身。

`ui-bootstrap.cjs --boundary-check` 实际通过：

```text
ordinary tool ran inside mode without review
approval denial prevented body and returned policy feedback
native manual fallback and PTC inner approval passed
actual fs sandbox blocked outside write; only reviewed one-call escalation wrote the file
unload restored workspace-write; PASS
```

测试先确认工作目录外的新建文件被 sandbox 拒绝且不发生模型调用；再用 `sandbox_permissions: danger-full-access` 请求一次批准，只在允许后写入一个明确的测试文本文件，并清理该文件。会话沙箱仍为 workspace-write。

生产 `apply()` 挂载检查也确认 `codexlikereview` 的组合为 workspace-write/ask，卸载恢复工作区权限。调试阶段的运行时日志插桩已移除；正式程序源码未修改。

## 真实 Codex 模型

`test/live-codexlike.mjs` 直接调用真实 `codex-auto-review`，usageGuard 开启：

```text
allow: allowed-once; model=codex-auto-review; inspections=0
deny: rejected; model=codex-auto-review; inspections=0
investigate: allowed-once; model=codex-auto-review; inspections=2
PASS; no proposed command was executed
```

调查用例要求仅在目标是空普通目录时允许删除。模型进行了两次只读检查，确认目录为空后允许；测试程序没有待审命令执行入口，因此未发生删除。

DSH 模型的工具调用/结果续接通过协议回归；此轮未另行进行真实 DSH 供应商的调查循环计费调用。此前已实测的 DSH 文本判定链路记录保留。

## 实际控制页

通过隔离宿主的认证浏览器界面，进入“已安装 → codexlikereview”，确认 0.4.0、workspace-write 沙箱说明、调查开关及模型设置。界面测试使用 `--ui-qa` 的合成拒绝动作和测试模型，复用生产控制服务和原版 DSH 客户端。

实际点击拒绝动作、查看完整参数、点击“批准此动作重试一次”。后台确认：

```text
authenticated control-page approval was consumed by exactly one reviewed retry; PASS
```

批准仅改变精确重试授权；测试随后发起同一动作的新审批请求，验证模型收到批准标记，执行无副作用的常量返回工具，批准记录被消费。截图仅保存在本机产物中。

## 正式安装与界面

正式 profile 的 Guardian dependency 和目录链接已更新到 0.4.0，旧 0.3.1 目录保留，package.json 与 cordis.patch.yml 更新前已备份。已保存的 `codex-auto-review` 模型、revision 1 和预算/额度保护设置保留，其他 manifest 字段保持一致。

运行中的桌面端缓存旧模块，组件内重载未切换客户端；随后重启已核对的同一桌面进程家族。通过正式端口 19387 的认证浏览器页面确认：插件位于“已安装”，显示 codexlikereview 0.4.0，新控制页和只读调查开关正常。在已有会话的权限菜单确认 `Codexlikereview` 选项；宿主对常规模式名称自动进行首字母大写，内部模式 ID 和控制页仍为 `codexlikereview`。

本轮界面核对没有主动更改所打开会话的权限，也没有向正式会话发送测试消息；旧 Auto 恢复按迁移逻辑进入工作区沙箱。新会话草稿只展示未来默认选项；先进入已有会话，再选择该模式。正式菜单截图只包含权限选项，保存在本机产物中。

## 限制

该插件接管 DSH 已有批准请求，不为所有工具自行创造批准边界；沙箱及网络隔离由 DSH 提供。策略仍是固定快照，调查工具集比 Codex 的只读执行器更小。人工回退使用 DSH 的审批服务。Electron 原生窗口内的人工批准按钮尚未点击验证。第三方直连 Guardian 的免费计费与长期稳定性未确认。
