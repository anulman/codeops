#!/usr/bin/python3
"""Harmless synthetic fixtures; run in a credential-free network-none container."""
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('launcher', Path(__file__).with_name('trusted-test-launcher.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

class SnapshotProof(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / 'source'
        self.source.mkdir()
        self.outside = self.base / 'outside'
        self.outside.mkdir()
        (self.outside / 'file').write_bytes(b'OUTSIDE-SYNTHETIC')
        (self.source / 'dir').mkdir()
        (self.source / 'dir/file').write_bytes(b'INSIDE')
        self.fd = launcher.open_directory(str(self.source))
        self.addCleanup(os.close, self.fd)

    def read(self, path=b'dir/file'):
        return launcher.read_source_file(self.fd, path)[0]

    def refused(self, path=b'dir/file'):
        with self.assertRaises((RuntimeError, OSError)):
            self.read(path)

    def test_ordinary(self):
        self.assertEqual(self.read(), b'INSIDE')

    def test_ancestor_symlink(self):
        (self.source / 'dir').rename(self.source / 'saved')
        (self.source / 'dir').symlink_to(self.outside, target_is_directory=True)
        self.refused()

    def test_leaf_symlink(self):
        (self.source / 'dir/file').unlink()
        (self.source / 'dir/file').symlink_to(self.outside / 'file')
        self.refused()

    def test_fifo_nonblocking(self):
        (self.source / 'dir/file').unlink()
        os.mkfifo(self.source / 'dir/file')
        self.refused()

    def test_hardlink(self):
        (self.source / 'dir/file').unlink()
        os.link(self.outside / 'file', self.source / 'dir/file')
        self.refused()

    def test_paths(self):
        for path in (b'/etc/irrelevant', b'../outside/file', b'dir/../file', b'dir//file', b'./dir/file', b''):
            with self.subTest(path=path): self.refused(path)

    def test_source_root_symlink(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(OSError): launcher.open_directory(str(alias))

    def test_ancestor_replaced_before_open(self):
        original = os.open
        def replace(path, *args, **kw):
            if path == b'dir':
                (self.source / 'dir').rename(self.source / 'saved')
                (self.source / 'dir').symlink_to(self.outside, target_is_directory=True)
            return original(path, *args, **kw)
        with patch.object(launcher.os, 'open', replace): self.refused()

    def test_ancestor_replaced_after_open_stays_pinned(self):
        original = os.open
        def replace(path, *args, **kw):
            result = original(path, *args, **kw)
            if path == b'dir':
                (self.source / 'dir').rename(self.source / 'saved')
                (self.source / 'dir').symlink_to(self.outside, target_is_directory=True)
            return result
        with patch.object(launcher.os, 'open', replace): self.assertEqual(self.read(), b'INSIDE')

    def test_leaf_replaced_before_open(self):
        original = os.open
        def replace(path, *args, **kw):
            if path == b'file':
                (self.source / 'dir/file').unlink()
                (self.source / 'dir/file').symlink_to(self.outside / 'file')
            return original(path, *args, **kw)
        with patch.object(launcher.os, 'open', replace): self.refused()

    def test_leaf_replaced_after_open_never_reads_outside(self):
        original = os.open
        def replace(path, *args, **kw):
            result = original(path, *args, **kw)
            if path == b'file':
                (self.source / 'dir/file').rename(self.source / 'dir/saved')
                (self.source / 'dir/file').symlink_to(self.outside / 'file')
            return result
        with patch.object(launcher.os, 'open', replace): self.assertEqual(self.read(), b'INSIDE')

    def test_content_mutation_refused(self):
        original = os.read
        def replace(fd, size):
            data = original(fd, size)
            if data: (self.source / 'dir/file').write_bytes(b'CHANGED-LENGTH')
            return data
        with patch.object(launcher.os, 'read', replace): self.refused()

    def test_dependency_archive_requires_operator_digest(self):
        archive = self.base / 'dependencies.tar'
        archive.write_bytes(b'SYNTHETIC-ARCHIVE')
        with self.assertRaises(RuntimeError): launcher.read_dependency_archive(archive, {})
        with self.assertRaises(RuntimeError): launcher.read_dependency_archive(archive, {'dependencyArchiveSha256': ['0' * 64]})
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertEqual(launcher.read_dependency_archive(archive, {'dependencyArchiveSha256': [digest]}), b'SYNTHETIC-ARCHIVE')
        archive.write_bytes(b'CHANGED')
        with self.assertRaises(RuntimeError): launcher.read_dependency_archive(archive, {'dependencyArchiveSha256': [digest]})

    def git(self, *args):
        subprocess.run(['/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', str(self.source), *args], env=launcher.ENV, check=True, capture_output=True)

    def test_ignored_ancestor_index_escape_no_archive(self):
        self.git('init', '-q'); self.git('add', 'dir/file')
        (self.source / '.gitignore').write_text('dir\n')
        (self.source / 'dir').rename(self.source / 'saved')
        (self.source / 'dir').symlink_to(self.outside, target_is_directory=True)
        archive = self.base / 'source.tar'
        with self.assertRaises((RuntimeError, OSError)): launcher.snapshot(self.source, archive)
        self.assertFalse(archive.exists())

    def test_digest_record_collision_regression(self):
        self.git('init', '-q')
        (self.source / 'a').write_bytes(b'Xb\x000\x00Y')
        first = launcher.snapshot(self.source, self.base / 'one.tar')
        (self.source / 'a').write_bytes(b'X')
        (self.source / 'b').write_bytes(b'Y')
        second = launcher.snapshot(self.source, self.base / 'two.tar')
        self.assertNotEqual(first, second)

    def test_digest_deterministic_and_normalized(self):
        self.git('init', '-q')
        leaf = self.source / 'dir/file'
        leaf.chmod(0o744)
        first = launcher.snapshot(self.source, self.base / 'one.tar')
        leaf.chmod(0o755)
        os.utime(leaf, (123456, 123456))
        second = launcher.snapshot(self.source, self.base / 'two.tar')
        self.assertEqual(first, second)
        self.assertEqual((self.base / 'one.tar').read_bytes(), (self.base / 'two.tar').read_bytes())
        leaf.chmod(0o644)
        self.assertNotEqual(first, launcher.snapshot(self.source, self.base / 'three.tar'))

    def test_regular_archive(self):
        self.git('init', '-q'); self.git('add', 'dir/file')
        archive = self.base / 'source.tar'
        digest = launcher.snapshot(self.source, archive)
        self.assertEqual(len(digest), 64)
        with tarfile.open(archive) as tar:
            self.assertEqual(tar.extractfile('dir/file').read(), b'INSIDE')

if __name__ == '__main__': unittest.main(verbosity=2)
