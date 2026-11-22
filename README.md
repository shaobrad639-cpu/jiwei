# 积微 · JiWei

> 一个微信窗口装下所有琐碎：文章收藏、日程、待办、灵感想法、报销记账。发进来自动分好类，每天早上给你一份提要，周日压成一页周报。数据全在本机。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-blue.svg)](https://python.org/)

---

## 核心能力

| 你说 | 它做 |
|------|------|
| 转发公众号链接 | 抓正文、解析标题、去重，可选同步到 Obsidian |
| 「明天九点见客户」 | 带时间入库，第二天早上自动出现在提要里 |
| 发票 PDF +「报销」 | 识别商家和金额，关联项目，随时可数、可发回微信 |
| 「我怀疑样本量不足」 | 单独存入「想法」库，不混进待办 |
| 「我有几个待办报销」 | 直接数给你，不用翻面板 |
| 「补进去：这是打车费」 | 并进原来那条，不重开一条 |
| 「取消刚才的保存」 | 撤销最近一次写入 |
| `/发 发票` | 把电脑上的附件直接发回微信 |

---

## 怎么用

**1. 安装**
```bash
git clone https://github.com/shaobrad639-cpu/jiwei.git
cd jiwei
node install.mjs
```

**2. 重启 DeepSeek Harness**（必须，插件路由只在重启后挂载）

**3. 建四个定时任务**

把安装器打印的 `schedules-ready.md` 路径发给 agent：

| 任务 | 触发 |
|------|------|
| 微信兜底扫描 | 每天 13:00 |
| 早间提要 | 每天 08:00 |
| 晚间收口 | 每天 22:30 |
| 周报压实 | 周日 21:00 |

**4. 接入微信**

面板「碎片阅读」→ 接入微信 → 手机扫码

> 默认账本目录：`~/.dsh-journal/data/`（可用 `--data` 指定）。装完是空账本，无示例数据。详见 [INSTALL.md](INSTALL.md)。

---

## 关键特性

- **语义去重**：同一天同一段原文不重复入库；24 小时内换说法的同一事算重复；隔天再记算新条目。只看字面相似度 + 时间窗，不调模型。
- **模型挂了消息不丢**：自动分类失败时退回确定性规则分诊再存一次；`/发`、`/记` 等命令失败不降级。
- **Obsidian 同步**：公众号正文自动写进库里的 `YYYY-MM-DD_标题.md`，改标题/日期自动删旧文件，不留重复。
- **微信里直接聊天**：发消息自动分诊；`/聊天` 进入纯聊天模式；`/记` 显式存一条。

---

## 硬规则（机器绝不越界）

1. **绝不改写你的本子**
2. **只重写项目文件的托管区**（`<!-- journal:managed -->` … `<!-- /journal:managed -->`）
3. **证据必须带逐字引用**
4. **冲突永不自动合并**

---

## 目录结构

```
├── plugins/reading-inbox/   # 微信通道 + 阅读收件箱（17 个 agent 工具）
├── plugins/journal-panel/   # 面板：今天 / 待办 / 项目 / 本子 / 想法 / 活动
├── journal/                 # 核心逻辑：journal.py + 模块 + RULES.md
├── templates/               # 数据目录空骨架
├── schedules/               # 四个定时任务提示词模板
├── tests/                   # node --test 回归测试
├── scripts/                 # check.mjs、release.sh
├── install.mjs              # 安装器（幂等、覆盖前比对备份）
└── release-notes/           # 每版本手写说明
```

> `journal/` 是源码，安装器把 `.py` 复制进数据目录形成**运行副本**。改代码请改 `journal/` 下的源文件。

---

## 来源与致谢

基于 [DSH-Wechat-Journal](https://github.com/CRYPTOCHROME384/DSH-Wechat-Journal) 继续开发，原作者版权保留，同样以 MIT 协议发布。

---

## License

MIT © 2024-present
