/** 问题族 = 合成工作负载的任务类型，每族有唯一签名（错误码），供技能匹配与挖掘聚类 */
export interface TaskFamily {
  id: string
  /** 技能正文含此签名 → agent 视为"相关技能已挂载" */
  signature: string
  toolName: string
  baseSuccess: number
  skilledSuccess: number
  prompt: string
}

export const FAMILIES = {
  /** E2 主要负载族之一 */
  'bash-timeout': {
    id: 'bash-timeout',
    signature: 'ETIMEDOUT',
    toolName: 'bash',
    baseSuccess: 0.35,
    skilledSuccess: 0.9,
    prompt: '运行测试套件并修复失败用例',
  },
  'perm-denied': {
    id: 'perm-denied',
    signature: 'EACCES',
    toolName: 'bash',
    baseSuccess: 0.4,
    skilledSuccess: 0.9,
    prompt: '写入构建产物目录',
  },
  'dep-missing': {
    id: 'dep-missing',
    signature: 'ENOENT',
    toolName: 'bash',
    baseSuccess: 0.35,
    skilledSuccess: 0.88,
    prompt: '安装依赖并启动开发服务器',
  },
  /** 第 4 族仅作 E3 隐藏 canary 变体，不进入 E2 负载，也不会被 forge */
  'net-refused': {
    id: 'net-refused',
    signature: 'ECONNREFUSED',
    toolName: 'web-fetch',
    baseSuccess: 0.3,
    skilledSuccess: 0.85,
    prompt: '抓取接口文档页面',
  },
} as const satisfies Record<string, TaskFamily>

export type FamilyId = keyof typeof FAMILIES
export const LOAD_FAMILIES: TaskFamily[] = [
  FAMILIES['bash-timeout'],
  FAMILIES['perm-denied'],
  FAMILIES['dep-missing'],
]
