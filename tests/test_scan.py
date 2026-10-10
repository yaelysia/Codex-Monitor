import importlib.util
import json
import os
import tempfile
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


if __name__ == '__main__':
    unittest.main()
