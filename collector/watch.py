"""Ephemeral Linux/WSL inotify event stream for Codex Monitor.

Runs via system ssh/wsl + Python stdin. No installation, remote daemon,
persistent state, or transcript content transfer. Emits small JSONL signals
on changes to rollout files; the Windows monitor performs the trusted scan.
"""
import base64
import ctypes
import ctypes.util
import errno
import json
import os
import select
import struct
import sys
import time
from pathlib import Path

IN_MODIFY = 0x00000002
IN_ATTRIB = 0x00000004
IN_CLOSE_WRITE = 0x00000008
IN_MOVED_TO = 0x00000080
IN_CREATE = 0x00000100
IN_DELETE_SELF = 0x00000400
IN_MOVE_SELF = 0x00000800
IN_Q_OVERFLOW = 0x00004000
IN_IGNORED = 0x00008000
IN_ISDIR = 0x40000000
MASK = (IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | IN_MOVED_TO |
        IN_CREATE | IN_DELETE_SELF | IN_MOVE_SELF)
MAX_WATCHED_DIRS = 2048
EMIT_INTERVAL_S = 0.3
HEARTBEAT_S = 25.0
HEADER = struct.Struct('iIII')


def emit(kind):
    # Only protocol names are sent to Windows, never paths, session IDs or text.
    print(json.dumps({'kind': kind}), flush=True)


class InotifyWatch:
    def __init__(self, root):
        library = ctypes.util.find_library('c') or 'libc.so.6'
        self.libc = ctypes.CDLL(library, use_errno=True)
        self.libc.inotify_init1.argtypes = [ctypes.c_int]
        self.libc.inotify_init1.restype = ctypes.c_int
        self.libc.inotify_add_watch.argtypes = [
            ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        self.libc.inotify_add_watch.restype = ctypes.c_int
        flags = os.O_NONBLOCK | getattr(os, 'O_CLOEXEC', 0)
        self.fd = self.libc.inotify_init1(flags)
        if self.fd < 0:
            err = ctypes.get_errno()
            raise OSError(err, os.strerror(err))
        self.directories = {}
        self.paths = set()
        try:
            self.add_tree(Path(root))
        except Exception:
            self.close()
            raise

    def close(self):
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1

    def add_directory(self, location):
        path = os.fspath(location)
        if path in self.paths or os.path.islink(path):
            return
        if len(self.paths) >= MAX_WATCHED_DIRS:
            raise RuntimeError('Too many Codex session directories for inotify')
        wd = self.libc.inotify_add_watch(self.fd, os.fsencode(path), MASK)
        if wd < 0:
            err = ctypes.get_errno()
            if err in (errno.ENOENT, errno.ENOTDIR):  # A folder was removed during walk.
                return
            raise OSError(err, os.strerror(err))
        self.directories[wd] = path
        self.paths.add(path)

    def add_tree(self, root):
        if root.is_symlink() or not root.is_dir():
            return
        for folder, children, _files in os.walk(root, followlinks=False):
            children[:] = [child for child in children
                           if not os.path.islink(os.path.join(folder, child))]
            self.add_directory(folder)

    def consume(self):
        """Return True when at least one Codex rollout may have changed."""
        dirty = False
        while True:
            try:
                raw = os.read(self.fd, 65536)
            except BlockingIOError:
                break
            if not raw:
                break
            offset = 0
            while offset + HEADER.size <= len(raw):
                wd, mask, _cookie, size = HEADER.unpack_from(raw, offset)
                offset += HEADER.size
                name_bytes = raw[offset:offset + size]
                offset += size
                if mask & IN_Q_OVERFLOW:
                    dirty = True  # Fall back to a complete trusted scan.
                    continue
                if mask & IN_IGNORED:
                    old = self.directories.pop(wd, None)
                    if old:
                        self.paths.discard(old)
                    continue
                directory = self.directories.get(wd)
                if not directory:
                    continue
                if mask & IN_ISDIR:
                    if mask & (IN_CREATE | IN_MOVED_TO):
                        name = os.fsdecode(name_bytes.rstrip(b'\0'))
                        if name:
                            self.add_tree(Path(directory) / name)
                    elif mask & (IN_DELETE_SELF | IN_MOVE_SELF):
                        # A future poll recreates the full watcher on failure.
                        dirty = True
                else:
                    name = os.fsdecode(name_bytes.rstrip(b'\0'))
                    if name.endswith('.jsonl') and mask & MASK:
                        dirty = True
        return dirty


def run(root):
    sessions = Path(root).expanduser() / 'sessions'
    if not sessions.is_dir():
        raise FileNotFoundError('Codex sessions folder unavailable')
    watcher = InotifyWatch(sessions)
    try:
        emit('ready')
        dirty = False
        last_emit = time.monotonic()
        last_heartbeat = last_emit
        while True:
            interval = EMIT_INTERVAL_S if dirty else 1.0
            readable, _, _ = select.select([watcher.fd], [], [], interval)
            if readable:
                dirty = watcher.consume() or dirty
            now = time.monotonic()
            if dirty and now - last_emit >= EMIT_INTERVAL_S:
                emit('change')
                dirty = False
                last_emit = now
            if now - last_heartbeat >= HEARTBEAT_S:
                emit('heartbeat')
                last_heartbeat = now
    finally:
        watcher.close()


def main():
    config_b64 = globals().get('CONFIG_B64', '')
    options = json.loads(base64.b64decode(config_b64)) if config_b64 else {}
    root = options.get('root') or os.environ.get('CODEX_HOME') or str(Path.home() / '.codex')
    run(root)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, TypeError) as error:
        print(f'Codex event watcher unavailable: {error}', file=sys.stderr)
        sys.exit(1)
