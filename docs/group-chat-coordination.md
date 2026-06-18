# 群聊多 Agent 协调

> 本文档详细描述 `GroupChatCoordinator` 的多 Agent 协作机制。
> 若只需了解整体架构，请返回 [README](../README.md#架构总览)。

## 核心概念

`GroupChatCoordinator` 管理多个 `createSingleChatGraph` 实例，每个角色独立执行完整的 7 节点流水线（详见 [Agent 调用链路](agent-call-chain.md)）。

## 调用流程

```
runSession()
  ├── 初始化: 为每个参与者惰性创建 agent 图实例
  ├── Turn 0: @mention 定向发言
  │  仅被 @ 的角色回答，其他角色收到 "保持沉默" 指令
  │  generatedCount++, turnCount++
  └── 后续轮次循环 (while generatedCount < maxMessages)
      ├── 退出条件检查
      │  turnCount >= maxRounds (默认 3) → break
      │  idleStreak >= idleStreakThreshold (默认 2) → break
      ├── 确定发言人 resolveNextSpeaker()
      │  优先使用 agent 指定的 nextSpeaker
      │  无指定 → firstUnspoken() (按参与顺序)
      ├── runAgentTurn(roleId, sharedHistory, ...)
      │  formatGroupContext() → 构建群聊提示词
      │  agent.invoke(state) → 执行完整 7 节点流水线
      │  返回 { messages, nextSpeaker }
      ├── generatedCount++, unspoken.delete(roleId)
      └── 轮次推进与 Idle 检测
```

## 分阶段提示策略

| 阶段 | 策略 |
|:---|:---|
| **前 2 轮** | 提示 agent 可以使用 `nextSpeaker` 指定下一位发言者 |
| **第 3 轮起** | 提示 "群聊已进入尾声，请完成本轮对话后主动停止发言" |

## 退出条件

| 条件 | 默认值 | 说明 |
|:---|:---|:---|
| `maxMessages` | 15 | 最大生成消息数 |
| `maxRounds` | 3 | 最大轮次（每轮至少一轮所有角色发言） |
| `idleStreakThreshold` | 2 | 连续 N 轮无人主动指定 nextSpeaker |
