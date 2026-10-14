"""On-demand bounded assistant reply preview for Windows WSL and SSH transports.

Only reads the selected rollout, returns at most 420 visible characters, and
never changes session files. Invoked via python3 - (no install on remote host).
"""
import base64
import json
import os
import re
import sys
from pathlib import Path

SHORT_BYTES = 256 * 1024
MAX_BYTES = 4 * 1024 * 1024
EXCERPT_CHARS = 420
EMPTY = {'text': None, 'phase': None, 'timestamp': None, 'truncated': False}
PHASES = {'final_answer', 'partial_answer', 'commentary'}
TEXT_TYPES = {'output_text', 'text'}
ITEM_TYPES = {'Text', 'text'}


def valid_relative_path(relative):
    if not isinstance(relative, str) or len(relative) > 350 or '\\' in relative or '\0' in relative:
        return False
    parts = relative.split('/')
    return (
        len(parts) == 4
        and re.fullmatch(r'\d{4}', parts[0]) is not None
        and re.fullmatch(r'\d{2}', parts[1]) is not None
        and re.fullmatch(r'\d{2}', parts[2]) is not None
        and re.fullmatch(r'[A-Za-z0-9_.-]+\.jsonl', parts[3]) is not None
        and all(part not in ('.', '..') for part in parts)
    )


def message_text(value, permitted_types):
    if isinstance(value, str):
        return value.strip() or None
    if not isinstance(value, list):
        return None
    texts = [item['text'] for item in value if isinstance(item, dict)
             and item.get('type') in permitted_types
             and isinstance(item.get('text'), str) and item['text'].strip()]
    return '\n'.join(texts).strip() or None


def candidate_reply(row):
    payload = row.get('payload')
    if not isinstance(payload, dict):
        return None
    kind = row.get('type')
    phase = payload.get('phase')
    text = None
    if kind == 'event_msg' and payload.get('type') == 'agent_message':
        text = payload.get('message')
    elif kind == 'response_item' and payload.get('type') == 'message' and payload.get('role') == 'assistant':
        text = message_text(payload.get('content'), TEXT_TYPES)
    elif kind == 'event_msg' and payload.get('type') == 'item_completed':
        item = payload.get('item')
        if isinstance(item, dict) and item.get('type') in ('AgentMessage', 'agentMessage'):
            phase = item.get('phase')
            text = message_text(item.get('content'), ITEM_TYPES)
    elif kind == 'event_msg' and payload.get('type') in ('task_complete', 'turn_complete'):
        phase, text = 'final_answer', payload.get('last_agent_message')
    if phase in ('analysis', 'reasoning') or not isinstance(text, str) or not text.strip():
        return None
    return text.strip(), phase if phase in PHASES else 'unspecified'


def excerpt_from_tail(text, clipped=False, chars=EXCERPT_CHARS):
    lines = text.splitlines()
    if clipped and lines:
        lines.pop(0)  # The first JSONL record may be partial.
    for line in reversed(lines):
        try:
            row = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(row, dict):
            continue
        reply = candidate_reply(row)
        if reply is None:
            continue
        content, phase = reply
        chars = max(1, min(1000, chars))
        truncated = len(content) > chars
        return {
            'text': ('…' if truncated else '') + content[-chars:],
            'phase': phase,
            'timestamp': row.get('timestamp') if isinstance(row.get('timestamp'), str) else None,
            'truncated': truncated,
        }
    return dict(EMPTY)


def read_recent_reply(root, relative):
    if not valid_relative_path(relative):
        raise ValueError('Invalid Codex rollout path')
    base = (Path(root).expanduser() / 'sessions').resolve(strict=True)
    target = (base / relative).resolve(strict=True)
    if not target.is_relative_to(base):
        raise ValueError('Rollout file is outside the Codex sessions folder')
    with target.open('rb') as handle:
        size = handle.seek(0, os.SEEK_END)
        for budget in (SHORT_BYTES, MAX_BYTES):
            length = min(size, budget)
            handle.seek(size - length)
            text = handle.read(length).decode('utf-8', errors='replace')
            result = excerpt_from_tail(text, size > length)
            if result['text'] or length == size:
                return result
    return dict(EMPTY)


def main():
    config_b64 = globals().get('CONFIG_B64', '')
    options = json.loads(base64.b64decode(config_b64)) if config_b64 else {}
    root = options.get('root') or os.environ.get('CODEX_HOME') or str(Path.home() / '.codex')
    print(json.dumps(read_recent_reply(root, options.get('rolloutPath')), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TypeError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
