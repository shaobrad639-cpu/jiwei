#!/usr/bin/env python3
"""journal —— 任务/想法账本的确定性操作。

分工：**判断归 agent，存取归本脚本**。
分类、提炼、写周报这些要脑子的活由 agent 做；这里只做幂等、可重放的存取与渲染，
免得每次跑出不一样的结果。

用法：
    python journal.py init
    python journal.py ingest              # 从微信事件里拉新消息（幂等）
    python journal.py add --type task --text "跑基线" --project 论文三章 --due 明天
    python journal.py list [--type task] [--status open]
    python journal.py set --id t_ab12 --status done
    python journal.py project add --name 论文三章
    python journal.py render              # 重新生成 board.md
    python journal.py status              # 给 agent 看的一屏概况
"""

from __future__ import annotations

import journal_notebook
import journal_sources
import journal_evidence
import journal_llm

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import uuid
import time
from contextlib import contextmanager
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("JOURNAL_DIR", HERE))
STORE = DATA / "store.json"
CAPTURE = DATA / "capture.jsonl"          # 迁移前的旧文件，只读
CAPTURE_DIR = DATA / "capture"
PROJECTS_DIR = DATA / "projects"
BOARD = DATA / "board.md"
REPORTS = DATA / "reports"

# 项目文件里机器维护的段落边界。边界外的东西机器一个字都不碰。
MANAGED_START = "<!-- journal:managed -->"
MANAGED_END = "<!-- /journal:managed -->"
PROJECT_SECTIONS = (("goal", "要解决"), ("state", "现在"), ("next", "下一步"), ("open", "未决"))
BAD_SLUG = re.compile(r'[\\/:*?"<>|\r\n\t]+')

# 阅读收件箱默认在数据目录的兄弟目录（install.mjs 就是这么铺的），
# 换位置用环境变量覆盖：WECHAT_EVENTS / READING_INBOX。
_READING_DIR = Path(os.environ.get("READING_INBOX_DIR", DATA.parent / "reading-inbox-data"))
EVENTS = Path(os.environ.get("WECHAT_EVENTS", _READING_DIR / "wechat-events.json"))
INBOX = Path(os.environ.get("READING_INBOX", _READING_DIR / "inbox.json"))

TZ = dt.timezone(dt.timedelta(hours=8))
URL_RE = re.compile(r"https?://\S+")
# 分享卡片自带的套话，剥掉后剩下的才算「他自己说的话」
BOILER_RE = re.compile(r"复制这段文字.*$|复制链接.*$|打开【[^】]*】.*$", re.S)
# 分诊规则的机械化部分（agent 可覆盖，这里只给初判）
TIME_RE = re.compile(r"今天|明天|后天|大后天|下周|本周|这周|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}月\d{1,2}日?|\d{1,2}[-/]\d{1,2}|截止|deadline")
# 即时分诊用：从句子中间捞时间短语
WHEN_RE = re.compile(
    r"(大后天|后天|明天|今天"
    r"|(?:这|本|下)?个?周[一二三四五六日天]"
    r"|(?:这|本|下)个?周"
    r"|\d{1,2}月\d{1,2}[日号]?"
    r"|\d{1,2}[./-]\d{1,2})"
)
EVENT_RE = re.compile(r"参加|开会|例会|上课|讲座|面谈|约|合唱|答辩|值班|讲|报告会|考试|体检|聚|见面")
DEADLINE_RE = re.compile(r"交|提交|完成|准备|写完|发给|截止|deadline|整理|做完|改完|跑完|核对|检查|确认|复习")
IDEA_RE = re.compile(r"感觉|觉得|可能|也许|如果|好像|突然想到|担心|是不是|改进|想法|其实|挺|有点")
STRONG_IDEA_RE = re.compile(r"怀疑|觉得|感觉|好像|可能|也许|如果|突然想到|是不是|担心|琢磨|猜想|不确定")
# ---- 通知/公告：不是「我随口一句」，是别人发来的一整份安排
ANNOUNCE_RE = re.compile(r"群公告|通知|各位同学|届时|将于|定于|请大家|麻烦大家|特此|@所有人|安排如下|集合时间|集合地点")
ANNOUNCE_EVENT_RE = re.compile(r"将于|定于|举行|召开|动员会|会议|讲座|培训|考试|集合")
CLOCK_COLON_RE = re.compile(r"(早上|上午|中午|下午|傍晚|晚上|晚|早)?\s*(\d{1,2})\s*[:：]\s*(\d{2})")
PLACE_BRACKET_RE = re.compile(r"【([^】]{2,24})】")
PLACE_WORD_RE = re.compile(r"楼|室|馆|厅|教室|会议室|中心|校区|礼堂|广场|门口|大门|校内|操场|食堂|大厅|报告厅|楼下")
PLACE_AT_RE = re.compile(r"在\s*([^\s，。；【】]{2,20}?)\s*(?:举行|召开|集合|进行)")
AHEAD_RE = re.compile(r"提前\s*(\d+)\s*(?:min|分钟|分)?.{0,10}?(\d{1,2})\s*[:：]\s*(\d{2})")
REMARK_RE = re.compile(r"(?:修改|改|设置)\s*(?:群)?备注\s*为?\s*【([^】]{2,30})】")
SLOT_NORMAL = {"晚": "晚上", "早": "早上"}
LEAD_RE = re.compile(r"^[要得该需要把就都也，,、\s]+")
TAIL_RE = re.compile(r"^(之前|以前|前)")
TYPES = ("task", "idea", "ref")
TASK_STATUS = ("open", "done", "dropped", "parked")
IDEA_STATUS = ("new", "promoted", "parked", "dropped")

WEEKDAYS = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}


# --------------------------------------------------------------------- utils
def now() -> dt.datetime:
    return dt.datetime.now(TZ)


def iso(t: dt.datetime | None = None) -> str:
    return (t or now()).isoformat(timespec="seconds")


def day() -> dt.date:
    return now().date()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:4]}"


def ev_hash(at: str, text: str) -> str:
    return hashlib.sha1(f"{at}\x00{text}".encode("utf-8")).hexdigest()[:16]


def parse_due(raw: str | None) -> str | None:
    """把「明天/周五/2026-10-21」这类说法归一成 YYYY-MM-DD。"""
    if not raw:
        return None
    s = raw.strip()
    if not s:
        return None
    s = re.sub(r"(之前|以前)$", "", s).strip()
    today = day()
    rel = {"今天": 0, "明天": 1, "后天": 2, "大后天": 3}
    for word, delta in rel.items():
        if s.startswith(word):
            return (today + dt.timedelta(days=delta)).isoformat()
    m = re.fullmatch(r"下(?:个)?(?:周|星期)", s)
    if m:
        return (today + dt.timedelta(days=7)).isoformat()
    m = re.fullmatch(r"(下|这|本)?(?:个)?(?:周|星期)([一二三四五六日天])", s)
    if m:
        target = WEEKDAYS[m.group(2)]
        ahead = (target - today.weekday()) % 7
        if m.group(1) == "下":
            ahead = 7 - today.weekday() + target
        return (today + dt.timedelta(days=ahead)).isoformat()
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        try:
            return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            return None
    m = re.fullmatch(r"(\d{1,2})[-/.月](\d{1,2})日?", s)
    if m:
        try:
            return dt.date(today.year, int(m.group(1)), int(m.group(2))).isoformat()
        except ValueError:
            # 「14:30-17:00」这类时间区间会被误读成「月-日」，不能让它炸掉整条分诊
            return None
    return None


def due_label(due: str | None) -> str:
    if not due:
        return ""
    try:
        d = dt.date.fromisoformat(due)
    except ValueError:
        return due
    delta = (d - day()).days
    word = {0: "今天", 1: "明天", 2: "后天"}.get(delta)
    return f"{word}({due[5:]})" if word else due[5:]


SLOT_RE = re.compile(r"(早上|上午|中午|下午|傍晚|晚上|夜里|深夜)")
CLOCK_RE = re.compile(r"(?<!\d)(\d{1,2})\s*[:：点]\s*(\d{1,2})?\s*分?")
CN_CLOCK_RE = re.compile(r"(?<![周星期个第])([一二三四五六七八九十两]{1,3})\s*[点時时]\s*([一二三四五六七八九十]{1,2}|半)?")
CN_DIGITS = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
             "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
PM_SLOTS = ("中午", "下午", "傍晚", "晚上", "夜里", "深夜")


def cn_number(text: str) -> int | None:
    if not text:
        return None
    if text == "半":
        return 30
    if len(text) <= 2:
        if text in CN_DIGITS:
            return CN_DIGITS[text]
        if text.startswith("十"):
            return 10 + CN_DIGITS.get(text[1:], 0)
        if text.endswith("十"):
            return CN_DIGITS.get(text[:-1], 0) * 10
    return None


def parse_at(raw: str | None) -> dict | None:
    """「周四晚上」「明天 19:00」→ {date, slot, clock}。

    due 是「截止」，at 是「发生」——两件事，别混。
    """
    if not raw:
        return None
    s = raw.strip()
    if not s:
        return None
    slot = None
    clock = None
    found = SLOT_RE.search(s)
    if found:
        slot = found.group(1)
        s = SLOT_RE.sub("", s)

    hour = minute = None
    found = CLOCK_RE.search(s)
    if found:
        hour = int(found.group(1))
        minute = int(found.group(2) or 0)
        s = CLOCK_RE.sub("", s)
    else:
        found = CN_CLOCK_RE.search(s)
        if found:
            hour = cn_number(found.group(1))
            minute = cn_number(found.group(2) or "") or 0
            s = s[: found.start()] + s[found.end():]

    if hour is not None:
        if slot in PM_SLOTS and hour < 12:
            hour += 12
        if not 0 <= hour <= 23 or not 0 <= (minute or 0) <= 59:
            raise ValueError("时间超出有效范围")
        clock = f"{hour:02d}:{(minute or 0):02d}"

    date = parse_due(s.strip())
    if not date:
        return None
    return {"date": date, "slot": slot, "clock": clock}


def at_label(when: dict | None) -> str:
    if not when:
        return ""
    bits = [due_label(when.get("date"))]
    if when.get("slot"):
        bits.append(when["slot"])
    if when.get("clock"):
        bits.append(when["clock"])
    return " ".join(b for b in bits if b)


def when_label(item: dict) -> str:
    """任务的时间显示：发生时刻优先，另一天有截止就补一句。地点跟在后面。"""
    at = item.get("at")
    due = item.get("due")
    place = f" @{item['place']}" if item.get("place") else ""
    if at:
        label = at_label(at)
        if due and due != at.get("date"):
            label = f"{label}，截止 {due_label(due)}"
        return label + place
    if due:
        return f"{due_label(due)}前" + place
    return ""


def when_key(item: dict) -> str:
    when = item.get("at") or {}
    date = when.get("date") or item.get("due") or "9999"
    return f"{date} {when.get('clock') or ''}"


# --------------------------------------------------------------------- store
def blank_store() -> dict:
    return {"version": 1, "projects": [], "items": [], "pending": [], "cursor": {}}


def load() -> dict:
    if not STORE.exists():
        return blank_store()
    data = read_json(STORE)
    data.setdefault("projects", [])
    data.setdefault("items", [])
    data.setdefault("pending", [])
    data.setdefault("cursor", {})
    return data


def save(data: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")
    os.replace(tmp, STORE)


@contextmanager
def store_lock():
    """Serialize CLI readers and writers across processes; OS releases on exit."""
    DATA.mkdir(parents=True, exist_ok=True)
    with (DATA / ".journal.lock").open("a+b") as lock:
        lock.seek(0, 2)
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        deadline = time.monotonic() + 30
        while True:
            try:
                lock.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise SystemExit("账本正在更新，请稍后重试")
                time.sleep(0.05)
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def find_project(data: dict, key: str | None) -> dict | None:
    if not key:
        return None
    for p in data["projects"]:
        if key in (p["id"], p["name"]):
            return p
    return None


# ------------------------------------------------------- 项目文件（Markdown）
def slug_for(name: str, pid: str) -> str:
    slug = BAD_SLUG.sub("-", (name or "").strip()).strip(" -.")
    return f"{slug}.md" if slug else f"{pid}.md"


def project_path(entry: dict) -> Path:
    rel = entry.get("file") or f"projects/{slug_for(entry.get('name', ''), entry['id'])}"
    return DATA / rel


def parse_project_file(entry: dict) -> dict:
    """读项目文件。机器只认两个标记之间的内容；标记没了就拒绝改写。"""
    path = project_path(entry)
    result = {"fields": {}, "managed_ok": False, "exists": path.exists(), "path": path}
    if not path.exists():
        return result
    text = path.read_text("utf-8")
    start = text.find(MANAGED_START)
    end = text.find(MANAGED_END)
    if start < 0 or end < start:
        return result
    result["managed_ok"] = True
    current = None
    buf: list[str] = []
    for line in text[start + len(MANAGED_START):end].splitlines():
        if line.startswith("## "):
            if current:
                result["fields"][current] = "\n".join(buf).strip()
            label = line[3:].strip()
            current = next((key for key, name in PROJECT_SECTIONS if name == label), None)
            buf = []
        elif current:
            buf.append(line)
    if current:
        result["fields"][current] = "\n".join(buf).strip()
    return result


def project_fields(entry: dict) -> dict:
    """四问。文件优先；文件还没建就退回 store.json 里的旧字段。"""
    parsed = parse_project_file(entry)
    fields = {key: "" for key, _ in PROJECT_SECTIONS}
    if parsed["managed_ok"]:
        fields.update({k: (v or "").strip() for k, v in parsed["fields"].items()})
    else:
        for key, _ in PROJECT_SECTIONS:
            fields[key] = (entry.get(key) or "").strip()
    return fields


def render_managed(fields: dict) -> str:
    body: list[str] = []
    for key, label in PROJECT_SECTIONS:
        body.append(f"## {label}")
        body.append("")
        value = (fields.get(key) or "").strip()
        if key == "open":
            for line in value.splitlines():
                if line.strip():
                    body.append(f"- {line.strip()}")
        elif value:
            body.append(value)
        body.append("")
    return f"{MANAGED_START}\n" + "\n".join(body).rstrip() + f"\n{MANAGED_END}"


def write_project_file(entry: dict, fields: dict) -> Path:
    """只重写标记之间的段落；你的「我的理解」「过程与依据」不会被动。"""
    path = project_path(entry)
    path.parent.mkdir(parents=True, exist_ok=True)
    managed = render_managed(fields)
    if path.exists():
        text = path.read_text("utf-8")
        start = text.find(MANAGED_START)
        end = text.find(MANAGED_END)
        if start < 0 or end < start:
            raise SystemExit(
                f"{path.name} 里找不到 {MANAGED_START} 标记，拒绝改写——否则会覆盖你写的内容。"
                f"把标记补回去，或者删掉这个文件让系统重建。"
            )
        new_text = text[:start] + managed + text[end + len(MANAGED_END):]
    else:
        head = (
            "---\n"
            f"id: {entry['id']}\n"
            f"created: {entry.get('created', iso())}\n"
            "---\n\n"
            f"# {entry.get('name', '')}\n\n"
        )
        tail = "\n\n## 我的理解\n\n\n## 过程与依据\n\n"
        new_text = head + managed + tail
    path.write_text(new_text, "utf-8")
    return path


def project_list(data: dict) -> list[dict]:
    """给界面用的项目列表：身份来自 JSON，四问来自文件。"""
    out = []
    for entry in data["projects"]:
        path = project_path(entry)
        out.append({
            **{k: entry.get(k) for k in ("id", "name", "status", "created", "updated", "file")},
            **project_fields(entry),
            "history": entry.get("history", []),
            "path": str(path),
            "mtime": dt.datetime.fromtimestamp(path.stat().st_mtime, TZ).isoformat(timespec="seconds")
            if path.exists() else None,
        })
    return out


# ------------------------------------------------------------ 原始记录（按日）
def capture_rows() -> list[dict]:
    rows: list[dict] = []
    if CAPTURE_DIR.exists():
        for path in sorted(CAPTURE_DIR.glob("*.jsonl")):
            rows.extend(_read_jsonl(path))
    if CAPTURE.exists():  # 迁移前的旧文件，仍然读
        rows.extend(_read_jsonl(CAPTURE))
    return rows


def _read_jsonl(path: Path) -> list[dict]:
    out = []
    for line in path.read_text("utf-8-sig").splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def capture_append(row: dict) -> None:
    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = local_date(row.get("at")) or day().isoformat()
    path = CAPTURE_DIR / f"{stamp}.jsonl"
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def item_by_id(data: dict, key: str) -> dict:
    for it in data["items"]:
        if it["id"] == key:
            return it
    raise SystemExit(f"没有这个条目：{key}")


def read_json(path: Path) -> dict | list:
    """外部文件可能被人手改出 BOM，统一按 utf-8-sig 读。"""
    return json.loads(path.read_text("utf-8-sig"))


# ------------------------------------------------------------------ commands
def cmd_init(_args) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    REPORTS.mkdir(parents=True, exist_ok=True)
    CAPTURE.touch(exist_ok=True)
    if not STORE.exists():
        save(blank_store())
    print(json.dumps({"ok": True, "dir": str(DATA)}, ensure_ascii=False))


def cmd_ingest(args) -> None:
    data = load()
    events = read_json(EVENTS) if EVENTS.exists() else []

    seen: set[str] = {row.get("ev") for row in capture_rows() if row.get("ev")}

    fresh = []
    for event in events:
        # New plugin versions explicitly route conversations away from the ledger.
        # Unrouted messages remain in the raw WeChat cache, never guessed into tasks.
        if event.get('journal_route') not in (None, 'capture'):
            continue
        text = (event.get('journal_text', event.get("text")) or "").strip()
        if not text:
            continue
        key = event.get("journal_ev") or ev_hash(event.get("at", ""), text)
        if key in seen:
            continue
        seen.add(key)
        urls = URL_RE.findall(text)
        rest = BOILER_RE.sub("", URL_RE.sub("", text)).strip()
        # 带链接的消息默认归碎片阅读服务（它已经存了 note）。
        # 只有 leftovers 里出现明确时间词时才拆一条待办出来——那才是「要我提醒」。
        if urls and not TIME_RE.search(rest):
            continue
        if urls and len(rest) < 2:
            continue
        hint = "task" if TIME_RE.search(rest or text) else "idea"
        fresh.append({"at": event.get("at"), "text": text if event.get('journal_sources') else rest or text, "urls": urls,
                      "ev": key, "hint": hint,
                      **({'source_messages': event['journal_sources']} if event.get('journal_sources') else {})})

    if fresh:
        for row in fresh:
            capture_append(row)
        data["cursor"]["lastIngestAt"] = iso()
        save(data)

    print(json.dumps({"new": len(fresh), "messages": fresh}, ensure_ascii=False, indent=2))


def classify_text(text: str) -> str:
    """「怀疑/觉得/好像」这类口气压倒一切——它是想法，不是任务。

    否则「我今天看了结果，怀疑正则化太强」会因为带了「今天」被记成任务。
    """
    if STRONG_IDEA_RE.search(text):
        return "idea"
    if WHEN_RE.search(text) or EVENT_RE.search(text) or DEADLINE_RE.search(text):
        return "task"
    return "idea"


CLAUSE_RE = re.compile(r"[。！？!?\n；;]+")


def split_clauses(text: str) -> list[str]:
    """一条消息常常藏着好几件事，按句切开，各自成条目。

    这是「一条消息可以产生几种不同变化」的机械部分：切句可以自动，
    但「这句话是在收尾上次那件事」要靠语义，那个留给当晚。
    """
    parts = [p.strip(" \t，,、") for p in CLAUSE_RE.split(text)]
    parts = [p for p in parts if p]
    merged: list[str] = []
    for part in parts:
        if merged and len(part) < 4:
            merged[-1] = f"{merged[-1]}，{part}"
        else:
            merged.append(part)
    return merged or ([text.strip()] if text.strip() else [])


def build_multi_receipt(items: list[dict], data: dict, duplicate: bool = False) -> str:
    if not items:
        return '原文已保存，没有新增记录。'
    if duplicate:
        head = '这条消息已处理，未重复添加：'
    else:
        tasks = sum(i['type'] == 'task' for i in items)
        ideas = sum(i['type'] == 'idea' for i in items)
        results = ([f'已记下 {tasks} 条'] if tasks else []) + ([f'已保存 {ideas} 条想法'] if ideas else [])
        head = '，'.join(results) + '：'
    lines = [head]
    for item in items:
        project = find_project(data, item.get('project'))
        lines.append('· ' + build_receipt(item, project['name'] if project else None, duplicate=duplicate))
    return '\n'.join(lines)


def extract_when(text: str):
    """从句子中间捞时间短语，返回 (raw, 去掉时间后的正文)。"""
    found = WHEN_RE.search(text)
    if not found:
        return None, text.strip()
    phrase = found.group(1)
    end = found.end()
    # Consume the whole optional time suffix, including spaces and exact clocks.
    suffix = re.match(
        r"\s*(?:(早上|上午|中午|下午|傍晚|晚上|夜里|深夜)\s*)?"
        r"(?:(\d{1,2}\s*[:：点]\s*\d{0,2}\s*分?"
        r"|[一二三四五六七八九十两]{1,3}\s*[点時时]\s*(?:[一二三四五六七八九十]{1,2}|半)?))?",
        text[end:],
    )
    if suffix:
        phrase += suffix.group(0).strip()
        end += suffix.end()
    before = re.match(r"(之前|以前|前)", text[end:])
    if before:
        phrase += before.group(0)
        end += before.end()
    cleaned = (text[:found.start()] + text[end:]).strip()
    cleaned = LEAD_RE.sub("", cleaned).strip().rstrip("。．.，,；; ")
    if len(cleaned) < 3:
        cleaned = text.strip()
    return phrase, cleaned


def match_project(data: dict, text: str) -> dict | None:
    best = None
    for project in data["projects"]:
        name = project.get("name") or ""
        if name and name in text and (best is None or len(name) > len(best["name"])):
            best = project
    return best


def due_short(due: str | None) -> str:
    if not due:
        return ""
    try:
        delta = (dt.date.fromisoformat(due) - day()).days
    except ValueError:
        return due
    return {0: "今天", 1: "明天", 2: "后天"}.get(delta, due[5:])


def short_when(item: dict) -> str:
    when = item.get("at")
    if when:
        bits = [due_short(when.get("date"))]
        if when.get("slot"):
            bits.append(when["slot"])
        if when.get("clock"):
            bits.append(when["clock"])
        return " ".join(b for b in bits if b)
    if item.get("due"):
        return f"{due_short(item['due'])}前"
    return ""


def clash_with(data: dict, item: dict) -> dict | None:
    """同一天还压着别的「必须到场」的事——回执里提一句，比多记一条有用。"""
    when = item.get("at") or {}
    date = when.get("date")
    if not date:
        return None
    for other in data["items"]:
        if other["id"] == item["id"] or other.get("status") in ("done", "dropped"):
            continue
        if (other.get("at") or {}).get("date") == date:
            return other
    return None


def receipt_description(item: dict, project_name: str | None = None) -> str:
    details = []
    if item.get('at'):
        details.append('时间：' + at_label(item['at']))
    if item.get('due'):
        details.append('截止：' + due_label(item['due']))
    if item.get('place'):
        details.append('地点：' + item['place'])
    if project_name:
        details.append('项目：' + project_name)
    body = item['text'].rstrip('。')
    return body + ('（' + '；'.join(details) + '）' if details else '')


def build_receipt(item: dict, project_name: str | None, clash: dict | None = None, duplicate: bool = False) -> str:
    kind = item['type']
    if duplicate:
        state = item.get('status')
        if kind == 'task':
            prefix = {'done': '该任务已完成', 'parked': '这条已暂缓', 'dropped': '这条已放弃'}.get(state, '这条已存在')
        else:
            prefix = {'promoted': '该想法已标记为已转任务', 'parked': '该想法已暂缓', 'dropped': '该想法已放弃'}.get(state, '这条想法已保存')
        prefix += '，未重复添加'
    else:
        prefix = '已记下' if kind == 'task' else '已保存想法'
    receipt = prefix + '：' + receipt_description(item, project_name) + '。'
    if clash:
        receipt += '\n同一天还有记录：' + receipt_description(clash) + '。'
    return receipt


def repeated_receipt(data: dict, ev: str) -> str:
    items = [i for i in data['items'] if i.get('ev') == ev]
    if len(items) == 1:
        project = find_project(data, items[0].get('project'))
        return build_receipt(items[0], project['name'] if project else None, duplicate=True)
    return build_multi_receipt(items, data, duplicate=True)


def capture_has(ev: str) -> bool:
    return any(row.get("ev") == ev for row in capture_rows())


def is_announcement(text: str) -> bool:
    """判断是不是别人发来的一整份安排，而不是我随口一句话。"""
    if len(text) < 80:
        return False
    hits = len(ANNOUNCE_RE.findall(text))
    return hits >= 2 and bool(ANNOUNCE_EVENT_RE.search(text))


def extract_place(text: str) -> str | None:
    for candidate in PLACE_BRACKET_RE.findall(text):
        if PLACE_WORD_RE.search(candidate) and not WHEN_RE.search(candidate):
            return candidate.strip()
    found = PLACE_AT_RE.search(text)
    return found.group(1).strip() if found else None


def event_when(sentence: str) -> dict | None:
    """通知里的主时间：日期从句子头，时刻从「晚19:00」这种写法里捞。"""
    found = WHEN_RE.search(sentence)
    if not found:
        return None
    date = parse_due(found.group(1))
    if not date:
        return None
    slot = clock = None
    colon = CLOCK_COLON_RE.search(sentence)
    if colon:
        slot = SLOT_NORMAL.get(colon.group(1) or "", colon.group(1))
        hour = int(colon.group(2))
        if slot in PM_SLOTS and hour < 12:
            hour += 12
        clock = f"{hour % 24:02d}:{colon.group(3)}"
    if slot is None:
        plain = SLOT_RE.search(sentence)
        if plain:
            slot = plain.group(1)
    return {"date": date, "slot": slot, "clock": clock}


def announce_title(raw: str) -> str | None:
    """「本次海清志愿服务具体安排如下」→ 海清志愿服务。

    同一份通知里常出现多个「本次…活动」（如「感谢大家对本次志愿活动的支持」），
    取最长的那个，它通常才是真正的活动名。
    """
    best = None
    for m in re.finditer(r"本次([^\n，。；【】]{2,20}?)(?:具体)?(?:安排|活动|会议|通知|流程)", raw):
        name = m.group(1).strip()
        if name and (best is None or len(name) > len(best)):
            best = name
    if best:
        return best
    m = re.search(r"关于([^\n，。；【】]{2,24}?)(?:的)?(?:通知|安排)", raw)
    return m.group(1).strip() if m else None


def build_announcement(raw: str, ev: str, stamp: str) -> list[dict]:
    """一份通知 → 一个主事件 + 最多两个行动项。其余内容只当来源，不生成条目。"""
    sentences = [s.strip() for s in re.split(r"[。！？!?\n]+", raw) if s.strip()]
    main = None
    for sentence in sentences:
        if ANNOUNCE_EVENT_RE.search(sentence) and WHEN_RE.search(sentence):
            main = sentence
            break
    when = event_when(main) if main else None
    created: list[dict] = []

    if main and when:
        head = re.split(r"将于|定于|在\s*【|举行|召开", main)[0].strip(" ，,、~")
        title = announce_title(raw)
        if title:
            text = f"参加{title}" if len(title) <= 12 else title[:15]
        else:
            cleaned = re.sub(r"(时间|地点)[:：]?$", "", head).strip(" ，,、~：:")
            text = (cleaned or "活动")[:60]
        place = extract_place(main) or extract_place(raw)
        created.append({
            "id": new_id("t"), "type": "task", "text": text,
            "project": None, "status": "open",
            "due": None, "due_raw": None, "at": when, "at_raw": None,
            "place": place, "created": iso(), "updated": iso(),
            "source": "wechat", "ev": ev, "ev_part": 0, "history": [],
        })

    ahead = AHEAD_RE.search(raw)
    if ahead and when:
        created.append({
            "id": new_id("t"), "type": "task",
            "text": f"提前 {ahead.group(1)} 分钟到场签到",
            "project": None, "status": "open",
            "due": None, "due_raw": None,
            "at": {"date": when["date"], "slot": None,
                   "clock": f"{int(ahead.group(2)):02d}:{ahead.group(3)}"},
            "at_raw": None, "place": created[0].get("place") if created else None,
            "created": iso(), "updated": iso(),
            "source": "wechat", "ev": ev, "ev_part": 1, "history": [],
        })

    remark = REMARK_RE.search(raw)
    if remark:
        created.append({
            "id": new_id("t"), "type": "task",
            "text": f"把群备注改成「{remark.group(1)}」",
            "project": None, "status": "open",
            "due": None, "due_raw": None, "at": None, "at_raw": None, "place": None,
            "created": iso(), "updated": iso(),
            "source": "wechat", "ev": ev, "ev_part": 2, "history": [],
        })

    return created


def build_announce_receipt(items: list[dict]) -> str:
    if len(items) == 1:
        return build_receipt(items[0], None)
    return build_multi_receipt(items, {'projects': []})


_NOISE = set("的了是我你他它这那就也都还在有和与吧吗呢啊呀个上下一不没很又再才把被让给对从到")


def _content_chars(text: str) -> set[str]:
    """只留下有信息量的汉字：去掉标点、字母、口语虚词。"""
    return {ch for ch in text if "\u4e00" <= ch <= "\u9fff" and ch not in _NOISE}


def match_pending(data: dict, text: str) -> tuple[dict | None, int, float]:
    """找最像「在回答哪一条待判」的那条，返回 (条目, 重合字数, 占本条消息的比例)。

    比例比字数重要：一句三十字的新内容里蹭到两个字，不叫回答。
    """
    mine = _content_chars(text)
    best = None
    best_score = 0
    best_ratio = 0.0
    candidates = active_questions(data)
    short = text.strip().strip('。！!，, ')
    if len(candidates) == 1 and (short in ('对', '是', '是的', '不是', '不对', '好', '好的', '先不做', '第一个', '第二个', '第三个', '1', '2', '3') or any(short in c.get('replies', []) or short == c['label'] for c in candidates[0].get('choices', []))):
        return candidates[0], 100, 1.0
    for entry in candidates:
        overlap = mine & _content_chars(entry.get("question", ""))
        score = len(overlap)
        ratio = score / len(mine) if mine else 0.0
        if score > best_score or (score == best_score and ratio > best_ratio):
            best, best_score, best_ratio = entry, score, ratio
    return best, best_score, best_ratio


def active_questions(data):
    result = []
    for entry in data.get('pending', []):
        if entry.get('answered') or entry.get('prepared'):
            continue
        try:
            age = (now() - dt.datetime.fromisoformat(entry.get('sent_at') or entry['asked'])).total_seconds()
            if 0 <= age <= 48*3600:
                result.append(entry)
        except (ValueError, KeyError, TypeError):
            pass
    return result


def cmd_ask(args) -> None:
    """把一条待判问题登记下来，这样用户回一句时能被认成答复，而不是新任务。"""
    data = load()
    question = (args.text or "").strip()
    if not question:
        raise SystemExit("问题不能为空")
    choices = json.loads(args.choices_json) if args.choices_json else []
    if not isinstance(choices, list) or len(choices) > 3:
        raise ValueError('最多提供三个选项')
    item = item_by_id(data,args.item) if args.item else None
    seen = set()
    for choice in choices:
        if not isinstance(choice,dict) or not isinstance(choice.get('label'),str) or not choice['label'].strip():
            raise ValueError('选项需要 label')
        replies = choice.get('replies', [])
        if not isinstance(replies,list) or any(not isinstance(r,str) for r in replies):
            raise ValueError('replies 必须是文字列表')
        keys = {choice['label'], *replies}
        if keys & seen:
            raise ValueError('选项回复不能重复')
        seen |= keys
        if choice.get('status') and (not item or choice['status'] not in (TASK_STATUS if item['type']=='task' else IDEA_STATUS)):
            raise ValueError('选项的条目或状态无效')
    question_id = new_id('q')
    data.setdefault("pending", []).append({
        "id": question_id,
        "question": question,
        "item": args.item or None,
        "asked": iso(),
        "answered": False,
        "answer": None,
        "choices": choices,
        "prepared": args.prepared,
        "item_revision": item_revision(item) if item else None,
    })
    save(data)
    print(json.dumps({"ok": True, "id": question_id, "pending": len([p for p in data["pending"] if not p.get("answered")])},
                     ensure_ascii=False))


def cmd_question_sent(args):
    data = load()
    entry = next((p for p in data['pending'] if p['id'] == args.id), None)
    if not entry or entry.get('answered'):
        raise ValueError('问题不存在或已回答')
    entry.update(prepared=False, sent_at=iso())
    save(data)
    print(json.dumps({'ok':True}))


def cmd_resolve(args) -> None:
    """销掉一条待判：用户用行动回答的（点了变成任务、改了日期），也算答了。"""
    data = load()
    target = None
    for entry in data.get("pending", []):
        if entry.get("id") == args.id or (not args.id and not entry.get("answered")):
            target = entry
            break
    if not target:
        raise SystemExit("找不到这条待判")
    target["answered"] = True
    target["answer"] = args.answer or "（已用行动处理）"
    target["answered_at"] = iso()
    target["resolved_by"] = "action" if not args.answer else "agent"
    save(data)
    print(json.dumps({"ok": True, "id": target["id"], "question": target["question"]},
                     ensure_ascii=False))


def cmd_pending(_args) -> None:
    data = load()
    open_items = [p for p in data.get("pending", []) if not p.get("answered")]
    print(json.dumps({"open": open_items,
                      "answered": [p for p in data.get("pending", []) if p.get("answered")]},
                     ensure_ascii=False))


def cmd_triage(args) -> None:
    """收到消息就地分诊：分类、抽时间、归位、返回一句回执。

    插件在收到微信的瞬间调它，所以回执是即时的，不用等定时任务。
    判断规则与 RULES.md §1 一致；agent 的定时分诊只是补漏，不是主路。
    """
    data = load()
    raw = (args.text or "").strip()
    reply = {"ok": True, "created": None, "receipt": ""}
    if args.validate_plan:
        plan = json.load(sys.stdin)
        journal_llm.validate(plan, raw, data['projects'])
        print(json.dumps({'ok': True}))
        return
    if not raw:
        print(json.dumps(reply, ensure_ascii=False))
        return

    urls = URL_RE.findall(raw)
    rest = BOILER_RE.sub("", URL_RE.sub("", raw)).strip()
    # 纯链接归碎片阅读服务，这边不出声（免得一次发送两条回执）
    if urls and not rest:
        print(json.dumps(reply, ensure_ascii=False))
        return

    ev = args.ev or ev_hash(args.at or "", raw)
    previous = data.get('llm_triage', {}).get(ev)
    if previous:
        print(json.dumps({**previous, 'duplicate': True, 'receipt': repeated_receipt(data, ev)}, ensure_ascii=False))
        return
    answered = next((p for p in data.get('pending', []) if p.get('answer_ev') == ev), None)
    if answered:
        print(json.dumps({'ok':True,'duplicate':True,'answered':answered['id'],'receipt':'这条答复已保存，未重复处理。'},ensure_ascii=False))
        return
    existing = next((i for i in data["items"] if i.get("ev") == ev), None)
    if not args.plan and not existing and len(active_questions(data)) > 1 and raw.strip('。！! ') in ('对','是','是的','不是','好','好的','先不做','第一个','第二个','第三个','1','2','3'):
        if not capture_has(ev):
            capture_append({'at':args.at or iso(),'text':raw,'urls':[],'ev':ev,'kind':'answer_uncertain'})
        questions = active_questions(data)
        print(json.dumps({'ok':True,'receipt':'答复原文已保存，但尚未修改任务：有多个待确认问题。请带上任务名或问题内容再回复。','uncertain':True},ensure_ascii=False))
        return

    # 有没答的待判时，短文本可能是在回答。但**必须字面真的对上**：
    # 光"没有时间词"远远不够，否则一句「仓库还要优化」会被当成回答问题的答案。
    if not args.plan and not existing and not urls and data.get("pending") and len(raw) <= 80:
        target, score, ratio = match_pending(data, raw)
        if target and score >= 2 and ratio >= 0.2:
            target["answered"] = True
            target["answer"] = raw
            target["answered_at"] = iso()
            target['answer_ev'] = ev
            # 就算判成答复，原文也必须进证据层——判错了还能捞回来重放
            if not capture_has(ev):
                capture_append({"at": args.at or iso(), "text": rest or raw, "urls": [],
                                "ev": ev, "kind": "answer"})
            head = target["question"][:24]
            receipt = f'已保存答复：{raw}（对应问题：{head}）。任务尚未修改，待核对。'
            short = raw.strip().strip('。！!，, ')
            choices = target.get('choices', [])
            index = {'第一个':0,'第二个':1,'第三个':2,'1':0,'2':1,'3':2}.get(short)
            choice = choices[index] if index is not None and index < len(choices) else next((c for c in choices if short == c['label'] or short in c.get('replies',[])),None)
            if choice and choice.get('status'):
                item = next((i for i in data['items'] if i['id'] == target.get('item')),None)
                if item and item_revision(item) == target.get('item_revision'):
                    stamp = iso()
                    item.setdefault('history',[]).append({'at':stamp,'field':'status','from':item['status'],'to':choice['status'],'answer_ev':ev})
                    item.update(status=choice['status'],updated=stamp)
                    label = {'open':'待办','done':'已完成','parked':'已暂缓','dropped':'已放弃','new':'已保存','promoted':'已转为任务'}[choice['status']]
                    receipt = f'已更新状态：「{item["text"]}」→ {label}。'
                    target['applied'] = True
                else:
                    receipt = '已保存你的选择，但未修改任务：任务已在其他地方更新，请核对最新状态。'
            target['receipt'] = receipt
            save(data)
            render(data)
            reply.update(answered=target["id"],
                         receipt=receipt)
            print(json.dumps(reply, ensure_ascii=False))
            return
    if existing:
        project = find_project(data, existing.get("project"))
        reply.update(created=existing["id"], duplicate=True,
                     receipt=repeated_receipt(data, ev))
        print(json.dumps(reply, ensure_ascii=False))
        return

    if args.check_reply:
        print(json.dumps({'needs_classification': True}))
        return
    if args.prepare:
        if not capture_has(ev):
            capture_append({'at': args.at or iso(), 'text': raw, 'urls': urls, 'ev': ev})
        print(json.dumps({'needs_llm': True, 'ev': ev, 'text': raw,
                          'received_at': args.at or iso(), 'timezone': 'Asia/Shanghai',
                          'projects': project_list(data)}, ensure_ascii=False))
        return
    if args.plan:
        plan = json.load(sys.stdin) if args.plan == '-' else json.loads(Path(args.plan).read_text(encoding='utf-8-sig'))
        proposals, model = journal_llm.validate(plan, raw, data['projects'])
        stamp = iso()
        created = []
        for index, proposal in enumerate(proposals):
            kind = proposal['type']
            created.append({
                'id': new_id('t' if kind == 'task' else 'k'), 'type': kind,
                'text': proposal['text'], 'note': proposal['note'],
                'project': proposal['project'], 'status': 'open' if kind == 'task' else 'new',
                'due': proposal['due'], 'due_raw': proposal['time_quote'] if proposal['due'] else None,
                'at': proposal['at'], 'at_raw': proposal['time_quote'] if proposal['at'] else None,
                'place': proposal['place'], 'created': stamp, 'updated': stamp,
                'source': 'wechat', 'ev': ev, 'ev_part': index, 'llm': model,
                'quote': proposal['quote'],
                'history': [{'at': stamp, 'field': 'text', 'from': raw, 'to': proposal['text'], 'by': 'llm'}],
            })
        if not capture_has(ev):
            capture_append({'at': args.at or stamp, 'text': raw, 'urls': urls, 'ev': ev,
                            **({'source_messages': plan['source_messages']} if 'source_messages' in plan else {})})
        data['items'].extend(created)
        data['cursor']['lastIngestAt'] = stamp
        receipt = ''
        if len(created) == 1:
            project = find_project(data, created[0]['project'])
            receipt = build_receipt(created[0], project['name'] if project else None,
                                    clash_with({'items': [i for i in data['items'] if i.get('ev') != ev]}, created[0]))
        elif created:
            receipt = build_multi_receipt(created, data)
        elif not urls:
            receipt = '原文已保存，没有新增记录。'
        reply.update(created=created[0]['id'] if created else None, ids=[i['id'] for i in created],
                     receipt=receipt, engine='llm', model=model)
        data.setdefault('llm_triage', {})[ev] = reply
        save(data)
        render(data)
        print(json.dumps(reply, ensure_ascii=False))
        return

    # 通知/公告走另一条路：整份当成一次来源，只抽主事件和行动项，
    # 不按句切——否则「各位同学大家好」会变成一条想法。
    if is_announcement(rest or raw):
        announced = build_announcement(rest or raw, ev, args.at or iso())
        if announced:
            if not capture_has(ev):
                capture_append({"at": args.at or iso(), "text": rest or raw, "urls": urls, "ev": ev})
            data["items"].extend(announced)
            data["cursor"]["lastIngestAt"] = iso()
            save(data)
            render(data)
            reply.update(created=announced[0]["id"], ids=[i["id"] for i in announced],
                         receipt=build_announce_receipt(announced))
            print(json.dumps(reply, ensure_ascii=False))
            return

    when_all = match_project(data, rest or raw)
    created: list[dict] = []
    for index, clause in enumerate(split_clauses(rest or raw)[:6]):
        if URL_RE.fullmatch(clause):
            continue
        when_raw, body = extract_when(clause)
        if len(body) < 2:
            continue
        # 先按**原句**判类型：时间短语被剥掉后，「明天下午比较 λ」会看不出是任务
        kind = classify_text(clause)
        project = match_project(data, body) or when_all
        item = {
            "id": new_id("t" if kind == "task" else "k"),
            "type": kind,
            "text": body,
            "project": project["id"] if project else None,
            "status": "open" if kind == "task" else "new",
            "due": None,
            "due_raw": None,
            "at": None,
            "at_raw": None,
            "created": iso(),
            "updated": iso(),
            "source": "wechat",
            "ev": ev,
            "ev_part": index,
            "history": [],
        }
        parsed = parse_at(re.sub(r"(之前|以前|前)$", "", when_raw)) if when_raw else None
        if when_raw and parsed is None:
            # 认不出的时间（「这周」「本月底」）不能就这么丢了，原样并回正文
            body = f"{when_raw}{body}"
            item["text"] = body
        if kind == "task" and parsed:
            # 有「必须到场」的动词，或者给了具体时段（明天下午）→ 发生
            # 只有日期、或者「之前」→ 截止
            needs_presence = EVENT_RE.search(body) and not DEADLINE_RE.search(body)
            has_slot = bool(parsed.get("slot") or parsed.get("clock")) and not re.search(r"(之前|以前|前)$", when_raw)
            if (needs_presence and not re.search(r"(之前|以前|前)$", when_raw)) or has_slot:
                item["at"], item["at_raw"] = parsed, when_raw
            else:
                item["due"], item["due_raw"] = parsed["date"], when_raw
        created.append(item)

    if not created:
        print(json.dumps(reply, ensure_ascii=False))
        return

    if not capture_has(ev):
        capture_append({"at": args.at or iso(), "text": rest or raw, "urls": urls, "ev": ev})

    data["items"].extend(created)
    data["cursor"]["lastIngestAt"] = iso()
    save(data)
    render(data)
    if len(created) == 1:
        only = created[0]
        project = find_project(data, only.get("project"))
        others = [i for i in data["items"] if i["id"] != only["id"]]
        receipt = build_receipt(only, project["name"] if project else None,
                                clash_with({"items": others}, only))
    else:
        receipt = build_multi_receipt(created, data)
    reply.update(created=created[0]["id"], ids=[i["id"] for i in created], receipt=receipt)
    print(json.dumps(reply, ensure_ascii=False))


def cmd_add(args) -> None:
    data = load()
    if args.type not in TYPES:
        raise SystemExit(f"type 只能是 {TYPES}")
    project = None
    if args.project:
        project = find_project(data, args.project)
        if not project:
            raise SystemExit(
                f"项目「{args.project}」不存在。按规则，新建项目需要人批："
                f"先问用户，再 `project add --name {args.project}`。"
            )
    item = {
        "id": new_id("t" if args.type == "task" else "k" if args.type == "idea" else "r"),
        "type": args.type,
        "text": args.text.strip(),
        "project": project["id"] if project else None,
        "status": "open" if args.type == "task" else "new",
        "due": parse_due(args.due),
        "due_raw": args.due if args.due else None,
        "at": parse_at(args.at),
        "at_raw": args.at if args.at else None,
        "place": (args.place or "").strip() or None,
        "note": (args.note or "").strip() or None,
        "created": iso(),
        "updated": iso(),
        "source": args.src,
        "ev": args.ev,
        "history": [],
    }
    data["items"].append(item)
    save(data)
    render(data)
    print(json.dumps(item, ensure_ascii=False, indent=2))


def cmd_promote(args) -> None:
    """Create a linked task and promote the idea in one locked JSON commit."""
    data = load()
    idea = item_by_id(data, args.id)
    if idea["type"] != "idea":
        raise SystemExit("只有想法可以提升为任务")
    existing = next((i for i in data["items"] if i.get("promoted_from") == idea["id"]), None)
    if existing:
        if existing["type"] != "task":
            raise SystemExit("关联任务已被纠正为想法，请在该条目的详情中纠正类型")
        print(json.dumps({"ok": True, "id": existing["id"], "duplicate": True}))
        return
    if idea["status"] not in ("new", "parked"):
        raise SystemExit("这条想法已经处理，不能再次提升")
    stamp = iso()
    task = {**idea, "id": new_id("t"), "type": "task", "status": "open",
            "created": stamp, "updated": stamp, "history": [],
            "promoted_from": idea["id"]}
    idea["history"].append({"at": stamp, "field": "status", "from": idea["status"], "to": "promoted"})
    idea.update(status="promoted", updated=stamp, promoted_to=task["id"])
    data["items"].append(task)
    save(data)
    render(data)
    print(json.dumps({"ok": True, "id": task["id"]}))


def cmd_list(args) -> None:
    data = load()
    rows = data["items"]
    if args.type:
        rows = [r for r in rows if r["type"] == args.type]
    if args.status:
        rows = [r for r in rows if r["status"] == args.status]
    if args.project:
        p = find_project(data, args.project)
        rows = [r for r in rows if p and r["project"] == p["id"]]
    out = []
    for r in rows:
        p = find_project(data, r["project"]) if r.get("project") else None
        out.append({**r, "project_name": p["name"] if p else None,
                    "due_label": due_label(r.get("due")), "when": when_label(r)})
    print(json.dumps(out, ensure_ascii=False, indent=2))


def item_revision(item: dict) -> str:
    """Content version also detects edits within the same second."""
    return hashlib.sha256(json.dumps(item, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def cmd_detail(args) -> None:
    data = load()
    item = item_by_id(data, args.id)
    project = find_project(data, item.get("project"))
    sources = [
        {"at": row.get("at"), "text": row.get("text"), "urls": row.get("urls", [])}
        for row in capture_rows() if item.get("ev") and row.get("ev") == item["ev"]
    ]
    print(json.dumps({
        "item": {**item, "revision": item_revision(item)},
        "project_name": project["name"] if project else None,
        "sources": sources,
    }, ensure_ascii=False))


def checked_at_json(raw: str) -> dict | None:
    value = json.loads(raw)
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {"date", "slot", "clock"}:
        raise ValueError("发生时间格式无效")
    date = value.get("date")
    if not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        raise ValueError("请填写发生日期")
    dt.date.fromisoformat(date)
    slot, clock = value.get("slot") or None, value.get("clock") or None
    if slot and (not isinstance(slot, str) or not SLOT_RE.fullmatch(slot)):
        raise ValueError("发生时段无效")
    if clock:
        if not isinstance(clock, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", clock):
            raise ValueError("具体时间须为 00:00 至 23:59")
    return {"date": date, "slot": slot, "clock": clock}


def cmd_set(args) -> None:
    data = load()
    item = item_by_id(data, args.id)
    if args.expected_revision and args.expected_revision != item_revision(item):
        raise SystemExit("这条记录已被其他操作更新，未覆盖。请重新加载详情后核对再保存。")
    changes = {}
    target_type = args.type or item["type"]
    if args.type and (item["type"] not in ("task", "idea") or args.type not in ("task", "idea")):
        raise SystemExit("类型纠错只支持任务与想法")
    if target_type != item["type"]:
        changes["type"] = target_type
        # Preserve parked/dropped; completed tasks become undecided ideas.
        changes["status"] = item["status"] if item["status"] in ("parked", "dropped") else (
            "open" if target_type == "task" else "new"
        )
    if args.status:
        allowed = TASK_STATUS if target_type == "task" else IDEA_STATUS
        if args.status not in allowed:
            raise SystemExit(f"{target_type} 的状态只能是 {allowed}")
        changes["status"] = args.status
    if args.text is not None:
        if not args.text.strip():
            raise SystemExit("正文不能为空")
        changes["text"] = args.text.strip()
    if args.due is not None:
        changes["due"] = parse_due(args.due) if args.due else None
        if args.due and changes["due"] is None:
            raise SystemExit("无法识别截止日期，未保存")
        changes["due_raw"] = args.due or None
    if args.at is not None and args.at_json is not None:
        raise SystemExit("发生时间只能提供一种格式")
    if args.at is not None:
        changes["at"] = parse_at(args.at) if args.at else None
        if args.at and changes["at"] is None:
            raise SystemExit("无法识别发生时间，未保存")
        changes["at_raw"] = args.at or None
    if args.at_json is not None:
        try:
            changes["at"] = checked_at_json(args.at_json)
        except (ValueError, TypeError) as exc:
            raise SystemExit(str(exc))
        changes["at_raw"] = " ".join(
            value for value in (changes["at"] or {}).values() if value
        ) or None
    if args.ev:
        changes["ev"] = args.ev
    if args.place is not None:
        changes["place"] = args.place.strip() or None
    if args.note is not None:
        changes["note"] = args.note.strip() or None
    if args.project is not None:
        if args.project == "":
            changes["project"] = None
        else:
            p = find_project(data, args.project)
            if not p:
                raise SystemExit(f"项目「{args.project}」不存在（新建项目需要人批）")
            changes["project"] = p["id"]
    changes = {key: value for key, value in changes.items() if item.get(key) != value}
    stamp = iso()
    for field, value in changes.items():
        item["history"].append({"at": stamp, "field": field, "from": item.get(field), "to": value})
        item[field] = value
    if changes:
        item["updated"] = stamp
        save(data)
        render(data)
    print(json.dumps({"ok": True, "id": item["id"], "changed": list(changes)}, ensure_ascii=False))


def cmd_project(args) -> None:
    data = load()
    if args.action == "add":
        if find_project(data, args.name):
            raise SystemExit("已经有同名项目")
        project = {
            "id": new_id("p"),
            "name": args.name.strip(),
            "status": "active",
            "created": iso(),
            "file": "",
        }
        project["file"] = f"projects/{slug_for(project['name'], project['id'])}"
        data["projects"].append(project)
        write_project_file(project, {key: "" for key, _ in PROJECT_SECTIONS})
        save(data)
        render(data)
        print(json.dumps({**project, **project_fields(project)}, ensure_ascii=False))
        return
    if args.action == "set":
        target = find_project(data, args.id) if args.id else find_project(data, args.name)
        if not target:
            raise SystemExit("找不到这个项目")
        changed = []
        previous = {**target, **project_fields(target)}
        for field in ("name", "status"):
            value = getattr(args, field, None)
            if value is None or not value.strip():
                continue
            target[field] = value.strip()
            changed.append(field)
        fields = project_fields(target)
        for key, _ in PROJECT_SECTIONS:
            value = getattr(args, key, None)
            if value is None:
                continue
            fields[key] = value.strip()
            changed.append(key)
        if changed:
            write_project_file(target, fields)
            target["updated"] = iso()
            for field in changed:
                value = fields[field] if field in fields else target[field]
                if previous.get(field) != value:
                    target.setdefault("history", []).append({"at": target["updated"], "field": field, "from": previous.get(field), "to": value})
            save(data)
            render(data)
        print(json.dumps({"ok": True, "id": target["id"], "changed": changed,
                          "file": target.get("file")}, ensure_ascii=False))
        return
    if args.action == "remove":
        target = find_project(data, args.id) if args.id else find_project(data, args.name)
        if not target:
            raise SystemExit("找不到这个项目")
        data["projects"] = [p for p in data["projects"] if p["id"] != target["id"]]
        # 项目删了，条目不能跟着消失：解除项目关联，历史留痕
        moved = 0
        for it in data["items"]:
            if it.get("project") == target["id"]:
                it["history"].append({"at": iso(), "field": "project", "from": target["id"], "to": None})
                it["project"] = None
                it["updated"] = iso()
                moved += 1
        save(data)
        render(data)
        print(json.dumps({"ok": True, "removed": target["name"], "items_detached": moved},
                         ensure_ascii=False))
        return
    print(json.dumps(project_list(data), ensure_ascii=False, indent=2))


def inbox_counts() -> dict:
    counts = {"inbox": 0, "later": 0, "read": 0, "dropped": 0}
    if not INBOX.exists():
        return counts
    try:
        data = read_json(INBOX)
    except (ValueError, OSError):
        return counts
    for it in data.get("items", []):
        st = it.get("status")
        if st in counts:
            counts[st] += 1
    return counts


def render(data: dict | None = None) -> None:
    data = data or load()
    projects = [p for p in data["projects"] if p.get("status") == "active"]
    items = data["items"]
    tasks = [i for i in items if i["type"] == "task"]
    ideas = [i for i in items if i["type"] == "idea"]

    lines = ["# 现在", "",
             f"_{iso()[:16].replace('T', ' ')} 生成 · 别手改这个文件，要写东西去 `notebook.md`_", ""]

    for project in projects:
        mine = [t for t in tasks if t.get("project") == project["id"] and t["status"] in ("open", "parked")]
        questions = [i for i in ideas if i.get("project") == project["id"] and i["status"] in ("new", "parked")]
        fields = project_fields(project)
        lines.append(f"## {project['name']}")
        for key, label in (("goal", "要解决"), ("state", "现在"), ("next", "下一步")):
            value = (fields.get(key) or "").strip()
            if value:
                lines.append(f"- **{label}**：{value}")
        open_lines = [x.strip(" -") for x in (fields.get("open") or "").splitlines() if x.strip()]
        if open_lines or questions:
            lines.append("- **未决**：")
            for line in open_lines[:6]:
                lines.append(f"  - {line}")
            for q in questions[:6]:
                lines.append(f"  - {q['text']}")
        if mine:
            lines.append("")
            for t in sorted(mine, key=lambda x: (when_key(x), x["created"])):
                park = " _(暂缓)_" if t["status"] == "parked" else ""
                when = when_label(t)
                lines.append(f"- [ ] {t['text']}" + (f" — {when}" if when else "") + park)
                if t.get("note"):
                    lines.append(f"    {t['note']}")
        lines.append("")

    loose = [t for t in tasks if not t.get("project") and t["status"] in ("open", "parked")]
    if loose:
        lines.append("## 记录")
        for t in sorted(loose, key=lambda x: (when_key(x), x["created"])):
            when = when_label(t)
            lines.append(f"- {t['text']}" + (f" — {when}" if when else ""))
            if t.get("note"):
                lines.append(f"    {t['note']}")
        lines.append("")

    since = now() - dt.timedelta(days=14)
    recent = [i for i in ideas if i["status"] in ("new", "parked") and not i.get("project")
              and dt.datetime.fromisoformat(i["created"]) >= since]
    if recent:
        lines.append("## 最近的想法")
        for i in sorted(recent, key=lambda x: x["created"], reverse=True)[:8]:
            lines.append(f"- `{i['created'][5:10]}` {i['text']}")
        lines.append("")

    done = [t for t in tasks if t["status"] == "done"]
    dropped = [i for i in items if i["status"] == "dropped"]
    counts = inbox_counts()
    lines.append("## 数")
    timed = [t for t in tasks if t["status"] == "open" and t.get("at")]
    lines.append(
        f"记录 {len(tasks)} 条 · 带时间 {len(timed)} 条 · "
        f"想法 {len([i for i in ideas if i['status'] in ('new', 'parked')])} 条 · "
        f"已丢 {len(dropped)} · 碎片阅读待读 {counts['inbox'] + counts['later']}"
    )
    lines.append("")

    BOARD.write_text("\n".join(lines), "utf-8")


def cmd_render(_args) -> None:
    render()
    print(BOARD.read_text("utf-8"))


def cmd_status(_args) -> None:
    data = load()
    items = data["items"]
    tasks = [i for i in items if i["type"] == "task" and i["status"] == "open"]
    today = day().isoformat()
    stale = [i for i in items
             if i["status"] in ("parked", "new")
             and (now() - dt.datetime.fromisoformat(i["created"])).days > 30]
    horizon = (day() + dt.timedelta(days=2)).isoformat()

    def event_row(t):
        when = t.get("at") or {}
        return {"id": t["id"], "text": t["text"], "at": at_label(t.get("at")),
                "date": when.get("date"), "slot": when.get("slot"), "clock": when.get("clock")}

    events = [event_row(t) for t in tasks if (t.get("at") or {}).get("date")]
    summary = {
        "today": today,
        "projects": [p["name"] for p in data["projects"] if p.get("status") == "active"],
        "open_tasks": len(tasks),
        "due_today_or_overdue": [
            {"id": t["id"], "text": t["text"], "due": t.get("due")}
            for t in tasks if t.get("due") and t["due"] <= today
        ],
        "events_today": [e for e in events if e["date"] == today],
        "events_next48h": [e for e in events if today <= e["date"] <= horizon],
        "loose_tasks": [{"id": t["id"], "text": t["text"], "when": when_label(t)} for t in tasks if not t.get("project")],
        "new_ideas": [{"id": i["id"], "text": i["text"], "created": i["created"]}
                      for i in items if i["type"] == "idea" and i["status"] == "new"],
        "stale_over_30d": [{"id": i["id"], "text": i["text"]} for i in stale],
        "pending": [{"id": p["id"], "question": p["question"]}
                    for p in data.get("pending", []) if not p.get("answered")],
        "reading": inbox_counts(),
        "last_ingest": data["cursor"].get("lastIngestAt"),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def cmd_heat(args) -> None:
    """按天统计记录 / 想法 / 完成，供热力图和字符条使用。"""
    data = load()
    days = max(7, min(int(args.days), 370))
    end = day()
    start = end - dt.timedelta(days=days - 1)
    rows = {(start + dt.timedelta(days=i)).isoformat(): {"capture": 0, "ideas": 0, "done": 0}
            for i in range(days)}

    for row in capture_rows():
        stamp = local_date(row.get("at"))
        if stamp in rows:
            rows[stamp]["capture"] += 1

    for it in data["items"]:
        stamp = local_date(it["created"])
        if stamp in rows:
            rows[stamp]["capture"] += 1
            if it["type"] == "idea":
                rows[stamp]["ideas"] += 1
        for entry in it.get("history", []):
            if entry.get("field") == "status" and entry.get("to") == "done":
                stamp = local_date(entry["at"])
                if stamp in rows:
                    rows[stamp]["done"] += 1

    series = [{"date": k, **v} for k, v in sorted(rows.items())]
    if args.text:
        print(spark(series))
    else:
        print(json.dumps({"days": days, "series": series}, ensure_ascii=False))


def local_date(stamp: str | None) -> str:
    """把带时区的时间戳折成本地日期；解析不了就空串。"""
    if not stamp:
        return ""
    try:
        value = dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=TZ)
    return value.astimezone(TZ).date().isoformat()


BARS = "▁▂▃▄▅▆▇█"


def spark(series: list[dict]) -> str:
    def line(values: list[int]) -> str:
        top = max(values) if values else 0
        if top <= 0:
            return "▁" * len(values)
        return "".join(BARS[min(len(BARS) - 1, round(v / top * (len(BARS) - 1)))] for v in values)

    records = [r["capture"] for r in series]
    done = [r["done"] for r in series]
    ideas = [r["ideas"] for r in series]
    return "\n".join([
        f"近 {len(series)} 天",
        f"记录  {line(records)}",
        f"想法  {line(ideas)}",
        f"完成  {line(done)}",
        "",
        f"合计：记录 {sum(records)} · 想法 {sum(ideas)} · 完成 {sum(done)}",
    ])


def notebook_review_state():
    path = DATA / "notebook.md"
    content = path.read_bytes() if path.exists() else b""
    digest = hashlib.sha256(content).hexdigest()
    reviews = _read_jsonl(REPORTS / "notebook-responses.jsonl") if (REPORTS / "notebook-responses.jsonl").exists() else []
    latest = reviews[-1] if reviews else None
    return {"hash": digest, "pending": not latest or latest.get("hash") != digest, "latest": latest, "responses": reviews[-100:]}


def cmd_notebook_review(args):
    state = notebook_review_state()
    if not args.file:
        print(json.dumps({**state, "notebook": (DATA / "notebook.md").read_text(encoding="utf-8-sig") if (DATA / "notebook.md").exists() else "",
                          "sections": journal_notebook.snapshot(DATA)["sections"],
                          "projects": project_list(load()), "items": load()["items"], "file_sources": journal_sources.scan(DATA, {p["id"] for p in load()["projects"]})}, ensure_ascii=False))
        return
    entry = json.loads(Path(args.file).read_text(encoding="utf-8-sig"))
    if entry.get("hash") != state["hash"]:
        raise SystemExit("本子已修改，请重新读取后再保存回应")
    response = entry.get("response")
    response_date = entry.get("date")
    if response_date is not None:
        dt.date.fromisoformat(response_date)
    if not isinstance(response, str) or not response.strip() or len(response) > 20000:
        raise SystemExit("回应不能为空且不能超过 20000 字")
    if state["latest"] and state["latest"].get("hash") == state["hash"] and state["latest"].get("response") == response.strip() and state["latest"].get("date") == response_date:
        print(json.dumps({"ok": True, "unchanged": True}))
        return
    REPORTS.mkdir(parents=True, exist_ok=True)
    with (REPORTS / "notebook-responses.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"at": iso(), "hash": state["hash"], "response": response.strip(), "date": response_date}, ensure_ascii=False) + "\n")
    print(json.dumps({"ok": True}))


def cmd_sources(args):
    data = load()
    if args.action == 'browse':
        print(json.dumps(journal_sources.browse(DATA, args.root), ensure_ascii=False))
        return
    if args.action in ('bind', 'unbind'):
        journal_sources.bind(DATA, args.id, args.root, {p['id'] for p in data['projects']}, remove=args.action == 'unbind')
    if args.action == 'scan':
        journal_evidence.collect(DATA, data, scan=True)
        save(data)
    result = journal_sources.status(DATA)
    print(json.dumps(result, ensure_ascii=False))


def cmd_context(args):
    data = load()
    journal_evidence.collect(DATA, data, scan=args.offset == 0)
    save(data)
    pending = [r for r in data['evidence'] if r['status'] == 'pending']
    # Page through evidence; never silently omit the remainder.
    offset = max(0, args.offset)
    print(json.dumps({'projects': project_list(data), 'items': data['items'],
        'pending_questions': data['pending'], 'notebook_review': notebook_review_state(),
        'sources': [{k:v for k,v in s.items() if k != 'events'} for s in journal_sources.status(DATA)], 'notion': journal_evidence.overview(DATA,data)['notion'],
        'external_sources': journal_evidence.overview(DATA,data)['handoff'],
        'evidence': [journal_evidence.batch_context(data,r) for r in pending[offset:offset+args.limit]], 'total': len(pending),
        'next_offset': offset+args.limit if offset+args.limit < len(pending) else None}, ensure_ascii=False))


def cmd_evidence(args):
    data = load()
    payload = json.loads(Path(args.file).read_text(encoding='utf-8-sig'))
    result = journal_evidence.summarize_batch(data,payload) if payload.get('decision')=='summarize' else journal_evidence.undo(data,payload) if payload.get('decision')=='undo' else journal_evidence.decide(DATA, data, payload, project_fields, write_project_file)
    save(data)
    render(data)
    print(json.dumps(result, ensure_ascii=False))


def cmd_notion_import(args):
    payload = json.loads(Path(args.file).read_text(encoding='utf-8-sig'))
    from urllib.parse import urlparse
    if not isinstance(payload.get('pages'), list) or not payload.get('snapshot_at'):
        raise ValueError('需要 pages 和 snapshot_at；仅导入可核对的读取快照')
    dt.datetime.fromisoformat(payload['snapshot_at'].replace('Z', '+00:00'))
    for page in payload['pages']:
        url = urlparse(page.get('url',''))
        if url.scheme != 'https' or url.hostname not in ('app.notion.com','www.notion.so','notion.so'):
            raise ValueError('文献来源必须是 Notion 页面链接')
        if not isinstance(page.get('text'), str) or len(page['text']) > 1000000:
            raise ValueError('文献正文格式错误或过长')
    temp = DATA / 'notion-import.tmp'
    temp.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    os.replace(temp, DATA / 'notion-snapshot.json')
    data = load()
    journal_evidence.collect(DATA, data)
    save(data)
    print(json.dumps({'ok':True,'pages':len(payload['pages']),'automatic':False}))


def cmd_notebook_day(args):
    payload = json.loads(Path(args.file).read_text(encoding="utf-8-sig"))
    if not isinstance(payload.get("text"), str) or not isinstance(payload.get("key"), str):
        raise SystemExit("缺少日期或正文")
    try:
        journal_notebook.save_day(DATA, payload["key"], payload["text"], payload.get("revision"), payload.get("base"), payload.get("existed"))
    except ValueError as error:
        raise SystemExit(str(error))
    print(json.dumps({"ok": True}))


def cmd_chat_context(_args) -> None:
    """Read-only snapshot for conversation: no scans, collection or journal writes."""
    data = load()
    print(json.dumps({'projects': project_list(data), 'items': data['items'],
                      'notebook': (DATA / 'notebook.md').read_text(encoding='utf-8-sig')
                      if (DATA / 'notebook.md').exists() else ''}, ensure_ascii=False))


def cmd_state(_args) -> None:
    """面板要的一整份状态：身份 + 四问 + 条目 + 统计。"""
    data = load()
    if (DATA/'handoff.json').exists():
        previous_count = len(data.get('evidence',[]))
        journal_evidence.collect(DATA,data)
        if len(data.get('evidence',[])) != previous_count:
            save(data)
    items = []
    for it in data["items"]:
        items.append({**it, "when": when_label(it)})
    stats = {
        "open": sum(1 for i in items if i["type"] == "task" and i["status"] == "open"),
        "parked": sum(1 for i in items if i["status"] == "parked"),
        "done": sum(1 for i in items if i["status"] == "done"),
        "ideas": sum(1 for i in items if i["type"] == "idea" and i["status"] == "new"),
        "dropped": sum(1 for i in items if i["status"] == "dropped"),
        "reading": inbox_counts(),
    }
    print(json.dumps({"projects": project_list(data), "items": items, "stats": stats, "notebook_review": notebook_review_state(), "notebook_view": journal_notebook.snapshot(DATA), "file_sources": journal_sources.status(DATA), "evidence": journal_evidence.overview(DATA, data)},
                     ensure_ascii=False))


def cmd_recent(args) -> None:
    """最近改动：谁、什么时候、把什么改成了什么。"""
    data = load()
    events: list[dict] = []
    for it in data["items"]:
        for entry in it.get("history", []):
            events.append({
                "at": entry.get("at"),
                "kind": it["type"],
                "target": it["text"],
                "field": entry.get("field"),
                "from": entry.get("from"),
                "to": entry.get("to"),
            })
    for project in project_list(data):
        for entry in project.get("history", []):
            events.append({**entry, "kind": "project", "target": project["name"]})
        if project.get("mtime") and project["mtime"] > max((e.get("at") or "" for e in project.get("history", [])), default=""):
            events.append({"at": project["mtime"], "kind": "project",
                           "target": project["name"], "field": "文件", "from": None, "to": None})
    events = [e for e in events if e.get("at") and not e.get('retracted')]
    events.sort(key=lambda e: e["at"], reverse=True)
    print(json.dumps(events[: int(args.limit)], ensure_ascii=False))


def cmd_search(args) -> None:
    """在项目文件、条目、本子和原始记录里找字面串。语义检索不在这层做。"""
    query = (args.q or "").strip().lower()
    limit = int(args.limit)
    if not query:
        print(json.dumps([], ensure_ascii=False))
        return
    data = load()
    hits: list[dict] = []

    for project in project_list(data):
        path = Path(project["path"])
        if not path.exists():
            continue
        for number, line in enumerate(path.read_text("utf-8").splitlines(), 1):
            if query in line.lower():
                hits.append({"where": project["name"], "kind": "project", "line": number,
                             "snippet": line.strip()[:180], "path": project["path"]})

    for it in data["items"]:
        if query in (it.get("text") or "").lower():
            hits.append({"where": it["text"][:48], "kind": it["type"], "id": it["id"],
                         "snippet": it["text"][:180]})

    notebook = DATA / "notebook.md"
    if notebook.exists():
        for number, line in enumerate(notebook.read_text("utf-8").splitlines(), 1):
            if query in line.lower():
                hits.append({"where": "本子", "kind": "notebook", "line": number,
                             "snippet": line.strip()[:180]})

    for row in capture_rows()[-800:]:
        text = (row.get("text") or "")
        if query in text.lower():
            hits.append({"where": local_date(row.get("at")), "kind": "capture",
                         "snippet": text[:180], "at": row.get("at")})

    print(json.dumps(hits[:limit], ensure_ascii=False))


def cmd_migrate(_args) -> None:
    """把旧的单文件存储迁移到「项目 Markdown + 按日原始记录」。幂等。"""
    CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    data = load()
    report = {"capture_split": 0, "projects_materialised": 0}

    if CAPTURE.exists():
        rows = _read_jsonl(CAPTURE)
        for row in rows:
            capture_append(row)
        report["capture_split"] = len(rows)
        CAPTURE.rename(CAPTURE.with_suffix(".jsonl.bak"))

    for entry in data["projects"]:
        if entry.get("file"):
            continue
        entry["file"] = f"projects/{slug_for(entry.get('name', ''), entry['id'])}"
        fields = {key: (entry.pop(key, "") or "") for key, _ in PROJECT_SECTIONS}
        write_project_file(entry, fields)
        report["projects_materialised"] += 1

    if report["projects_materialised"]:
        save(data)
    render(data)
    print(json.dumps({"ok": True, **report}, ensure_ascii=False))


# ---------------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(prog="journal")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init").set_defaults(fn=cmd_init)
    sub.add_parser("ingest").set_defaults(fn=cmd_ingest)

    p = sub.add_parser("triage")
    p.add_argument("--text", required=True)
    p.add_argument("--at", default="")
    p.add_argument("--ev", default="")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--prepare', action='store_true', help='保存原文并返回 LLM 分诊上下文')
    mode.add_argument('--check-reply', action='store_true', help='只检查已有答复和重复消息，不新增记录')
    mode.add_argument('--validate-plan', action='store_true', help='从 stdin 校验提议，不保存记录')
    mode.add_argument('--plan', default='', help='经过校验的 LLM JSON 提议；- 表示 stdin')
    p.set_defaults(fn=cmd_triage)

    sub.add_parser("render").set_defaults(fn=cmd_render)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    sub.add_parser("state").set_defaults(fn=cmd_state)
    sub.add_parser("chat-context").set_defaults(fn=cmd_chat_context)
    p = sub.add_parser("sources")
    p.add_argument("action", choices=("scan", "status", "bind", "unbind", "browse"))
    p.add_argument('--id', default='')
    p.add_argument('--root', default='')
    p.set_defaults(fn=cmd_sources)
    p = sub.add_parser('context')
    p.add_argument('--offset', type=int, default=0)
    p.add_argument('--limit', type=int, choices=range(1, 31), default=30)
    p.set_defaults(fn=cmd_context)
    p = sub.add_parser('evidence')
    p.add_argument('--file', required=True)
    p.set_defaults(fn=cmd_evidence)
    p = sub.add_parser('notion-import')
    p.add_argument('--file', required=True)
    p.set_defaults(fn=cmd_notion_import)
    p = sub.add_parser("notebook-day")
    p.add_argument("--file", required=True)
    p.set_defaults(fn=cmd_notebook_day)
    sub.add_parser("pending").set_defaults(fn=cmd_pending)

    p = sub.add_parser("ask")
    p.add_argument("--text", required=True)
    p.add_argument("--item", default="")
    p.add_argument('--choices-json', default='')
    p.add_argument('--prepared', action='store_true')
    p.set_defaults(fn=cmd_ask)
    p = sub.add_parser('question-sent')
    p.add_argument('--id', required=True)
    p.set_defaults(fn=cmd_question_sent)

    p = sub.add_parser("resolve")
    p.add_argument("--id", default="")
    p.add_argument("--answer", default="")
    p.set_defaults(fn=cmd_resolve)

    p = sub.add_parser("notebook-review")
    p.add_argument("--file")
    p.set_defaults(fn=cmd_notebook_review)
    sub.add_parser("migrate").set_defaults(fn=cmd_migrate)

    p = sub.add_parser("recent")
    p.add_argument("--limit", default="40")
    p.set_defaults(fn=cmd_recent)

    p = sub.add_parser("search")
    p.add_argument("--q", required=True)
    p.add_argument("--limit", default="30")
    p.set_defaults(fn=cmd_search)

    p = sub.add_parser("heat")
    p.add_argument("--days", default="30")
    p.add_argument("--text", action="store_true", help="输出字符条，便于直接发微信")
    p.set_defaults(fn=cmd_heat)

    p = sub.add_parser("add")
    p.add_argument("--type", required=True)
    p.add_argument("--text", required=True)
    p.add_argument("--project")
    p.add_argument("--due")
    p.add_argument("--at")
    p.add_argument("--place")
    p.add_argument("--note")
    p.add_argument("--src", default="wechat")
    p.add_argument("--ev")
    p.set_defaults(fn=cmd_add)

    p = sub.add_parser("promote")
    p.add_argument("--id", required=True)
    p.set_defaults(fn=cmd_promote)

    p = sub.add_parser("list")
    p.add_argument("--type")
    p.add_argument("--status")
    p.add_argument("--project")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("set")
    p.add_argument("--id", required=True)
    p.add_argument("--type", choices=["task", "idea"])
    p.add_argument("--expected-revision")
    p.add_argument("--status")
    p.add_argument("--text")
    p.add_argument("--due")
    p.add_argument("--at")
    p.add_argument("--at-json")
    p.add_argument("--place")
    p.add_argument("--note")
    p.add_argument("--project")
    p.add_argument("--ev")
    p.set_defaults(fn=cmd_set)

    p = sub.add_parser("detail")
    p.add_argument("--id", required=True)
    p.set_defaults(fn=cmd_detail)

    p = sub.add_parser("project")
    p.add_argument("action", choices=["add", "list", "remove", "set"])
    p.add_argument("--name", default="")
    p.add_argument("--id", default="")
    p.add_argument("--goal", default=None, help="要解决什么")
    p.add_argument("--state", default=None, help="做到哪、确认了什么")
    p.add_argument("--next", default=None, help="下一步")
    p.add_argument("--open", default=None, help="还没决定的疑问，一行一条")
    p.add_argument("--status", default=None)
    p.set_defaults(fn=cmd_project)

    args = ap.parse_args()
    if getattr(args, "fn", None) is cmd_project and args.action == "add" and not args.name.strip():
        raise SystemExit("project add 需要 --name")
    with store_lock():
        args.fn(args)


if __name__ == "__main__":
    main()

