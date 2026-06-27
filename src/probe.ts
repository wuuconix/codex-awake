import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { AppConfig, AuthAccount } from './types.js';
import type { Store, StoredCandidate } from './db.js';
import { authJsonForCodexCli } from './auth.js';
import { removeDirQuiet, sleep, truncate, writeJsonFile } from './util.js';

export type ProbeResult = {
  candidate: StoredCandidate;
  status: 'success' | 'failed' | 'skipped';
  exitCode: number | null;
  error: string | null;
};

export function buildProbeCommand(config: AppConfig): string {
  return `${config.codexBin} exec --skip-git-repo-check --color never --output-last-message <tmp> -C <workspace> -c model=${JSON.stringify(
    config.probeModel
  )} ${JSON.stringify(config.probePrompt)}`;
}

async function createCodexHome(account: AuthAccount): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-awake-'));
  await mkdir(path.join(root, 'workspace'), { recursive: true });
  await writeJsonFile(path.join(root, 'auth.json'), authJsonForCodexCli(account));
  return root;
}

async function waitForProbeInterval(store: Store, minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const lastStartedAt = store.lastSuccessfulProbeStartedAt();
  if (lastStartedAt === null) return;
  const waitMs = minIntervalMs - (Date.now() - lastStartedAt);
  if (waitMs > 0) await sleep(waitMs);
}

function proxyEnv(config: AppConfig): NodeJS.ProcessEnv {
  if (!config.proxyUrl) return {};
  return {
    HTTP_PROXY: process.env.HTTP_PROXY ?? config.proxyUrl,
    HTTPS_PROXY: process.env.HTTPS_PROXY ?? config.proxyUrl,
    ALL_PROXY: process.env.ALL_PROXY ?? config.proxyUrl,
    NO_PROXY: process.env.NO_PROXY
  };
}

function errorSummary(error: unknown): string {
  const pieces: string[] = [];
  if (typeof error === 'object' && error !== null) {
    const maybe = error as {
      message?: unknown;
      timedOut?: unknown;
      signal?: unknown;
      exitCode?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      all?: unknown;
    };
    if (maybe.timedOut) pieces.push('codex exec timed out');
    if (maybe.signal) pieces.push(`signal=${String(maybe.signal)}`);
    if (maybe.exitCode !== undefined) pieces.push(`exitCode=${String(maybe.exitCode)}`);
    if (typeof maybe.message === 'string') pieces.push(maybe.message);
    if (typeof maybe.all === 'string' && maybe.all.trim()) pieces.push(`output=${maybe.all.trim()}`);
    if (typeof maybe.stderr === 'string' && maybe.stderr.trim()) pieces.push(`stderr=${maybe.stderr.trim()}`);
    if (typeof maybe.stdout === 'string' && maybe.stdout.trim()) pieces.push(`stdout=${maybe.stdout.trim()}`);
  } else {
    pieces.push(String(error));
  }
  const summary = pieces.filter(Boolean).join('\n');
  return truncate(summary || 'codex exec failed', 2000);
}

export async function probeCandidate(
  candidate: StoredCandidate,
  account: AuthAccount | undefined,
  config: AppConfig,
  store: Store,
  dryRun: boolean
): Promise<ProbeResult> {
  if (!account) {
    store.markCandidate(candidate.id, 'missing-auth');
    return { candidate, status: 'skipped', exitCode: null, error: 'auth account not found' };
  }
  if (dryRun) {
    return { candidate, status: 'skipped', exitCode: null, error: null };
  }

  await waitForProbeInterval(store, config.probeMinIntervalMs);
  const commandText = buildProbeCommand(config);
  const probeRunId = store.insertProbeStart(candidate, commandText);
  store.markCandidate(candidate.id, 'probing');

  let codexHome: string | null = null;
  try {
    codexHome = await createCodexHome(account);
    const workspace = path.join(codexHome, 'workspace');
    const lastMessagePath = path.join(codexHome, 'last-message.txt');
    await execa(
      config.codexBin,
      [
        'exec',
        '--skip-git-repo-check',
        '--color',
        'never',
        '--output-last-message',
        lastMessagePath,
        '-C',
        workspace,
        '-c',
        `model=${JSON.stringify(config.probeModel)}`,
        config.probePrompt
      ],
      {
        env: { ...proxyEnv(config), CODEX_HOME: codexHome },
        stdin: 'ignore',
        all: true,
        timeout: config.probeTimeoutMs,
        killSignal: 'SIGTERM',
        forceKillAfterDelay: 5000,
        reject: true
      }
    );
    store.finishProbe(probeRunId, 'success', 0, null);
    store.markCandidate(candidate.id, 'probed');
    return { candidate, status: 'success', exitCode: 0, error: null };
  } catch (error) {
    const exitCode =
      typeof error === 'object' && error !== null && 'exitCode' in error
        ? Number((error as { exitCode?: unknown }).exitCode ?? 1)
        : 1;
    const message = errorSummary(error);
    store.finishProbe(probeRunId, 'failed', Number.isFinite(exitCode) ? exitCode : 1, message);
    store.markCandidate(candidate.id, 'failed');
    return { candidate, status: 'failed', exitCode: Number.isFinite(exitCode) ? exitCode : 1, error: message };
  } finally {
    if (codexHome) await removeDirQuiet(codexHome);
  }
}

export async function probeCandidates(
  candidates: StoredCandidate[],
  accounts: AuthAccount[],
  config: AppConfig,
  store: Store,
  options: { dryRun: boolean; limitProbes?: number }
): Promise<ProbeResult[]> {
  const lockOwner = options.dryRun ? 'dry-run' : store.acquireLock('probe', Math.max(config.probeMinIntervalMs * 2, 600_000));
  if (!lockOwner) {
    throw new Error('another probe run is active');
  }
  const byKey = new Map(accounts.map((account) => [account.accountKey, account]));
  const selected = candidates.slice(0, options.limitProbes ?? candidates.length);
  const results: ProbeResult[] = [];
  try {
    for (const candidate of selected) {
      if (store.hasRecentSuccessfulProbe(candidate.accountKey, config.probeCooldownMs)) {
        store.markCandidate(candidate.id, 'recently-probed');
        results.push({ candidate, status: 'skipped', exitCode: null, error: 'recently probed' });
        continue;
      }
      results.push(await probeCandidate(candidate, byKey.get(candidate.accountKey), config, store, options.dryRun));
    }
    return results;
  } finally {
    if (!options.dryRun) store.releaseLock('probe', lockOwner);
  }
}
