"""Synthetic remote-scanner benchmark. Never opens the user's Codex home.

Optional --baseline is an exported older collector/scan.py. Timings measure local
Python/filesystem work, not SSH latency, WSL startup, OS disk traffic or app RAM.
"""
import argparse
import importlib.util
import json
import os
import statistics
import tempfile
import time
from pathlib import Path
from unittest.mock import patch


def load(file, name):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def hints(response):
    return {'version': 1, 'rootKey': response['rootKey'], 'entries': [
        dict(path=row['rolloutPath'], id=row['id'], **{key: row['_cache'][key]
             for key in ('signature', 'from', 'until')})
        for row in response['sessions'] if '_cache' in row]}


def hydrate(response, baseline):
    by_path = {row['rolloutPath']: row for row in baseline['sessions']}
    result = []
    for row in response['sessions']:
        if '_reuse' in row:
            previous = by_path[row['rolloutPath']]
            metadata = previous['_cache']
            row = {**previous, 'title': row['title'] or metadata['title'],
                'clientKind': row['clientKind'] if metadata['clientKind'] == 'unknown' else metadata['clientKind'],
                'ageAtSourceMs': response['sourceNow'] - previous['updatedAt'],
                'lastUserInputAgeAtSourceMs': None if previous['lastUserInputAtSourceMs'] is None
                    else response['sourceNow'] - previous['lastUserInputAtSourceMs']}
        result.append({key: value for key, value in row.items() if not key.startswith('_')})
    return result


def measured_reads(run):
    original = Path.open
    stats = {'logOpens': 0, 'logBytesRead': 0}
    class Metered:
        def __init__(self, stream): self.stream = stream
        def __enter__(self): return self
        def __exit__(self, *args): return self.stream.__exit__(*args)
        def __getattr__(self, name): return getattr(self.stream, name)
        def read(self, *args):
            value = self.stream.read(*args)
            stats['logBytesRead'] += len(value)
            return value
    def opened(file, *args, **kwargs):
        stream = original(file, *args, **kwargs)
        if file.suffix == '.jsonl' and 'sessions' in file.parts:
            stats['logOpens'] += 1
            return Metered(stream)
        return stream
    with patch.object(Path, 'open', opened):
        result = run()
    return stats, result


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument('--baseline', type=Path)
    args.add_argument('--files', type=int, default=10000)
    args.add_argument('--repeats', type=int, default=5)
    opts = args.parse_args()
    if not 200 <= opts.files <= 10000 or not 1 <= opts.repeats <= 20:
        args.error('Use 200..10000 files and 1..20 repetitions')
    current = load(Path(__file__).resolve().parents[1] / 'collector' / 'scan.py', 'current')
    baseline = load(opts.baseline, 'baseline') if opts.baseline else current
    now = 1_800_000_000_000
    with tempfile.TemporaryDirectory(prefix='codex-monitor-bench-') as directory:
        root = Path(directory)
        day = root / 'sessions' / '2026' / '10' / '19'
        day.mkdir(parents=True)
        filler = json.dumps({'type': 'response_item', 'payload': {'type': 'function_call_output',
            'output': 'x' * 1024}}) + '\n'
        for i in range(opts.files):
            meta = json.dumps({'type': 'session_meta', 'payload': {'id': 'bench-' + str(i), 'source': 'cli'}}) + '\n'
            terminal = json.dumps({'type': 'event_msg', 'timestamp': '2026-10-19T00:00:00Z',
                'payload': {'type': 'turn_complete', 'turn_id': 'turn-' + str(i)}}) + '\n'
            file = day / ('rollout-' + str(i) + '.jsonl')
            file.write_text(meta + (filler * 470 if i >= opts.files - 200 else '') + terminal, encoding='utf8')
            modified = now - (opts.files - i) * 1000
            os.utime(file, ns=(modified * 1_000_000,) * 2)
        initial = current.scan(root, now=now, cache_request={'version': 1})
        results = []
        def bench(name, run, expected):
            samples = []
            for _ in range(opts.repeats):
                start = time.perf_counter()
                run()
                samples.append((time.perf_counter() - start) * 1000)
            io_counts, result = measured_reads(run)
            rows = hydrate(result, initial) if isinstance(result, dict) else result
            assert rows == expected, name + ': semantic mismatch'
            results.append({'case': name, 'medianMs': round(statistics.median(samples), 2),
                **io_counts, **({'parsedFiles': result['metrics']['parsedFiles'],
                    'cacheHits': result['metrics']['cacheHits'],
                    'indexedFiles': result['metrics']['indexedFiles']} if isinstance(result, dict) else {})})
        expected = baseline.scan(root, now=now)
        bench('baseline-full', lambda: baseline.scan(root, now=now), expected)
        bench('optimized-cold', lambda: current.scan(root, now=now, cache_request={'version': 1}), expected)
        expected = baseline.scan(root, now=now + 3000)
        bench('warm-unchanged', lambda: current.scan(root, now=now + 3000, cache_request=hints(initial)), expected)
        changed = day / ('rollout-' + str(opts.files - 1) + '.jsonl')
        with changed.open('a', encoding='utf8') as stream:
            stream.write(json.dumps({'type': 'event_msg', 'payload': {'type': 'turn_started', 'turn_id': 'new-turn'}}) + '\n')
        os.utime(changed, ns=((now + 2000) * 1_000_000,) * 2)
        expected = baseline.scan(root, now=now + 3000)
        bench('warm-one-change', lambda: current.scan(root, now=now + 3000, cache_request=hints(initial)), expected)
        print(json.dumps({'files': opts.files, 'selected': 200, 'repeats': opts.repeats,
            'timingScope': 'synthetic-local-python-filesystem', 'baseline': 'provided-file' if opts.baseline else 'uncached-current',
            'results': results}, indent=2))


if __name__ == '__main__':
    main()
