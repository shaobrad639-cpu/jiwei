"""Pull the seller name and total amount out of a Chinese e-invoice PDF.

Everything happens locally: pdfplumber reads the text layer the invoice already
carries, and a few label patterns pick the two fields a reimbursement list needs.
No model is called, so this costs no tokens and sends nothing off the machine.

Usage:
    python invoice_fields.py <file.pdf>

Prints one JSON object:
    {"ok": true, "seller": "...", "amount": "128.00",
     "number": "...", "date": "...", "chars": 812, "pages": 1}
A scanned invoice has no text layer; that is reported as ok=false rather than
guessed at.
"""

import json
import re
import sys
import unicodedata

# Labels differ between the old VAT layout and the newer all-digital invoice.
SELLER_PATTERNS = (
    r"销售方(?:名称)?[：:]\s*([^\s\n]+)",
    r"销\s*售\s*方[^\n]{0,20}?名\s*称[：:]\s*([^\s\n]+)",
    r"销售方信息[^\n]*\n[^\n]*名\s*称[：:]\s*([^\s\n]+)",
)
AMOUNT_PATTERNS = (
    r"[（(]小写[）)]\s*[¥￥]?\s*([0-9][0-9,]*\.\d{2})",
    r"价税合计[^\n]{0,30}?[¥￥]\s*([0-9][0-9,]*\.\d{2})",
    r"合\s*计\s*[¥￥]\s*([0-9][0-9,]*\.\d{2})",
)
NUMBER_PATTERNS = (
    r"发票号码[：:]\s*(\d{8,20})",
    r"发\s*票\s*号\s*码[：:]\s*(\d{8,20})",
)
DATE_PATTERNS = (
    r"开票日期[：:]\s*(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)",
    r"开票日期[：:]\s*(\d{4}-\d{2}-\d{2})",
)


def _first(patterns, text):
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return re.sub(r"\s+", " ", match.group(1)).strip()
    return ""


def _amount(text):
    for pattern in AMOUNT_PATTERNS:
        match = re.search(pattern, text)
        if match:
            return match.group(1).replace(",", "")
    return ""


def _rows(page):
    """Group words into visual rows, keeping their x positions."""
    buckets = {}
    for word in page.extract_words():
        key = round(word["top"] / 3)
        buckets.setdefault(key, []).append(word)
    rows = []
    for key in sorted(buckets):
        rows.append(sorted(buckets[key], key=lambda w: w["x0"]))
    return rows


def _after(row, word, page_width):
    """Words that sit to the right of a label on the same visual row."""
    limit = None
    for index, candidate in enumerate(row):
        if candidate is word:
            rest = row[index + 1:]
            break
    else:
        return ""
    parts = []
    for part in rest:
        if limit is not None and part["x0"] > limit:
            break
        parts.append(part["text"])
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def _positional(page):
    """Read the value that sits beside each label.

    All-digital invoices keep labels and values on the same row but not in the
    same text run, so `"发票号码:"` alone tells us nothing. Positions do.
    """
    width = page.width
    rows = _rows(page)
    found = {"seller": "", "number": "", "date": "", "amount": ""}

    for row in rows:
        for word in row:
            text = unicodedata.normalize("NFKC", word["text"])
            if text in ("名称:", "名称：") and not found["seller"]:
                # Two name columns: left is the buyer, right is the seller.
                if word["x0"] > width * 0.4:
                    value = _after(row, word, width)
                    if value and ("公司" in value or "厂" in value or "店" in value):
                        found["seller"] = value
            elif text.startswith("发票号码") and not found["number"]:
                value = _after(row, word, width)
                digits = re.sub(r"\D", "", value)
                if len(digits) >= 8:
                    found["number"] = digits
            elif text.startswith("开票日期") and not found["date"]:
                value = _after(row, word, width)
                if re.search(r"\d{4}", value):
                    found["date"] = value

    if not found["seller"]:
        # Older layout: the two names share one row, buyer first.
        for row in rows:
            companies = [w["text"] for w in row if w["text"].endswith(("公司", "分公司")) or w["text"].endswith("公司")]
            if len(companies) >= 2:
                found["seller"] = companies[-1]
                break
    return found


def main(path):
    try:
        import pdfplumber
    except ImportError:
        return {"ok": False, "error": "pdfplumber not installed"}
    try:
        with pdfplumber.open(path) as pdf:
            pages = len(pdf.pages)
            text = "\n".join((page.extract_text() or "") for page in pdf.pages)
            layout = _positional(pdf.pages[0])
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"cannot read pdf: {exc}"}

    # Many PDF fonts encode CJK as Kangxi radicals or compatibility forms
    # (「⽅」 instead of 「方」). NFKC folds them back before matching labels.
    text = unicodedata.normalize("NFKC", text)
    compact = re.sub(r"[ \t\u00a0]+", " ", text)
    fields = {
        "seller": layout.get("seller") or _first(SELLER_PATTERNS, compact),
        "amount": _amount(compact) or layout.get("amount") or "",
        "number": layout.get("number") or _first(NUMBER_PATTERNS, compact),
        "date": layout.get("date") or _first(DATE_PATTERNS, compact),
    }
    if not fields["date"]:
        anywhere = re.search(r"(20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)", compact)
        if anywhere:
            fields["date"] = re.sub(r"\s+", "", anywhere.group(1))
    if not fields["seller"] and not fields["amount"]:
        reason = "no text layer (scanned invoice?)" if len(text.strip()) < 20 else "labels not found"
        return {"ok": False, "error": reason, "chars": len(text.strip()), "pages": pages, **fields}
    return {"ok": True, "error": None, "chars": len(text.strip()), "pages": pages, **fields}


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "missing path"}, ensure_ascii=True))
        sys.exit(2)
    print(json.dumps(main(sys.argv[1]), ensure_ascii=True))
