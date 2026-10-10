"""Read-only Codex metadata scanner for Linux/WSL; invoked through ssh/wsl stdin.

No install, no daemon, no dependency. Output: JSON array of session metadata.
CONFIG_B64 may be prepended by the Electron host to override root/limit.
"""
import base64
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

INDEX_TAIL_BYTES = 2 * 1024 * 1024

HEAD_BYTES = 128 * 1024
TAIL_BYTES = 192 * 1024
# For a recent, unknown session look further back for task_started/task_complete.
EXTENDED_TAIL_BYTES = 8 * 1024 * 1024
RECENT_MS = 5 * 60_000
MAX_DISCOVERED = 10000
MAX_RETURNED = 200
START = {'task_started', 'turn_started'}
END = {'task_complete', 'turn_complete', 'turn_aborted'}
WAIT = {'exec_approval_request', 'apply_patch_approval_request', 'request_user_input', 'request_permissions', 'elicitation_request'}
RESUME = {'exec_command_begin', 'patch_apply_begin', 'agent_message', 'agent_reasoning'}


def rows(text, clipped=False):
    lines = text.splitlines()
    if clipped and lines:
        lines.pop(0)
    for line in lines:
        try:
            item = json.loads(line)
            if isinstance(item, dict):
                yield item
        except (ValueError, TypeError):
            pass


def safe_cwd(value):
    return value if isinstance(value, str) and value.strip() else None



def normalize_title(value):
    if not isinstance(value, str):
        return None
    title = ' '.join(value.split())
    return title[:180] + ('…' if len(title) > 180 else '') if title else None


def title_from_head(head):
    fallback = None
    for row in rows(head):
        payload = row.get('payload')
        if not isinstance(payload, dict):
            continue
        if row.get('type') == 'event_msg' and payload.get('type') == 'user_message':
            title = normalize_title(payload.get('message'))
            if title:
                return title
        if row.get('type') == 'response_item' and payload.get('type') == 'message' and payload.get('role') == 'user':
            content = payload.get('content')
            if isinstance(content, str):
                fallback = fallback or normalize_title(content)
            elif isinstance(content, list):
                text = ' '.join(part.get('text', '') for part in content
                                if isinstance(part, dict) and part.get('type') == 'input_text'
                                and isinstance(part.get('text'), str))
                fallback = fallback or normalize_title(text)
    return fallback


def names_from_index(root, ids):
    path = root / 'session_index.jsonl'
    names = {}
    try:
        with path.open('rb') as stream:
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            length = min(size, INDEX_TAIL_BYTES)
            stream.seek(size - length)
            lines = stream.read(length).decode('utf-8', errors='replace').splitlines()
        if size > length:
            lines = lines[1:]  # Discard potentially truncated JSONL row.
        for line in reversed(lines):
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict):
                continue
            uid = entry.get('id')
            if uid in ids and uid not in names:
                name = normalize_title(entry.get('thread_name'))
                if name:
                    names[uid] = name
    except OSError:
        pass
    return names


def titles_from_state(root, ids):
    path = root / 'state_5.sqlite'
    if not path.is_file() or not ids:
        return {}
    conn = None
    try:
        conn = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=0.5)
        columns = {row[1] for row in conn.execute('PRAGMA table_info(threads)')}
        fields = [field for field in ('name', 'title', 'first_user_message', 'preview') if field in columns]
        if 'id' not in columns or not fields:
            return {}
        values = list(ids)
        found = {}
        for start in range(0, len(values), 150):
            batch = values[start:start + 150]
            sql = 'SELECT id, ' + ', '.join(fields) + ' FROM threads WHERE id IN (' + ','.join('?' for _ in batch) + ')'
            for row in conn.execute(sql, batch):
                found[row[0]] = dict(zip(fields, row[1:]))
        return found
    except (sqlite3.Error, OSError, ValueError):
        return {}
    finally:
        if conn is not None:
            conn.close()


def enrich_titles(root, sessions):
    ids = {session['id'] for session in sessions}
    indexed = names_from_index(root, ids)
    stored = titles_from_state(root, ids)
    for session in sessions:
        row = stored.get(session['id'], {})
        session['title'] = (
            normalize_title(row.get('name'))
            or indexed.get(session['id'])
            or normalize_title(row.get('title'))
            or normalize_title(row.get('first_user_message'))
            or normalize_title(row.get('preview'))
            or session['title']
        )

def details(head, tail, filename, clipped, modified, now):
    session_id = None
    cwd = None
    for row in rows(head):
        if row.get('type') == 'session_meta':
            meta = row.get('payload') or {}
            if isinstance(meta, dict):
                session_id = meta.get('id') if isinstance(meta.get('id'), str) else None
                cwd = safe_cwd(meta.get('cwd'))
            break
    if not cwd:
        match = re.search(r'"cwd"\s*:\s*("(?:\\.|[^"\\])*")', head)
        if match:
            try:
                cwd = safe_cwd(json.loads(match.group(1)))
            except ValueError:
                pass
    if not session_id:
        match = re.search(r'"id"\s*:\s*"([0-9a-fA-F-]{32,36})"', head)
        if match:
            session_id = match.group(1)
    if not session_id:
        match = re.search(r'([0-9a-fA-F]{8}-[0-9a-fA-F-]{27,})', filename)
        session_id = match.group(1) if match else filename.removesuffix('.jsonl')

    phase = 'unknown'
    awaiting = False
    for row in rows(tail, clipped):
        payload = row.get('payload') or {}
        if not isinstance(payload, dict):
            continue
        if row.get('type') == 'turn_context':
            cwd = safe_cwd(payload.get('cwd')) or cwd
        elif row.get('type') == 'event_msg':
            event = payload.get('type')
            if not isinstance(event, str):
                continue
            if event in START:
                phase, awaiting = 'started', False
            elif event in END:
                phase, awaiting = 'finished', False
            elif event in WAIT and phase == 'started':
                awaiting = True
            elif event in RESUME and phase == 'started':
                awaiting = False

    age = max(0, now - modified)
    if phase == 'finished':
        status, reason = 'finished', '检测到本轮结束事件；不代表客户端已退出'
    elif phase == 'started' and awaiting and age <= 600000:
        status, reason = 'waiting', '日志存在等待用户操作事件（推断）'
    elif phase == 'started' and age <= 90000:
        status, reason = 'working', '本轮已开始、尚无结束事件，且最近 90 秒有日志更新（推断）'
    elif phase == 'started':
        status, reason = 'unknown', '执行开始后未见结束事件，但日志已停止更新；无法确认是否仍在运行'
    else:
        status, reason = 'unknown', '没有足够的执行生命周期记录'
    return {
        'id': session_id,
        'workspace': cwd,
        'title': title_from_head(head),
        'status': status,
        'statusReason': reason,
        'updatedAt': modified,
        'startedAt': None,
    }


def scan(root, now=None, limit=MAX_RETURNED):
    now = now or int(time.time() * 1000)
    base = Path(root).expanduser() / 'sessions'
    if not base.is_dir():
        raise FileNotFoundError(f'Codex sessions folder not found: {base}')
    # Bounding both discovery and returned records avoids reading old transcripts unnecessarily.
    files = []
    for folder, dirs, names in os.walk(base):
        dirs[:] = sorted(dirs, reverse=True)
        for name in names:
            if name.endswith('.jsonl'):
                full = Path(folder) / name
                try:
                    stat = full.stat()
                    files.append((stat.st_mtime_ns // 1000000, stat.st_size, full))
                except OSError:
                    pass
                if len(files) >= MAX_DISCOVERED:
                    break
        if len(files) >= MAX_DISCOVERED:
            break
    files.sort(key=lambda item: item[0], reverse=True)
    result, seen = [], set()
    for modified, size, file in files[:max(1, min(limit, MAX_RETURNED))]:
        try:
            with file.open('rb') as handle:
                head = handle.read(min(HEAD_BYTES, size)).decode('utf-8', errors='replace')
                clipped = size > TAIL_BYTES
                handle.seek(max(0, size - TAIL_BYTES))
                tail = handle.read().decode('utf-8', errors='replace')
                item = details(head, tail, file.name, clipped, modified, now)
                if item['status'] == 'unknown' and clipped and now - modified <= RECENT_MS:
                    length = min(EXTENDED_TAIL_BYTES, size)
                    handle.seek(max(0, size - length))
                    expanded = handle.read(length).decode('utf-8', errors='replace')
                    item = details(head, expanded, file.name, size > length, modified, now)
            item['byteSize'] = size
            if item['id'] not in seen:
                seen.add(item['id'])
                result.append(item)
        except (OSError, ValueError, UnicodeError):
            continue
    enrich_titles(Path(root).expanduser().resolve(), result)
    return result


def main():
    config_b64 = globals().get('CONFIG_B64', '')
    options = json.loads(base64.b64decode(config_b64)) if config_b64 else {}
    root = options.get('root') or os.environ.get('CODEX_HOME') or str(Path.home() / '.codex')
    print(json.dumps(scan(root, limit=options.get('limit', MAX_RETURNED)), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
