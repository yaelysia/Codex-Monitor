"""Metadata-only remote candidate index: identical scan results, less directory I/O."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_remote_scan_cache import NOW, scanner, create, event, request


def hints(response, reuse=False):
    # The index selects candidate files; parse reuse is an independent feature.
    base = request(response) if reuse else {
        'version': 1, 'rootKey': response['rootKey'], 'entries': [],
    }
    return dict(base, directory=response['directory'])


def semantic(response):
    return [{key: value for key, value in row.items() if not key.startswith('_')}
            for row in response['sessions']]


class TestRemoteDirectoryIndex(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_incremental_shortlist_skips_tree_walk_and_preserves_full_results(self):
        for i in range(310):
            create(self.root, str(i), events=[event('turn_complete')],
                   mtime=NOW - (310 - i) * 1000)
        first = scanner.scan(self.root, now=NOW, cache_request={'version': 1})
        self.assertEqual(first['metrics']['indexedFiles'], 310)
        self.assertEqual(len(first['directory']['files']), 200)
        self.assertEqual(first['metrics']['indexMode'], 'full')
        with patch.object(scanner.os, 'walk', side_effect=AssertionError('unexpected full walk')):
            warm = scanner.scan(self.root, now=NOW + 3000, cache_request=hints(first))
        full = scanner.scan(self.root, now=NOW + 3000, cache_request={'version': 1})
        self.assertEqual(warm['metrics']['indexMode'], 'incremental')
        self.assertEqual(warm['metrics']['directoriesEnumerated'], 0)
        self.assertLessEqual(warm['metrics']['statCalls'], 216)
        self.assertEqual(warm['metrics']['indexedFiles'], 310)
        self.assertEqual(semantic(warm), semantic(full))

    def test_single_append_rechecks_shortlist_and_keeps_original_age_semantics(self):
        for i in range(30):
            create(self.root, str(i), events=[event('turn_started')],
                   mtime=NOW - 5000 + i)
        first = scanner.scan(self.root, now=NOW, cache_request={'version': 1})
        file = self.root / 'sessions' / '2026' / '10' / '19' / 'rollout-29.jsonl'
        with file.open('a', encoding='utf8') as handle:
            handle.write(json.dumps(event('turn_complete', NOW + 1500)) + '\n')
        os.utime(file, ns=((NOW + 2000) * 1_000_000,) * 2)
        second = scanner.scan(self.root, now=NOW + 3000, cache_request=hints(first, reuse=True))
        full = scanner.scan(self.root, now=NOW + 3000, cache_request={'version': 1})
        self.assertEqual(second['metrics']['indexMode'], 'incremental')
        self.assertEqual(second['metrics']['parsedFiles'], 1)
        self.assertEqual(second['metrics']['cacheHits'], 29)
        self.assertEqual([r['rolloutPath'] for r in second['sessions']],
                         [r['rolloutPath'] for r in full['sessions']])
        self.assertEqual(next(r for r in second['sessions'] if r['id'] == '29')['status'], 'finished')

    def test_decrease_deletion_invalid_or_wrong_root_reverts_to_full_in_same_call(self):
        for i in range(5):
            create(self.root, str(i), mtime=NOW - 1000)
        first = scanner.scan(self.root, now=NOW, cache_request={'version': 1})
        file = self.root / 'sessions' / '2026' / '10' / '19' / 'rollout-4.jsonl'
        os.utime(file, ns=((NOW - 5000) * 1_000_000,) * 2)
        reset = scanner.scan(self.root, now=NOW + 2000, cache_request=hints(first))
        self.assertEqual(reset['metrics']['indexMode'], 'full')
        self.assertEqual(semantic(reset), semantic(scanner.scan(self.root, now=NOW + 2000,
                         cache_request={'version': 1})))
        file.unlink()
        deleted = scanner.scan(self.root, now=NOW + 3000, cache_request=hints(first))
        self.assertEqual(deleted['metrics']['indexMode'], 'full')
        self.assertEqual(len(deleted['sessions']), 4)
        for invalid in [
            {'rootKey': '0' * 64, **{k:v for k,v in first['directory'].items() if k != 'rootKey'}},
            {**first['directory'], 'files': [{**first['directory']['files'][0], 'path': '../../secret.jsonl'}]},
            {**first['directory'], 'files': [first['directory']['files'][0]] * 2},
            {**first['directory'], 'count': True},
        ]:
            with self.subTest(invalid=invalid):
                result = scanner.scan(self.root, now=NOW + 4000,
                    cache_request=dict(request(first), directory=invalid))
                self.assertEqual(result['metrics']['indexMode'], 'full')

    def test_equal_mtimes_keep_original_os_walk_tie_order_after_reordering(self):
        for i in range(12):
            create(self.root, str(i), mtime=NOW - 3000)
        first = scanner.scan(self.root, now=NOW, cache_request={'version': 1})
        selected = first['directory']['files']
        self.assertEqual(len({row['modified'] for row in selected}), 1)
        # Push one old candidate to the front, preserving original order for
        # all remaining tied mtimes. Later it returns to the same tie.
        file = self.root / 'sessions' / Path(selected[-1]['path'])
        os.utime(file, ns=((NOW + 2000) * 1_000_000,) * 2)
        second = scanner.scan(self.root, now=NOW + 3000, cache_request=hints(first))
        full = scanner.scan(self.root, now=NOW + 3000, cache_request={'version': 1})
        self.assertEqual([r['rolloutPath'] for r in second['sessions']],
                         [r['rolloutPath'] for r in full['sessions']])
        self.assertEqual(semantic(second), semantic(full))

    def test_old_active_pin_is_retained_in_incremental_mode(self):
        old = create(self.root, 'old', mtime=NOW - 20_000, day='2020/01/01')
        for i in range(10):
            create(self.root, str(i), mtime=NOW - i * 1000)
        pin = old.relative_to(self.root / 'sessions').as_posix()
        first = scanner.scan(self.root, now=NOW, limit=4, pinned_paths=[pin],
                             cache_request={'version': 1})
        second = scanner.scan(self.root, now=NOW + 1000, limit=4, pinned_paths=[pin],
                              cache_request=hints(first))
        self.assertEqual(second['metrics']['indexMode'], 'incremental')
        self.assertEqual(semantic(second), semantic(scanner.scan(self.root,
                         now=NOW + 1000, limit=4, pinned_paths=[pin],
                         cache_request={'version': 1})))
        self.assertIn('old', [row['id'] for row in second['sessions']])


if __name__ == '__main__':
    unittest.main()
