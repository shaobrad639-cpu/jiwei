"""Validate model proposals before the deterministic journal commits anything."""
import datetime as dt
import re


def text(value, name, limit, optional=False):
    if optional and value is None:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f'模型字段 {name} 无效')
    return value.strip()


def date(value):
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('模型日期必须为 YYYY-MM-DD')
    return dt.date.fromisoformat(value).isoformat()


def validate(plan, raw, projects):
    if not isinstance(plan, dict) or not {'items', 'model'} <= set(plan) or set(plan) - {'items', 'model', 'source_messages'}:
        raise ValueError('模型分诊必须只包含 items 与 model')
    sources = plan.get('source_messages')
    evidence = [raw]
    if sources is not None:
        if not isinstance(sources, list) or not 1 <= len(sources) <= 8:
            raise ValueError('确认来源必须为 1 至 8 条用户消息')
        evidence = []
        for source in sources:
            if not isinstance(source, dict) or set(source) != {'text', 'at', 'ev'}:
                raise ValueError('确认来源字段无效')
            evidence.append(text(source['text'], 'source text', 4000))
            stamp = dt.datetime.fromisoformat(text(source['at'], 'source at', 100).replace('Z', '+00:00'))
            if stamp.tzinfo is None:
                raise ValueError('确认来源时间缺少时区')
            text(source['ev'], 'source ev', 200)
        if raw != '\n'.join(evidence):
            raise ValueError('记录原文必须与用户消息来源一致')
    model = plan['model']
    if not isinstance(model, dict) or set(model) != {'provider', 'model'}:
        raise ValueError('缺少模型来源')
    model = {key: text(model[key], key, 200) for key in model}
    rows = plan['items']
    if not isinstance(rows, list) or len(rows) > 6:
        raise ValueError('模型最多返回 6 条分诊')
    day = None
    for source in (plan.get('source_messages') or []):
        try:
            stamp = dt.datetime.fromisoformat(str(source.get('at', '')).replace('Z', '+00:00'))
            day = stamp.astimezone(dt.timezone(dt.timedelta(hours=8))).date().isoformat()
            break
        except ValueError:
            continue
    valid = []
    ids = {p['id'] for p in projects}
    allowed = {'type', 'text', 'note', 'quote', 'project', 'due', 'at', 'place', 'time_quote'}
    for row in rows:
        if not isinstance(row, dict) or set(row) != allowed:
            raise ValueError('模型条目字段不完整或包含不允许的字段')
        kind = row['type']
        if kind not in ('task', 'idea'):
            raise ValueError('模型只能分诊 task 或 idea')
        quote = text(row['quote'], 'quote', 8000)
        if not any(quote in source for source in evidence):
            raise ValueError('模型引用必须逐字存在于微信原文中')
        project = row['project']
        if project is not None and (not isinstance(project, str) or project not in ids):
            raise ValueError('模型不能创建或关联不存在的项目')
        due = date(row['due'])
        at = row['at']
        if at is not None:
            if not isinstance(at, dict) or set(at) != {'date', 'slot', 'clock'} or not at['date']:
                raise ValueError('模型发生时间格式无效')
            date(at['date'])
            if at['slot'] not in (None, '早上', '上午', '中午', '下午', '傍晚', '晚上', '夜里', '深夜'):
                raise ValueError('模型时段无效')
            if at['clock'] is not None and (not isinstance(at['clock'], str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', at['clock'])):
                raise ValueError('模型钟点无效')
        time_quote = text(row['time_quote'], 'time_quote', 1000, optional=True)
        if due or at:
            if not time_quote or not any(time_quote in source for source in evidence):
                raise ValueError('模型时间必须有原文依据')
            if not re.search(r'今天|明|后天|周|星期|月|日|号|年|\d', time_quote):
                # 「中午订餐」这类只有时段、没有日期的说法，按当天算；日期对不上仍然拒绝。
                slot_only = bool(at) and bool(at.get('slot')) and bool(re.search(r'早上|上午|中午|下午|傍晚|晚上|夜里|深夜', time_quote)) and at.get('date') == day
                if not slot_only:
                    raise ValueError('模型时间必须有原文依据')
        place = text(row['place'], 'place', 200, optional=True)
        if place and not any(place in source for source in evidence):
            raise ValueError('模型地点必须来自原文')
        if kind == 'idea' and any((due, at, place, time_quote)):
            raise ValueError('想法不能变成时间安排')
        note = row['note']
        if not isinstance(note, str) or len(note) > 2000:
            raise ValueError('模型备注无效')
        valid.append(dict(type=kind, text=text(row['text'], 'text', 80), note=note.strip(),
                          quote=quote, project=project, due=due, at=at, place=place,
                          time_quote=time_quote, model=model))
    return valid, model
