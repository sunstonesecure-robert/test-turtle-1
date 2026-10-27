import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[2] / 'scripts/skills/runtime-skills.py'
spec = importlib.util.spec_from_file_location('runtime_skills', MODULE)
skills = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skills)


class RuntimeSkillsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / 'source'
        self.source.mkdir()
        self.workspace = self.base / 'workspace'
        self.workspace.mkdir()
        self.root = self.base / 'runtime'
        for i in range(4):
            folder = self.source / 'skills' / f'skill-{i}'
            folder.mkdir(parents=True)
            (folder / 'SKILL.md').write_text(f'---\nname: skill-{i}\ndescription: Test\n---\nInstructions')
            (folder / 'reference.txt').write_text('supporting material')
        unsafe = self.source / 'skills' / 'unsafe'
        unsafe.mkdir()
        (unsafe / 'SKILL.md').write_text('unsafe')
        (unsafe / 'escape').symlink_to('/etc/passwd')
        subprocess.run(['git', 'init', '-q', str(self.source)], check=True)
        self.git('add', '.')
        self.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture')
        self.manifest = skills.prepare(self.source, self.workspace, self.root)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.source), *args], text=True).strip()

    def test_catalog_records_commit_and_excludes_symlinks(self):
        self.assertEqual(self.manifest['commit'], self.git('rev-parse', 'HEAD'))
        self.assertEqual(len(self.manifest['skills']), 4)
        self.assertTrue((self.workspace / '.claude/skills').is_dir())

    def test_install_copies_supporting_files_and_is_idempotent(self):
        entry = self.manifest['skills'][0]
        skills.install(entry['id'], self.root)
        skills.install(entry['id'], self.root)
        installed = json.loads((self.root / 'installed.json').read_text())
        self.assertEqual(len(installed), 1)
        self.assertEqual(installed[0]['commit'], self.manifest['commit'])
        self.assertEqual((self.workspace / '.claude/skills' / entry['id'] / 'reference.txt').read_text(), 'supporting material')

    def test_rejects_unknown_and_traversal_ids(self):
        for value in ['unknown', '../../escape', 'https://example.com/skill']:
            with self.assertRaises(ValueError):
                skills.install(value, self.root)

    def test_limits_installations(self):
        for entry in self.manifest['skills'][:3]:
            skills.install(entry['id'], self.root)
        with self.assertRaises(ValueError):
            skills.install(self.manifest['skills'][3]['id'], self.root)

    def test_does_not_overwrite_existing_skills(self):
        entry = self.manifest['skills'][0]
        (self.workspace / '.claude/skills' / entry['id']).mkdir()
        with self.assertRaises(ValueError):
            skills.install(entry['id'], self.root)


if __name__ == '__main__':
    unittest.main()
