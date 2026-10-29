import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit publishing command. It never changes the source checkout or global Git settings.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const repo = 'NaOH42/apple-duo-fold-simulator';
const author = ['-c', 'user.name=NaOH42', '-c', 'user.email=86754662+NaOH42@users.noreply.github.com'];
const auth = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Git command failed');
  return result.stdout.trim();
}
function ref(name) {
  const result = spawnSync('git', ['rev-parse', '--verify', name], { cwd: root, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : '';
}
const remote = git(['remote', 'get-url', 'origin']);
if (remote.toLowerCase() !== `https://github.com/${repo}.git`.toLowerCase()) throw new Error('Unexpected publish repository');
if (!existsSync(join(dist, 'index.html'))) throw new Error('Run npm run build first');
if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Commit source changes before publishing');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
git([...auth, 'fetch', 'origin']);
const local = ref('refs/heads/gh-pages');
const remoteHead = ref('refs/remotes/origin/gh-pages');
if (local && remoteHead && local !== remoteHead) throw new Error('Local and remote publish history differ; inspect before publishing');
const parent = remoteHead || local;
const gitDir = git(['rev-parse', '--absolute-git-dir']);
const env = { ...process.env, GIT_INDEX_FILE: join(gitDir, 'pages-publish-index') };
const publishGit = args => git(['-c', 'core.autocrlf=false', `--git-dir=${gitDir}`, `--work-tree=${dist}`, ...args], { cwd: dist, env });
publishGit(['read-tree', ...(parent ? [parent] : ['--empty'])]);
function files(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Publish artifacts must not contain symlinks');
    return entry.isDirectory() ? files(path) : [relative(dist, path).replaceAll('\\', '/')];
  });
}
// Overlay current artifacts; preserve older fingerprinted assets for already-open tabs.
publishGit(['add', '-f', '--', ...files(dist)]);
const tree = publishGit(['write-tree']);
const commit = git([...author, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `Deploy Apple DUO v${pkg.version}`]);
git(['update-ref', 'refs/heads/gh-pages', commit, local || '0000000000000000000000000000000000000000']);
git([...auth, 'push', '-u', 'origin', 'gh-pages']);
const receipt = { repository: repo, sourceCommit: git(['rev-parse', 'main']), publishCommit: commit, tree, version: pkg.version };
mkdirSync(join(root, 'artifacts'), { recursive: true });
writeFileSync(join(root, 'artifacts', `github-pages-v${pkg.version}.json`), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
