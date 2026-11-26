# 安装

## 前提

| 需要 | 说明 |
| --- | --- |
| DeepSeek Harness | 已安装并至少启动过一次（否则没有 profile 目录） |
| Node.js ≥ 18 | 安装器用；DSH 自带的 node 也行 |
| Python ≥ 3.10 | `journal.py` 用了 `dict \| None` 之类的新语法 |
| `requests` | Python 网页抓取辅助脚本需要；基础账本不需要 |

可选安装：`python -m pip install -r requirements.txt`。若使用 `--python` 指定解释器，请用同一个解释器安装依赖。

支持 Python 3.10 及以上；低版本不在兼容范围内。

## 一键安装

```
git clone https://github.com/shaobrad639-cpu/jiwei.git
cd jiwei
node install.mjs
```

装完**重启 DeepSeek Harness**。插件的 HTTP 路由只有重启后才挂载——这是最常见的一步踩空。

## 参数

```
node install.mjs --data D:/my-journal       # 自定义数据目录
node install.mjs --profile myprofile        # 多 profile 时指定
node install.mjs --python /usr/bin/python3  # 指定解释器
node install.mjs --dry-run                  # 只打印，不写文件
node install.mjs --no-llm                   # 禁用模型分诊与整理工具，保留正则
node install.mjs --llm-provider <id> --llm-model <id>  # 使用 Harness 中的指定模型
```

默认：profile = `desktop`，数据目录 = `~/.dsh-journal/data`。

## LLM 配置

默认开启，直接复用 Harness 已配置的模型服务和认证，无需另存密钥。默认跟随账本定时任务所属会话的模型选择：优先“晚间收口”，其次“周报压实”和“微信兜底扫描”，只匹配当前账本目录的活跃任务。不固定 provider/model；在 Harness 切换该会话模型后，微信聊天和分类会跟着切换。显式安装参数仍可覆盖。没有对应定时任务时，再按调用者、近期对话、Harness 默认、唯一一致的根会话以及唯一可用服务选择，目录查询会跳过未认证的服务；多个可用服务无法确定优先项时返回明确提示。重启后直接从微信发消息也能使用默认模型，不必先在 Harness 对话。仍无法确定时会返回明确错误；请在 Harness 选择默认模型，或用上述参数指定模型。

手动配置位于 `reading-inbox` 的 `config` 下：

```yaml
llm:
  enabled: true
  # provider: 'Harness 中已配置的 provider id'
  # model: 'Harness 中已配置的 model id'
  timeoutMs: 45000
  maxInputBytes: 240000
```

一般无需填写 provider/model，保持默认即可跟随账本定时任务。需要固定某个模型时，两项必须同时指定；它们是 Harness 的注册 id。重新运行安装器时使用相同参数以保留选择。禁用后 `journal.py triage` 的正则路径照常可用。

微信默认由一次模型调用完成意图分类与回复：明确的待办/想法保存，聊天直接回答，收藏链接交给阅读收件箱，不确定时提出一个确认问题。提议须先通过 Python 对类型、逐字引用、时间格式和已有项目的校验；保存成功后才生成操作回执。模型不能传入完成状态或创建项目。自动分类失败时**消息不会丢**：只要还没写过账本、且这条走的是自动分诊，就退回确定性的规则分诊再存一次，回执里说明存下了什么，并且不会再调用刚才失败的模型。`/发`、`/记` 这类命令的失败不会被当成记录；纯聊天模式的消息也不会被降级。`--no-llm` 则整条链路都用规则记账。

晚间/周报使用 `reading_journal_review`（`mode=daily` 或 `weekly`，`limit` 默认 6）。返回内容是建议，尚未写入；Agent 必须先完整读取各页，再通过既有证据闸门保存。`coverage.next_offset` 非空要继续分页；`partial_source_ids` 表示仍需查看完整来源。上下文过长会明确失败，不静默丢弃。调用失败时，定时 Agent 按原流程读取上下文并核对，不能声称模型整理已经成功。

重启后可让 Harness Agent 调用 `reading_journal_llm_status` 查看启用状态、服务可用性和最近调用结果。即时分诊不会访问密钥文件；发送到模型服务的内容包括对应消息和已有项目，晚间整理还包括本子和证据上下文。请在 Harness 配置你愿意使用的服务。

## 微信连续对话

默认可用，复用上面的 LLM 配置。升级并重启 Harness 后，微信消息会自动区分待办、想法、资料和聊天，无需先发命令。发 `/聊天` 可进入纯聊天模式，暂停自动记账。对话保存最近 20 轮，最多向模型提供最近约 16000 字的历史；任务、项目和本子以带覆盖范围说明的只读快照提供。模型不能直接执行任务状态修改、联网搜索或运行命令。

`/记 具体内容` 可以在聊天中新增一条记录；`/退出` 或 `/退出聊天` 恢复自动识别；`/新对话` 清空对话上下文和待确认提议，保留当前模式。普通聊天和待确认内容不会进入 capture、任务列表或阅读收件箱，晚间 ingest 也会跳过；原始消息仍保留在微信通道最近消息缓存中。

确认问题发送成功后才激活待确认提议；最多保留 8 条相关用户消息，24 小时后失效，切换模式也会取消。只答“好/对”但没有明确候选内容、上次问题未送达或已切换话题时，会继续询问，不自动保存。保存时将原话、确认答复及各自的时间一并写入证据，重试不重复添加。

对话历史、模式和待确认提议保存在 `<数据目录>/conversations/`，按绑定用户隔离，重启不会丢失当前模式；旧版本记账模式自动升级为自动识别模式，已进入的纯聊天模式保留。只接受扫码绑定用户的消息，切换绑定账号后不会向新账号发送旧对话的生成结果。若需禁用普通聊天回复（保留分类和确认），可在 `reading-inbox.config` 下设置：

```yaml
chat:
  enabled: false
```

`--no-llm` 也会禁用聊天。聊天调用失败时会明确提示，不把该消息降级成任务或想法。提示会区分未选定模型、认证失败、超时和账本读取失败，并附错误码，不输出密钥或原始服务响应。

诊断接口：`GET /reading-inbox/api/llm/status` 查看选定模型、选择来源、对应定时任务和可用模型目录；`POST /reading-inbox/api/llm/probe`（`Content-Type: application/json`，正文 `{}`）只用固定测试文本调用模型，不读取账本、不写聊天历史、不推送微信。

## 公众号正文与 Obsidian

转发进来的公众号文章会自动抓一次正文，存在 `inbox.json` 的 `body` 里。抓到之后可以顺手写一份 Markdown 笔记到 Obsidian 库——不配置就完全不导出，其他功能不受影响。

在 `reading-inbox` 的 `config` 下加：

```yaml
obsidian:
  vault: '/Users/you/Documents/Obsidian Vault'   # 库的根目录，不是子文件夹
  folder: 'Weixin_Article_Analysis'              # 库内子目录，省略则用这个名字
```

`vault` 必须是你 Obsidian 库的根目录（含 `.obsidian/` 那一层）。`folder` 不存在会自动创建。

写出来的文件名是 `YYYY-MM-DD_标题.md`，日期优先取文章发布时间，取不到才用收录日期。笔记头部 front matter 带 `title` / `source` / `author` / `publish_time` / `tags`，正文原样保留。

同一篇文章如果后来改了标题或改了日期，会写到新文件名下，并按库里的 `_sync-index.json` 删掉旧文件，不会留两份。想手动补一次，在微信里说「存到 Obsidian」，或让 agent 调 `reading_export_obsidian`（不带参数就同步全部）。

**抓不到正文怎么办。** 公众号会返回「环境异常」验证页，脚本会把这个情况原样报出来，不会存一段空正文。走本地代理（Clash/Surge 的 fake-IP 模式）时域名会解析到 `198.18.0.0/15`，这个 RFC 2544 测试段被当作公网目标放行；`127.0.0.1`、`10.0.0.0/8`、`192.168.0.0/16` 这类真正的内网地址仍然拒绝。

排查接口：`GET /reading-inbox/api/debug` 会给出 `fetch_meta.py` 的路径、是否存在、当前解释器，以及最近一次抓取失败的原因。

## 行程提醒

具体到小时的安排（账本里 `at.clock` 有值，比如「下午 3:30 电话会议」）由插件自己盯：提前一小时推一条微信，15:30 的会 14:30 提醒。条目备注里写了「提前一天提醒」「提前半小时」就按它来；只有「上午/下午」没有钟点的安排不单独提醒，留给早间提要。

提醒不需要建定时任务，也不用模型参与：插件每分钟对一次表，同一件事只提醒一次，记录在 `<数据目录>/reminders.json`。改默认提前量：

```yaml
reminder:
  leadMinutes: 60      # 默认提前一小时
  enabled: false       # 想彻底关掉
```

DSH 关着的时候不会提醒；会前重新打开还会补发一次（会已经开了就不发）。


## 项目关联目录

项目的“浏览添加目录”可以选择工作区外的目录：使用“上一级”、用户目录/磁盘快捷入口，或输入完整路径（支持 `~/目录名`）后点“前往”，再点“添加当前目录”。未配置工作区时从用户目录开始。浏览不会更改目录关联，只有点击添加后才保存；一个项目可关联多个目录。

## 安装器做了什么

1. 建数据目录，铺空账本（`store.json`、`notebook.md`、`projects/`、`capture/`、`reports/`）
2. 把 `journal/*.py` 和 `RULES.md` 复制进数据目录（让数据目录自包含）
3. 在 profile 的 `package.json` 里登记两个插件（dependency + bundle）
4. 在 profile 的 `node_modules/@local/` 下建链接
5. 在 profile 的 `cordis.patch.yml` 末尾写一段配置覆盖（写入 `dataDir`）
6. 把 `schedules/` 里的四份模板填好路径，生成 `schedules-ready.md`

**幂等**，重复跑不会重复写。

数据目录里的 `.py` 是**运行副本**，源码在 `journal/` 下。第 2 步覆盖前会先比内容：不一致就留一份 `.bak-<时间>`，并列出哪几个文件和仓库对不上。改代码请改 `journal/` 下的源文件——改运行副本的话，下次重跑安装器虽然不会丢，但会一直提示你不一致。

第 3、5 步同样会先备份成 `*.dsh-journal.bak`。

## 建定时任务（必须）

安装器**不能**替你建定时任务——它们存在 DSH 的 schedule 存储里，不是文件。

重启 DSH 后，把这句话发给 agent：

> 读 `<数据目录上级>/schedules-ready.md`，按里面的 schedule 元信息建四个定时任务

装完时安装器会把完整路径打印出来，直接复制即可。

四个任务：

| 任务 | 触发 | 作用 |
| --- | --- | --- |
| 微信兜底扫描 | 每天 13:00 | 插件分诊失败时补漏 |
| 早间提要 | 每天 08:00 | 今天的安排，带时间与地点 |
| 晚间收口 | 每天 22:30 | 语义收尾：关任务、更项目状态 |
| 周报压实 | 周日 21:00 | 合并重复、改写四问、出周报 |

**跳过这一步的后果**：面板和微信通道能用，但没有「每晚收口 / 每周压实」——系统只剩一个记录工具，不会自己收敛。这是这套东西最核心的一半。

## 装完检查

```
python <数据目录>/journal.py status
```

应该返回一段 JSON，`projects` 是空数组。然后在面板左侧栏能看到「碎片阅读」和「账本」两个图标。

## 配置微信

1. 打开面板「碎片阅读」
2. 点「接入微信」，用手机微信打开返回的链接并确认
3. 之后往那个机器人会话里发链接或文字

微信通道走腾讯 iLink 机器人协议。**只能收到发给这个机器人的消息**，转发到「文件传输助手」它看不到——这是微信的边界，不是 bug。

机器人偶尔会出现「状态是 connected，但发送返回 `prepare failed`」。遇到就断开重连、必要时重新扫码。收消息和发消息是两条独立的链路，一条坏了另一条可能还是好的。

## 手动安装（不用安装器）

1. 把 `plugins/reading-inbox`、`plugins/journal-panel` 放到任意固定目录
2. 编辑 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": {
    "@local/reading-inbox": "link:/绝对路径/plugins/reading-inbox",
    "@local/journal-panel": "link:/绝对路径/plugins/journal-panel"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "@local/reading-inbox", "@local/journal-panel"]
    }
  }
}
```

3. 建链接：Windows 用 `mklink /J`，macOS/Linux 用 `ln -s`，指向 `node_modules/@local/<名字>`
4. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾加：

```yaml
- id: reading-inbox
  config:
    dataDir: '/绝对路径/reading-inbox-data'
    journalDir: '/绝对路径/journal-data'
    python: 'python'
- id: journal-panel
  config:
    dataDir: '/绝对路径/journal-data'
    readingInbox: '/绝对路径/reading-inbox-data'
    python: 'python'
```

5. 建数据目录，把 `templates/journal/*` 和 `journal/*.py`、`journal/RULES.md` 复制进去
6. 重启 DSH

## 排查

| 现象 | 原因 |
| --- | --- |
| 面板没出现 | 没重启，或 profile 的 bundles 里没登记 |
| 面板出现但提示「未配置账本目录」 | `cordis.patch.yml` 的 `dataDir` 是空的 |
| `/journal/api/state` 404 | 插件没加载；看 DSH 启动日志里的 `[journal-panel]` |
| 微信消息没回执 | Python 没找到，或 `journalDir` 路径不对 |
| 发送返回 `prepare failed` | 腾讯侧会话失效，重连或重新扫码 |
| Obsidian 里没有笔记 | 没配 `config.obsidian.vault`，或这篇没抓到正文 |

## 升级

```
git pull
node install.mjs     # 会把新的 .py 同步进数据目录
```

Python 代码会更新；已有 `RULES.md` 保留，升级后需自行对比仓库规则。账本数据只补缺，`store.json`、`capture/`、`projects/` 里已有的内容一律不动。

如果数据目录里的 `.py` 被人改过（和仓库不一致），安装器会先留一份 `.bak-<时间>` 再覆盖，并打印出哪几个文件对不上。看到这个提示说明改错了位置——要改代码请改仓库 `journal/` 下的源文件。

启用本次 LLM 功能后，还要让 Agent 用新生成的 `schedules-ready.md` **更新已有定时任务**；已有任务不会随模板文件自动更新。插件链接若指向旧的仓库位置，安装器会把链接更新到当前仓库；普通目录不会被覆盖。

## 卸载

删掉 profile `cordis.patch.yml` 里那段 `# >>> dsh-journal installer >>>` 注释块，从 `package.json` 移除两个依赖和 bundle，删掉 `node_modules/@local/` 下两个链接，重启。数据目录留着即可——它是纯文件，任何编辑器都能读。

## 改了代码怎么生效（不用重启 App）

服务端插件是随 DSH 进程加载的，但插件管理器支持热重载——禁用再启用会重新加载模块：

```
plugin_manager set_plugin  target=include:reading-inbox  enabled=false
plugin_manager set_plugin  target=include:reading-inbox  enabled=true
```

面板里「设置 → 插件」关掉再打开同一个条目也行。实测约两秒，`reading_get`、`reading_list` 的改动会立即生效。

代价：微信机器人断线重连几秒，期间到达的消息在重连后补收。

需要重载的是 `plugins/*/` 下的所有 `.js`（`index.js`、`util.js`、`store.js`、`fetch.js`、`chat.js`、`llm.js`、`wechat.js`）和 `tools/*.py`；改 `schedules/*.md` 里的提示词不用——定时任务每次触发重新下发。`journal-panel` 同理，把 target 换成 `include:journal-panel`。
