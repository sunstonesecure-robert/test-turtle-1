#!/usr/bin/env python3
"""Stage and install skills from the workflow's single approved checkout.

prepare runs before Claude, with no execution of downloaded code. install runs
inside the agent sandbox and needs no network or credentials.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

REPOSITORY = 'SunStone-Secure-LLC/claude-skills'
ROOT = Path('/tmp/gh-aw/skills')


def prepare(source, workspace, root=ROOT):
    source, workspace = Path(source).resolve(), Path(workspace).resolve()
    sha = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    tracked = subprocess.check_output(['git', '-C', str(source), 'ls-files', '--stage', '-z'])
    files = {}
    for record in tracked.decode().split('\0'):
        if record:
            metadata, path = record.split('\t', 1)
            mode = metadata.split()[0]
            files[path] = mode
    root.mkdir(parents=True, exist_ok=False)
    entries = []
    for path, mode in sorted(files.items()):
        if Path(path).name != 'SKILL.md' or mode != '100644':
            continue
        folder = Path(path).parent
        members = [p for p in files if Path(p).is_relative_to(folder)]
        # Reject symlinks and submodules instead of following them outside a skill.
        if any(files[p] not in ('100644', '100755') for p in members):
            continue
        skill_id = 'repo-' + hashlib.sha256(str(folder).encode()).hexdigest()[:16]
        destination = root / 'source' / skill_id
        for member in members:
            relative = Path(member).relative_to(folder)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / member, target)
        text = (destination / 'SKILL.md').read_text()
        # Preserve raw metadata rather than trusting or executing YAML extensions.
        metadata = text.split('---', 2)[1] if text.startswith('---\n') and text.count('---') >= 2 else text[:1500]
        entries.append({'id': skill_id, 'path': str(folder), 'metadata': metadata[:6000]})
    if not entries:
        raise ValueError('Approved repository contains no installable skills')
    skills_dir = workspace / '.claude' / 'skills'
    skills_dir.mkdir(parents=True, exist_ok=True)
    manifest = {'repository': REPOSITORY, 'commit': sha, 'workspace': str(workspace), 'skills': entries}
    (root / 'catalog.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (root / 'installed.json').write_text('[]\n')
    shutil.copyfile(__file__, root / 'manage.py')
    print(f'Staged {len(entries)} skills from {REPOSITORY}@{sha}')
    return manifest


def install(skill_id, root=ROOT):
    manifest = json.loads((root / 'catalog.json').read_text())
    matches = [s for s in manifest['skills'] if s['id'] == skill_id]
    if len(matches) != 1:
        raise ValueError('Skill ID is not in the approved repository catalog')
    installed = json.loads((root / 'installed.json').read_text())
    if skill_id in [s['id'] for s in installed]:
        print(f'Already installed: {skill_id}')
        return
    if len(installed) >= 3:
        raise ValueError('At most three skills may be installed per run')
    destination = Path(manifest['workspace']) / '.claude' / 'skills' / skill_id
    if destination.exists():
        raise ValueError('Refusing to overwrite an existing skill')
    shutil.copytree(root / 'source' / skill_id, destination)
    installed.append({**matches[0], 'commit': manifest['commit']})
    (root / 'installed.json').write_text(json.dumps(installed, indent=2) + '\n')
    print(f"Installed {matches[0]['path']}@{manifest['commit']} to {destination}")


if __name__ == '__main__':
    try:
        if len(sys.argv) == 4 and sys.argv[1] == 'prepare':
            prepare(sys.argv[2], sys.argv[3])
        elif len(sys.argv) == 3 and sys.argv[1] == 'install':
            install(sys.argv[2])
        else:
            raise ValueError('Usage: runtime-skills.py prepare SOURCE WORKSPACE | install CATALOG_ID')
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
