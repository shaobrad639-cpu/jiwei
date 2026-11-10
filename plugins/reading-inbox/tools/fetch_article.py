"""Fetch a page and dump its readable text as JSON.

WeChat official-account articles matter most here: their body lives in
``<div id="js_content">`` and plain HTTP fetches normally succeed, while the
page still answers 环境异常 to clients it does not like. That wall is reported
instead of silently returning an empty string.

Usage:
    python fetch_article.py <url>            # JSON on stdout
    python fetch_article.py <url> out.txt    # also write the text to a file

Output is one JSON object:
    {"title": ..., "description": ..., "body": ..., "chars": N, "error": null}
"""

import html as htmllib
import json
import re
import sys

import requests

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)
WECHAT_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN"
)
# Pages that answer 200 but carry a verification wall instead of the article.
BLOCK_MARKERS = ("环境异常", "wappoc_appmsgcaptcha", "完成验证后即可继续访问")

BODY_LIMIT = 20000


def _clean(text: str) -> str:
    text = htmllib.unescape(text or "")
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def _to_text(fragment: str) -> str:
    fragment = re.sub(r"<script.*?</script>", " ", fragment, flags=re.S | re.I)
    fragment = re.sub(r"<style.*?</style>", " ", fragment, flags=re.S | re.I)
    fragment = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.I)
    fragment = re.sub(r"</(p|div|section|li|h[1-6]|tr|blockquote)>", "\n", fragment, flags=re.I)
    fragment = re.sub(r"<[^>]+>", "", fragment)
    return _clean(fragment)


def _pick(pattern: str, page: str) -> str:
    match = re.search(pattern, page, re.I | re.S)
    return _clean(match.group(1)) if match else ""


def _title(page: str) -> str:
    for pattern in (
        r'var\s+msg_title\s*=\s*[\'"](.*?)[\'"]',
        r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
        r'<h1[^>]*id=["\']activity-name["\'][^>]*>(.*?)</h1>',
        r"<title[^>]*>(.*?)</title>",
    ):
        found = _pick(pattern, page)
        if found and found not in ("微信公众平台", "Weixin Official Accounts Platform"):
            return found
    return ""


# Everything after one of these belongs to the page chrome, not the article.
BODY_END = ('<script', 'id="js_pc_qr_code"', 'class="rich_media_tool"', 'id="js_pc_qr_code"', 'id="js_temp_bottom_area"')


def _body(page: str) -> str:
    # Official-account article: the body sits in #js_content and is closed by
    # nested divs, so cut at the first footer marker rather than guessing </div>.
    match = re.search(r'id=["\']js_content["\'][^>]*>', page)
    if match:
        segment = page[match.end():]
        cuts = [segment.find(marker) for marker in BODY_END]
        cuts = [cut for cut in cuts if cut > 0]
        if cuts:
            segment = segment[: min(cuts)]
        return _to_text(segment)
    match = re.search(r"<article[^>]*>(.*?)</article>", page, re.S | re.I)
    if match:
        return _to_text(match.group(1))
    match = re.search(r"<body[^>]*>(.*?)</body>", page, re.S | re.I)
    return _to_text(match.group(1)) if match else ""


def _get(url: str, ua: str):
    return requests.get(
        url,
        headers={
            "user-agent": ua,
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9",
            "referer": "https://mp.weixin.qq.com/",
        },
        timeout=25,
        allow_redirects=True,
    )


def main(url: str) -> dict:
    response = None
    try:
        response = _get(url, UA)
        page = response.text
        if any(marker in page for marker in BLOCK_MARKERS):
            # The desktop UA was flagged; the in-app browser UA sometimes is not.
            alt = _get(url, WECHAT_UA)
            if not any(marker in alt.text for marker in BLOCK_MARKERS):
                response, page = alt, alt.text
    except Exception as exc:  # noqa: BLE001
        return {"error": f"request failed: {exc}", "body": "", "title": "", "description": ""}

    if any(marker in page for marker in BLOCK_MARKERS):
        return {
            "error": "blocked: WeChat answered with its verification wall",
            "status": response.status_code,
            "finalUrl": response.url,
            "body": "",
            "title": "",
            "description": "",
        }

    body = _body(page)
    return {
        "error": None,
        "status": response.status_code,
        "finalUrl": response.url,
        "title": _title(page),
        "description": _pick(
            r'<meta[^>]+(?:property|name)=["\'](?:og:)?description["\'][^>]+content=["\']([^"\']+)["\']',
            page,
        ),
        "body": body[:BODY_LIMIT],
        "chars": len(body),
    }


if __name__ == "__main__":
    # The parent process may not use a UTF-8 console; escaping keeps stdout safe.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing url", "body": "", "title": "", "description": ""}, ensure_ascii=True))
        sys.exit(2)
    result = main(sys.argv[1])
    if len(sys.argv) > 2 and result.get("body"):
        with open(sys.argv[2], "w", encoding="utf-8") as handle:
            handle.write(result["title"] + "\n\n" + result["body"] if result.get("title") else result["body"])
    print(json.dumps(result, ensure_ascii=True))
