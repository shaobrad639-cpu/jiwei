/**
 * 账本 (Journal) — Client half.
 *
 * 一个全页面板：现在 / 想法 / 密度 / 最近改动 / 本子。
 * 只调 /journal/api/*，所有语义都在 journal.py 里。
 */
window.__ModuleLoader__.load({
  id: '@local/journal-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState, useRef } = React

    const CSS = `
.jp-review { margin:0 0 38px; }
.jp-review-head { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; flex-wrap:wrap; }
.jp-review-head h2 { font-size:22px; margin:0 0 5px; }
.jp-review-count { font-size:14px; color:var(--dsw-alias-label-secondary); }
.jp-review-card { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:20px; padding:28px; box-shadow:0 8px 30px #00000006; overflow-wrap:anywhere; }
.jp-review-meta { display:flex; gap:10px; align-items:center; font-size:14px; color:var(--dsw-alias-label-secondary); flex-wrap:wrap; }
.jp-review-card h3 { font-size:23px; line-height:1.45; margin:18px 0; font-weight:600; }
.jp-review-summary { width:100%; box-sizing:border-box; resize:vertical; min-height:100px; border:0; border-bottom:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:20px; line-height:1.65; padding:0 0 15px; }
.jp-review-label { display:block; font-size:14px; color:var(--dsw-alias-label-secondary); margin:22px 0 10px; }
.jp-review-quote { margin:0; padding:16px 20px; border-left:3px solid var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); border-radius:0 12px 12px 0; font-size:17px; line-height:1.8; white-space:pre-wrap; }
.jp-review-projects { display:flex; flex-wrap:wrap; gap:10px; }
.jp-review-chip { padding:9px 15px; border:1px solid var(--dsw-alias-border-l1); border-radius:99px; background:transparent; color:var(--dsw-alias-label-primary); font-size:15px; cursor:pointer; }
.jp-review-chip[aria-pressed="true"] { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.jp-review-actions { display:grid; grid-template-columns:1fr 1fr 1.3fr; gap:12px; margin-top:28px; }
.jp-review-actions button { min-height:49px; padding:10px 12px; border-radius:12px; border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-primary); font-size:16px; cursor:pointer; }
.jp-review-actions .accept { background:var(--dsw-alias-brand-primary); border-color:transparent; color:white; }
.jp-review-actions button:disabled { opacity:.5; cursor:default; }
.jp-review-original { font-size:16px; line-height:1.8; white-space:pre-wrap; overflow-wrap:anywhere; margin-top:14px; }
.jp-review-tools { display:flex; gap:18px; flex-wrap:wrap; margin-top:18px; font-size:14px; }
.jp-review-empty { padding:45px 25px; text-align:center; border:1px dashed var(--dsw-alias-border-l1); border-radius:20px; font-size:17px; line-height:1.8; }
.jp-review-status { margin-top:18px; font-size:14px; line-height:1.7; }
@media(max-width:600px) { .jp-review-card { padding:20px 16px; } .jp-review-card h3 { font-size:21px; } .jp-review-summary { font-size:18px; } .jp-review-quote { padding:12px 14px; } .jp-review-actions { gap:8px; } }
.jp-toolbar { display:flex; justify-content:space-between; margin:0 0 22px; }
.jp-segments { display:flex; gap:4px; background:var(--dsw-alias-bg-layer-2); border-radius:9px; padding:3px; }
.jp-filter { border:0; border-radius:6px; background:transparent; padding:7px 12px; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.jp-filter[aria-pressed="true"] { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }
.jp-filter span { margin-left:8px; font-size:12px; }
.jp-quickadd { flex-wrap:wrap; }
.jp-quickadd > input { flex:1 1 200px; }
.jp-quickadd .jp-project-picker { flex:0 1 150px; }
.jp-section-title { font-size:14px; font-weight:600; margin:0 0 14px; color:var(--dsw-alias-label-primary); }
.jp-project-layout { display:grid; grid-template-columns:165px minmax(0,1fr); gap:30px; align-items:start; }
.jp-project-nav { display:flex; flex-direction:column; gap:5px; }
.jp-project-choice { text-align:left; display:flex; flex-wrap:wrap; gap:8px; border:0; background:transparent; color:var(--dsw-alias-label-secondary); padding:11px 12px; border-radius:8px; cursor:pointer; overflow-wrap:anywhere; }
.jp-project-choice[aria-pressed="true"] { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-weight:600; }
.jp-project-heading { display:flex; align-items:center; gap:12px; margin-bottom:18px; }
.jp-project-heading h2 { font-size:20px; margin:0; overflow-wrap:anywhere; }
.jp-project-section { margin:26px 0; }
.jp-project-body .jp-ov { margin-bottom:26px; }
.jp-project-body .jp-ov-editbtn { opacity:1; }
.jp-project-body .jp-ov-v { font-size:14px; line-height:1.8; }
.jp-project-body .jp-ov-k { width:70px; flex-shrink:0; }
.jp-new-project { margin-top:16px; }
.jp-new-project input { width:100%; box-sizing:border-box; margin-bottom:8px; }
.jp-timeline { list-style:none; margin:0; padding:0 0 0 16px; border-left:1px solid var(--dsw-alias-border-l1); }
.jp-timeline li { position:relative; padding:0 0 24px 4px; }
.jp-timeline li::before { content:''; position:absolute; width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-border-l2); left:-20px; top:6px; }
.jp-timeline-meta { color:var(--dsw-alias-label-secondary); font-size:12px; margin-bottom:7px; }
.jp-timeline-text, .jp-timeline-link { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; font-size:16px; line-height:1.7; color:var(--dsw-alias-label-primary); }
.jp-timeline-link { text-align:left; background:none; border:0; padding:0; cursor:pointer; }
.jp-timeline-link:hover { text-decoration:underline; }
.jp-history-before, .jp-metrics-help { margin-top:8px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.jp-history-before summary, .jp-metrics-help summary { cursor:pointer; }
.jp-project-task { display:block; width:100%; text-align:left; border:0; background:transparent; color:var(--dsw-alias-label-primary); padding:9px 0; cursor:pointer; }
@media(max-width:600px) { .jp-project-layout { grid-template-columns:minmax(0,1fr); gap:20px; } .jp-project-nav { flex-direction:row; flex-wrap:wrap; } .jp-new-project { width:100%; margin-top:4px; } }

.jp-root { height: 100%; overflow-y: auto; box-sizing: border-box; }
.jp-inner { max-width: 880px; margin: 0 auto; padding: 34px 32px 72px; }
.jp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.jp-title { margin: 0; font-size: 22px; line-height: 1.3; font-weight: 650; color: var(--dsw-alias-label-primary); letter-spacing: -0.01em; }
.jp-sub { margin: 6px 0 0; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.jp-stats { display: flex; gap: 18px; flex-shrink: 0; padding-top: 4px; }
.jp-stat { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.jp-stat b { font-size: 20px; font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.jp-stat span { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.jp-today { display: flex; flex-direction: column; gap: 16px; }
.jp-today-block { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px; padding: 16px 18px 6px; }
.jp-today-block.warn { border-color: var(--dsw-alias-state-error-primary); }
.jp-today-head { display: flex; align-items: baseline; gap: 8px; padding: 0 2px 8px; }
.jp-today-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.jp-today-count { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: 999px; padding: 1px 8px; }
.jp-today-row { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; align-items: center; gap: 12px; width: 100%; text-align: left; background: none; border: 0; border-top: 1px solid var(--dsw-alias-border-l1); padding: 11px 4px; font: inherit; color: var(--dsw-alias-label-primary); cursor: pointer; }
.jp-today-head + .jp-today-row { border-top: 0; }
.jp-today-row:hover { background: var(--dsw-alias-bg-layer-2); }
.jp-today-time { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); white-space: nowrap; text-align: right; }
.jp-today-time.strong { color: var(--dsw-alias-brand-primary); font-weight: 600; }
.jp-today-text { font-size: 14.5px; line-height: 1.5; overflow-wrap: anywhere; }
.jp-today-tag { font-size: 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
.jp-today-empty { padding: 6px 4px 14px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.jp-today-date { margin-top: 4px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.jp-tabs { display: flex; gap: 6px; margin: 26px 0 18px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.jp-tab { appearance: none; background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 10px 10px; margin-bottom: -1px; font-size: 13px; color: var(--dsw-alias-label-secondary); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.jp-tab[data-active="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 550; }
.jp-tab i { font-style: normal; font-size: 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: 999px; padding: 1px 6px; }
.jp-addrow { display: flex; gap: 8px; margin: 0 0 20px; }
.jp-input { flex: 1; min-width: 0; height: 34px; padding: 0 11px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 13px; outline: none; }
.jp-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: .8; }
.jp-input:focus { border-color: var(--dsw-alias-brand-primary); }
.jp-btn { height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid transparent; background: var(--dsw-alias-brand-primary); color: #fff; font-size: 12.5px; font-weight: 550; cursor: pointer; white-space: nowrap; }
.jp-btn:disabled { opacity: .5; cursor: default; }
.jp-btn.ghost { background: none; border-color: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.jp-btn.ghost:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.jp-group { margin: 0 0 26px; }
.jp-group-head { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
.jp-group-name { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.jp-group-count { flex-shrink: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.jp-group-spacer { flex: 1; }
.jp-x { appearance: none; background: none; border: none; padding: 2px 6px; border-radius: 6px; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 15px; line-height: 1; opacity: 0; transition: opacity .12s; }
.jp-group:hover .jp-x, .jp-row:hover .jp-x { opacity: 1; }
.jp-x:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-error-primary); }
.jp-row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 9px; border: 1px solid transparent; }
.jp-row:hover { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l1); }
.jp-check { width: 15px; height: 15px; flex-shrink: 0; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
.jp-text { flex: 1; min-width: 0; font-size: 13.5px; line-height: 1.5; color: var(--dsw-alias-label-primary); word-break: break-word; }
.jp-text.done { text-decoration: line-through; opacity: .45; }
.jp-due { font-size: 11.5px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: 6px; padding: 2px 7px; white-space: nowrap; }
.jp-due.hot { color: var(--dsw-alias-state-warn-primary); }
.jp-due.overdue { color: var(--dsw-alias-state-error-primary); }
.jp-move { font-size: 11.5px; height: 24px; max-width: 130px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); opacity: 0; transition: opacity .12s; }
.jp-row:hover .jp-move { opacity: 1; }
.jp-empty { padding: 40px 8px; text-align: center; font-size: 13px; line-height: 1.8; color: var(--dsw-alias-label-secondary); }
.jp-error { margin: 14px 0 0; font-size: 12.5px; color: var(--dsw-alias-state-error-primary); }
.jp-loading { padding: 40px 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.jp-idea { display: flex; align-items: flex-start; gap: 10px; padding: 11px 12px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); margin-bottom: 8px; }
.jp-idea-main { flex: 1; min-width: 0; }
.jp-idea-text { font-size: 13.5px; line-height: 1.6; color: var(--dsw-alias-label-primary); word-break: break-word; }
.jp-idea-meta { margin-top: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.jp-idea-acts { display: flex; gap: 4px; flex-shrink: 0; opacity: 0; transition: opacity .12s; }
.jp-idea:hover .jp-idea-acts { opacity: 1; }
.jp-act { appearance: none; background: none; border: 1px solid transparent; border-radius: 7px; padding: 4px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.jp-act:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.jp-note { width: 100%; box-sizing: border-box; min-height: 240px; padding: 18px 20px; border-radius: 11px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 13.5px; line-height: 1.85; font-family: inherit; resize: vertical; outline: none; }
.jp-note:focus { border-color: var(--dsw-alias-brand-primary); }
.jp-note-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.jp-hint { font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.jp-saved { font-size: 11.5px; color: var(--dsw-alias-state-success-primary); }
.jp-due.event { background: none; border: 1px solid var(--dsw-alias-border-l2); }
.jp-strip { margin-bottom: 20px; }
.jp-strip-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 7px; }
.jp-strip-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.jp-strip-sum { font-size: 12px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.jp-grid { display: grid; grid-template-rows: repeat(7, 12px); grid-auto-flow: column; grid-auto-columns: 12px; gap: 3px; }
.jp-cell { width: 12px; height: 12px; border-radius: 3px; }
.jp-cell.blank { background: transparent; }
.jp-ov { margin: 2px 0 10px; padding: 10px 12px; border-radius: 9px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
.jp-ov-blank { background: none; border: 1px dashed var(--dsw-alias-border-l1); padding: 4px 8px; }
.jp-ov-row { display: flex; gap: 10px; align-items: flex-start; padding: 3px 0; }
.jp-ov-k { flex-shrink: 0; width: 42px; font-size: 11.5px; line-height: 1.8; color: var(--dsw-alias-label-secondary); }
.jp-ov-v { font-size: 13px; line-height: 1.7; color: var(--dsw-alias-label-primary); word-break: break-word; }
.jp-ov-list { margin: 0; padding-left: 16px; font-size: 13px; line-height: 1.75; color: var(--dsw-alias-label-primary); }
.jp-ov-editbtn { margin-top: 4px; opacity: 0; transition: opacity .12s; }
.jp-group:hover .jp-ov-editbtn { opacity: 1; }
.jp-ov-field { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 6px; }
.jp-ov-input { flex: 1; box-sizing: border-box; padding: 6px 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12.5px; line-height: 1.6; font-family: inherit; resize: vertical; outline: none; }
.jp-ov-input:focus { border-color: var(--dsw-alias-brand-primary); }
.jp-ov-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.jp-ov-acts .jp-btn { height: 28px; font-size: 12px; }
.jp-searchrow { margin: 16px 0 0; }
.jp-search-out { margin-top: 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; overflow: hidden; }
.jp-hit { display: flex; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12.5px; line-height: 1.6; }
.jp-hit:last-child { border-bottom: none; }
.jp-hit-where { flex-shrink: 0; width: 42px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.jp-hit-body { color: var(--dsw-alias-label-primary); word-break: break-word; }
.jp-diff { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12.5px; line-height: 1.6; }
.jp-diff-time { flex-shrink: 0; width: 72px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.jp-diff-kind { flex-shrink: 0; width: 34px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.jp-diff-text { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary); word-break: break-word; }
.jp-diff-field { flex-shrink: 0; max-width: 46%; color: var(--dsw-alias-label-secondary); font-size: 11.5px; word-break: break-word; }
.jp-row { flex-wrap: wrap; }
.jp-text { flex-basis: 200px; }
.jp-due { white-space: normal; overflow-wrap: anywhere; max-width: 100%; line-height: 1.6; }
.jp-ov-v, .jp-idea-text { white-space: pre-wrap; }
.jp-searchrow { display: flex; margin: 16px 0; gap: 8px; }
.jp-searchrow .jp-input { width: 100%; }
.jp-tabs { flex-wrap: wrap; }
.jp-tab { white-space: nowrap; }
.jp-group-name { overflow-wrap: anywhere; min-width: 0; }
.jp-badge { font-size: 11px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: 5px; padding: 2px 6px; }
.jp-summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 10px 0; }
.jp-focus { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px 14px; margin: 0 0 24px; }
.jp-focus h2 { margin: 0 0 8px; font-size: 14px; }
.jp-focus-row { display: flex; flex-wrap: wrap; gap: 6px 12px; padding: 7px 0; }
.jp-focus-row .jp-text { flex-basis: 240px; }
.jp-inline-error { margin: 8px 0; }
.jp-hit-body { min-width: 0; }
.jp-grid { width: max-content; }
.jp-strip { overflow-x: auto; padding-bottom: 4px; }
.jp-legend { display: flex; gap: 8px; align-items: center; margin: 6px 0 16px; }
.jp-row:focus-within .jp-x, .jp-group:focus-within > .jp-group-head .jp-x,
.jp-row:focus-within .jp-move, .jp-idea:focus-within .jp-idea-acts,
.jp-group:focus-within .jp-ov-editbtn { opacity: 1; }
.jp-root :focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px; }
.jp-act:disabled { opacity: .5; cursor: wait; }
@media (hover: none) {
  .jp-x, .jp-move, .jp-idea-acts, .jp-ov-editbtn { opacity: 1; }
}
@media (max-width: 600px) {
  .jp-inner { padding: 20px 14px 40px; }
  .jp-head { flex-direction: column; gap: 14px; }
  .jp-stats { gap: 22px; }
  .jp-stat { align-items: flex-start; }
  .jp-tabs { gap: 0; margin-top: 18px; }
  .jp-tab { padding: 9px 8px; }
  .jp-text { flex-basis: calc(100% - 40px); }
  .jp-move, .jp-x, .jp-idea-acts, .jp-ov-editbtn { opacity: 1; }
  .jp-idea { flex-wrap: wrap; }
  .jp-idea-main { flex-basis: 100%; }
  .jp-note { padding: 12px; }
  .jp-note-foot, .jp-diff { flex-wrap: wrap; }
  .jp-diff-text { flex-basis: calc(100% - 130px); }
  .jp-diff-field { max-width: 100%; padding-left: 0; }
}

.jp-detail { width: min(680px, calc(100vw - 32px)); max-height: calc(100vh - 32px); box-sizing: border-box; padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.jp-detail::backdrop { background: rgba(15,23,42,.42); }
.jp-detail-inner { padding: 22px; }
.jp-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.jp-detail h2 { margin: 0; font-size: 18px; }
.jp-detail label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; margin-bottom: 14px; }
.jp-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
.jp-detail .jp-input { width: 100%; flex: none; box-sizing: border-box; }
.jp-detail textarea { min-height: 110px; width: 100%; box-sizing: border-box; resize: vertical; }
.jp-detail-meta { display: grid; grid-template-columns: 70px 1fr; gap: 6px 12px; margin: 14px 0; font-size: 12px; line-height: 1.7; }
.jp-detail-meta dt { color: var(--dsw-alias-label-secondary); }
.jp-detail-meta dd { margin: 0; overflow-wrap: anywhere; }
.jp-detail-source { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; margin: 8px 0; background: var(--dsw-alias-bg-layer-2); border-radius: 8px; font-size: 12px; line-height: 1.7; }
.jp-detail-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.jp-detail-entry { opacity: 1; flex-shrink: 0; }
.jp-idea-acts { opacity: 1; flex-wrap: wrap; }
.jp-notice { margin: 12px 0; font-size: 13px; color: var(--dsw-alias-state-success-primary); }
@media (max-width: 600px) {
  .jp-detail-inner { padding: 16px; }
  .jp-detail-grid { grid-template-columns: 1fr; }
}

`

    async function api(path, body) {
      const res = await fetch(`/journal/api/${path}`, body
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : { headers: { accept: 'application/json' } })
      let data = {}
      try {
        data = await res.json()
      } catch {
        throw new Error('服务器返回了无效内容，请重试')
      }
      if (res.status === 404 && path.startsWith('sources/browse')) throw new Error('目录浏览服务尚未加载。请完全退出 DSH 后重新打开，再刷新工作台（仅刷新页面不会更新服务端）。')
      if (!res.ok) throw new Error(data.error || '请求失败')
      return data
    }

    function localDay() {
      return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    }

    function dayDistance(iso) {
      return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${localDay()}T00:00:00Z`)) / 86400000)
    }

    function dayLabel(iso, event = false) {
      const diff = dayDistance(iso)
      if (!Number.isFinite(diff)) return { label: iso, cls: '' }
      if (diff < 0) return event
        ? { label: `已过 ${-diff} 天`, cls: '' }
        : { label: `逾期 ${-diff} 天`, cls: 'overdue' }
      if (diff === 0) return { label: '今天', cls: 'hot' }
      if (diff === 1) return { label: '明天', cls: 'hot' }
      if (diff === 2) return { label: '后天', cls: 'hot' }
      return { label: iso.slice(0, 4) === localDay().slice(0, 4) ? iso.slice(5) : iso, cls: '' }
    }

    function whenInfo(item) {
      const bits = []
      const classes = []
      if (item.at?.date) {
        const base = dayLabel(item.at.date, true)
        bits.push(`${base.label}${item.at.clock ? ` ${item.at.clock}` : item.at.slot ? ` ${item.at.slot}` : ''}`)
        classes.push(base.cls)
      }
      if (item.due) {
        const base = dayLabel(item.due)
        bits.push(base.cls === 'overdue' ? base.label : `${base.label}内完成`)
        classes.push(base.cls)
      }
      if (!bits.length) return null
      return {
        label: bits.join(' · '),
        cls: classes.includes('overdue') ? 'overdue' : classes.includes('hot') ? 'hot' : '',
        event: Boolean(item.at?.date),
      }
    }

    function compareTasks(a, b) {
      const key = item => {
        const dates = [item.at?.date, item.due].filter(Boolean).sort()
        return `${dates[0] || '9999'} ${item.at?.clock || '23:59'}`
      }
      return Number(a.status === 'parked') - Number(b.status === 'parked') ||
        key(a).localeCompare(key(b)) || (a.created || '').localeCompare(b.created || '')
    }

    function TaskRow({ item, projects, onSet, onMove, onEdit, showCheck = true }) {
      const when = whenInfo(item)
      return h(
        'div',
        { className: 'jp-row' },
        showCheck ? h('input', {
          className: 'jp-check',
          type: 'checkbox',
          'aria-label': `完成任务：${item.text}`,
          checked: item.status === 'done',
          onChange: (e) => onSet(item.id, { status: e.target.checked ? 'done' : 'open' }),
        }) : null,
        h('span', { className: `jp-text${item.status === 'done' ? ' done' : ''}` }, item.text),
        h('button', { className: 'jp-act jp-detail-entry', 'aria-label': `查看详情：${item.text}`, onClick: () => onEdit(item.id) }, '详情'),
        item.status === 'parked' ? h('span', { className: 'jp-badge' }, '暂缓') : null,
        when ? h('span', { className: `jp-due ${when.cls}${when.event ? ' event' : ''}` }, when.label) : null,
        h('button', { className: 'jp-x', title: '丢弃', 'aria-label': `丢弃任务：${item.text}`, onClick: () => onSet(item.id, { status: 'dropped' }) }, '×'),
      )
    }

    const OVERVIEW = [
      { key: 'goal', label: '目标' },
      { key: 'state', label: '当前进展' },
      { key: 'next', label: '下一步' },
      { key: 'open', label: '未决' },
    ]

    function Overview({ project, onSave }) {
      const [editing, setEditing] = useState(false)
      const [form, setForm] = useState(null)
      const [saving, setSaving] = useState(false)
      const start = () => {
        setForm({
          goal: project.goal || '',
          state: project.state || '',
          next: project.next || '',
          open: project.open || '',
        })
        setEditing(true)
      }
      if (editing && form) {
        return h(
          'div',
          { className: 'jp-ov jp-ov-edit' },
          OVERVIEW.map((field) =>
            h(
              'div',
              { className: 'jp-ov-field', key: field.key },
              h('span', { className: 'jp-ov-k' }, field.label),
              h('textarea', {
                className: 'jp-ov-input',
                disabled: saving,
                'aria-label': `${project.name}：${field.label}`,
                rows: field.key === 'open' ? 3 : 2,
                value: form[field.key],
                placeholder: field.key === 'open' ? '一行一条，还没决定的疑问或想法' : '',
                onChange: (e) => setForm({ ...form, [field.key]: e.target.value }),
              }),
            ),
          ),
          h(
            'div',
            { className: 'jp-ov-acts' },
            h('button', { className: 'jp-btn ghost', disabled: saving, onClick: () => setEditing(false) }, '取消'),
            h(
              'button',
              {
                className: 'jp-btn',
                disabled: saving,
                onClick: async () => {
                  setSaving(true)
                  try { if (await onSave(form)) setEditing(false) }
                  finally { setSaving(false) }
                },
              },
              '保存',
            ),
          ),
        )
      }
      const rows = OVERVIEW.slice(0, 3).filter((field) => (project[field.key] || '').trim())
      const opens = (project.open || '')
        .split('\n')
        .map((line) => line.trim().replace(/^[-*]\s+/, ''))
        .filter(Boolean)
      if (!rows.length && !opens.length) {
        return h(
          'div',
          { className: 'jp-ov jp-ov-blank' },
          h('button', { className: 'jp-act', onClick: start }, '添加项目结论'),
        )
      }
      return h(
        'div',
        { className: 'jp-ov' },
        rows.map((field) =>
          h(
            'div',
            { className: 'jp-ov-row', key: field.key },
            h('span', { className: 'jp-ov-k' }, field.label),
            h('span', { className: 'jp-ov-v' }, project[field.key]),
          ),
        ),
        opens.length
          ? h(
              'div',
              { className: 'jp-ov-row' },
              h('span', { className: 'jp-ov-k' }, '未决'),
              h(
                'ul',
                { className: 'jp-ov-list' },
                opens.map((line, index) => h('li', { key: index }, line)),
              ),
            )
          : null,
        h('button', { className: 'jp-act jp-ov-editbtn', onClick: start }, '编辑结论'),
      )
    }

    function TodoTab({ state, onSet, onEdit, onAdd }) {
      const [draft, setDraft] = useState('')
      const [project, setProject] = useState('')
      const [busy, setBusy] = useState(false)
      // 记录不分「完成/未完成」，只按时间排；丢弃掉的才不显示。
      const records = state.items.filter((item) => item.type === 'task' && item.status !== 'dropped' && item.status !== 'done')
      const submit = async () => {
        if (!draft.trim() || busy) return
        const text = draft
        setBusy(true)
        try { if (await onAdd({ text: text.trim(), project })) setDraft((current) => current === text ? '' : current) }
        finally { setBusy(false) }
      }
      const groups = [{ id: '', name: '未关联项目' }, ...state.projects]
      return h('div', null,
        h('div', { className: 'jp-addrow jp-quickadd' },
          h('input', { className: 'jp-input', 'aria-label': '新增记录', placeholder: '记一笔…', value: draft,
            onChange: e => setDraft(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing) void submit() } }),
          h('select', { className: 'jp-input jp-project-picker', 'aria-label': '新记录所属项目', value: project, onChange: e => setProject(e.target.value) },
            groups.map(p => h('option', { key: p.id, value: p.id }, p.name))),
          h('button', { className: 'jp-btn', disabled: busy || !draft.trim(), onClick: submit }, '记下')),
        records.length ? groups.map((p) => {
          const rows = records.filter((item) => (item.project || '') === p.id).sort(compareTasks)
          return rows.length ? h('section', { key: p.id, className: 'jp-group' },
            h('h2', { className: 'jp-section-title' }, p.name),
            rows.map((item) => h(TaskRow, { key: item.id, item, projects: state.projects, onSet, onEdit, showCheck: false }))) : null
        }) : h('div', { className: 'jp-empty' }, '还没有记录。'))
    }

    function projectTimeline(project, items) {
      const events = (project.history || []).filter(event=>!event.retracted).map((event, index) => ({ ...event, key: `project-${index}`, kind: '结论',
        label: { goal: '目标', state: '进展', next: '下一步', open: '未决问题', name: '名称', status: '状态', evidence: '来源确认' }[event.field] || event.field,
        text: typeof event.to === 'string' ? event.to : String(event.to ?? '已清空') }))
      for (const item of items.filter(i => i.project === project.id && i.type === 'task')) {
        const doneEvents = (item.history || []).filter(e => e.field === 'status' && e.to === 'done')
        if (!doneEvents.length && item.status === 'done') doneEvents.push({ at: completedAt(item) })
        doneEvents.forEach((event,index) => events.push({ key: `${item.id}-${index}`, at: event.at, kind: '完成', text: item.text, itemId: item.id }))
      }
      return events.reverse().sort((a,b) => (b.at || '').localeCompare(a.at || ''))
    }

    function ProjectDetail({ project, state, onEdit, onSave, onRemove, onScan, onAction }) {
      const [limit, setLimit] = useState(3)
      const events = projectTimeline(project, state.items)
      const tasks = state.items.filter(i => i.project === project.id && i.type === 'task' && i.status === 'open')
      const source = (state.file_sources || []).filter(s => s.id === project.id)
      return h('article', { className: 'jp-project-body' },
        h('div', { className: 'jp-project-heading' }, h('h2', null, project.name),
          h('span', { className: 'jp-badge' }, project.status === 'active' || !project.status ? '进行中' : '非活跃')),
        h('section', {className:'jp-project-section'}, h('h3',{className:'jp-section-title'}, `记录 · ${tasks.length}`), tasks.length ? tasks.sort(compareTasks).map(item=>h('button',{key:item.id,className:'jp-project-task',onClick:()=>onEdit(item.id)},item.text)) : h('p',{className:'jp-empty'},'还没有记录。')),
        h(Overview, { project, onSave }),
        h('section', { className: 'jp-project-section' },
          h('h3', { className: 'jp-section-title' }, '进展历程'),
          !events.length ? h('p', { className: 'jp-empty' }, '还没有可回看的进展记录。') : null,
          h('ol', { className: 'jp-timeline' }, events.slice(0,limit).map(event => h('li', { key: event.key },
            h('div', { className: 'jp-timeline-meta' }, (event.at || '').slice(0,10), ' · ', event.kind === '完成' ? '完成任务' : event.label),
            event.itemId ? h('button', { className: 'jp-timeline-link', onClick: () => onEdit(event.itemId) }, event.text) :
              h('div', { className: 'jp-timeline-text' }, event.text || '已清空'),
            event.source ? h('details', { className: 'jp-history-before' }, h('summary', null, '查看依据'),
              h('p', { style: { overflowWrap: 'anywhere' } }, event.source.kind === 'notion' && /^https:\/\/(app\.notion\.com|www\.notion\.so|notion\.so)\//.test(event.source.locator) ? h('a', { href:event.source.locator, target:'_blank', rel:'noreferrer' },event.source.locator) : event.source.locator),
              h('blockquote', { style:{whiteSpace:'pre-wrap'} },event.source.quote),h('small',null,`版本 ${String(event.source.version || '').slice(0,12)}`)) : null,
            event.from !== undefined ? h('details', { className: 'jp-history-before' }, h('summary', null, '此前'), h('div', { className: 'jp-timeline-text' }, String(event.from || '未填写'))) : null))),
          events.length > limit ? h('button', { className: 'jp-act', onClick: () => setLimit(n => n+10) }, `查看更多 · 还有 ${events.length-limit} 条`) : null,
          limit > 3 ? h('button',{className:'jp-act',onClick:()=>setLimit(3)},'收起至最近 3 条') : null),
        source.length ? h(SourcesView, { state: { ...state, file_sources: source }, onScan }) : null,
        h(SourceBinding, { project, state, onAction }),
        h('details', { className: 'jp-project-section' }, h('summary', { className: 'jp-summary' }, '项目设置'),
          h('button', { className: 'jp-act', onClick: () => { if (window.confirm(`删除项目「${project.name}」？条目会保留并移入未分类。`)) onRemove() } }, '删除项目')))
    }

    function SourceBinding({ project, state, onAction }) {
      const bound = (state.file_sources || []).filter(s=>s.id===project.id)
      const [open,setOpen]=useState(false)
      const [folder,setFolder]=useState(null)
      const [directoryPath,setDirectoryPath]=useState('')
      const [busy,setBusy]=useState(false)
      const [error,setError]=useState('')
      const browse=async(root='')=>{setOpen(true);setBusy(true);setError('');try{const next=await api('sources/browse?root='+encodeURIComponent(root));setFolder(next);setDirectoryPath(next.root)}catch(e){setFolder(null);setError(e.message)}finally{setBusy(false)}}
      const change=async(action,root)=>{setBusy(true);setError('');try{if(!await onAction(action,{id:project.id,root}))setError('未保存，请重试。')}catch(e){setError(e.message)}finally{setBusy(false)}}
      return h('section',{className:'jp-project-section'},h('h3',{className:'jp-section-title'},`项目来源 · ${bound.length}`),
        bound.map(row=>h('div',{key:row.key||row.root,style:{display:'flex',gap:12,alignItems:'center',marginBottom:12}},
          h('div',{style:{flex:1,minWidth:0}},h('div',null,row.root.split(/[\\/]/).pop()),h('div',{style:{overflowWrap:'anywhere',fontSize:14,lineHeight:1.6}},row.root)),
          h('button',{className:'jp-act',disabled:busy,onClick:()=>change('sources.unbind',row.root)},'解除关联'))),
        h('button',{className:'jp-btn ghost',disabled:busy,onClick:()=>open?setOpen(false):browse()},open?'关闭浏览':'浏览添加目录'),
        error?h('p',{className:'jp-error',role:'alert'},error):null,
        open?h('div',{style:{padding:16,border:'1px solid var(--dsw-alias-border-l1)',borderRadius:12,marginTop:12}},
          h('form',{className:'jp-addrow',onSubmit:e=>{e.preventDefault();if(!busy&&directoryPath.trim())browse(directoryPath.trim())}},
            h('input',{className:'jp-input','aria-label':'目录路径',placeholder:'输入完整目录路径，或 ~/目录名',value:directoryPath,disabled:busy,onChange:e=>setDirectoryPath(e.target.value)}),
            h('button',{className:'jp-btn ghost',type:'submit',disabled:busy||!directoryPath.trim()},'前往')),
          h('div',{className:'jp-row'},(folder?.shortcuts||[]).map(shortcut=>h('button',{key:shortcut.root,className:'jp-act',disabled:busy,onClick:()=>browse(shortcut.root)},shortcut.name))),
          folder?h('div',null,
            h('p',{style:{overflowWrap:'anywhere',fontSize:15}},folder.root),
            h('div',{className:'jp-row'},folder.parent?h('button',{className:'jp-act',disabled:busy,onClick:()=>browse(folder.parent)},'上一级'):null,
              h('button',{className:'jp-btn',disabled:busy||bound.some(s=>s.root===folder.root),onClick:()=>change('sources.bind',folder.root)},bound.some(s=>s.root===folder.root)?'已添加':'添加当前目录')),
            folder.children.map(child=>h('button',{key:child.root,className:'jp-project-task',disabled:busy,onClick:()=>browse(child.root)},'▸ '+child.name)),
            !folder.children.length?h('p',null,'没有子目录；可以直接添加当前目录，或前往其他路径。'):null):null):null,
        h('p',{className:'jp-hint'},'可添加多个目录。解除关联只停止归属，不删除文件或已确认进展。文献、本子和微信在活动中选择项目。'))
    }

    function evidenceQuote(record) {
      if (record.suggested_quote && record.excerpt.includes(record.suggested_quote)) return record.suggested_quote
      return record.excerpt.split('\n').find(line=>line.trim().length>8 && !/^\s*(<|Here is|\{|\}|"|#)/.test(line))?.trim().slice(0,500) || record.excerpt.slice(0,500)
    }

    function readableEvidence(text) {
      const body=text.match(/<content>([\s\S]*?)<\/content>/)?.[1] || text
      return body.replace(/<[^>]+>/g,'').replace(/^Here is the result[^\n]*\n/,'').trim()
    }

    function ReviewCard({record,projects,onDecision,onLater}) {
      const [selected,setSelected]=useState(record.projects.filter(id=>projects.some(p=>p.id===id)))
      const [quote,setQuote]=useState(evidenceQuote(record))
      const [summary,setSummary]=useState(record.suggested_summary || evidenceQuote(record).slice(0,300))
      const [busy,setBusy]=useState(false)
      const [error,setError]=useState('')
      const [full,setFull]=useState(false)
      const lock=useRef(false)
      const summaryRef=useRef(null)
      useEffect(()=>{ const el=summaryRef.current; if(!el)return; const resize=()=>{el.style.height='auto';el.style.height=el.scrollHeight+'px'};resize();let width=-1;const observer=new ResizeObserver(()=>{if(el.clientWidth!==width){width=el.clientWidth;resize()}});observer.observe(el);return()=>observer.disconnect() },[summary])
      const decide=async decision=>{
        if(lock.current)return
        if(decision==='confirmed' && (!selected.length || !summary.trim() || !quote.trim())) {
          setError(!selected.length?'请选择要更新的项目。':'请填写进展摘要和原文引用。');return
        }
        lock.current=true;setBusy(true);setError('')
        try {if(!await onDecision({id:record.id,decision,projects:selected,summary,quote}))setError('这一步没有保存，请查看错误后重试。')}
        finally {lock.current=false;setBusy(false)}
      }
      const original=readableEvidence(record.excerpt)
      const link=/^https:\/\//.test(record.locator)
      return h('article',{className:'jp-review-card',tabIndex:0,'aria-label':'当前待核对卡片',onKeyDown:e=>{
        if(e.target!==e.currentTarget || busy)return
        if(e.key==='ArrowLeft'){e.preventDefault();void decide('ignored')}
        if(e.key==='ArrowDown'){e.preventDefault();onLater(record.id)}
        if(e.key==='ArrowRight'){e.preventDefault();void decide('confirmed')}
      }},
        h('div',{className:'jp-review-meta'},h('span',null,{notebook:'本子',notion:'文献',file:'工作区',file_batch:'文件变化汇总',wechat:'微信',external:'外部来源'}[record.kind]||record.kind),
        record.kind!=='notebook'?h('span',null,(record.source_updated_at||record.observed_at||record.at||'').slice(0,10)):null,
          record.change==='baseline'?h('span',null,'首次收集'):null),
        h('h3',null,record.kind==='wechat'?record.excerpt.split('\n')[0].slice(0,70):record.title),
        h('textarea',{ref:summaryRef,style:{overflow:'hidden'},className:'jp-review-summary',rows:3,'aria-label':'准备加入的进展',value:summary,maxLength:2000,onChange:e=>setSummary(e.target.value)}),
        !record.findings && summary.trim()!==quote.trim()?h('span',{className:'jp-review-label'},'原文依据'):null,
        !record.findings && summary.trim()!==quote.trim()?h('blockquote',{className:'jp-review-quote'},quote):null,
        record.findings?h('details',null,h('summary',{className:'jp-summary'},'来源依据'),record.findings.map((f,i)=>h('details',{key:i},h('summary',{style:{fontSize:16,lineHeight:1.8}},`${i+1}. ${f.locator.split(/[\\/]/).slice(-3).join('/')}`),h('p',{style:{overflowWrap:'anywhere'}},f.locator),h('blockquote',{className:'jp-review-quote'},f.quote)))):null,

        record.partial || record.truncated?h('p',{className:'jp-review-status'},'当前原文不完整，确认前请核对来源。'):null,
        h('div',{className:'jp-review-tools'},
          h('button',{className:'jp-act',onClick:()=>setFull(v=>!v),'aria-expanded':full},full?'收起原文':'阅读全文'),
          link?h('a',{href:record.locator,target:'_blank',rel:'noreferrer'},'打开来源'):null,
          h('details',null,h('summary',null,'调整引用'),h('textarea',{className:'jp-review-summary',rows:3,'aria-label':'引用原文',value:quote,onChange:e=>setQuote(e.target.value)}))),
        full?h('div',{className:'jp-review-original'},original):null,
        h('span',{className:'jp-review-label'},'放进哪个项目'),
        h('div',{className:'jp-review-projects'},projects.map(p=>h('button',{key:p.id,className:'jp-review-chip','aria-pressed':selected.includes(p.id),onClick:()=>setSelected(ids=>ids.includes(p.id)?ids.filter(id=>id!==p.id):[...ids,p.id])},p.name))),
        !projects.length?h('p',{className:'jp-review-status'},'还没有项目，可以先留待稍后。'):null,
        error?h('p',{className:'jp-error',role:'alert'},error):null,
        h('div',{className:'jp-review-actions'},
          h('button',{disabled:busy,onClick:()=>decide('ignored'),'aria-keyshortcuts':'ArrowLeft'},'略过'),
          h('button',{disabled:busy,onClick:()=>onLater(record.id),'aria-keyshortcuts':'ArrowDown'},'稍后'),
          h('button',{className:'accept',disabled:busy,onClick:()=>decide('confirmed'),'aria-keyshortcuts':'ArrowRight'},busy?'正在保存…':'加入进展')))
    }

    function EvidenceInbox({state,onAction,onScan}) {
      const [deferred,setDeferred]=useState([])
      const [completed,setCompleted]=useState(0)
      const [last,setLast]=useState(null)
      const [undoBusy,setUndoBusy]=useState(false)
      const [scanBusy,setScanBusy]=useState(false)
      const reviewRef=useRef(null)
      const pending=(state.evidence?.records||[]).filter(r=>r.status==='pending').sort((a,b)=>Number(a.kind==='file_batch')-Number(b.kind==='file_batch'))
      const queue=pending.filter(r=>!deferred.includes(r.id))
      const current=queue[0]
      useEffect(()=>{if(last && reviewRef.current?.getClientRects().length)reviewRef.current.scrollIntoView({block:'start'})},[current?.id])
      const notion=state.evidence?.notion
      const bridge=state.evidence?.handoff||[]
      const decide=async payload=>{
        const ok=await onAction('evidence.decide',payload)
        if(ok){setLast({id:payload.id,action:'decision',revision:ok.revision});setCompleted(n=>n+1)}
        return ok
      }
      const later=id=>{setDeferred(ids=>[...ids,id]);setLast({id,action:'later'})}
      const undo=async()=>{
        if(!last||undoBusy)return
        if(last.action==='later'){setDeferred(ids=>ids.filter(id=>id!==last.id));setLast(null);return}
        const record=(state.evidence?.records||[]).find(r=>r.id===last.id)
        if(!record)return
        setUndoBusy(true)
        try {if(await onAction('evidence.undo',{id:last.id,revision:last.revision})) {setCompleted(n=>Math.max(0,n-1));setLast(null)}}
        finally {setUndoBusy(false)}
      }
      return h('section',{ref:reviewRef,className:'jp-review','aria-label':'整理新发现'},
        h('div',{className:'jp-review-head'},h('div',null,h('h2',null,'整理新发现'),
          h('div',{className:'jp-review-count','aria-live':'polite'},pending.length?`还有 ${pending.length} 组${completed?` · 本次已处理 ${completed} 条来源`:''}`:'没有待核对来源')),
          last?h('button',{className:'jp-act',onClick:undo,disabled:undoBusy},'撤销上一步'):null),
        current?h('div',null,h(ReviewCard,{key:current.id,record:current,projects:state.projects,onDecision:decide,onLater:later}),current.members?h('details',{className:'jp-project-section'},h('summary',{className:'jp-summary'},`查看这批 ${current.member_count} 个文件`),h('p',null,current.excerpt),h('div',{style:{maxHeight:400,overflow:'auto',fontSize:15,lineHeight:1.8}},(state.evidence?.records||[]).filter(r=>current.members.includes(r.id)).map(r=>h('details',{key:r.id},h('summary',{style:{overflowWrap:'anywhere'}},r.title),h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},r.locator+'\n\n'+r.excerpt))))):null):
          h('div',{className:'jp-review-empty'},pending.length?'剩余来源已设为稍后处理，可继续核对。':'没有待核对来源。已确认进展可在项目页查看。',
            pending.length?h('div',null,h('button',{className:'jp-act',onClick:()=>setDeferred([])},`继续看 ${pending.length} 组`)):null),
        h('details',{className:'jp-review-status'},h('summary',null,'来源状态与操作说明'),
          h('p',null,'略过只是不纳入进展，原始记录仍会保留；稍后只调整本次阅读顺序。聚焦卡片后可用方向键：← 略过，↓ 稍后，→ 加入。'),
          bridge.map(source=>h('p',{key:source.source},`${source.source==='notion-library'?'Notion 文献':source.source} · ${source.count} 条 · ${source.checked_at?.slice(0,16).replace('T',' ')||'尚未检查'}${source.outcome==='error'?' · 检查失败，保留旧内容':source.outcome==='partial'?' · 部分内容未读全':' · 检查完成'}${source.stale?' · 已超过 36 小时未更新':''}`)),
          !bridge.some(s=>s.source==='notion-library')?h('p',null,notion?.mode==='snapshot'?`Notion：${notion.count} 条旧快照，等待自动化交接。`:'Notion：等待自动化交接。'):null,
          state.evidence?.schedule?.status==='error'?h('p',{className:'jp-error'},'晚间流程更新存在冲突，请查看迁移报告。'):null,
          h('button',{className:'jp-act',disabled:scanBusy,onClick:async()=>{setScanBusy(true);try{await onScan()}finally{setScanBusy(false)}}},scanBusy?'正在检查…':'检查本地新变化'),
          h(SourcesView,{state,onScan})))
    }

    function ProjectsTab({ state, onEdit, onSave, onRemove, onAdd, onScan, onAction }) {
      const [selected, setSelected] = useState('')
      const [name, setName] = useState('')
      const [busy, setBusy] = useState(false)
      const projects = state.projects.slice().sort((a,b) => Number(a.status !== 'active') - Number(b.status !== 'active'))
      const current = projects.some(p => p.id === selected) ? selected : projects[0]?.id
      const add = async () => {
        if (!name.trim() || busy) return
        const value = name
        setBusy(true)
        try { if (await onAdd(value.trim())) setName(current => current === value ? '' : current) }
        finally { setBusy(false) }
      }
      return h('div', { className: 'jp-project-layout' },
        h('aside', { className: 'jp-project-nav', 'aria-label': '选择项目' },
          projects.map(p => h('button', { key: p.id, className: 'jp-project-choice', 'aria-pressed': p.id === current, onClick: () => setSelected(p.id) },
            h('span', null, p.name), p.status && p.status !== 'active' ? h('span', { className: 'jp-badge' }, '非活跃') : null)),
          h('details', { className: 'jp-new-project' }, h('summary', { className: 'jp-summary' }, '新建项目'),
            h('input', { className: 'jp-input', 'aria-label': '新项目名称', placeholder: '项目名称', value: name, onChange: e => setName(e.target.value),
              onKeyDown: e => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing) void add() } }),
            h('button', { className: 'jp-btn ghost', disabled: busy || !name.trim(), onClick: add }, '创建'))),
        h('div', { className: 'jp-project-content' },

          projects.length ? projects.map(p => h('div', { key: p.id, hidden: current !== p.id }, h(ProjectDetail, {
            project: p, state, onEdit, onSave: values => onSave(p.id,values), onRemove: () => onRemove(p.id), onScan, onAction,
          }))) : h('div', { className: 'jp-empty' }, '建立项目后，在这里回看长期进展。')))
    }

    function ActivityTab({ state, onAction, onScan }) {
      return h('div', null,
        h(EvidenceInbox,{state,onAction,onScan}),
        h('section', { className: 'jp-project-section' }, h('h2', { className: 'jp-section-title' }, '活动趋势'), h(HeatTab)),
        h('section', { className: 'jp-project-section' }, h('h2', { className: 'jp-section-title' }, '最近动态'), h(RecentTab, { state })))
    }

    function completedAt(item) {
      return [...(item.history || [])].reverse().find(e => e.field === 'status' && e.to === 'done')?.at || item.updated || item.created || ''
    }

    function CompletedTab({ state, onEdit, onSet }) {
      const items = state.items.filter(i => i.type === 'task' && i.status === 'done')
        .sort((a,b) => completedAt(b).localeCompare(completedAt(a)))
      return h('section', { className: 'jp-group' },
        !items.length ? h('p', { className: 'jp-hint' }, '还没有已完成的任务。') : null,
        items.map(item => h('div', { key: item.id, className: 'jp-idea' },
          h('div', { className: 'jp-idea-main' },
            h('div', { className: 'jp-idea-text' }, item.text),
            h('div', { className: 'jp-hint' }, `${state.projects.find(p => p.id === item.project)?.name || '未关联项目'} · ${completedAt(item).slice(0,10)} 完成`)),
          h('button', { className: 'jp-act', onClick: () => onEdit(item.id) }, '详情'),
          h('button', { className: 'jp-act', onClick: () => onSet(item.id, { status: 'open' }) }, '重新打开'))))
    }

    function IdeasTab({ state, onSet, onPromote, onEdit }) {
      const ideas = state.items
        .filter((i) => i.type === 'idea' && i.status !== 'dropped' && i.status !== 'promoted')
        .slice()
        .reverse()
      if (!ideas.length) {
        return h('div', { className: 'jp-empty' }, '还没有想法。')
      }
      return h(
        'div',
        null,
        ideas.map((idea) =>
          h(
            'div',
            { className: 'jp-idea', key: idea.id },
            h(
              'div',
              { className: 'jp-idea-main' },
              h('div', { className: 'jp-idea-text' }, idea.text),
              h('div', { className: 'jp-idea-meta' },
                `${idea.created.slice(0, 10)} · ${state.projects.find(p => p.id === idea.project)?.name || '未关联项目'}${idea.status === 'parked' ? ' · 暂缓' : ''}`),
            ),
            h(
              'div',
              { className: 'jp-idea-acts' },
              h('button', { className: 'jp-act jp-detail-entry', 'aria-label': `查看详情：${idea.text}`, onClick: () => onEdit(idea.id) }, '详情 / 纠错'),
              h('button', { className: 'jp-act', title: '保留想法，创建一条关联任务；分类错误请使用详情纠错', onClick: () => onPromote(idea.id) }, '提升为任务'),
              h('button', { className: 'jp-act', onClick: () => onSet(idea.id, { status: 'dropped' }) }, '丢弃'),
            ),
          ),
        ),
      )
    }

    const KIND_LABEL = { task: '任务', idea: '想法', project: '项目', notebook: '本子', capture: '原始', ref: '资料' }

    function brief(value) {
      if (value === null || value === undefined || value === '') return '—'
      if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 40)}…` : value
      if (typeof value === 'object') {
        if (value.date) return [value.date, value.slot, value.clock].filter(Boolean).join(' ')
        return JSON.stringify(value).slice(0, 40)
      }
      return String(value)
    }

    function useRemoteData(path, revision = '') {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [attempt, setAttempt] = useState(0)
      useEffect(() => {
        let active = true
        let busy = false
        const load = async () => {
          if (busy) return
          busy = true
          try {
            const result = await api(path)
            if (active) { setData(result); setError('') }
          } catch (e) { if (active) setError(e.message) }
          finally { busy = false }
        }
        void load()
        const timer = setInterval(load, 15000)
        return () => { active = false; clearInterval(timer) }
      }, [path, attempt, revision])
      return { data, error, retry: () => setAttempt(n => n + 1) }
    }

    function LoadError({ error, retry }) {
      return h('div', { className: 'jp-error jp-inline-error', role: 'alert' },
        `加载失败：${error}。`, h('button', { className: 'jp-act', onClick: retry }, '重试'))
    }

    const FIELD_LABEL = { goal: '目标', state: '进展', next: '下一步', open: '未决问题', name: '名称', type: '类型', place: '地点', status: '状态', project: '归属', text: '内容', due: '截止日期', due_raw: '截止原文', at: '发生时间', at_raw: '发生原文', ev: '来源', evidence: '来源确认' }
    const STATUS_LABEL = { open: '记录', done: '已完成', parked: '已暂缓', dropped: '已放弃', new: '已保存', promoted: '已转为任务' }

    function RecentTab({ state }) {
      const { data: rows, error, retry } = useRemoteData('recent?limit=60', (state.evidence?.records || []).map(r => r.review_revision || '').join('|'))
      if (error && !rows) return h(LoadError, { error, retry })
      if (!rows) return h('div', { className: 'jp-loading', role: 'status' }, '读取中…')
      if (!Array.isArray(rows)) return h(LoadError, { error: '改动记录格式异常', retry })
      const valueLabel = (field, value) => field === 'status' ? STATUS_LABEL[value] || brief(value)
        : field === 'project' ? state.projects.find(p => p.id === value)?.name || (value ? '已移除项目' : '未关联项目') : brief(value)
      return h('div', null,
        error ? h(LoadError, { error, retry }) : null,
        !rows.length ? h('div', { className: 'jp-empty' }, '还没有改动记录。') : null,
        rows.map((row, index) => h('div', { className: 'jp-diff', key: `${row.at}-${index}` },
          h('span', { className: 'jp-diff-time' }, String(row.at || '').slice(5, 16).replace('T', ' ')),
          h('span', { className: 'jp-diff-kind' }, KIND_LABEL[row.kind] || row.kind || '—'),
          h('span', { className: 'jp-diff-text' }, row.target || ''),
          row.field ? h('span', { className: 'jp-diff-field' },
            row.field === '文件' ? '项目文件已更新' :
              `${FIELD_LABEL[row.field] || row.field}：${valueLabel(row.field, row.from)} → ${valueLabel(row.field, row.to)}`) : null)),
      )
    }

    function SearchResults({ hits, query }) {
      if (!hits.length) {
        return h('div', { className: 'jp-empty' }, `没有找到「${query}」。`)
      }
      return h(
        'div',
        { className: 'jp-search-out' },
        hits.map((hit, index) =>
          h(
            'div',
            { className: 'jp-hit', key: index },
            h('span', { className: 'jp-hit-where' }, KIND_LABEL[hit.kind] || hit.kind || ''),
            h('div', { className: 'jp-hit-body' },
              h('div', null, hit.snippet || hit.where || ''),
              h('div', { className: 'jp-hint' }, `${hit.where || ''}${hit.line ? ` · 第 ${hit.line} 行` : ''}`)),
          ),
        ),
      )
    }

    function NotebookTab({ state, onSave }) {
      const today = localDay()
      const [selected, setSelected] = useState(`${today}#1`)
      const [drafts, setDrafts] = useState({})
      const [saving, setSaving] = useState(false)
      const [saved, setSaved] = useState('')
      const view = state.notebook_view || { sections: [], revision: '' }
      const sections = view.sections || []
      const section = sections.find(row => row.key === selected)
      const draft = drafts[selected]
      const value = draft?.text ?? section?.text ?? ''
      const selectedDate = selected === 'undated' ? '' : selected.split('#')[0]
      const choices = [...sections]
      for (const key of [`${today}#1`, selected, ...Object.keys(drafts)]) {
        if (!choices.some(row => row.key === key)) choices.push({ key, date: key === 'undated' ? null : key.split('#')[0], text: '' })
      }
      choices.sort((a,b) => (b.date || '').localeCompare(a.date || '') || a.key.localeCompare(b.key))
      const responses = (state.notebook_review?.responses || []).filter(r => r.date === selectedDate)
      const allBookResponse = state.notebook_review?.latest?.date ? null : state.notebook_review?.latest
      useEffect(() => {
        if (!Object.keys(drafts).length) return
        const guard = event => { event.preventDefault(); event.returnValue = '' }
        window.addEventListener('beforeunload', guard)
        return () => window.removeEventListener('beforeunload', guard)
      }, [drafts])
      const save = async () => {
        if (saving || !draft) return
        const key = selected
        const submitted = draft
        setSaving(true)
        try {
          if (await onSave({ key, text: draft.text, revision: draft.revision, base: draft.base, existed: draft.existed })) {
            setDrafts(current => {
              if (current[key] !== submitted) return current
              const copy = { ...current }; delete copy[key]; return copy
            })
            setSaved(key)
          }
        } finally { setSaving(false) }
      }
      const move = delta => {
        const date = new Date(`${selectedDate || today}T00:00:00Z`)
        date.setUTCDate(date.getUTCDate() + delta)
        setSelected(`${date.toISOString().slice(0,10)}#1`)
      }
      return h('div', null,
        h('div', { className: 'jp-addrow', style: { flexWrap: 'wrap' } },
          h('button', { className: 'jp-btn ghost', onClick: () => move(-1) }, '前一天'),
          h('button', { className: 'jp-btn ghost', onClick: () => setSelected(`${today}#1`) }, '今天'),
          h('button', { className: 'jp-btn ghost', onClick: () => move(1) }, '后一天'),
          h('input', { className: 'jp-input', style: { flex: '0 1 160px' }, type: 'date', 'aria-label': '本子日期', value: selectedDate,
            onInput: e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setSelected(`${e.target.value}#1`) },
            onChange: e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setSelected(`${e.target.value}#1`) } }),
          h('select', { className: 'jp-input', 'aria-label': '已有记录', value: selected, onChange: e => setSelected(e.target.value) },
            choices.map(row => h('option', { key: row.key, value: row.key }, `${row.date || '未归日期 / 原有说明'}${row.key.endsWith('#1') || !row.date ? '' : `（第 ${row.key.split('#')[1]} 段）`}${row.text?.trim() ? ' · 有记录' : ''}${drafts[row.key] ? ' · 草稿' : ''}`)))),
        h('textarea', { className: 'jp-note', 'aria-label': '本子正文', value, spellCheck: false,
          placeholder: '今天想记下什么？', disabled: saving,
          onChange: e => {
            const text = e.target.value
            setDrafts(current => ({ ...current, [selected]: { text, revision: current[selected]?.revision ?? view.revision, base: current[selected]?.base ?? section?.text ?? '', existed: current[selected]?.existed ?? !!section } }))
            setSaved('')
          }, onKeyDown: e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save() } } }),
        h('div', { className: 'jp-note-foot', style: { flexWrap: 'wrap' } },
          h('span', { className: 'jp-hint', role: 'status' }, saving ? '保存中…' : draft ? '有未保存的修改' : saved === selected ? '已保存' : ''),
          draft ? h('button', { className: 'jp-btn ghost', disabled: saving, onClick: () => {
            if (window.confirm('放弃当前日期的未保存草稿，显示磁盘上的最新内容？')) setDrafts(current => { const copy = { ...current }; delete copy[selected]; return copy })
          } }, '放弃草稿') : null,
          h('button', { className: 'jp-btn', disabled: saving || !draft, onClick: save }, '保存这一天')),
        h('section', { className: 'jp-group', 'aria-label': '当天回应' },
          h('h2', null, '当天回应'),
          state.notebook_review?.pending ? h('p', { className: 'jp-hint' }, '有新内容待回应') : null,
          responses.length ? responses.map((r,i) => h('div', { key: i },
            h('p', { className: 'jp-hint' }, `回应于 ${r.at.slice(0,16).replace('T',' ')}`),
            h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, r.response)))
            : h('p', { className: 'jp-hint' }, '暂无回应')),
        allBookResponse ? h('details', null, h('summary', { className: 'jp-summary' }, '此前的整本回应（未关联日期）'),
          h('div', { style: { whiteSpace: 'pre-wrap' } }, allBookResponse.response)) : null,
        h('details', null, h('summary', { className: 'jp-summary' }, '查看整本原文'),
          h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit' } }, view.text || state.notebook || '')))
    }

    function SourcesView({ state, onScan }) {
      const [busy, setBusy] = useState(false)
      const sources = state.file_sources || []
      if (!sources.length) return null
      return h('details', { className: 'jp-group' },
        h('summary', { className: 'jp-summary' }, '项目文件动态'),
        h('button', { className: 'jp-btn ghost', disabled: busy, onClick: async () => {
          setBusy(true); try { await onScan() } finally { setBusy(false) }
        } }, busy ? '正在检查…' : '现在检查文件变化'),
        sources.map(source => h('section', { key: source.key || source.root },
          h('h3', null, state.projects.find(p => p.id === source.id)?.name || source.root.split(/[\\/]/).pop()),
          h('details', null, h('summary', { className: 'jp-summary' }, '来源目录'), h('p', { className: 'jp-hint', style: { overflowWrap: 'anywhere' } }, source.root)),
          source.error ? h('p', { className: 'jp-error', role: 'alert' }, source.error) : null,
          h('p', { className: 'jp-hint' }, source.scanned_at ? `${source.scanned_at.slice(0,16).replace('T',' ')} 检查 · ${source.count} 个文件${source.baseline ? ' · 已建立基线' : ''}` : '尚未建立基线'),
          !(source.events || []).length ? h('p', { className: 'jp-hint' }, '建立基线后尚未发现变化。') : null,
          (source.events || []).slice(-20).reverse().map((event,i) => h('div', { key: i, style: { overflowWrap: 'anywhere', marginBottom: 8 } },
            h('span', null, `${event.kind} · ${event.path}`), h('div', { className: 'jp-hint' }, event.at.slice(0,16).replace('T',' ')))),
          source.events?.length > 20 ? h('p', { className: 'jp-hint' }, `界面显示最近 20 条，索引保留 ${source.events.length} 条供晚间读取。`) : null,
          source.omitted_events ? h('p', { className: 'jp-hint' }, `更早的 ${source.omitted_events} 条变化已超出索引保留范围。`) : null)))
    }

    function HeatStrip({ label, series, field }) {
      const max = series.reduce((top, row) => Math.max(top, row[field] || 0), 0)
      const cells = series.map((row) => row[field] || 0)
      const first = new Date(`${series[0].date}T00:00:00`)
      const leading = Number.isNaN(first.getTime()) ? 0 : (first.getDay() + 6) % 7
      const padded = new Array(leading).fill(null).concat(
        cells.map((value, index) => ({ value, date: series[index].date, row: series[index] })),
      )
      const weeks = []
      for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7))
      return h(
        'div',
        { className: 'jp-strip' },
        h(
          'div',
          { className: 'jp-strip-head' },
          h('span', { className: 'jp-strip-label' }, label),
          h('span', { className: 'jp-strip-sum' }, `${cells.reduce((a, b) => a + b, 0)}`),
        ),
        h(
          'div',
          { className: 'jp-grid' },
          weeks.flatMap((week, wi) =>
            week.map((cell, di) =>
              cell === null
                ? h('div', { key: `p${wi}-${di}`, className: 'jp-cell blank' })
                : h('div', {
                    key: cell.date,
                    className: 'jp-cell',
                    title: `${cell.date} · 记录 ${cell.row.capture} · 想法 ${cell.row.ideas} · 完成 ${cell.row.done}`,
                    style: {
                      background: cell.value ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
                      opacity: cell.value ? 0.22 + 0.78 * (max ? cell.value / max : 0) : 1,
                    },
                  }),
            ),
          ),
        ),
      )
    }

    function HeatTab() {
      const { data, error, retry } = useRemoteData('heat?days=84')
      if (error && !data) return h(LoadError, { error, retry })
      if (!data) return h('div', { className: 'jp-loading', role: 'status' }, '统计中…')
      if (!Array.isArray(data.series)) return h(LoadError, { error: '统计格式异常', retry })
      const series = data.series || []
      if (!series.length) return h('div', { className: 'jp-empty' }, '还没有数据。')
      const totalDone = series.reduce((a, r) => a + r.done, 0)
      const totalIdeas = series.reduce((a, r) => a + r.ideas, 0)
      return h(
        'div',
        null,
        h('p', { className: 'jp-hint', style: { marginBottom: 18 } }, `近 12 周 · ${series[0].date} — ${series[series.length - 1].date}`),
        error ? h(LoadError, { error, retry }) : null,
        h(HeatStrip, { label: '记录', series, field: 'capture' }),
        h(HeatStrip, { label: '想法', series, field: 'ideas' }),
        h(HeatStrip, { label: '完成', series, field: 'done' }),
        h('details', { className: 'jp-metrics-help' }, h('summary', null, '统计口径'),
          h('p', { className: 'jp-hint' }, `完成操作 ${totalDone} 次 · 新增想法 ${totalIdeas} 条。记录包含原始消息和生成条目，可能重复计数；完成按状态变更次数统计。每列一周，周一到周日从上到下，颜色按各行分别计算。`)),
      )
    }

    function detailForm(item) {
      return {
        type: item.type, text: item.text || '', project: item.project || '',
        due: item.due || '', atDate: item.at?.date || '', atClock: item.at?.clock || '',
        atSlot: item.at?.slot || '', place: item.place || '',
      }
    }

    function detailPatch(item, form) {
      if (!form.text.trim()) throw new Error('正文不能为空')
      if (form.text !== item.text && form.text.length > 20000) throw new Error('正文超过 20000 字，请缩短后保存')
      if (!form.atDate && (form.atClock || form.atSlot)) throw new Error('填写具体时间或时段时，请同时填写发生日期')
      const before = detailForm(item)
      const patch = { id: item.id, revision: item.revision }
      for (const field of ['type', 'text', 'project', 'due', 'place']) {
        if (form[field] !== before[field]) patch[field] = form[field]
      }
      if (['atDate', 'atClock', 'atSlot'].some(field => before[field] !== form[field])) {
        patch.at = form.atDate ? { date: form.atDate, clock: form.atClock || null, slot: form.atSlot || null } : null
      }
      return patch
    }

    function correctionStatus(item, type) {
      if (type === item.type || ['parked', 'dropped'].includes(item.status)) return item.status
      return type === 'task' ? 'open' : 'new'
    }

    function ItemDetail({ id, projects, onClose, onSave, onSaved }) {
      const dialog = useRef(null)
      const [detail, setDetail] = useState(null)
      const [form, setForm] = useState(null)
      const [error, setError] = useState('')
      const [saving, setSaving] = useState(false)
      const [attempt, setAttempt] = useState(0)
      const item = detail?.item
      const dirty = Boolean(item && form && JSON.stringify(form) !== JSON.stringify(detailForm(item)))
      const close = () => {
        if (saving) return
        if (dirty && !window.confirm('有未保存的修改，确定放弃并关闭详情吗？')) return
        dialog.current?.close()
        onClose()
      }
      useEffect(() => {
        const element = dialog.current
        element?.showModal()
        return () => element?.close()
      }, [])
      useEffect(() => {
        let active = true
        setError('')
        api(`item?id=${encodeURIComponent(id)}`).then(result => {
          if (!result.item || !result.item.revision) throw new Error('条目详情格式异常')
          if (active) { setDetail(result); setForm(detailForm(result.item)) }
        }).catch(e => { if (active) setError(e.message) })
        return () => { active = false }
      }, [id, attempt])
      useEffect(() => {
        if (!dirty) return undefined
        const warn = event => { event.preventDefault(); event.returnValue = '' }
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
      }, [dirty])
      const change = (field, value) => setForm(current => ({ ...current, [field]: value }))
      const reload = () => {
        if (dirty && !window.confirm('重新加载将放弃当前草稿，确定继续吗？')) return
        setDetail(null); setForm(null); setAttempt(n => n + 1)
      }
      const save = async () => {
        if (!item || !form || saving) return
        setError('')
        setSaving(true)
        try {
          const patch = detailPatch(item, form)
          const result = await onSave(patch)
          dialog.current?.close()
          onSaved(form.type, form.type !== item.type, result)
        } catch (e) { setError(e.message || '保存失败，草稿已保留') }
        finally { setSaving(false) }
      }
      const label = (text, control) => h('label', null, text, control)
      const input = (field, type, title) => h('input', {
        type, className: 'jp-input', 'aria-label': title, value: form[field],
        disabled: saving, onChange: e => change(field, e.target.value),
        onInput: e => change(field, e.target.value),
      })
      const status = item && form ? STATUS_LABEL[correctionStatus(item, form.type)] || item.status : ''
      const historyValue = (field, value) => {
        if (value === null || value === undefined || value === '') return '—'
        if (field === 'type') return KIND_LABEL[value] || value
        if (field === 'status') return STATUS_LABEL[value] || value
        if (field === 'project') return projects.find(project => project.id === value)?.name || value
        return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }
      return h('dialog', { className: 'jp-detail', ref: dialog, 'aria-label': '条目详情与编辑',
        onCancel: e => { e.preventDefault(); close() } },
        h('div', { className: 'jp-detail-inner' },
          h('div', { className: 'jp-detail-head' },
            h('h2', null, '条目详情'),
            h('button', { className: 'jp-act', disabled: saving, onClick: close, 'aria-label': '关闭详情' }, '关闭')),
          error ? h('div', { className: 'jp-error', role: 'alert' }, error,
            h('button', { className: 'jp-act', disabled: saving, onClick: reload }, '重新加载详情')) : null,
          !form ? !error ? h('p', { role: 'status' }, '读取详情中…') : null :
          h('form', { onSubmit: e => { e.preventDefault(); void save() } },
            h('div', { className: 'jp-detail-grid' },
              label('类型（纠错）', h('select', { className: 'jp-input', value: form.type, disabled: saving,
                'aria-label': '类型（纠错）', onChange: e => change('type', e.target.value) },
                h('option', { value: 'task' }, '任务'), h('option', { value: 'idea' }, '想法'))),
              label('项目归属', h('select', { className: 'jp-input', value: form.project, disabled: saving,
                'aria-label': '项目归属', onChange: e => change('project', e.target.value) },
                h('option', { value: '' }, '未关联项目'),
                projects.map(project => h('option', { key: project.id, value: project.id }, project.name)))),
            ),
            h('p', { className: 'jp-hint' },
              `状态：${status}。类型纠错直接修改原条目，不新建副本。时间、来源和历史保留。`),
            label('正文', h('textarea', { className: 'jp-ov-input', 'aria-label': '条目正文',
              required: true, value: form.text, disabled: saving, onChange: e => change('text', e.target.value) })),
            h('div', { className: 'jp-detail-grid' },
              label('截止日期（此日前完成）', input('due', 'date', '截止日期')),
              label('发生日期（当天到场）', input('atDate', 'date', '发生日期')),
              label('具体时间（24 小时制，可留空）', h('input', { className: 'jp-input', type: 'time',
                'aria-label': '具体时间', value: form.atClock, disabled: saving,
                onInput: e => setForm(current => ({ ...current, atClock: e.target.value, atSlot: '' })),
                onChange: e => setForm(current => ({ ...current, atClock: e.target.value, atSlot: '' })) })),
              label('时段（时间不确定时填写）', h('select', { className: 'jp-input', 'aria-label': '发生时段',
                value: form.atSlot, disabled: saving || Boolean(form.atClock),
                onChange: e => change('atSlot', e.target.value) },
                h('option', { value: '' }, '未指定'),
                ['早上', '上午', '中午', '下午', '傍晚', '晚上', '夜里', '深夜'].map(slot => h('option', { value: slot, key: slot }, slot)))),
            ),
            h('button', { type: 'button', className: 'jp-act', disabled: saving,
              onClick: () => setForm(current => ({ ...current, atDate: '', atClock: '', atSlot: '' })) }, '清除发生时间'),
            h('p', { className: 'jp-hint' }, '日期与时间按北京时间保存。截止日期可清空；只知道发生日期时，不必补具体钟点。',
              form.type === 'idea' ? '想法的关联时间会保留，但不计入记录和近期发生事项。' : ''),
            label('地点（可留空）', input('place', 'text', '地点')),
            h('dl', { className: 'jp-detail-meta' },
              h('dt', null, '条目 ID'), h('dd', null, item.id),
              h('dt', null, '来源'), h('dd', null, ({wechat:'微信',manual:'手动'})[item.source] || item.source || '未记录'),
              h('dt', null, '创建时间'), h('dd', null, item.created || '未记录'),
              h('dt', null, '更新时间'), h('dd', null, item.updated || '未记录'),
              item.promoted_from || item.promoted_to ? h(React.Fragment, null,
                h('dt', null, '关联条目'), h('dd', null, item.promoted_from || item.promoted_to)) : null),
            h('details', null, h('summary', { className: 'jp-summary' }, '原始记录'),
              detail.sources?.length ? detail.sources.map((source, index) => h('div', { key: index, className: 'jp-detail-source' },
                h('div', { className: 'jp-hint' }, source.at || ''),
                source.text,
                (source.urls || []).map((url, link) => h('div', { key: link }, url))))
                : h('p', { className: 'jp-hint' }, '没有关联的原始消息；来源信息仍保留。')),
            h('details', null, h('summary', { className: 'jp-summary' }, `修改历史（${item.history?.length || 0}）`),
              (item.history || []).slice().reverse().map((entry, index) => h('div', { key: index, className: 'jp-detail-source' },
                h('div', { className: 'jp-hint' }, entry.at),
                `${FIELD_LABEL[entry.field] || entry.field}：${historyValue(entry.field, entry.from)} → ${historyValue(entry.field, entry.to)}`))),
            h('div', { className: 'jp-detail-actions' },
              h('span', { className: 'jp-hint', role: 'status' }, saving ? '保存中…' : dirty ? '有未保存的修改' : ''),
              h('button', { type: 'button', className: 'jp-btn ghost', disabled: saving, onClick: close }, '取消'),
              h('button', { type: 'submit', className: 'jp-btn', disabled: saving || !dirty }, '保存修改')),
          ),
        ),
      )
    }


    function actionNotice(action, payload, result) {
      if (action === 'item.add') return `${(result.type || payload.type) === 'idea' ? '已保存想法' : '已记下'}：${result.text || payload.text}。`
      if (action === 'item.set') {
        if (Array.isArray(result.changed) && !result.changed.length) return '内容未变化，无需更新。'
        if (result.changed?.includes('status')) return `已更新状态：${STATUS_LABEL[payload.status] || payload.status}。`
        return '条目修改已保存。'
      }
      if (action === 'idea.promote') return result.duplicate ? '关联记录已存在，未重复创建。' : '已将想法转为记录。'
      if (action === 'project.add') return `已创建项目：${result.name || payload.name}。`
      if (action === 'project.set') return '项目修改已保存。'
      if (action === 'project.remove') return `已移除项目，保留原有条目${result.items_detached ? `；${result.items_detached} 条记录已解除项目关联` : ''}。`
      if (action === 'evidence.decide') return result.unchanged ? '该来源已处理，未重复更新。'
        : payload.decision === 'ignored' ? '已略过该来源，未加入项目进展；原始记录已保留。' : '已加入项目进展时间线。'
      if (action === 'evidence.undo') return '已撤销来源处理，恢复为待核对；原始记录已保留。'
      if (action === 'sources.scan') return '已执行来源扫描，请查看各来源的检查结果。'
      if (action === 'sources.bind') return '已关联来源目录。'
      if (action === 'sources.unbind') return '已解除目录关联，未删除文件。'
      if (action === 'notebook.day.save' || action === 'notebook.save') return '本子已保存。'
      return '操作已完成。'
    }

    function Page() {
      const [state, setState] = useState(null)
      const [tab, setTab] = useState('today')
      const [reading, setReading] = useState([])
      const [invoices, setInvoices] = useState([])
      const [editingId, setEditingId] = useState(null)
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [loadError, setLoadError] = useState('')
      const loadSequence = useRef(0)

      const load = useCallback(async () => {
        const request = ++loadSequence.current
        try {
          const [next, shelf, bills] = await Promise.all([api('state'), api('reading').catch(() => ({ items: [] })),
            api('invoices').catch(() => ({ items: [] }))])
          if (!Array.isArray(next.projects) || !Array.isArray(next.items) || !next.stats) throw new Error('账本数据格式异常')
          if (request === loadSequence.current) {
            setState(next)
            setReading(Array.isArray(shelf.items) ? shelf.items : [])
            setInvoices(Array.isArray(bills.items) ? bills.items : [])
            setLoadError('')
          }
        } catch (e) {
          if (request === loadSequence.current) setLoadError(e.message)
        }
      }, [])

      useEffect(() => {
        void load()
        // 微信那边随时会进新东西，面板不能只在挂载时读一次
        const timer = setInterval(() => void load(), 15000)
        return () => clearInterval(timer)
      }, [load])

      const act = useCallback(
        async (action, payload) => {
          try {
            setError('')
            setNotice('')
            const result = await api('action', { action, ...payload })
            setNotice(actionNotice(action, payload, result))
            await load()
            return result
          } catch (e) {
            setError(e.message)
            return false
          }
        },
        [load],
      )

      const [query, setQuery] = useState('')
      const [search, setSearch] = useState(null)
      useEffect(() => {
        const text = query.trim()
        if (!text) { setSearch(null); return undefined }
        let active = true
        const timer = setTimeout(async () => {
          try {
            const hits = await api(`search?q=${encodeURIComponent(text)}`)
            if (!Array.isArray(hits)) throw new Error('搜索结果格式异常')
            if (active) setSearch({ query: text, hits })
          } catch (e) { if (active) setSearch({ query: text, error: e.message }) }
        }, 300)
        return () => { active = false; clearTimeout(timer) }
      }, [query])

      if (!state) return h('div', { className: 'jp-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'jp-inner' }, loadError ? h(LoadError, { error: loadError, retry: load })
          : h('div', { className: 'jp-loading', role: 'status' }, '读取中…')))

      return h(
        'div',
        { className: 'jp-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'div',
          { className: 'jp-inner' },
          h('header', { className: 'jp-head' }, h('h1', { className: 'jp-title' }, '账本')),
          h('nav', { className: 'jp-tabs', 'aria-label': '账本导航' },
            [['today','今天'],['now','记录'],['projects','项目'],['notebook','本子'],['ideas','想法'],['activity','活动']].map(([key,label]) =>
              h('button', { key, className: 'jp-tab', 'data-active': String(tab === key), 'aria-pressed': tab === key, onClick: () => setTab(key) }, label))),
          editingId ? h(ItemDetail, {
            key: editingId, id: editingId, projects: state.projects,
            onClose: () => setEditingId(null),
            onSave: async patch => {
              const result = await api('action', { action: 'item.set', ...patch })
              await load()
              return result
            },
            onSaved: (type, corrected, result) => {
              setEditingId(null)
              if (corrected) setTab(type === 'task' ? 'now' : 'ideas')
              setNotice(Array.isArray(result.changed) && !result.changed.length ? '内容未变化，无需更新。' : corrected ? `已改为${type === 'task' ? '记录' : '想法'}，来源和修改历史已保留。` : '条目修改已保存。')
            },
          }) : null,
          notice ? h('div', { className: 'jp-notice', role: 'status' }, notice,
            h('button', { className: 'jp-act', onClick: () => setNotice('') }, '关闭提示')) : null,
          loadError ? h(LoadError, { error: loadError, retry: load }) : null,
          error ? h('div', { className: 'jp-error', role: 'alert' }, `操作失败：${error}`,
            h('button', { className: 'jp-act', onClick: () => setError('') }, '关闭提示')) : null,
          h(
            'div',
            { className: 'jp-searchrow' },
            h('input', {
              className: 'jp-input',
              placeholder: '搜索账本…',
              'aria-label': '搜索账本',
              value: query,
              onChange: (e) => setQuery(e.target.value),
            }),
          ),
          query.trim() ? search?.query === query.trim()
            ? search.error ? h('div', { className: 'jp-error', role: 'alert' }, `搜索失败：${search.error}`)
              : h(SearchResults, { hits: search.hits, query: query.trim() })
            : h('div', { className: 'jp-hint', role: 'status' }, '搜索中…') : null,
          h('div', { hidden: tab !== 'today' }, h(TodayTab, { state, reading, invoices, onEdit: setEditingId })),
          h('div', { hidden: tab !== 'now' }, h(TodoTab, { state, onEdit: setEditingId,
            onSet: (id,patch) => act('item.set', { id, ...patch }), onAdd: payload => act('item.add', { type: 'task', ...payload }) })),
          h('div', { hidden: tab !== 'projects' }, h(ProjectsTab, { state, onEdit: setEditingId,
            onSave: (id, values) => act('project.set', { id, ...values }), onRemove: id => act('project.remove', { id }),
            onAdd: name => act('project.add', { name }), onScan: () => act('sources.scan', {}), onAction:act })),
          tab === 'ideas'
            ? h(IdeasTab, {
                state,
                onEdit: setEditingId,
                onSet: (id, patch) => act('item.set', { id, ...patch }),
                onPromote: (id) => act('idea.promote', { id }),
              })
            : null,
          h('div', { hidden:tab !== 'activity' }, h(ActivityTab, { state, onAction:act, onScan:()=>act('sources.scan',{}) })),
          h('div', { hidden: tab !== 'notebook' }, h(NotebookTab, { state, onSave: payload => act('notebook.day.save', payload) })),
        ),
      )
    }

    const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })
    const todayKey = () => DAY_FORMAT.format(new Date())

    const shortDay = (value) => String(value || '').replace(/^\d{4}年?/, '').replace(/-/gu, '/')

    function TodayTab({ state, reading, invoices, onEdit }) {
      const day = todayKey()
      const yesterday = DAY_FORMAT.format(new Date(Date.parse(`${day}T00:00:00+08:00`) - 86400000))
      const tasks = (state.items || []).filter((item) => item.type === 'task' && item.status === 'open')
      const stamp = (item) => `${item.at.date}${item.at.clock || item.at.slot || ''}`
      const timed = tasks.filter((item) => item.at && item.at.date).sort((a, b) => stamp(a).localeCompare(stamp(b)))
      const today = timed.filter((item) => item.at.date === day)
      const earlier = timed.filter((item) => item.at.date <= yesterday)
      const isMoney = (item) => /报销|发票/u.test(item.text)
      const reimburse = tasks.filter(isMoney)
      const untimed = tasks.filter((item) => !(item.at && item.at.date) && !isMoney(item))
      const projectName = (id) => (state.projects || []).find((p) => p.id === id)?.name || ''
      const row = (item, withTime, prefix) => h('button', { key: item.id, className: 'jp-today-row',
        onClick: onEdit ? () => onEdit(item.id) : undefined },
        h('span', { className: withTime ? 'jp-today-time strong' : 'jp-today-time' },
          withTime ? (prefix || item.at.clock || item.at.slot || '·') : ''),
        h('span', { className: 'jp-today-text' }, item.text),
        item.project ? h('span', { className: 'jp-today-tag' }, projectName(item.project)) : null)
      const block = (title, count, rows, empty, warn) => h('section', { className: warn ? 'jp-today-block warn' : 'jp-today-block' },
        h('div', { className: 'jp-today-head' },
          h('span', { className: 'jp-today-title' }, title),
          h('span', { className: 'jp-today-count' }, String(count))),
        rows.length ? rows : h('p', { className: 'jp-today-empty' }, empty))
      const money = [
        ...reimburse.slice(0, 4).map((item) => row(item, false)),
        ...(invoices || []).map((invoice, index) => h('div', { key: `inv-${index}`, className: 'jp-today-row' },
          h('span', { className: 'jp-today-time' }, shortDay(invoice.date)),
          h('span', { className: 'jp-today-text' }, `${invoice.seller || invoice.name}　¥${invoice.amount || '—'}`),
          h('span', { className: 'jp-today-tag' }, '发票'))),
      ]
      return h('div', { className: 'jp-today' },
        block('今天', today.length, today.map((item) => row(item, true)), '今天没有安排。'),
        earlier.length ? block('昨天回顾', earlier.length, earlier.slice(-6).map((item) => row(item, true,
          item.at.date === yesterday ? '' : shortDay(item.at.date))), '') : null,
        block('报销', reimburse.length + (invoices || []).length, money, '还没有发票。'),
        block('未读收藏', reading.length, reading.map((item) => h('div', { key: item.id, className: 'jp-today-row' },
          h('span', { className: 'jp-today-time' }, item.status === 'later' ? '稍后' : '待读'),
          h('span', { className: 'jp-today-text' }, item.title),
          item.hasBody ? null : h('span', { className: 'jp-today-tag' }, '无正文'))), '收藏是空的。'),
      )
    }

    function TodayPage() {
      const [state, setState] = useState(null)
      const [reading, setReading] = useState([])
      const [invoices, setInvoices] = useState([])
      const [error, setError] = useState('')
      const [editingId, setEditingId] = useState(null)
      const load = useCallback(async () => {
        try {
          const [next, shelf, bills] = await Promise.all([api('state'), api('reading').catch(() => ({ items: [] })),
            api('invoices').catch(() => ({ items: [] }))])
          setState(next)
          setReading(Array.isArray(shelf.items) ? shelf.items : [])
          setInvoices(Array.isArray(bills.items) ? bills.items : [])
          setError('')
        } catch (e) { setError(e.message) }
      }, [])
      useEffect(() => { void load() }, [load])
      return h('div', { className: 'jp-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'jp-inner' },
          h('header', { className: 'jp-head' },
            h('div', null,
              h('h1', { className: 'jp-title' }, '今天'),
              h('p', { className: 'jp-today-date' }, new Intl.DateTimeFormat('zh-CN', {
                timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long',
              }).format(new Date()).replace('星期', ' · 星期'))),
            h('button', { className: 'jp-act', onClick: () => { void load() } }, '刷新')),
          error ? h('div', { className: 'jp-error', role: 'alert' }, error) : null,
          editingId ? h(ItemDetail, { key: editingId, id: editingId, projects: state?.projects || [],
            onClose: () => setEditingId(null),
            onSave: async patch => api('action', { action: 'item.set', ...patch }),
            onSaved: () => { setEditingId(null); void load() } }) : null,
          state ? h(TodayTab, { state, reading, invoices, onEdit: setEditingId })
            : h('div', { className: 'jp-loading', role: 'status' }, '读取中…')),
      )
    }

    function TodayIcon(props) {
      const size = (props && props.size) || 18
      return h('svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5 }),
        h('path', { d: 'M3.5 9.5h17' }),
        h('path', { d: 'M8 3.5v3' }),
        h('path', { d: 'M16 3.5v3' }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'journal' }, Page))
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'today' }, TodayPage))
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'journal', order: 21, label: () => '账本' },
            PanelIcon,
          ),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'today', order: 20, label: () => '今天' },
            TodayIcon,
          ),
        )
      },
    }
  },
})


