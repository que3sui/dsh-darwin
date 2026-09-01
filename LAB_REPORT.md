# dsh-darwin 模拟实验报告（LAB）

> 运行环境：Node v24.14.0；全部实验固定种子可复现。
> 方法：mock DSH 运行时（会话日志/共享存储域/内存文件系统），`dsh-sentinel` 与 `dsh-forge` 的 `apply()` 原封不动挂载；评测门为真实的 `decideGate`；概率 agent 的技能效应按"签名匹配"简化建模。

**总判定：✅ 全部通过**

## E1 挖掘查全/查准

- 合成负载：30 个干净会话 + 植入缺陷 10 个（4 重试环 / 3 EACCES 错误簇 / 2 纯中断 / 1 Token 鲸鱼 12k）
- darwin_scan 产出工单 9 张：{"retry-loop":1,"tool-error-cluster":2,"interrupted-turn":3,"token-waste":3}
- 错误簇工单：工具错误簇：bash:ETIMEDOUT 累计失败 8 次 , 工具错误簇：bash:EACCES 累计失败 6 次
- 查准：所有工单 sourceSessions ⊆ 植入集 → true（污染的干净会话：0）
- 查全：重试环/两类错误簇/中断/鲸鱼全部检出 → true
- 扫描器输出：扫描完成：40 个会话，23 个信号
- **判定：通过**

## E2 端到端飞轮（挖掘→合成→评测→晋级→重放）

- 基线负载：48 会话（20/16/12 三族，无技能成功率 ≈35-40%），darwin_scan → darwin_forge ×3 → 评测门 → darwin_promote
- 三轮门决策：promote → promote → promote（冠军基线 = 晋级前的已挂载技能组合，首轮即无技能基线，可直接对比）
- 门理由（第 1 轮）：通过率 55% → 100%；平均 token 变化 -29% 在容忍内；hidden canary 全部通过
- 晋级技能签名：{ETIMEDOUT, EACCES, ENOENT}（期望恰为三族各一）→ true
- 重放同一 48 任务混合（配对同种子）：成功率 47.9% → 95.8%（+47.9pt），平均 token 1729 → 1074（-37.9%）
- **判定：通过**（要求：三签名各一、成功率 +≥25pt、token 下降）

## E3 评测门对抗（选择压）

- ① 过拟合候选（只帮可见族，hold-out canary 用 net-refused/ECONNREFUSED）：canary 翻车 1 项 → **reject**（理由：hidden canary 翻车 1 项：疑似迎合可见任务，拒绝晋级）
- ② 持平但 token +40%（构造样本）：→ **reject**（理由：平均 token 上涨 40% 超过容忍 20%，且通过率无提升）
- ③ 真改进候选（EACCES 技能，配对同种子 8+3 任务）：通过率 36.4% → 100.0% → **promote**
- **判定：通过**（要求：①② reject、③ promote）

## E4 回归→自动回滚

- 基线：famA 技能晋级后冠军通过率 100.0%（10+3 配对任务）
- 注入毒技能（含 ETIMEDOUT 签名 + POISON-GUIDE 标记）→ darwin_promote 确认写入：true
- 回归重放：通过率崩至 15.4%（冠军 --84.6pt）→ 检出回归：true
- darwin_rollback → 文件删除：true（输出：已回滚（removed-file）→ proj/.dsh/skills/darwin-evil-timeout/SKILL.md）
- 恢复重放：通过率 100.0%（冠军 ±15pt 内：true）
- **判定：通过**

## E5 防膨胀稳定性

- 小负载（12 会话）→ scan → 首轮晋级 ETIMEDOUT
- 随后连续 darwin_forge：新增候选 1 个，其中携带问题族签名（可能重复覆盖）的 0 个；工单耗尽优雅停止：true
- 已晋级技能集合不变：1 → 1
- **判定：通过**

## 边界声明

- 本报告验证的是**架构逻辑闭环**（挖掘→工单→合成→选择→遗传→淘汰各环节连通且方向正确），不验证真实 LLM 行为与真实 DSH 运行时兼容性；
- agent 的技能效应是"签名匹配即生效"的简化模型，真实技能质量取决于 LLM 合成水平（P1 模板技能是保守起点）；
- token 为模型化相对量，仅用于趋势比较，不代表真实计费；
- 指纹把聚类键中的数字压平（如会话编号）：同类缺陷的不同会话合并为一张工单（occurrences 累加），E1 的 retry-loop=1 张即 4 个植入会话归并的结果，属预期行为；
- E2/E4 的 harness 策略里保留了"无冠军基线 → needs_human 人工确认"分支（P1 语义），本组实验中冠军基线始终可测（无技能组合），该分支未被触发。