# js-cursor-agent

**Cursor CLI ACP 运行时封装** — 管理 Cursor `agent acp` 长驻进程，提供独立 CLI、MCP Server、OpenClaw 插件三种使用方式。

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 为什么用这个项目？

- **封装 Cursor Agent**：管理 Cursor CLI 的 `agent acp` 长驻进程，提供会话创建、prompt 交互、模式切换等能力。
- **多种用法**：可当 **OpenClaw 插件**（ACP Runtime 后端）、**独立 CLI**、**MCP Server**（供其他 IDE 调用）。
- **进程池管理**：自动复用、空闲回收、并发限制，适合非交互式自动化场景。
- **权限自动审批**：非交互式环境下自动处理 Cursor 的工具权限请求。

---

## 三种使用方式

| 方式 | 适用场景 | 入口 |
|------|----------|------|
| **独立 CLI** | 终端直接与 Cursor agent 交互 | `node cli/cli.js <命令>` |
| **MCP Server** | 在 Claude Desktop / 其他 IDE 里当 MCP 工具用 | 配置 MCP 后由 IDE 调用 |
| **OpenClaw 插件** | 在 OpenClaw 聊天中 `/acp spawn cursor` | `openclaw cursor <命令>` |

---

## 快速开始

### 环境要求

- **Node.js** >= 18
- **Cursor CLI** (`agent` 命令可用，需先 `agent login` 完成认证)

### 1. 安装依赖

```bash
git clone https://github.com/imjszhang/js-cursor-agent.git
cd js-cursor-agent
npm install
```

### 2. 配置环境

```bash
cp .env.example .env
```

编辑 `.env`，配置认证方式（二选一）：

- `CURSOR_API_KEY` — Cursor API Key
- `CURSOR_AUTH_TOKEN` — Cursor Auth Token
- 或不配置，依赖 `agent login` 预认证

### 3. 试几条命令

```bash
# 诊断 Cursor CLI 状态
node cli/cli.js doctor

# 交互式多轮对话
node cli/cli.js chat --mode plan --cwd /path/to/project

# 发送单次 prompt
node cli/cli.js prompt "Explain the auth module" --cwd /path/to/project

# 查看活跃会话
node cli/cli.js sessions
```

---

## 独立 CLI 命令

```bash
node cli/cli.js chat                # 交互式多轮对话 [--session] [--mode] [--cwd] [--model]
node cli/cli.js prompt <text>       # 发送单次 prompt [--session] [--mode] [--cwd] [--json] [--model]
node cli/cli.js sessions            # 列出活跃会话
node cli/cli.js session-new         # 创建新会话 [--cwd] [--mode]
node cli/cli.js cancel              # 取消当前 turn [--session]
node cli/cli.js close               # 关闭会话 [--session]
node cli/cli.js set-mode <mode>     # 切换模式 (agent/plan/ask) [--session]
node cli/cli.js doctor              # 诊断 Cursor CLI 状态
node cli/cli.js help                # 帮助信息
```

### chat 交互式对话

`chat` 命令启动 REPL，在同一会话中进行多轮对话，保持上下文连续：

```bash
node cli/cli.js chat --session my-task --mode plan --cwd /path/to/project
```

支持的 REPL 命令：
- `/mode <agent|plan|ask>` — 切换模式
- `/new` — 重置上下文，创建新会话
- `/info` — 显示当前会话信息
- `/quit` 或 `/exit` — 退出

---

## 在 Cursor / Claude Desktop 里用 MCP

在 MCP 配置中添加：

```json
{
  "mcpServers": {
    "js-cursor-agent": {
      "command": "node",
      "args": ["/path/to/js-cursor-agent/mcp-server/index.mjs"],
      "env": {
        "CURSOR_API_KEY": "your-key"
      }
    }
  }
}
```

---

## 作为 OpenClaw 插件

```bash
openclaw plugins install ./path/to/js-cursor-agent/openclaw-plugin
openclaw config set plugins.entries.js-cursor-agent.enabled true
openclaw config set acp.backend cursor
```

然后在聊天中使用：`/acp spawn cursor --mode persistent --thread auto`

---

## 配置说明

| 变量 | 说明 | 默认 |
|------|------|------|
| `CURSOR_AGENT_PATH` | Cursor CLI agent 命令路径 | `agent` |
| `CURSOR_API_KEY` | Cursor API Key | — |
| `CURSOR_AUTH_TOKEN` | Cursor Auth Token | — |
| `CURSOR_ENDPOINT` | Cursor API Endpoint | — |
| `CURSOR_MODEL` | 使用的模型（`agent --list-models` 查看可选） | `composer-1.5` |
| `CURSOR_DEFAULT_MODE` | 默认会话模式 | `agent` |
| `CURSOR_PERMISSION_MODE` | 权限审批策略 | `approve-all` |
| `CURSOR_IDLE_TTL_MINUTES` | 空闲进程回收时间（分钟） | `30` |
| `CURSOR_MAX_SESSIONS` | 最大并发进程数 | `4` |

---

## 项目结构

```
js-cursor-agent/
├── core/              # 核心层（零外部依赖，三种入口共享）
│   ├── acp-client.js  # 高层 ACP 操作封装
│   ├── process-manager.js  # Cursor agent 进程池
│   ├── jsonrpc.js     # JSON-RPC 2.0 传输层
│   ├── config.js      # 统一配置解析
│   ├── auth.js        # 认证管理
│   ├── permissions.js # 权限审批策略
│   └── cursor-extensions.js  # Cursor 扩展方法
├── cli/               # 独立 CLI
├── mcp-server/        # MCP Server（给其他 IDE 用）
├── openclaw-plugin/   # OpenClaw 插件（ACP Runtime 后端）
└── src/               # Web UI（状态面板）
```

---

## 许可证

MIT
