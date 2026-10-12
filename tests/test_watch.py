import contextlib
import importlib.util
import io
import json
import os
import select
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'collector' / 'watch.py'
spec = importlib.util.spec_from_file_location('codex_monitor_watcher', SCRIPT)
watcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watcher)


class WatcherProtocolTests(unittest.TestCase):
    def test_event_stream_protocol_never_contains_transcripts(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            watcher.emit('change')
            watcher.emit('heartbeat')
        self.assertEqual(
            output.getvalue().splitlines(),
            ['{"kind": "change"}', '{"kind": "heartbeat"}'],
        )

    def test_missing_codex_home_uses_safe_polling_fallback(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(FileNotFoundError):
                watcher.run(root)

    @unittest.skipUnless(sys.platform.startswith('linux'), 'inotify is Linux/WSL only')
    def test_file_writes_and_new_date_directories_wake_the_monitor(self):
        with tempfile.TemporaryDirectory() as root:
            sessions = Path(root) / 'sessions'
            sessions.mkdir()
            try:
                monitor = watcher.InotifyWatch(sessions)
            except OSError as error:
                self.skipTest(f'host inotify not supported: {error}')
            try:
                new_date = sessions / '2026' / '10' / '12'
                new_date.mkdir(parents=True)
                self.assertTrue(select.select([monitor.fd], [], [], 3)[0])
                monitor.consume()  # Installs watches on newly created date directories.

                rollout = new_date / 'rollout-123.jsonl'
                rollout.write_text(json.dumps({
                    'type': 'event_msg',
                    'payload': {'type': 'task_complete', 'message': 'Do not transmit'},
                }))
                self.assertTrue(select.select([monitor.fd], [], [], 3)[0])
                self.assertTrue(monitor.consume())

                rollout.write_text(rollout.read_text() + '\\nnew checkpoint')
                self.assertTrue(select.select([monitor.fd], [], [], 3)[0])
                self.assertTrue(monitor.consume())

                unrelated = new_date / 'notes.txt'
                unrelated.write_text('no Codex rollout here')
                self.assertTrue(select.select([monitor.fd], [], [], 3)[0])
                self.assertFalse(monitor.consume())
            finally:
                monitor.close()

    @unittest.skipUnless(sys.platform.startswith('linux'), 'inotify is Linux/WSL only')
    def test_ignores_symlinked_directories_and_refuses_unbounded_watches(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / 'sessions'
            (base / '2026' / '10' / '12').mkdir(parents=True)
            (base / 'alias').symlink_to(base / '2026', target_is_directory=True)
            saved_limit = watcher.MAX_WATCHED_DIRS
            watcher.MAX_WATCHED_DIRS = 2
            try:
                with self.assertRaises(RuntimeError):
                    watcher.InotifyWatch(base)
            except OSError as error:
                self.skipTest(f'host inotify not supported: {error}')
            finally:
                watcher.MAX_WATCHED_DIRS = saved_limit


if __name__ == '__main__':
    unittest.main()
