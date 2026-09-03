# dsh-darwin-forge

DSH 自进化插件工厂（[dsh-darwin](https://github.com/que3sui/dsh-darwin) 双插件架构的 A 面）：
消费 dsh-darwin-sentinel 的问题工单 → 分级合成候选（config / skill；零代码执行）
→ 评测门 → `darwin_promote` 晋级为项目 `.dsh/skills/` 技能（官方热重载即时生效）
→ 每次晋级留快照，`darwin_rollback` 确定性恢复（不用 LLM 重猜）。

## 安装

```bash
dsh plugin --profile <name> add dsh-darwin-forge   # 需先装 dsh-darwin-sentinel
```

## 工具

- `darwin_forge` —— 取最严重开放工单合成候选（近重复拒绝立项）
- `darwin_promote` —— 晋级 skill 候选并留回滚快照（默认需人工 confirm）
- `darwin_rollback` —— 回滚到最近一次晋级前的状态

默认只启用零代码执行的两级合成（config/skill）；code 级需显式开启且逐案人工确认。
要求 Node ≥ 22，DSH ≥ 0.1.1-rc.2。MIT。
