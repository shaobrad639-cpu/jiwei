# 给 agent 的约定

这个仓库是 DSH 的插件（`plugins/reading-inbox`、`plugins/journal-panel`），代码随 DSH 进程加载。

## 改完代码必须重载插件

改过 `plugins/*/index.js`、`chat.js`、`llm.js`、`wechat.js`、`tools/*.py` 之后，**固定执行一次热重载**，不要等用户重启 App：

```
plugin_manager set_plugin  target=include:reading-inbox  enabled=false
plugin_manager set_plugin  target=include:reading-inbox  enabled=true
```

`journal-panel` 同理，target 换成 `include:journal-panel`。

- 约两秒完成；微信机器人会断线重连几秒，期间的消息重连后补收
- 改 `schedules/*.md` 的提示词**不用**重载（定时任务每次触发重新下发）
- 改完先跑 `node --test tests/*.test.mjs` 和 `node scripts/check.mjs`

## 发版与日常更新

- 日常改完：`git add` → `commit` → `git push origin main`，**不打 tag、不建 Release**
- 只有用户明确说「release」时才发版：`./scripts/release.sh v0.x.y`，tag 推上去后由 GitHub Actions 自动建 Release，说明按提交生成
- 提交信息写具体：「feat(panel): 过期改为昨天回顾，新增报销模块」，不要写 update / fix bug

## 两条产品约定

- 周报（周报压实）里，收藏文章只写一行摘要，不点评
- 微信「点评我的收藏」是另一条线：手动触发，写点评（讲了什么、站不站得住、彼此关系），不要和摘要混用
- 点评每篇不超过 300 字；用户说「点评」就直接把全文发到微信，不要只回一句「已生成，去标签页看」

## 判断工具输出要看的地方

DSH 里模型看到的是工具的 `render` 文本，不是结构化返回值。新增或修改读类工具时，`render` 必须把调用方真正需要的数据（id、标题、正文、`next_offset`）放进去，否则 agent 等于什么都读不到。
