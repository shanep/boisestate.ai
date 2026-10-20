// Where the launcher keeps its files. State (the usage log, the bridge log and
// each session's notice file) goes under XDG_STATE_HOME and config (the api key
// on Linux without secret-tool) under XDG_CONFIG_HOME, with the usual defaults
// on both macOS and Linux.

import path from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

export interface Paths {
  readonly stateDir: string;
  readonly configDir: string;
  /** Every session on the machine appends here, so `boisestate usage` sees them all. */
  readonly usageLog: string;
  /** Bridge errors go here, since stderr belongs to the Claude Code TUI. */
  readonly bridgeLog: string;
  /** Claude Code's own folder, where it lists installed plugins. */
  readonly claudeDir: string;
}

const APP = 'boisestate-ai';

function dirFrom(value: string | undefined, fallback: string): string {
  return value !== undefined && value.trim() !== '' ? value : fallback;
}

export function pathsFor(env: Env, home: string): Paths {
  const stateDir = path.join(
    dirFrom(env['XDG_STATE_HOME'], path.join(home, '.local', 'state')),
    APP,
  );
  const configDir = path.join(dirFrom(env['XDG_CONFIG_HOME'], path.join(home, '.config')), APP);
  return {
    stateDir,
    configDir,
    usageLog: dirFrom(env['BOISESTATE_USAGE_LOG'], path.join(stateDir, 'usage.jsonl')),
    bridgeLog: path.join(stateDir, 'bridge.log'),
    claudeDir: dirFrom(env['CLAUDE_CONFIG_DIR'], path.join(home, '.claude')),
  };
}

/** The notice file for one launcher process, removed when it exits. */
export function noticeFileFor(paths: Paths, pid: number): string {
  return path.join(paths.stateDir, `notices-${String(pid)}.jsonl`);
}
