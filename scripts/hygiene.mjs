import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export function violations(path, text) {
  const errors = [];
  if (/(^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|data|backups|node_modules|\.wrangler)(\/|$)|\.(?:sqlite(?:-wal|-shm)?|db|pem|key|eml|mbox|log|tgz|tar)$/.test(path)) errors.push('private-path');
  if (/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/.test(text)) errors.push('credential');
  if (/\/home\/[a-z][a-z0-9_-]*\//i.test(text)) errors.push('private-home-path');
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const git = args => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
  const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean))];
  const errors = [];
  for (const file of files) {
    if (lstatSync(file).isSymbolicLink()) { errors.push(`${file}: symlink`); continue; }
    for (const code of violations(file, readFileSync(file, 'utf8'))) errors.push(`${file}: ${code}`);
  }
  const revisions = git(['rev-list', '--all']).toString().trim().split('\n').filter(Boolean);
  for (const rev of revisions) {
    const paths = git(['ls-tree', '-r', '-z', '--name-only', rev]).toString().split('\0').filter(Boolean);
    for (const file of paths) for (const code of violations(file, git(['show', `${rev}:${file}`]).toString())) errors.push(`${rev}:${file}: ${code}`);
    if (violations('commit', git(['show', '-s', '--format=fuller', rev]).toString()).length) errors.push(`${rev}: metadata`);
  }
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Hygiene passed: ${files.length} worktree files and ${revisions.length} reachable commits`);
}
