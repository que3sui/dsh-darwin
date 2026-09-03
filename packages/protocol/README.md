# @dsh-darwin/protocol

**中文** | [English](#english)

[dsh-darwin](https://github.com/que3sui/dsh-darwin) 双插件自进化架构的共享协议包：`dsh-darwin-sentinel`（信号源）与 `dsh-darwin-forge`（插件工厂）之间唯一的通信合同。

## 内容

- **Schema 四件套**（Zod）：`ProblemTicket`（问题工单）/ `CandidatePlugin`（候选，按 tier 分级 skill/config/template/code）/ `EvalReceipt`（评测回执）/ `LineageNode`（谱系）
- **指纹与相似度**：`fingerprintOf`（数字归一化的稳定指纹）、`jaccardSimilarity`（近重复拒绝，阈值 0.8 惯例）、`computeSeverity`（频次+浪费+新近度 → 0-100）
- **回归任务格式**：`RegressionTask` / `TaskSuite`，附**隐藏评分器隔离**工具 `redactForAgent`（评分标准 `expect` 物理上不进入 agent 上下文，防 reward hacking）与 `gradeTask` / `aggregateResults`
- **storageDomain 约定**：共享域名 `darwin` 与表名常量（tickets / candidates / evals / lineage / snapshots）

## 用法

```ts
import {
  ProblemTicket, PROTOCOL_VERSION,
  fingerprintOf, jaccardSimilarity,
  redactForAgent, gradeTask, aggregateResults,
  DARWIN_DOMAIN, DARWIN_TABLES,
} from '@dsh-darwin/protocol'
```

以 TS 源码形式分发（`exports` 直指 `src/index.ts`）——与 DSH 插件生态的 TS-first 分发惯例一致，bundler/vitest/DSH loader 直接可用。

## English

Shared protocol for the [dsh-darwin](https://github.com/que3sui/dsh-darwin) two-plugin self-evolution architecture: Zod schemas (ProblemTicket / CandidatePlugin / EvalReceipt / LineageNode), stable fingerprinting & Jaccard near-dup rejection, regression-task format with hidden-grader isolation (`redactForAgent` keeps `expect` out of agent context), and the shared `darwin` storageDomain conventions. Shipped as TS source, MIT.
