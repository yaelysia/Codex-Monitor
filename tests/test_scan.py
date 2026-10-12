import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from datetime import datetime

SCRIPT = Path(__file__).resolve().parents[1] / 'collector' / 'scan.py'
spec = importlib.util.spec_from_file_location('codex_monitor_scanner', SCRIPT)
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class TestLinuxCollector(unittest.TestCase):
    def test_window_evidence_only_reports_client_and_source_clock_age(self):
        now = int(datetime.fromisoformat('2026-10-12T09:00:02+00:00').timestamp() * 1000)
        meta = json.dumps({'type': 'session_meta', 'payload': {
            'id': 'thread-one', 'originator': 'codex-tui', 'source': 'cli'}})
        tail = json.dumps({'type': 'event_msg', 'timestamp': '2026-10-12T09:00:00Z',
                           'payload': {'type': 'user_message', 'message': 'PRIVATE CONTENT'}})
        result = scanner.details(meta, tail, 'rollout-one.jsonl', False, now - 1000, now)
        self.assertEqual(result['clientKind'], 'terminal')
        self.assertEqual(result['lastUserInputAgeAtSourceMs'], 2000)
        self.assertEqual(result['lastUserInputAtSourceMs'], now - 2000)
        self.assertNotIn('PRIVATE CONTENT', json.dumps(result))
        self.assertEqual(scanner.client_kind_from_header(json.dumps({
            'type': 'session_meta', 'payload': {'originator': 'Codex Desktop'}})),
            'desktop')
        self.assertEqual(scanner.client_kind_from_header(json.dumps({
            'type': 'session_meta', 'payload': {'source': 'vscode'}})), 'unknown')


    def test_desktop_paginated_user_message_and_late_turn_completion(self):
        now = 1_800_000_000_000
        row = lambda kind, payload: {'type': kind, 'payload': payload,
                                     'timestamp': '2026-10-12T09:00:00Z'}
        start = lambda turn: row('event_msg', {'type': 'turn_started', 'turn_id': turn})
        end = lambda turn: row('event_msg', {'type': 'turn_complete', 'turn_id': turn})
        user = row('event_msg', {'type': 'item_completed',
                    'item': {'type': 'UserMessage', 'id': 'm1',
                             'content': [{'type': 'Text', 'text': 'PRIVATE QUERY'}]}})
        records = [start('a'), end('a'), user, end('a')]
        tail = '\n'.join(map(json.dumps, records))
        result = scanner.details('', tail, 'rollout-abc.jsonl', False, now - 1000, now)
        self.assertEqual(result['status'], 'working')
        self.assertIsNone(result['finishedToken'])
        self.assertNotIn('PRIVATE QUERY', json.dumps(result))
        future = scanner.details('', tail, 'rollout-abc.jsonl', False, now - 200_000, now)
        self.assertEqual(future['status'], 'unknown')
        records = [start('a'), end('a'), start('b'), end('a')]
        self.assertEqual(scanner.details('', '\n'.join(map(json.dumps, records)),
                         'x.jsonl', False, now - 1000, now)['status'], 'working')
        records.append(end('b'))
        self.assertEqual(scanner.details('', '\n'.join(map(json.dumps, records)),
                         'x.jsonl', False, now - 1000, now)['status'], 'finished')

    def test_desktop_async_question_cannot_be_a_fully_completed_user_task(self):
        now = 1_800_000_000_000
        events = [
            {'type': 'event_msg', 'payload': {'type': 'turn_started', 'turn_id': 'a'}},
            {'type': 'event_msg', 'payload': {'type': 'item_completed', 'item': {
                'type': 'AgentMessage', 'id': 'request-1', 'delivery': 'async',
                'questions': [{'title': '继续运行吗？'}]}}},
            {'type': 'event_msg', 'payload': {'type': 'turn_complete', 'turn_id': 'a'}},
        ]
        tail = '\n'.join(map(json.dumps, events))
        result = scanner.details('', tail, 'x.jsonl', False, now - 1000, now)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['pendingQuestionToken'], 'async:request-1')
        self.assertIsNone(result['finishedToken'])
        events.append({'type': 'event_msg', 'payload': {'type': 'item_completed',
                       'item': {'type': 'UserMessage', 'id': 'm1', 'content': []}}})
        answer = scanner.details('', '\n'.join(map(json.dumps, events)),
                                 'x.jsonl', False, now - 1000, now)
        self.assertIsNone(answer['pendingQuestionToken'])
        self.assertEqual(answer['status'], 'working')

    def test_desktop_client_originator_alias_and_paginated_input_timestamp(self):
        head = json.dumps({'type': 'session_meta', 'payload': {
            'originator': 'codex_desktop', 'source': 'appServer'}})
        self.assertEqual(scanner.client_kind_from_header(head), 'desktop')
        now = int(datetime.fromisoformat('2026-10-12T09:00:02+00:00').timestamp() * 1000)
        row = {'type': 'event_msg', 'timestamp': '2026-10-12T09:00:00Z',
               'payload': {'type': 'item_completed', 'item': {
                   'type': 'UserMessage', 'content': [{'type': 'Text', 'text': 'PRIVATE'}]}}}
        details = scanner.details(head, json.dumps(row), 'x.jsonl', False, now - 1000, now)
        self.assertEqual(details['lastUserInputAtSourceMs'], now - 2000)
        self.assertNotIn('PRIVATE', json.dumps(details))


    def test_fallback_sqlite_originator_when_rollout_metadata_missing(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state_5.sqlite'
            conn = sqlite3.connect(path)
            conn.execute('CREATE TABLE threads (id TEXT, originator TEXT)')
            conn.execute('INSERT INTO threads VALUES (?, ?)', ('desktop', 'codex_desktop'))
            conn.commit()
            conn.close()
            sessions = [{'id': 'desktop', 'clientKind': 'unknown', 'title': None}]
            scanner.enrich_titles(Path(tmp), sessions)
            self.assertEqual(sessions[0]['clientKind'], 'desktop')


    def test_named_running_turn_ignores_completion_without_matching_identity(self):
        now = 1_800_000_000_000
        def ev(kind, turn=None):
            payload = {'type': kind}
            if turn:
                payload['turn_id'] = turn
            return {'type': 'event_msg', 'payload': payload}
        events = [ev('turn_started', 'old'), ev('turn_complete', 'old'),
                  ev('turn_started', 'current'), ev('task_complete')]
        result = scanner.details('', '\n'.join(map(json.dumps, events)),
                                 'x.jsonl', False, now - 1000, now)
        self.assertEqual(result['status'], 'working')
        legacy = scanner.details('', '\n'.join(map(json.dumps, [ev('task_started'), ev('task_complete')])),
                                 'x.jsonl', False, now - 1000, now)
        self.assertEqual(legacy['status'], 'finished')

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


    def test_rollout_source_age_uses_remote_clock_not_windows_clock(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / 'sessions' / '2026' / '10' / '12'
            base.mkdir(parents=True)
            file = base / 'rollout-remote.jsonl'
            file.write_text('\n'.join(json.dumps(row) for row in [
                {'type': 'session_meta', 'payload': {'id': 'remote', 'cwd': '/srv/project'}},
                {'type': 'event_msg', 'timestamp': '2026-10-12T09:00:00Z',
                 'payload': {'type': 'task_complete', 'turn_id': 'turn1'}},
            ]))
            remote_now = 1_800_000_360_000
            os.utime(file, ((remote_now - 1200) / 1000, (remote_now - 1200) / 1000))
            session = scanner.scan(root, now=remote_now)[0]
            self.assertEqual(session['status'], 'finished')
            self.assertEqual(session['finishedToken'], '2026-10-12T09:00:00Z|turn1')
            self.assertLess(abs(session['ageAtSourceMs'] - 1200), 15)



    def test_subagent_source_is_preserved_in_ssh_wsl_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / 'sessions' / '2026' / '10' / '12'
            base.mkdir(parents=True)
            parent = '00000000-0000-4000-8000-000000000001'
            child = '00000000-0000-4000-8000-000000000002'
            for uid, source, extras in [
                (parent, 'cli', {'session_id': parent}),
                (child, {'subagent': {'thread_spawn': {
                    'parent_thread_id': parent, 'depth': 1}}}, {
                    'parent_thread_id': parent, 'thread_source': 'subagent', 'session_id': parent}),
                ('review', {'subagent': 'review'}, {}),
                ('fork', 'vscode', {'forked_from_id': parent}),
            ]:
                file = base / f'rollout-{uid}.jsonl'
                file.write_text('\n'.join(json.dumps(row) for row in [
                    {'type': 'session_meta', 'payload': {'id': uid, 'cwd': '/project',
                        'source': source, **extras}},
                    {'type': 'event_msg', 'payload': {'type': 'task_complete'}},
                ]))
            found = {row['id']: row for row in scanner.scan(root)}
            self.assertFalse(found[parent]['isSubagent'])
            self.assertTrue(found[child]['isSubagent'])
            self.assertEqual(found[child]['parentThreadId'], parent)
            self.assertTrue(found['review']['isSubagent'])
            self.assertFalse(found['fork']['isSubagent'])

    def test_truncated_large_metadata_still_identifies_subagent(self):
        meta = {'type': 'session_meta', 'payload': {
            'id': '00000000-0000-4000-8000-000000000002',
            'source': {'subagent': 'review'},
            'base_instructions': 'x' * (scanner.HEAD_BYTES + 9000),
        }}
        head = json.dumps(meta)[:scanner.HEAD_BYTES]
        self.assertTrue(scanner.session_origin_from_header(head)['isSubagent'])
        self.assertFalse(scanner.session_origin_from_header(
            json.dumps({'type': 'session_meta', 'payload': {
                'id': '00000000-0000-4000-8000-000000000003',
                'source': 'cli', 'base_instructions': 'mentions subagent source'}}))['isSubagent'])



    def test_aborted_and_failed_turns_do_not_count_as_normal_completion(self):
        now = 1_800_000_000_000
        for event, fields, expected in (
            ('turn_aborted', {'reason': 'interrupted'}, 'interrupted'),
            ('turn_complete', {'error': {'message': 'tool failure'}}, 'failed'),
            ('turn_complete', {'error': None}, 'finished'),
        ):
            with self.subTest(event=event, expected=expected):
                rows = [
                    {'type': 'event_msg', 'payload': {'type': 'task_started'}},
                    {'type': 'event_msg', 'payload': {'type': event, **fields}},
                ]
                state = scanner.details('', '\n'.join(map(json.dumps, rows)),
                                        'rollout-abc.jsonl', False, now - 1000, now)
                self.assertEqual(state['status'], expected)
                if expected != 'finished':
                    self.assertIsNone(state['finishedToken'])




    def test_unanswered_blocking_question_from_persisted_function_call(self):
        now = 1_800_000_000_000
        ask = {'type': 'response_item', 'payload': {
            'type': 'function_call', 'name': 'request_user_input', 'call_id': 'call-1',
            'arguments': json.dumps({'questions': [{'question': '现在继续执行吗？'}]})}}
        started = {'type': 'event_msg', 'payload': {'type': 'task_started'}}
        raw = '\n'.join(map(json.dumps, [started, ask]))
        state = scanner.details('', raw, 'rollout-test.jsonl', False, now - 11 * 60_000, now)
        self.assertEqual(state['status'], 'waiting')
        self.assertEqual(state['pendingQuestionToken'], 'blocking:call-1')
        self.assertEqual(state['questionText'], '现在继续执行吗？')
        answer = {'type': 'response_item', 'payload': {
            'type': 'function_call_output', 'call_id': 'call-1', 'output': '{"answers":{}}'}}
        after = scanner.details('', raw + '\n' + json.dumps(answer),
                                'rollout-test.jsonl', False, now - 1000, now)
        self.assertEqual(after['status'], 'working')
        self.assertIsNone(after['pendingQuestionToken'])

    def test_async_question_is_visible_after_tool_accepts_and_turn_finishes(self):
        now = 1_800_000_000_000
        lines = [
            {'type': 'event_msg', 'payload': {'type': 'task_started'}},
            {'type': 'event_msg', 'payload': {'type': 'item_completed', 'item': {
                'type': 'AgentMessage', 'id': 'ask-async', 'delivery': 'async',
                'questions': [{'title': '选择要发布的分支'}]}}},
            {'type': 'response_item', 'payload': {
                'type': 'function_call_output', 'call_id': 'ask-async', 'output': '{"accepted":true}'}},
            {'type': 'event_msg', 'payload': {'type': 'turn_complete', 'turn_id': 'turn-1'}},
        ]
        raw = '\n'.join(map(json.dumps, lines))
        pending = scanner.details('', raw, 'rollout-abc.jsonl', False, now - 1000, now)
        self.assertEqual(pending['status'], 'unknown')
        self.assertEqual(pending['pendingQuestionToken'], 'async:ask-async')
        self.assertIsNone(pending['finishedToken'])
        self.assertEqual(pending['questionText'], '选择要发布的分支')
        lines.append({'type': 'event_msg', 'payload': {
            'type': 'user_message', 'message': 'main'}})
        answered = scanner.details('', '\n'.join(map(json.dumps, lines)),
                                   'rollout-abc.jsonl', False, now - 1000, now)
        self.assertIsNone(answered['pendingQuestionToken'])

    def test_unrelated_tools_or_stale_question_do_not_fabricate_waiting(self):
        now = 1_800_000_000_000
        other = {'type': 'response_item', 'payload': {
            'type': 'function_call', 'name': 'exec_command', 'call_id': 'cmd-1',
            'arguments': '{"cmd":"echo request_user_input"}'}}
        state = scanner.details('', json.dumps(other), 'rollout-abc.jsonl', False, now - 1000, now)
        self.assertEqual(state['status'], 'unknown')
        self.assertIsNone(state['pendingQuestionToken'])
        ask = {'type': 'response_item', 'payload': {
            'type': 'function_call', 'name': 'request_user_input', 'call_id': 'call-1',
            'arguments': '{"questions":[{"title":"Continue?"}]}'}}
        stale = scanner.details('', json.dumps(ask), 'rollout-abc.jsonl', False,
                                now - 8 * 60 * 60_000, now)
        self.assertIsNone(stale['pendingQuestionToken'])
        self.assertEqual(stale['status'], 'unknown')


if __name__ == '__main__':
    unittest.main()
