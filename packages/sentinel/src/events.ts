/**
 * 挖掘输入的归一化事件切面。
 * dsh-adapter 负责把真实 SessionEvent / sessionQuery 检索文档映射成它；
 * miner 只消费这个切面，与上游事件 schema 解耦。
 */
export type RawEventType =
  | 'tool/call'
  | 'tool/result'
  | 'llm/retry'
  | 'turn/end'
  | 'assistant/message'

export interface RawEvent {
  sessionId: string
  seq: number
  time: number
  type: RawEventType
  turn?: number
  step?: number
  /** tool/call / tool/result：工具名 */
  name?: string
  /** tool/result 错误码（如 'ETIMEDOUT'、'denied'） */
  errorCode?: string
  errorText?: string
  /** turn/end：是否被用户打断 */
  interrupted?: boolean
  turnEndReason?: string
  /** assistant/message：官方把 token 用量内嵌在该事件（无独立 usage 记录） */
  usage?: { inputTokens: number; outputTokens: number }
}

export interface SessionFrame {
  ref: { id: string; cwd?: string; createdAt?: number }
  events: RawEvent[]
}
