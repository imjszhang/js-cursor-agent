# Cursor Agent (OpenClaw Plugin)

通过 OpenClaw 驱动 Cursor CLI agent，实现 ACP 运行时后端。

## 快速使用

在 OpenClaw 聊天中：

```
/acp spawn cursor --mode persistent --thread auto
```

## 可用命令

| 命令 | 说明 |
|------|------|
| `/acp spawn cursor` | 启动 Cursor agent 会话 |
| `openclaw cursor doctor` | 诊断 Cursor CLI 状态 |
| `openclaw cursor sessions` | 查看活跃会话 |

## 插件配置

在 `openclaw.json` 中：

```json
{
  "plugins": {
    "entries": {
      "js-cursor-agent": {
        "enabled": true,
        "config": {
          "apiKey": "your-cursor-api-key",
          "permissionMode": "approve-all",
          "defaultMode": "agent",
          "maxConcurrentSessions": 4,
          "idleTtlMinutes": 30
        }
      }
    }
  }
}
```

## 工作原理

1. OpenClaw 发送 `/acp spawn cursor` 时，插件创建一个长驻 `agent acp` 子进程
2. 通过 JSON-RPC 2.0 (NDJSON over stdio) 与 Cursor agent 通信
3. 权限请求根据 `permissionMode` 自动审批
4. 进程空闲超过 `idleTtlMinutes` 自动回收
5. 同一会话的多次 prompt 复用同一进程

## 排错

- 运行 `openclaw cursor doctor` 检查 Cursor CLI 可用性
- 确保 `agent` 命令在 PATH 中，或通过 `command` 配置项指定完整路径
- 查看 OpenClaw 日志中 `[cursor-runtime]` 前缀的消息
