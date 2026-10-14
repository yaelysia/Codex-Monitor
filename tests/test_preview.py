import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'collector' / 'preview.py'
spec = importlib.util.spec_from_file_location('codex_monitor_preview', SCRIPT)
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


def line(row):
    return json.dumps(row, ensure_ascii=False) + '\n'


class PreviewTests(unittest.TestCase):
    def test_legacy_latest_assistant_excludes_reasoning_and_tools(self):
        text = ''.join(line(row) for row in [
            {'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': '最初回复'}},
            {'type': 'event_msg', 'payload': {'type': 'agent_reasoning', 'text': '不应泄露'}},
            {'type': 'response_item', 'payload': {'type': 'function_call_output', 'output': '工具结果'}},
            {'type': 'response_item', 'timestamp': '2026-10-12T08:30:00Z',
             'payload': {'type': 'message', 'role': 'assistant', 'phase': 'commentary',
                         'content': [{'type': 'output_text', 'text': '刚完成一次测试。'}]}},
        ])
        self.assertEqual(preview.excerpt_from_tail(text), {
            'text': '刚完成一次测试。', 'phase': 'commentary',
            'timestamp': '2026-10-12T08:30:00Z', 'truncated': False,
        })

    def test_paginated_assistant_item_and_completion_fallback(self):
        text = ''.join(line(row) for row in [
            {'type': 'event_msg', 'payload': {'type': 'item_completed', 'item': {
                'type': 'AgentMessage', 'phase': 'final_answer',
                'content': [{'type': 'Text', 'text': '第一段'}, {'type': 'Text', 'text': '第二段'}]}}},
            {'type': 'event_msg', 'payload': {'type': 'token_count'}},
        ])
        self.assertEqual(preview.excerpt_from_tail(text)['text'], '第一段\n第二段')
        self.assertEqual(preview.excerpt_from_tail(line({
            'type': 'event_msg', 'payload': {'type': 'task_complete', 'last_agent_message': '完成'}
        }))['text'], '完成')

    def test_hidden_analysis_partial_record_and_unicode_suffix(self):
        text = 'broken-json\n' + line({'type': 'event_msg',
            'payload': {'type': 'agent_message', 'message': '🙂' * 450}}) + '{"bad": '
        result = preview.excerpt_from_tail(text, clipped=True)
        self.assertEqual(len(result['text']), preview.EXCERPT_CHARS + 1)
        self.assertTrue(result['text'].startswith('…'))
        self.assertTrue(result['text'].endswith('🙂'))
        self.assertIsNone(preview.excerpt_from_tail(line({
            'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant',
                                               'phase': 'analysis', 'content': [{
                'type': 'output_text', 'text': 'hidden'}]}
        }))['text'])

    def test_reads_only_selected_valid_file_and_falls_back_from_big_tool_output(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder) / 'sessions' / '2026' / '10' / '12'
            base.mkdir(parents=True)
            file = base / 'rollout-abc.jsonl'
            file.write_text(
                line({'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': '最后回复'}})
                + line({'type': 'response_item', 'payload': {
                    'type': 'function_call_output', 'output': 'x' * 280_000}}),
                encoding='utf-8',
            )
            self.assertEqual(preview.read_recent_reply(folder, '2026/10/12/rollout-abc.jsonl')['text'], '最后回复')
            for bad in ['../../root', '2026/10/12/../../../private.jsonl',
                        r'2026\10\12\rollout-abc.jsonl', '/etc/passwd']:
                with self.subTest(bad=bad):
                    self.assertFalse(preview.valid_relative_path(bad))
                    with self.assertRaises(ValueError):
                        preview.read_recent_reply(folder, bad)


if __name__ == '__main__':
    unittest.main()
