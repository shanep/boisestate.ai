// Runs claude plugin validate and fails on any error, warning or directory
// finding, except the one about the missing version. The plugin has no version
// on purpose, so Claude Code uses the commit SHA and every push to master ships.
// Prints nothing when the plugin is clean.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

const run = spawnSync('claude', ['plugin', 'validate', '--json', '.'], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (run.error !== undefined) {
  if ('code' in run.error && run.error.code === 'ENOENT') {
    console.error('validate: claude is not installed, so skipping plugin validate.');
    process.exit(0);
  }
  throw run.error;
}

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error('validate: claude plugin validate did not print JSON:');
  console.error(run.stdout + run.stderr);
  process.exit(1);
}

const isNoVersion = (warning) =>
  warning.path === 'version' && warning.message.startsWith('No version specified');

const problems = [];
const add = (where, kind, items) => {
  for (const item of items ?? []) {
    problems.push(`${where}: ${kind}: ${item.path === undefined ? '' : `${item.path}: `}${item.message}`);
  }
};

const manifest = report.manifest ?? {};
const manifestFile = manifest.file === undefined ? 'plugin.json' : path.relative(ROOT, manifest.file);
add(manifestFile, 'error', manifest.errors);
add(manifestFile, 'warning', (manifest.warnings ?? []).filter((warning) => !isNoVersion(warning)));
for (const content of report.contents ?? []) {
  const where = path.relative(ROOT, content.file);
  add(where, 'error', content.errors);
  add(where, 'warning', content.warnings);
}

const directory = report.directory ?? {};
for (const finding of directory.findings ?? []) {
  problems.push(`${finding.file}: ${finding.severity} ${finding.code}: ${finding.message}\n  fix: ${finding.fix}`);
}
if (directory.failure !== null && directory.failure !== undefined) {
  problems.push(`directory check failed: ${JSON.stringify(directory.failure)}`);
}
if (directory.incomplete === true) {
  problems.push('directory check did not finish');
}
if (report.success !== true && problems.length === 0) {
  problems.push(`claude plugin validate failed:\n${run.stdout}${run.stderr}`);
}

if (problems.length > 0) {
  console.error('validate: the plugin has problems:');
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}
