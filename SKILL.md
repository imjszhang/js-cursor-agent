# js-cursor-agent

Cursor CLI (`agent acp`) ACP 运行时封装。管理长驻 Cursor agent 进程，提供会话池、权限自动审批、空闲回收。

## 运行时检测

运行 `node cli/cli.js doctor` 检查 Cursor CLI 是否可用及认证状态。

## 三种使用方式

### 1. 独立 CLI

```bash
node cli/cli.js prompt "解释这段代码" --cwd /path/to/project
node cli/cli.js sessions
node cli/cli.js doctor
```

### 2. MCP Server

在 MCP 配置中添加：

```json
{
  "mcpServers": {
    "js-cursor-agent": {
      "command": "node",
      "args": ["/path/to/js-cursor-agent/mcp-server/index.mjs"],
      "env": { "CURSOR_API_KEY": "your-key" }
    }
  }
}
```

提供的 MCP 工具：
- `cursor_session_new` — 创建新会话
- `cursor_session_list` — 列出活跃会话
- `cursor_session_close` — 关闭会话
- `cursor_prompt` — 发送 prompt 并获取完整响应
- `cursor_cancel` — 取消当前 turn
- `cursor_set_mode` — 切换模式
- `cursor_doctor` — 诊断状态

### 3. OpenClaw 插件

```bash
openclaw plugins install ./path/to/js-cursor-agent/openclaw-plugin
openclaw config set plugins.entries.js-cursor-agent.enabled true
openclaw config set acp.backend cursor
```

然后在聊天中使用：`/acp spawn cursor --mode persistent --thread auto`

## 配置

| 环境变量 | 说明 | 默认 |
|----------|------|------|
| `CURSOR_AGENT_PATH` | agent 命令路径 | `agent` |
| `CURSOR_API_KEY` | API Key | — |
| `CURSOR_AUTH_TOKEN` | Auth Token | — |
| `CURSOR_ENDPOINT` | API Endpoint | — |
| `CURSOR_DEFAULT_MODE` | 默认模式 | `agent` |
| `CURSOR_PERMISSION_MODE` | 权限策略 | `approve-all` |
| `CURSOR_IDLE_TTL_MINUTES` | 空闲回收（分钟） | `30` |
| `CURSOR_MAX_SESSIONS` | 最大并发 | `4` |

## 排错

1. **`Cannot reach Cursor CLI "agent"`** — 确认 Cursor CLI 已安装且 `agent` 在 PATH 中
2. **认证失败** — 先运行 `agent login`，或配置 `CURSOR_API_KEY`/`CURSOR_AUTH_TOKEN`
3. **权限拒绝** — 调整 `CURSOR_PERMISSION_MODE` 为 `approve-all`
4. **达到最大并发** — 增大 `CURSOR_MAX_SESSIONS` 或关闭空闲会话
