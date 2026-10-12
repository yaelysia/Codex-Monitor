import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'collector' / 'scan.py'
spec = importlib.util.spec_from_file_location('codex_monitor_scanner', SCRIPT)
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class TestLinuxCollector(unittest.TestCase):
    def test_sessions_and_cwd_are_read_without_full_transcript(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / 'sessions' / '2026' / '10' / '10'
            base.mkdir(parents=True)
            session_id = '01234567-89ab-4cde-8123-123456789abc'
            rows = [
                {'type': 'session_meta', 'payload': {'id': session_id, 'cwd': '/home/u/project'}},
                {'type': 'event_msg', 'payload': {'type': 'task_started'}},
                {'type': 'turn_context', 'payload': {'cwd': '/home/u/other'}},
                {'type': 'event_msg', 'payload': {'type': 'task_complete'}},
            ]
            (base / f'rollout-{session_id}.jsonl').write_text('\n'.join(map(json.dumps, rows)))
            result = scanner.scan(tmp)
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0]['id'], session_id)
            self.assertEqual(result[0]['workspace'], '/home/u/other')
            self.assertEqual(result[0]['status'], 'finished')
            self.assertEqual(result[0]['rolloutPath'], f'2026/10/10/rollout-{session_id}.jsonl')

    def test_stale_unfinished_session_is_unknown(self):
        now = 1_800_000_000_000
        details = scanner.details('', json.dumps({'type': 'event_msg', 'payload': {'type': 'task_started'}}),
                                  'rollout-abc.jsonl', False, now - 500_000, now)
        self.assertEqual(details['status'], 'unknown')

    def test_approval_request_is_tentative_waiting(self):
        now = 1_800_000_000_000
        tail = '\n'.join(json.dumps({'type': 'event_msg', 'payload': {'type': event}})
                         for event in ['task_started', 'exec_approval_request'])
        details = scanner.details('', tail, 'rollout-abc.jsonl', False, now - 10_000, now)
        self.assertEqual(details['status'], 'waiting')

    def test_recent_long_rollout_recovers_start_beyond_short_tail(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / 'sessions' / '2026' / '10' / '10'
            base.mkdir(parents=True)
            session_id = '01234567-89ab-4cde-8123-123456789abc'
            file = base / f'rollout-{session_id}.jsonl'
            data = [
                {'type': 'session_meta', 'payload': {'id': session_id, 'cwd': '/tmp/active'}},
                {'type': 'event_msg', 'payload': {'type': 'task_started'}},
                {'type': 'response_item', 'payload': {'type': 'reasoning', 'text': 'x' * 250_000}},
            ]
            file.write_text('\n'.join(map(json.dumps, data)) + '\n')
            self.assertEqual(scanner.scan(tmp)[0]['status'], 'working')
            self.assertGreater(scanner.scan(tmp)[0]['byteSize'], scanner.TAIL_BYTES)

            old = time.time() - 600
            os.utime(file, (old, old))
            self.assertEqual(scanner.scan(tmp)[0]['status'], 'unknown')

    def test_completed_long_rollout_not_mistaken_for_running(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / 'sessions' / '2026' / '10' / '10'
            base.mkdir(parents=True)
            file = base / 'rollout-abcd.jsonl'
            data = [
                {'type': 'event_msg', 'payload': {'type': 'task_started'}},
                {'type': 'response_item', 'payload': {'type': 'reasoning', 'text': 'x' * 250_000}},
                {'type': 'event_msg', 'payload': {'type': 'task_complete'}},
            ]
            file.write_text('\n'.join(map(json.dumps, data)) + '\n')
            self.assertEqual(scanner.scan(tmp)[0]['status'], 'finished')

    def test_titles_from_sqlite_then_legacy_index_then_user_prompt(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / 'sessions' / '2026' / '10' / '10'
            base.mkdir(parents=True)
            db = sqlite3.connect(str(Path(tmp) / 'state_5.sqlite'))
            db.execute('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, preview TEXT)')
            db.executemany('INSERT INTO threads VALUES (?, ?, ?, ?, ?)', [
                ('db', '数据库名称', '旧标题', '首条用户消息', ''),
                ('index', None, '标题来自数据库', '', ''),
                ('derived', None, '自动标题', '', ''),
            ])
            db.commit()
            db.close()
            (Path(tmp) / 'session_index.jsonl').write_text('\n'.join([
                json.dumps({'id': 'db', 'thread_name': '更早的索引'}),
                json.dumps({'id': 'index', 'thread_name': '索引标题'}),
            ]))
            for uid in ('db', 'index', 'derived', 'prompt'):
                lines = [
                    {'type': 'session_meta', 'payload': {'id': uid, 'cwd': '/tmp/work'}},
                    {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': '首条指令'}},
                ]
                (base / f'rollout-{uid}.jsonl').write_text('\n'.join(map(json.dumps, lines)))
            result = {row['id']: row['title'] for row in scanner.scan(tmp)}
            self.assertEqual(result, {
                'db': '数据库名称',
                'index': '索引标题',
                'derived': '自动标题',
                'prompt': '首条指令',
            })

    def test_title_index_ignores_unhashable_corrupt_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            index = Path(tmp) / 'session_index.jsonl'
            index.write_text('\n'.join([
                json.dumps({'id': ['bad'], 'thread_name': 'bad'}),
                json.dumps({'id': 'ok', 'thread_name': 'title'}),
            ]))
            self.assertEqual(scanner.names_from_index(Path(tmp), {'ok'}), {'ok': 'title'})



    def test_compaction_checkpoints_report_recent_progress_even_without_turn_start(self):
        now = 1_800_000_000_000
        variants = [
            {'type': 'compacted', 'payload': {'message': 'checkpoint'}},
            {'type': 'event_msg', 'payload': {'type': 'context_compacted'}},
            {'type': 'event_msg', 'payload': {
                'type': 'item_completed', 'item': {'type': 'ContextCompaction', 'id': 'x'}}},
            {'type': 'response_item', 'payload': {'type': 'compaction'}},
        ]
        for row in variants:
            with self.subTest(row=row['type']):
                status = scanner.details('', json.dumps(row), 'rollout-abc.jsonl',
                                         False, now - 5000, now)
                self.assertEqual(status['status'], 'working')
                self.assertIsNone(status['finishedToken'])
                self.assertIn('压缩完成记录', status['statusReason'])

    def test_terminal_after_compaction_wins_and_carries_finished_token(self):
        now = 1_800_000_000_000
        tail = '\n'.join(json.dumps(row) for row in [
            {'type': 'compacted', 'payload': {'message': 'checkpoint'}},
            {'type': 'event_msg', 'timestamp': '2026-10-12T09:00:00Z',
             'payload': {'type': 'task_complete', 'turn_id': 'turn1'}},
        ])
        status = scanner.details('', tail, 'rollout-abc.jsonl', False, now - 5000, now)
        self.assertEqual(status['status'], 'finished')
        self.assertEqual(status['finishedToken'], '2026-10-12T09:00:00Z|turn1')

    def test_stale_checkpoint_cannot_keep_finished_or_active_state(self):
        now = 1_800_000_000_000
        tail = '\n'.join(json.dumps(row) for row in [
            {'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 'old'}},
            {'type': 'compacted', 'payload': {}},
        ])
        status = scanner.details('', tail, 'rollout-abc.jsonl', False, now - 500_000, now)
        self.assertEqual(status['status'], 'unknown')
        self.assertIsNone(status['finishedToken'])


if __name__ == '__main__':
    unittest.main()
