# Codex Guardian for DSH

独立替代 DSH 官方 Auto review 的插件。使用 Guardian 策略，在工具执行前审查操作；支持 Codex 订阅模型和 DSH 已配置模型，并提供插件控制页。

当前插件版本 **0.3.0**，目标宿主 **DSH 桌面端 0.2.0-rc.2**。

- [安装、模型选择和控制页说明](dsh-plugin-codex-guardian/README.md)
- [控制页与模型路由验证](dsh-plugin-codex-guardian/notes/CONTROL-VERIFICATION.md)
- [Auto 执行链和生命周期验证](dsh-plugin-codex-guardian/notes/REPLACEMENT-VERIFICATION.md)

## 本地验证

```powershell
cd dsh-plugin-codex-guardian
npm test
npm run test:legacy
```

上述命令执行离线测试。模型连接测试和桌面测试方法见插件说明。

## 仓库范围

版本管理包含插件源码、策略快照、测试、准备脚本和验证文档。本地 DSH 配置、登录凭据、会话、缓存、临时运行时、打包产物和个人交接简报不进入仓库。

认证来自本机已有登录，仓库不包含 token。Codex 直连订阅后端的第三方可用性和免费计费未确认；审查异常会转人工审批。
