# dsh-darwin 🐦‍⬛

**中文** | [English](#english)

> 给 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 的**双插件自进化架构**：一个插件负责"发现问题"（`dsh-sentinel`），一个插件负责"制造修复"（`dsh-forge`），中间用一份可独立发布的协议（`@dsh-darwin/protocol`）传递**问题工单 → 候选 → 评测回执 → 谱系**。
>
> 与市面上"LLM 自由反思"式进化插件的本质区别：**变异之外必须有选择压**——评测门（隐藏评分器 + 回归套件 + 成本适应度）和确定性回滚。没有选择的进化只是随机生成。

## 架构

```
┌──────────────────────────────────────────────────────────────────┐
│                         DSH 运行时 (Cordis)                       │
│                                                                   │
│  ┌───────────────┐  ProblemTicket   ┌─────────────────────────┐  │
│  │ dsh-sentinel  │ ────────────────▶│ dsh-forge               │  │
│  │ 信号源（B 面） │  (storageDomain  │ 插件工厂（A 面）          │  │
│  │               │   共享域 darwin)  │                          │  │
│  │ · 重试环       │                  │ · 近重复拒绝              │  │
│  │ · 工具错误簇   │                  │ · 分级合成(config/skill)  │  │
│  │ · 高频中断     │                  │ · 评测门(P2: fork A/B)    │  │
│  │ · Token 浪费  │ ◀────────────────│ · 晋级 .dsh/skills(热载)  │  │
│  └───────────────┘  EvalReceipt/谱系  │ · 快照确定性回滚         │  │
│           ▲                          └─────────────────────────┘  │
│           │ sessionQuery · sessionProjections · tokenMeter         │
└──────────────────────────────────────────────────────────────────┘
```

三个包：

| 包 | 角色 | 状态 |
|---|---|---|
| `packages/protocol` | Zod schema 四件套 + 域名约定 + 回归任务格式（含隐藏评分器隔离 `redactForAgent`） | ✅ 可独立发布，目标：`dsh-evolution-protocol` 事实标准 |
| `packages/sentinel` | 信号源插件：`darwin_scan` / `darwin_report` 工具，机械化挖掘 → 工单 | ✅ P0 可用，可独立安装当"会话体检" |
| `packages/forge` | 插件工厂：`darwin_forge` / `darwin_promote` / `darwin_rollback` 工具 | ✅ P1（skill/config 级）；P2 试挂与 fork 评测门接口已预留 |

## 安全边界（默认保守）

- MVP 只启用**零代码执行**的两级合成：`config`（patch 行草稿，恒为 `disabled`）与 `skill`（纯 Markdown，官方分层注册表热重载）；
- `template` / `code`（Creator 模式 `cordis_define` 自由代码）**默认关闭**——官方明言 vm 沙箱"不是安全边界"；
- 晋级默认 `requireConfirm: true`，且每次晋级**必留快照**；回滚是确定性恢复（不用 LLM 重猜）；
- 回归任务的评分标准（`expect`）物理上不进入任何 agent 上下文（`redactForAgent`），hold-out canary 翻车一票否决。

## 快速开始

```bash
# 开发
pnpm install
pnpm typecheck   # 全包 TypeScript 严格模式
pnpm test        # 55 个单测（miner/distiller/gate/promote/rollback/protocol/lab）
pnpm lab         # 跑 5 组模拟实验并生成 LAB_REPORT.md（E1 挖掘查全查准 / E2 端到端飞轮 /
                 #   E3 评测门对抗 / E4 回归自动回滚 / E5 防膨胀稳定性）

# 安装到 DSH（在有 DSH 的机器上）
dsh plugin --profile <你的profile> add ./packages/sentinel
dsh plugin --profile <你的profile> add ./packages/forge
```

安装后在 DSH 会话里：

1. 让 agent 调 `darwin_scan` → 扫描最近会话，挖掘问题并落库；
2. 调 `darwin_report` → 按严重度输出会话体检报告；
3. 调 `darwin_forge` → 取最严重工单合成候选技能（近重复会被拒绝立项）；
4. 调 `darwin_promote { candidateId, confirm: true }` → 写入项目 `.dsh/skills/`（热重载生效，留快照）;
5. 不满意？`darwin_rollback { skillName, confirm: true }` → 确定性回滚。

## 路线图

- **P0（当前）**：sentinel 独立可用（挖掘 + 工单 + 报告）。
- **P1（当前）**：forge skill/config 级合成 + 人工确认晋级 + 快照回滚。
- **P2**：接 `ctx.dynamicCordisRunner` 试挂（接口已预留：`src/trial.ts`）+ `ctx.sessions.fork` 冠军/挑战者 A/B + `ctx.workflow` 跑回归任务集 + tokenMeter 成本适应度（评测门已实现：`src/gate.ts`，并已在 `packages/lab` 的模拟闭环中验证）。
- **P3**：code 级合成（默认关闭）、全自动闭环、跨工件统一谱系。

## 模拟实验验证（packages/lab）

mock DSH 运行时 + **真实插件代码** + 种子化概率 agent，验证闭环五环节（结果见 [LAB_REPORT.md](./LAB_REPORT.md)，`pnpm lab` 可复现）：

| 实验 | 验证内容 | 结果 |
|---|---|---|
| E1 | 挖掘查全/查准：植入缺陷全检出、干净会话零误报 | ✅ 9 工单，0 污染 |
| E2 | 端到端飞轮：48 会话 → 挖掘→合成→门→晋级→重放 | ✅ 成功率 47.9%→95.8%，token −37.9% |
| E3 | 评测门对抗：过拟合/变贵/真改进 | ✅ reject / reject / promote |
| E4 | 毒技能回归 → 确定性回滚恢复 | ✅ 100%→15.4% 检出，回滚后恢复 100% |
| E5 | 工单耗尽优雅停止、无重复签名技能 | ✅ |

## 上游兼容性声明

DeepSeek Harness 处于开发预览期，官方保证会有破坏性变更。本仓库：

- 所有对 DSH 服务的访问收敛在每个包的 `src/dsh-adapter.ts`（标注 `TODO(verify 0.1.x)`）；
- 对未验证的 API 形状采用**防御性探测 + 内存回退**，坏一个上游版本不会拖垮整个插件；
- 当前对齐目标：`0.1.1-rc.2` ~ `0.1.2-alpha.x`。

## English

Self-evolution for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) via **two plugins + one protocol**: `dsh-sentinel` (mechanically mines session logs — retry loops, tool-error clusters, interrupted turns, token waste — into structured ProblemTickets), `dsh-forge` (consumes tickets, synthesizes tiered candidates — config/skill first, zero code execution by default — promotes into project `.dsh/skills` with hot reload, snapshots for deterministic rollback), and `@dsh-darwin/protocol` (the shared Zod contract: ProblemTicket / CandidatePlugin / EvalReceipt / LineageNode, plus hidden-grader isolation for regression tasks).

Design stance: evolution requires **selection pressure**, not just mutation — the eval gate (`src/gate.ts`) enforces a pass-rate floor, champion regression, cost fitness, and hold-out canary veto; `redactForAgent` keeps graders out of agent context to prevent reward hacking.

```bash
pnpm install && pnpm typecheck && pnpm test
```

MIT. Verified against DSH `0.1.1-rc.2` – `0.1.2-alpha.x` (docs-level; runtime verification pending on a live install).
