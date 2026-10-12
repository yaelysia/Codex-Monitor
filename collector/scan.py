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
from datetime import datetime

INDEX_TAIL_BYTES = 2 * 1024 * 1024

HEAD_BYTES = 128 * 1024
TAIL_BYTES = 192 * 1024
# For a recent, unknown session look further back for task_started/task_complete.
EXTENDED_TAIL_BYTES = 8 * 1024 * 1024
RECENT_MS = 5 * 60_000
MAX_DISCOVERED = 10000
MAX_RETURNED = 200
START = {'task_started', 'turn_started'}
END = {'task_complete', 'turn_complete'}
ABORT = {'turn_aborted'}
WAIT = {'exec_approval_request', 'apply_patch_approval_request', 'request_user_input', 'request_permissions', 'elicitation_request'}
RESUME = {'exec_command_begin', 'patch_apply_begin', 'agent_message', 'agent_reasoning'}
COMPACT_RESPONSES = {'compaction', 'context_compaction', 'contextCompaction'}
COMPACT_ITEMS = {'ContextCompaction', 'contextCompaction', 'context_compaction'}


def is_compaction_checkpoint(row, payload):
    if row.get('type') == 'compacted':
        return True
    if row.get('type') == 'response_item' and payload.get('type') in COMPACT_RESPONSES:
        return True
    if row.get('type') == 'event_msg':
        if payload.get('type') == 'context_compacted':
            return True
        if payload.get('type') == 'item_completed':
            item = payload.get('item')
            return isinstance(item, dict) and item.get('type') in COMPACT_ITEMS
    return False


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
    title = ' '.join(re.sub(r'[\x00-\x1f\x7f]', ' ', value).split())
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
            if isinstance(uid, str) and uid in ids and uid not in names:
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


def classify_session_origin(meta):
    """Codex serializes child source as {"subagent":...}; forks are not children."""
    if not isinstance(meta, dict):
        return {'isSubagent': False, 'parentThreadId': None}
    source = meta.get('source')
    source_value = source if isinstance(source, dict) else {}
    sub_source = source_value.get('subagent', source_value.get('subAgent'))
    sub_data = sub_source if isinstance(sub_source, dict) else {}
    spawn = sub_data.get('thread_spawn', sub_data.get('threadSpawn'))
    spawn = spawn if isinstance(spawn, dict) else {}
    parent = (meta.get('parent_thread_id') or meta.get('parentThreadId')
              or spawn.get('parent_thread_id') or spawn.get('parentThreadId'))
    parent = parent if isinstance(parent, str) and parent.strip() else None
    session_id, tid = meta.get('session_id'), meta.get('id')
    different_root = (isinstance(session_id, str) and session_id and
                      isinstance(tid, str) and tid and session_id != tid)
    is_child = (bool(parent) or bool(different_root) or
                meta.get('thread_source', meta.get('threadSource')) == 'subagent' or
                (isinstance(source, str) and source in ('subagent', 'subAgent')) or
                (isinstance(source, dict) and
                 ('subagent' in source or 'subAgent' in source)))
    return {'isSubagent': bool(is_child), 'parentThreadId': parent}


def session_origin_from_header(head):
    first = head.split('\n', 1)[0].lstrip('\ufeff')
    if not re.search(r'"type"\s*:\s*"session_meta"', first):
        return {'isSubagent': False, 'parentThreadId': None}
    try:
        return classify_session_origin(json.loads(first).get('payload'))
    except (ValueError, AttributeError, TypeError):
        pass
    # A long first metadata line may be truncated in HEAD_BYTES. Source/parent
    # fields appear before large base_instructions in Codex's serialized SessionMeta.
    prefix = re.split(r'"base_instructions"\s*:', first, maxsplit=1)[0]
    match = re.search(r'"(?:parent_thread_id|parentThreadId)"\s*:\s*"([^"]+)"', prefix)
    parent = match.group(1) if match else None
    source_subagent = (re.search(r'"source"\s*:\s*\{\s*"(?:subagent|subAgent)"\s*:', prefix)
                       or re.search(r'"source"\s*:\s*"(?:subagent|subAgent)"', prefix))
    thread_subagent = re.search(r'"(?:thread_source|threadSource)"\s*:\s*"subagent"', prefix)
    tid = re.search(r'"id"\s*:\s*"([0-9a-fA-F-]{32,36})"', prefix)
    session_id = re.search(r'"session_id"\s*:\s*"([0-9a-fA-F-]{32,36})"', prefix)
    other_root = tid and session_id and tid.group(1) != session_id.group(1)
    return {'isSubagent': bool(parent or source_subagent or thread_subagent or other_root),
            'parentThreadId': parent}

def client_kind_from_header(head):
    first = head.split('\n', 1)[0].lstrip('\ufeff')
    if not re.search(r'"type"\s*:\s*"session_meta"', first):
        return 'unknown'
    try:
        meta = json.loads(first).get('payload')
        originator = meta.get('originator') if isinstance(meta, dict) else None
    except (ValueError, TypeError, AttributeError):
        prefix = re.split(r'"base_instructions"\s*:', first, maxsplit=1)[0]
        found = re.search(r'"originator"\s*:\s*"([^"]{1,128})"', prefix)
        originator = found.group(1) if found else None
    if not isinstance(originator, str):
        return 'unknown'
    name = originator.strip().lower()
    if name in ('codex desktop', 'codex_work_desktop'):
        return 'desktop'
    if name in ('codex_vscode', 'codex-vscode'):
        return 'vscode'
    if name in ('codex-tui', 'codex_cli_rs', 'codex-cli', 'codex_cli'):
        return 'terminal'
    return 'unknown'


def last_user_input_at_source(records):
    latest = None
    for row in records:
        payload = row.get('payload')
        if row.get('type') != 'event_msg' or not isinstance(payload, dict):
            continue
        if payload.get('type') != 'user_message' or not isinstance(row.get('timestamp'), str):
            continue
        try:
            at = int(datetime.fromisoformat(row['timestamp'].replace('Z', '+00:00')).timestamp() * 1000)
            if at > 0 and (latest is None or at > latest):
                latest = at
        except (ValueError, OverflowError):
            pass
    return latest


QUESTION_AGE_LIMIT_MS = 6 * 60 * 60 * 1000


def limited_question_text(value):
    if not isinstance(value, str):
        return None
    text = ' '.join(value.split()).strip()
    return text[:160] if text else None


def question_from_arguments(value):
    if isinstance(value, str):
        if len(value) > 16384:
            return None
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return None
    if not isinstance(value, dict):
        return None
    questions = value.get('questions')
    if not isinstance(questions, list) or not questions or not isinstance(questions[0], dict):
        return None
    first = questions[0]
    return (limited_question_text(first.get('title')) or
            limited_question_text(first.get('question')) or
            limited_question_text(first.get('header')))


def safe_question_id(value):
    return value if isinstance(value, str) and 0 < len(value) <= 256 else None


def detect_pending_question_records(records):
    """Find unmatched persisted blocking tool calls or delivered async questions.

    No inference from quiet output or tool timeouts. The first reply/user message
    after an async question dismisses its pending state; blocking calls must have
    a matching function_call_output, or a later turn boundary.
    """
    pending = {}
    for row in records:
        payload = row.get('payload')
        if not isinstance(payload, dict):
            continue
        if row.get('type') == 'response_item':
            kind = payload.get('type')
            if kind in ('function_call', 'custom_tool_call'):
                name = payload.get('name')
                name = name.split('.')[-1] if isinstance(name, str) else None
                call_id = safe_question_id(payload.get('call_id'))
                if call_id and name in ('request_user_input', 'request_permissions'):
                    pending['blocking:' + call_id] = {
                        'text': question_from_arguments(payload.get('arguments')) or
                                ('Codex 请求权限确认' if name == 'request_permissions' else None),
                        'blocking': True,
                    }
            elif kind in ('function_call_output', 'custom_tool_call_output'):
                call_id = safe_question_id(payload.get('call_id'))
                if call_id:
                    pending.pop('blocking:' + call_id, None)
            elif kind == 'message' and payload.get('role') == 'user':
                pending = {k: v for k, v in pending.items() if v['blocking']}
            continue
        if row.get('type') != 'event_msg':
            continue
        kind = payload.get('type')
        if kind == 'user_message':
            pending = {k: v for k, v in pending.items() if v['blocking']}
        elif kind == 'item_completed':
            item = payload.get('item')
            if not isinstance(item, dict):
                continue
            questions = item.get('questions')
            if (item.get('type') in ('AgentMessage', 'agentMessage') and
                    item.get('delivery') == 'async' and
                    isinstance(questions, list) and questions):
                call_id = safe_question_id(item.get('id'))
                if call_id:
                    pending['async:' + call_id] = {
                        'text': question_from_arguments({'questions': questions}),
                        'blocking': False,
                    }
        elif kind in ('turn_complete', 'task_complete', 'turn_aborted',
                      'turn_started', 'task_started'):
            pending = {k: v for k, v in pending.items() if not v['blocking']}
        if len(pending) > 128:
            pending.pop(next(iter(pending)))
    if not pending:
        return {'token': None, 'text': None, 'blocking': False}
    token = next(reversed(pending))
    return {'token': token, **pending[token]}


def details(head, tail, filename, clipped, modified, now):
    session_id = None
    cwd = None
    origin = session_origin_from_header(head)
    client_kind = client_kind_from_header(head)
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
    finished_token = None
    waiting_token = None
    checkpoint_after_boundary = False
    parsed_rows = list(rows(tail, clipped))
    question = detect_pending_question_records(parsed_rows)
    input_at_source = last_user_input_at_source(parsed_rows)
    input_age = None if input_at_source is None else now - input_at_source
    for row in parsed_rows:
        payload = row.get('payload') or {}
        if not isinstance(payload, dict):
            continue
        if is_compaction_checkpoint(row, payload):
            checkpoint_after_boundary = True
            continue
        if row.get('type') == 'turn_context':
            cwd = safe_cwd(payload.get('cwd')) or cwd
        elif row.get('type') == 'event_msg':
            event = payload.get('type')
            if not isinstance(event, str):
                continue
            timestamp = row.get('timestamp') if isinstance(row.get('timestamp'), str) else ''
            turn_id = payload.get('turn_id') if isinstance(payload.get('turn_id'), str) else ''
            marker = (timestamp + '|' + turn_id) if timestamp or turn_id else None
            if event in START:
                phase, awaiting, waiting_token = 'started', False, None
                finished_token, checkpoint_after_boundary = None, False
            elif event in END:
                phase = 'failed' if payload.get('error') is not None else 'finished'
                awaiting, finished_token, waiting_token = (
                    False, marker if phase == 'finished' else None, None)
                checkpoint_after_boundary = False
            elif event in ABORT:
                phase, awaiting, finished_token, waiting_token = 'interrupted', False, None, None
                checkpoint_after_boundary = False
            elif event in WAIT and phase == 'started':
                awaiting, waiting_token = True, marker
            elif event in RESUME and phase == 'started':
                awaiting, waiting_token = False, None

    age = max(0, now - modified)
    terminal = phase == 'finished' and not checkpoint_after_boundary
    pending_token = question['token'] if age <= QUESTION_AGE_LIMIT_MS else None
    if question['blocking'] and pending_token:
        status, reason = 'waiting', (
            '检测到未匹配回答的 Codex 请求用户输入/确认工具调用；可能正在等待用户处理')
    elif terminal:
        status, reason = 'finished', '检测到本轮正常结束事件；不代表客户端已退出'
    elif phase == 'interrupted' and not checkpoint_after_boundary:
        status, reason = 'interrupted', '检测到 Codex 本轮中断事件，不能视为任务完成'
    elif phase == 'failed' and not checkpoint_after_boundary:
        status, reason = 'failed', '检测到本轮结束事件携带错误信息，不能视为正常完成'
    elif phase == 'started' and awaiting and age <= 600000:
        status, reason = 'waiting', '日志存在等待用户操作事件（推断）'
    elif phase == 'started' and age <= 90000:
        status = 'working'
        reason = ('检测到上下文压缩结果，尚无本轮结束事件；可能仍在继续执行（推断）'
                  if checkpoint_after_boundary
                  else '本轮已开始、尚无结束事件，且最近 90 秒有日志更新（推断）')
    elif checkpoint_after_boundary and age <= 90000:
        status, reason = 'working', '最近检测到上下文压缩完成记录，但未见之后的任务结束事件；可能正在继续执行（推断）'
    elif phase == 'started':
        status, reason = 'unknown', '执行开始后未见结束事件，但日志已停止更新；无法确认是否仍在运行'
    else:
        status, reason = 'unknown', '没有足够的近期执行生命周期记录'
    return {
        'id': session_id,
        'workspace': cwd,
        'isSubagent': origin['isSubagent'],
        'parentThreadId': origin['parentThreadId'],
        'clientKind': client_kind,
        'lastUserInputAgeAtSourceMs': input_age,
        'lastUserInputAtSourceMs': input_at_source,
        'title': title_from_head(head),
        'status': status,
        'statusReason': reason,
        'finishedToken': finished_token if terminal and not (question['blocking'] and pending_token) else None,
        'waitingToken': pending_token if question['blocking'] and pending_token
                        else waiting_token if awaiting else None,
        'pendingQuestionToken': pending_token,
        'questionText': question['text'] if pending_token else None,
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
            item['rolloutPath'] = file.relative_to(base).as_posix()
            item['ageAtSourceMs'] = now - modified  # Both timestamps come from this Linux host.
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
