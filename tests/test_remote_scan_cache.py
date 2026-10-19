import importlib.util
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('remote_cache_scanner',
    Path(__file__).resolve().parents[1] / 'collector' / 'scan.py')
scanner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scanner)
NOW = 1_800_000_000_000


def event(kind, at=NOW - 1000, **extra):
    return {'type': 'event_msg', 'timestamp': datetime.fromtimestamp(at / 1000, timezone.utc).isoformat(),
            'payload': {'type': kind, 'turn_id': 'turn-a', **extra}}


def create(root, uid='one', events=None, mtime=NOW - 1000, source='cli', padding=0, day='2026/10/19'):
    file = Path(root) / 'sessions' / day / ('rollout-' + uid + '.jsonl')
    file.parent.mkdir(parents=True, exist_ok=True)
    head = {'type': 'session_meta', 'payload': {'id': uid, 'source': source, 'cwd': '/workspace'}}
    content = [head]
    if padding:
        content.extend({'type': 'response_item', 'payload': {'type': 'function_call_output',
            'output': 'x' * 1024}} for _ in range(padding // 1024))
    content.extend(events if events is not None else [event('turn_started')])
    file.write_text('\n'.join(map(json.dumps, content)) + '\n', encoding='utf8')
    os.utime(file, ns=(mtime * 1_000_000, mtime * 1_000_000))
    return file


def request(response):
    return {'version': 1, 'rootKey': response['rootKey'], 'entries': [
        dict(path=row['rolloutPath'], id=row['id'], **{key: row['_cache'][key]
             for key in ('signature', 'from', 'until')})
        for row in response['sessions'] if '_cache' in row]}


def full(root, now=NOW, **kwargs):
    return scanner.scan(root, now=now, cache_request={'version': 1}, **kwargs)


class TestRemoteScanCache(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_unchanged_scans_skip_all_jsonl_reads_but_keep_full_discovery(self):
        for i in range(30):
            create(self.root, str(i), [event('turn_complete')], padding=256 * 1024)
        first = full(self.root)
        with patch.object(scanner, 'details', wraps=scanner.details) as parse:
            warm = scanner.scan(self.root, now=NOW + 3000, cache_request=request(first))
        self.assertEqual(warm['metrics']['cacheHits'], 30)
        self.assertEqual(warm['metrics']['logBytesRead'], 0)
        self.assertEqual(warm['metrics']['parsedFiles'], 0)
        self.assertEqual(warm['metrics']['indexedFiles'], 30)
        parse.assert_not_called()
        self.assertTrue(all('_reuse' in row for row in warm['sessions']))
        # Legacy direct callers still get the original array and no internal cache fields.
        legacy = scanner.scan(self.root, now=NOW)
        self.assertIsInstance(legacy, list)
        self.assertTrue(all(not any(k.startswith('_') for k in row) for row in legacy))

    def test_single_append_reparses_only_changed_file_and_deletion_is_not_retained(self):
        a = create(self.root, 'a')
        b = create(self.root, 'b')
        first = full(self.root)
        with a.open('a', encoding='utf8') as handle:
            handle.write(json.dumps(event('turn_complete', NOW + 2000)) + '\n')
        os.utime(a, ns=((NOW + 2000) * 1_000_000,) * 2)
        warm = scanner.scan(self.root, now=NOW + 3000, cache_request=request(first))
        self.assertEqual(warm['metrics']['parsedFiles'], 1)
        self.assertEqual(warm['metrics']['cacheHits'], 1)
        self.assertEqual(next(row for row in warm['sessions'] if row['id'] == 'a')['status'], 'finished')
        b.unlink()
        third = scanner.scan(self.root, now=NOW + 4000, cache_request=request(first))
        self.assertEqual([row['id'] for row in third['sessions']], ['a'])

    def test_truncation_and_same_size_mtime_replacement_invalidate(self):
        file = create(self.root, 'one')
        first = full(self.root)
        previous = file.stat()
        replacement = file.with_suffix('.tmp')
        replacement.write_bytes(file.read_bytes().replace(b'/workspace', b'/different'))
        os.utime(replacement, ns=(previous.st_atime_ns, previous.st_mtime_ns))
        os.replace(replacement, file)
        fresh = scanner.scan(self.root, now=NOW + 1000, cache_request=request(first))
        self.assertEqual(fresh['metrics']['cacheHits'], 0)
        self.assertEqual(fresh['sessions'][0]['workspace'], '/different')
        file.write_text('{}\n', encoding='utf8')
        self.assertEqual(scanner.scan(self.root, now=NOW + 2000,
            cache_request=request(fresh))['metrics']['cacheHits'], 0)

    def test_source_clock_deadlines_are_inclusive_and_never_slide(self):
        for boundary, events in [
            (scanner.WORKING_MS, [event('turn_started')]),
            (scanner.WAITING_MS, [event('turn_started'), event('exec_approval_request')]),
            (scanner.QUESTION_AGE_LIMIT_MS, [event('agent_message', id='async-one',
                delivery='async', questions=[{'question': 'choose'}])]),
        ]:
            with self.subTest(boundary=boundary):
                create(self.root, 'one', events, mtime=NOW - boundary + 10)
                first = full(self.root)
                at_boundary = scanner.scan(self.root, now=NOW + 10, cache_request=request(first))
                self.assertEqual(at_boundary['metrics']['cacheHits'], 1)
                expired = scanner.scan(self.root, now=NOW + 11, cache_request=request(first))
                self.assertEqual(expired['metrics']['cacheHits'], 0)
                expected = scanner.scan(self.root, now=NOW + 11)[0]
                self.assertEqual({k: v for k, v in expired['sessions'][0].items() if k != '_cache'}, expected)
        create(self.root, 'one', [event('turn_complete')])
        initial = full(self.root)
        self.assertEqual(scanner.scan(self.root, now=NOW + scanner.SCAN_CACHE_MS,
            cache_request=request(initial))['metrics']['cacheHits'], 0)
        self.assertEqual(scanner.scan(self.root, now=NOW - 1,
            cache_request=request(initial))['metrics']['cacheHits'], 0)

    def test_title_index_and_sqlite_are_refreshed_without_jsonl_reads(self):
        import sqlite3
        create(self.root, events=[event('user_message', message='base title'), event('turn_complete')])
        first = full(self.root)
        self.assertEqual(first['sessions'][0]['_cache']['title'], 'base title')
        (self.root / 'session_index.jsonl').write_text(json.dumps({'id': 'one', 'thread_name': 'renamed'}))
        warm = scanner.scan(self.root, now=NOW + 1000, cache_request=request(first))
        self.assertEqual(warm['metrics']['cacheHits'], 1)
        self.assertEqual(warm['sessions'][0]['title'], 'renamed')
        db = sqlite3.connect(self.root / 'state_5.sqlite')
        db.execute('CREATE TABLE threads (id TEXT, name TEXT)')
        db.execute('INSERT INTO threads VALUES (?, ?)', ('one', 'sqlite name'))
        db.commit(); db.close()
        warm = scanner.scan(self.root, now=NOW + 2000, cache_request=request(first))
        self.assertEqual(warm['sessions'][0]['title'], 'sqlite name')
        self.assertEqual(warm['metrics']['logBytesRead'], 0)
        (self.root / 'state_5.sqlite').unlink()
        (self.root / 'session_index.jsonl').unlink()
        warm = scanner.scan(self.root, now=NOW + 3000, cache_request=request(first))
        self.assertIsNone(warm['sessions'][0]['title'])  # Caller restores the original log title.

    def test_root_mismatch_and_malformed_hints_fall_back_without_reading_hint_paths(self):
        create(self.root)
        first = full(self.root)
        other = self.root / 'other'
        create(other)
        self.assertEqual(scanner.scan(other, now=NOW, cache_request=request(first))['metrics']['cacheHits'], 0)
        for entries in [None, 'not-array', [None, {'path': '../../secret'}],
                        [dict(request(first)['entries'][0], until=NOW + 120_000)],
                        [dict(request(first)['entries'][0], **{'from': True})]]:
            with self.subTest(entries=entries):
                data = scanner.scan(self.root, now=NOW, cache_request={
                    'version': 1, 'rootKey': first['rootKey'], 'entries': entries})
                self.assertEqual(data['metrics']['cacheHits'], 0)

    def test_short_file_edges_do_not_read_overlapping_bytes_twice(self):
        for size in [1, 4096, scanner.HEAD_BYTES, scanner.TAIL_BYTES + 20,
                     scanner.HEAD_BYTES + scanner.TAIL_BYTES, scanner.HEAD_BYTES + scanner.TAIL_BYTES + 1]:
            data = bytes((i % 95 + 32) for i in range(size))
            metrics = {'logBytesRead': 0}
            head, tail = scanner.read_edges(io.BytesIO(data), size, metrics)
            self.assertEqual(head.encode(), data[:scanner.HEAD_BYTES])
            self.assertEqual(tail.encode(), data[max(0, size - scanner.TAIL_BYTES):])
            self.assertEqual(metrics['logBytesRead'], min(size, scanner.HEAD_BYTES + scanner.TAIL_BYTES))

    def test_old_active_pin_and_mtime_ties_keep_original_selection(self):
        old = create(self.root, 'old', day='2020/01/01', mtime=NOW - 5000)
        for i in range(10):
            create(self.root, str(i))
        pin = old.relative_to(self.root / 'sessions').as_posix()
        with patch.object(scanner, 'MAX_DISCOVERED', 6):
            first = full(self.root, limit=3, pinned_paths=[pin, pin, '../../escape'])
            rows = list(scanner.rollout_candidates(self.root / 'sessions', dict(
                statCalls=0, indexedFiles=0, directoriesEnumerated=0)))
            selected = sorted(rows, key=lambda item: item[0], reverse=True)[:3]
            self.assertEqual([row['rolloutPath'] for row in first['sessions'][:3]],
                [Path(row[1]).relative_to(self.root / 'sessions').as_posix() for row in selected])
            self.assertIn('old', [row['id'] for row in first['sessions']])
            warm = scanner.scan(self.root, now=NOW + 1000, limit=3, pinned_paths=[pin], cache_request=request(first))
            self.assertEqual(warm['metrics']['cacheHits'], 4)

    def test_recent_clipped_vscode_rows_keep_per_scan_deep_lookback_budget(self):
        for i in range(10):
            create(self.root, str(i), [event('turn_started')], source='vscode', padding=256 * 1024)
        first = full(self.root)
        second = scanner.scan(self.root, now=NOW + 1000, cache_request=request(first))
        self.assertEqual(first['metrics']['cacheHits'], 0)
        self.assertEqual(second['metrics']['parsedFiles'], 10)
        self.assertTrue(all('_cache' not in row for row in first['sessions']))
        self.assertEqual(first['metrics']['logBytesRead'], second['metrics']['logBytesRead'])

    def test_path_and_open_handle_share_an_identity_signature(self):
        file = create(self.root)
        # Force a later file change, rather than assuming creation == change.
        with file.open('ab') as handle:
            handle.write(b'{}\n')
        with file.open('rb') as handle:
            before, opened = file.stat(), os.fstat(handle.fileno())
            self.assertEqual(scanner.file_signature(before), scanner.file_signature(opened),
                'Path/handle identity must not compare Windows birth time with change time')

    def test_windows_birthtime_normalization_does_not_drop_linux_change_detection(self):
        from types import SimpleNamespace
        values = dict(st_dev=1, st_ino=2, st_size=3, st_mtime_ns=4,
                      st_ctime_ns=5, st_birthtime_ns=5, st_mode=33188)
        before = SimpleNamespace(**values)
        after = SimpleNamespace(**{**values, 'st_ctime_ns': 6})
        with patch.object(scanner.sys, 'platform', 'win32'):
            self.assertEqual(scanner.file_signature(before), scanner.file_signature(after))
            replaced = SimpleNamespace(**{**values, 'st_ino': 7})
            self.assertNotEqual(scanner.file_signature(before), scanner.file_signature(replaced))
        with patch.object(scanner.sys, 'platform', 'linux'):
            self.assertNotEqual(scanner.file_signature(before), scanner.file_signature(after))

    def test_write_during_parse_never_creates_a_reusable_snapshot(self):
        file = create(self.root)
        original = scanner.details
        def changing(*args):
            result = original(*args)
            with file.open('ab') as handle:
                handle.write(b'{}\n')
            return result
        with patch.object(scanner, 'details', side_effect=changing):
            first = full(self.root)
        self.assertNotIn('_cache', first['sessions'][0])

    def test_conditional_stdin_entrypoint_needs_no_imports_from_remote_installation(self):
        import base64
        import subprocess
        import sys
        create(self.root)
        config = base64.b64encode(json.dumps({'root': str(self.root), 'scanCache': {'version': 1}}).encode()).decode()
        source = "CONFIG_B64 = '" + config + "'\n" + Path(SPEC.origin).read_text(encoding='utf8')
        completed = subprocess.run([sys.executable, '-'], input=source, text=True,
            encoding='utf8', capture_output=True, check=True, cwd=self.temp.name,
            env=dict(os.environ, PYTHONIOENCODING='utf-8'))
        response = json.loads(completed.stdout)
        self.assertEqual(response['version'], 1)
        self.assertEqual(response['sessions'][0]['id'], 'one')


if __name__ == '__main__':
    unittest.main()
