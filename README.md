# codex-awake

`codex-awake` 用于管理 CPA Codex 账号：刷新账号额度、从已保存的额度结果中挑选疑似休眠账号，并通过官方 `codex exec` 执行一次轻量探测来唤醒账号。

额度刷新与唤醒是两个独立步骤。唤醒不会重复调用额度接口，而是只使用上一次保存到 SQLite 的额度快照。

## 快速开始

```bash
npm install
cp codex-awake.config.example.json codex-awake.config.json
# 按实际环境修改 codex-awake.config.json 中的目录和 codexBin
npm run build
npm run doctor
```

示例配置默认面向 Linux 服务器，使用：

- CPA 认证目录：`/root/.cli-proxy-api`
- Codex 可执行文件：`/root/.local/bin/codex`
- SQLite 数据库：`data/codex-awake.sqlite`
- 额度刷新并发：2；每轮请求间隔：10 秒
- 探测最小间隔：2 分钟；同一账号探测冷却时间：24 小时

完整的默认演示配置见 [codex-awake.config.example.json](codex-awake.config.example.json)。`proxyUrl` 为空字符串时不设置代理；如需代理，请填写完整的代理地址。

## 日常使用

先刷新全部账号的额度：

```bash
npm run refresh-quotas
```

刷新完成后，再根据保存的最新额度快照挑选并唤醒账号：

```bash
npm run wake
```

查看当前状态：

```bash
npm run show
npm run show-quota-resets
```

`show` 展示账户与额度总览、当前待处理队列、最近唤醒结果和最新额度刷新失败；`show-quota-resets` 按最早重置时间列出账号的周期、剩余额度和重置时间。

## 命令说明

| 命令 | 作用 |
| --- | --- |
| `npm run doctor` | 检查认证目录、SQLite 数据库和 Codex CLI 是否可用。 |
| `npm run refresh-quotas` | 刷新启用账号的额度，并将结果保存到 SQLite。不会创建或执行唤醒任务。 |
| `npm run wake` | 读取最新保存的额度快照，生成候选队列并执行唤醒。不会再次刷新额度。 |
| `npm run show` | 用简洁表格查看运行状态；可通过 `npm run show -- --limit 20` 扩大明细行数。 |
| `npm run show-quota-resets` | 按额度重置时间查看账号。 |
| `npm run set-cpa-priorities` | 按 SQLite 中的额度重置时间设置 CPA 认证文件优先级；额度耗尽的账号会被禁用，可用时会重新启用。 |

所有 CLI 命令都可以加 `--config <路径>` 使用另一份配置，例如：

```bash
node dist/cli.js --config /root/codex-awake/config.json show
```

## 配置说明

配置文件为 `codex-awake.config.json`。以下字段通常需要按部署环境确认：

| 字段 | 说明 |
| --- | --- |
| `authDir` | CPA Codex 认证文件目录。 |
| `dbPath` | SQLite 数据库路径。 |
| `proxyUrl` | 可选 HTTP/HTTPS 代理地址；留空表示不显式设置代理。 |
| `codexBin` | `codex` 可执行文件路径。 |
| `quotaConcurrency` / `quotaDelayMs` | 额度接口的并发数与请求间隔。 |
| `probeMinIntervalMs` / `probeCooldownMs` | 全局探测间隔与同账号冷却时间。 |
| `probeModel` / `probePrompt` | 唤醒探测使用的模型和提示词。 |

## 安全与行为

- 认证 token 只从 CPA 认证文件读取，不会写入 SQLite 或日志。
- 探测在临时、隔离的 `CODEX_HOME` 中运行，不会使用系统默认 Codex 登录状态。
- 探测任务全局串行，进程超时会被终止并记录为失败。
- 每次探测完成后会再次验证额度；若额度窗口仍保持满额，任务会被标记为无效，而非成功。
