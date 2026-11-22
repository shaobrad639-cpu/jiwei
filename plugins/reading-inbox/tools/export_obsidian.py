"""Mirror collected articles into an Obsidian vault.

Every inbox item that already carries a body becomes one Markdown note under
``<vault>/<folder>/YYYY-MM-DD_标题.md``. The note keeps the source URL and the
publication time in its front matter so Obsidian can index it.

The script is idempotent: a note whose rendered text has not changed is left
alone, so it is safe to run after every capture.

Usage:
    python export_obsidian.py --inbox <inbox.json> --vault <vault> [--folder F]
    python export_obsidian.py ... --item it_ab12cd34     # one item only
    python export_obsidian.py ... --dry-run              # report, write nothing

Output is one JSON object on stdout:
    {"ok": true, "written": [...], "skipped": [...], "errors": [...]}
"""

import argparse
import json
import re
import sys
from pathlib import Path

DEFAULT_FOLDER = "Weixin_Article_Analysis"
INDEX_NAME = "_sync-index.json"
BAD_NAME = re.compile(r'[\\/:*?"<>|\r\n\t]+')
DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def _safe_name(text: str, limit: int = 80) -> str:
    name = BAD_NAME.sub("_", (text or "").strip()).strip(" ._")
    name = re.sub(r"\s+", " ", name)
    return name[:limit] or "untitled"


def _date_of(item: dict) -> str:
    """Publication date when known, else the day the link was collected."""
    for key in ("publishTime", "addedAt"):
        value = item.get(key)
        if isinstance(value, str):
            found = DATE_RE.search(value)
            if found:
                return found.group(1)
    return "0000-00-00"


def _yaml_scalar(value) -> str:
    text = str(value if value is not None else "").replace("\n", " ").strip()
    if not text:
        return '""'
    if re.fullmatch(r"[A-Za-z0-9\u4e00-\u9fff _\-./:()（）！？、，·]+", text) and not text.startswith(("-", "?", ":")):
        return text
    return json.dumps(text, ensure_ascii=False)


def _tags(item: dict) -> list:
    tags = [t for t in (item.get("tags") or []) if isinstance(t, str) and t.strip()]
    merged = ["公众号"]
    for tag in tags:
        if tag not in merged:
            merged.append(tag)
    kind = (item.get("kind") or "").strip()
    if kind and kind not in merged:
        merged.append(kind)
    return merged


def render(item: dict) -> str:
    title = (item.get("title") or "").strip() or "未命名文章"
    body = (item.get("body") or "").strip()
    url = (item.get("url") or "").strip()
    site = (item.get("site") or "").strip()
    author = (item.get("author") or site or "").strip()
    publish = (item.get("publishTime") or "").strip()
    added = (item.get("addedAt") or "").strip()
    summary = (item.get("summary") or "").strip()

    lines = ["---", f"title: {_yaml_scalar(title)}"]
    if url:
        lines.append(f"source: {_yaml_scalar(url)}")
    if author:
        lines.append(f"author: {_yaml_scalar(author)}")
    if publish:
        lines.append(f"publish_time: {_yaml_scalar(publish)}")
    if added:
        lines.append(f"collected_at: {_yaml_scalar(added)}")
    lines.append(f"chars: {len(body)}")
    tags = _tags(item)
    lines.append("tags:")
    lines.extend(f"  - {_yaml_scalar(tag)}" for tag in tags)
    lines.append("---")
    lines.append("")
    lines.append(f"# {title}")
    lines.append("")
    if url:
        label = author or site or "原文"
        lines.append(f"> **来源**：[{label}]({url})")
    if publish:
        lines.append(f"> **发布时间**：{publish}")
    if summary and summary not in body:
        lines.append(f"> **摘要**：{summary}")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(body)
    lines.append("")
    return "\n".join(lines)


def _read_index(target: Path) -> dict:
    path = target / INDEX_NAME
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_index(target: Path, index: dict) -> None:
    path = target / INDEX_NAME
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def export(inbox: Path, vault: Path, folder: str, only: str = "", dry_run: bool = False) -> dict:
    if not inbox.exists():
        return {"ok": False, "error": f"找不到收件箱：{inbox}", "written": [], "skipped": [], "errors": []}
    try:
        data = json.loads(inbox.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        return {"ok": False, "error": f"收件箱读取失败：{error}", "written": [], "skipped": [], "errors": []}

    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return {"ok": False, "error": "收件箱格式无效", "written": [], "skipped": [], "errors": []}

    target = vault / folder if folder else vault
    index = _read_index(target)
    written, skipped, errors, removed = [], [], [], []
    for item in items:
        if not isinstance(item, dict):
            continue
        item_id = item.get("id")
        if only and item_id != only:
            continue
        body = item.get("body")
        if not isinstance(body, str) or not body.strip():
            continue
        title = (item.get("title") or "").strip()
        if not title:
            errors.append({"id": item_id, "error": "缺少标题，跳过以免覆盖同名文件"})
            continue
        name = f"{_date_of(item)}_{_safe_name(title)}.md"
        path = target / name
        content = render(item)
        try:
            # A retitled or re-dated article lands on a new filename; drop the
            # note this item produced last time so the vault keeps one copy.
            previous = index.get(item_id)
            if previous and previous != name:
                stale = target / previous
                if stale.exists() and stale.is_file():
                    if not dry_run:
                        stale.unlink()
                    removed.append({"id": item_id, "path": str(stale)})
            if path.exists() and path.read_text(encoding="utf-8") == content:
                skipped.append({"id": item_id, "path": str(path), "reason": "unchanged"})
                index[item_id] = name
                continue
            if not dry_run:
                target.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".md.tmp")
                tmp.write_text(content, encoding="utf-8")
                tmp.replace(path)
            written.append({"id": item_id, "path": str(path), "chars": len(body)})
            index[item_id] = name
        except OSError as error:
            errors.append({"id": item_id, "error": str(error)})

    if not dry_run and index:
        try:
            target.mkdir(parents=True, exist_ok=True)
            _write_index(target, index)
        except OSError as error:
            errors.append({"id": "", "error": f"索引写入失败：{error}"})

    return {"ok": not errors, "written": written, "skipped": skipped, "removed": removed, "errors": errors}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="把收件箱里的公众号文章同步到 Obsidian 库")
    parser.add_argument("--inbox", required=True, help="inbox.json 的路径")
    parser.add_argument("--vault", required=True, help="Obsidian 库根目录")
    parser.add_argument("--folder", default=DEFAULT_FOLDER, help=f"库内子目录，默认 {DEFAULT_FOLDER}")
    parser.add_argument("--item", default="", help="只同步这一条")
    parser.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    args = parser.parse_args(argv)

    result = export(Path(args.inbox).expanduser(), Path(args.vault).expanduser(),
                    args.folder, args.item.strip(), args.dry_run)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    sys.exit(main())
