"""Real inotify and wire-contract tests. No Codex installation or sessions needed."""
import contextlib
import importlib.util
import io
import json
import os
import select
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('codex_monitor_remote_watch',
    Path(__file__).resolve().parents[1] / 'collector' / 'watch.py')
watch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watch)


@unittest.skipUnless(os.name == 'posix' and hasattr(os, 'O_NONBLOCK'),
                     'inotify is available on Linux/WSL only')
class TestRemoteWatcherDeltas(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name) / 'sessions'
        self.day = self.base / '2026' / '10' / '19'
        self.day.mkdir(parents=True)
        self.observer = watch.InotifyWatch(self.base)
        self.addCleanup(self.observer.close)

    def receive(self):
        # No background process: read the actual kernel queue after a write.
        select.select([self.observer.fd], [], [], 1.5)
        return self.observer.consume()

    def test_create_append_delete_have_precise_or_reset_outcomes(self):
        file = self.day / 'rollout-one.jsonl'
        file.write_text('{}\n', encoding='utf8')
        dirty, paths, reset = self.receive()
        self.assertTrue(dirty)
        self.assertTrue(reset, 'creation needs a full discovery')
        with file.open('a', encoding='utf8') as handle:
            handle.write('{}\n')
        dirty, paths, reset = self.receive()
        self.assertTrue(dirty)
        self.assertFalse(reset)
        self.assertEqual(paths, {'2026/10/19/rollout-one.jsonl'})
        file.unlink()
        dirty, paths, reset = self.receive()
        self.assertTrue(dirty)
        self.assertTrue(reset, 'deletion must reselect the 201st candidate')

    def test_new_date_folder_invalidates_and_becomes_watched(self):
        next_day = self.base / '2026' / '10' / '20'
        next_day.mkdir(parents=True)
        dirty, paths, reset = self.receive()
        self.assertTrue(dirty)
        self.assertTrue(reset)
        file = next_day / 'rollout-next.jsonl'
        file.write_text('{}\n', encoding='utf8')
        dirty, paths, reset = self.receive()
        self.assertTrue(dirty)
        self.assertTrue(reset)

    def test_kernel_queue_overflow_explicitly_invalidates(self):
        blob = watch.HEADER.pack(-1, watch.IN_Q_OVERFLOW, 0, 0)
        with patch.object(watch.os, 'read', side_effect=[blob, BlockingIOError()]):
            dirty, paths, reset = self.observer.consume()
        self.assertTrue(dirty)
        self.assertTrue(reset)
        self.assertEqual(paths, set())

    def test_wire_change_contains_only_relative_candidate_locators(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            watch.emit('change', {'2026/10/19/rollout-one.jsonl'}, False)
            watch.emit('change', set(), True)
        first, second = [json.loads(line) for line in buf.getvalue().splitlines()]
        self.assertEqual(first['paths'], ['2026/10/19/rollout-one.jsonl'])
        self.assertFalse(first['reset'])
        self.assertTrue(second['reset'])
        self.assertEqual(second['paths'], [])
        self.assertNotIn(str(self.base), buf.getvalue())


if __name__ == '__main__':
    unittest.main()
