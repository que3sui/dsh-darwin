# dsh-darwin-sentinel

DSH 自进化信号源（[dsh-darwin](https://github.com/que3sui/dsh-darwin) 双插件架构的 B 面）：
机械挖掘 DeepSeek Harness 会话日志——重试环、工具错误簇、中断回合、Token 浪费——
提炼为结构化 ProblemTicket 落入官方 storageDomain 共享域，供 dsh-darwin-forge 消费。
可独立安装，当作"会话体检"工具使用。

## 安装

```bash
dsh plugin --profile <name> add dsh-darwin-sentinel
```

## 工具

- `darwin_scan` —— 扫描最近会话，挖掘问题并落库
- `darwin_report` —— 按严重度输出会话体检报告

要求 Node ≥ 22，DSH ≥ 0.1.1-rc.2。MIT。
