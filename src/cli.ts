#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { Command } from 'commander';
import { execa } from 'execa';
import pino from 'pino';
import { loadAuthAccounts } from './auth.js';
import { loadConfig } from './config.js';
import { currentRunId, openStore } from './db.js';
import { applyCpaPriorityPlan, buildCpaPriorityPlan, inferredResetAtMs, pickDisplayWindow } from './priority.js';
import { buildWakeCandidates, refreshQuotas } from './quota.js';
import { buildProbeCommand, probeCandidates } from './probe.js';
import type { AppConfig, AuthAccount, WakeCandidate } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

type GlobalOptions = { config?: string };
type ProbeOptions = { dryRun?: boolean; limitProbes?: string; limitAccounts?: string; probeModel?: string; probePrompt?: string };
type PriorityOptions = {
  dryRun?: boolean;
  keepMissingResetPriority?: boolean;
  limitAccounts?: string;
};

function parseLimit(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('--limit-probes must be a non-negative integer');
  return parsed;
}

function parseOptionalLimit(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function formatDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-';
  return new Date(ms).toLocaleString('sv-SE', { hour12: false });
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '-';
  const sign = seconds < 0 ? '-' : '';
  const total = Math.abs(Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${sign}${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${sign}${hours}h ${minutes}m`;
  return `${sign}${minutes}m`;
}

function showQuotaResets(store: ReturnType<typeof openStore>, limit?: number): void {
  const rows = store
    .listLatestQuotaSnapshots()
    .map((row) => {
      const window = pickDisplayWindow(row);
      const resetAtMs = inferredResetAtMs(row, window);
      return {
        email: row.email ?? row.accountKey,
        fileName: row.fileName,
        plan: row.planType ?? '-',
        ok: row.ok === null ? '-' : row.ok ? 'yes' : 'no',
        window: window?.kind ?? '-',
        scope: window?.scope ?? '-',
        usedPercent: window?.usedPercent ?? '-',
        remaining: formatDuration(window?.remainingSeconds),
        resetAt: formatDateTime(resetAtMs),
        refreshedAt: formatDateTime(row.createdAtMs),
        error: row.error ? row.error.slice(0, 80) : '',
        resetAtMs
      };
    })
    .sort((a, b) => {
      if (a.resetAtMs === null && b.resetAtMs === null) return a.email.localeCompare(b.email);
      if (a.resetAtMs === null) return 1;
      if (b.resetAtMs === null) return -1;
      return a.resetAtMs - b.resetAtMs;
    })
    .slice(0, limit ?? undefined)
    .map(({ resetAtMs: _resetAtMs, ...row }) => row);

  console.table(rows);
}

async function setCpaPriorities(
  config: AppConfig,
  store: ReturnType<typeof openStore>,
  options: PriorityOptions
): Promise<void> {
  const limitAccounts = parseOptionalLimit(options.limitAccounts, '--limit-accounts');
  const loadedAccounts = await loadAuthAccounts(config.authDir);
  const accounts = limitAccounts === undefined ? loadedAccounts : loadedAccounts.slice(0, limitAccounts);
  for (const account of accounts) {
    store.upsertAccount(account);
  }

  const fullPlan = buildCpaPriorityPlan(accounts, store.listLatestQuotaSnapshots(), {
    clearMissingReset: !options.keepMissingResetPriority
  });
  const enabledCount = accounts.filter((account) => !account.disabled).length;
  const knownResetCount = fullPlan.filter((item) => item.reason === 'reset-known').length;
  const plan =
    enabledCount > 0 && knownResetCount === 0
      ? fullPlan.filter((item) => item.reason !== 'missing-reset')
      : fullPlan;

  if (enabledCount > 0 && knownResetCount === 0 && plan.length === 0) {
    throw new Error('no existing enabled auth files have quota reset metadata in SQLite; run scan separately first');
  }

  const results = await applyCpaPriorityPlan(plan, { dryRun: Boolean(options.dryRun) });
  console.table(
    results.map((result) => ({
      fileName: result.account.fileName,
      email: result.account.email ?? result.account.accountKey,
      priority: result.priority > 0 ? result.priority : 'default',
      previous: result.previousPriority ?? '-',
      disabled: result.disabled ? 'yes' : 'no',
      previousDisabled: result.previousDisabled ? 'yes' : 'no',
      resetAt: formatDateTime(result.resetAtMs),
      action: result.skipped ? 'skipped' : result.changed ? (options.dryRun ? 'would update' : 'updated') : 'unchanged',
      reason: result.reason,
      error: result.error ?? ''
    }))
  );

  const changed = results.filter((item) => item.changed && !item.skipped).length;
  const skipped = results.filter((item) => item.skipped).length;
  logger.info(
    {
      enabled: enabledCount,
      knownReset: knownResetCount,
      maintenanceOnly: fullPlan.length !== plan.length,
      planned: plan.length,
      changed,
      skipped,
      dryRun: Boolean(options.dryRun)
    },
    options.dryRun ? 'CPA priority dry run complete' : 'CPA priorities updated'
  );
  if (skipped > 0) process.exitCode = 1;
}

async function withStore<T>(configPath: string | undefined, fn: (config: AppConfig, store: ReturnType<typeof openStore>) => Promise<T>): Promise<T> {
  const config = loadConfig(configPath);
  const store = openStore(config.dbPath);
  try {
    return await fn(config, store);
  } finally {
    store.close();
  }
}

async function scan(
  config: AppConfig,
  store: ReturnType<typeof openStore>,
  dryRun: boolean,
  limitAccounts?: number
): Promise<{
  accounts: AuthAccount[];
  candidates: WakeCandidate[];
}> {
  const loadedAccounts = await loadAuthAccounts(config.authDir);
  const accounts = limitAccounts === undefined ? loadedAccounts : loadedAccounts.slice(0, limitAccounts);
  const candidates: WakeCandidate[] = [];
  logger.info({ selected: accounts.length, total: loadedAccounts.length }, 'loaded codex auth accounts');

  if (!dryRun) {
    for (const account of accounts) {
      store.upsertAccount(account);
    }
  }

  await refreshQuotas(accounts, config, async (result) => {
    if (!dryRun) {
      store.upsertAccount(result.account, result.planType);
      store.insertQuotaSnapshot(result);
    }
    const recent = store.hasRecentSuccessfulProbe(result.account.accountKey, config.probeCooldownMs);
    const nextCandidates = buildWakeCandidates(
      result,
      config.dormantToleranceSeconds,
      config.dormantMaxUsedPercent,
      recent
    );
    candidates.push(...nextCandidates);
    logger.info(
      {
        fileName: result.account.fileName,
        ok: result.ok,
        statusCode: result.statusCode,
        windows: result.windows.length,
        candidates: nextCandidates.length,
        error: result.error
      },
      dryRun ? 'quota refreshed (dry run)' : 'quota refreshed'
    );
    for (const candidate of nextCandidates) {
      logger.info(
        {
          fileName: candidate.fileName,
          email: candidate.email,
          windowKind: candidate.windowKind,
          windowScope: candidate.windowScope,
          remainingSeconds: candidate.remainingSeconds,
          reason: candidate.reason
        },
        dryRun ? 'would create wake candidate' : 'created wake candidate'
      );
    }
  });

  if (!dryRun) {
    store.replaceCandidates(currentRunId(), candidates);
  }
  return { accounts, candidates };
}

async function runProbePhase(
  config: AppConfig,
  store: ReturnType<typeof openStore>,
  accounts: AuthAccount[],
  options: ProbeOptions
): Promise<void> {
  const limitProbes = parseLimit(options.limitProbes);
  const probeConfig: AppConfig = {
    ...config,
    probeModel: options.probeModel?.trim() || config.probeModel,
    probePrompt: options.probePrompt?.trim() || config.probePrompt
  };
  const pending = store.listPendingCandidates(limitProbes ?? 1000);
  logger.info(
    { count: pending.length, dryRun: Boolean(options.dryRun), command: buildProbeCommand(probeConfig) },
    'loaded pending wake candidates'
  );
  for (const candidate of pending) {
    logger.info(
      {
        id: candidate.id,
        fileName: candidate.fileName,
        email: candidate.email,
        windowKind: candidate.windowKind,
        windowScope: candidate.windowScope
      },
      options.dryRun ? 'would probe candidate' : 'probing candidate'
    );
  }
  const results = await probeCandidates(pending, accounts, probeConfig, store, {
    dryRun: Boolean(options.dryRun),
    limitProbes
  });
  logger.info(
    {
      success: results.filter((item) => item.status === 'success').length,
      failed: results.filter((item) => item.status === 'failed').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      ineffective: results.filter((item) => item.status === 'ineffective').length
    },
    'probe phase complete'
  );
}

async function doctor(config: AppConfig): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  checks.push({ name: 'authDir', ok: existsSync(config.authDir), detail: config.authDir });
  try {
    const store = openStore(config.dbPath);
    store.close();
    checks.push({ name: 'sqlite', ok: true, detail: config.dbPath });
  } catch (error) {
    checks.push({ name: 'sqlite', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    await execa(config.codexBin, ['--version']);
    checks.push({ name: 'codex', ok: true, detail: config.codexBin });
  } catch (error) {
    checks.push({ name: 'codex', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    await access(config.authDir);
    const accounts = await loadAuthAccounts(config.authDir);
    checks.push({ name: 'authFiles', ok: accounts.length > 0, detail: `${accounts.length} codex accounts` });
  } catch (error) {
    checks.push({ name: 'authFiles', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  console.table(checks);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

const program = new Command();
program.name('codex-awake').description('Refresh Codex quota metadata and wake dormant accounts').version('0.1.0');
program.option('-c, --config <path>', 'config file path');

program
  .command('doctor')
  .description('check auth directory, sqlite, codex CLI, and local setup')
  .action(async () => {
    const opts = program.opts<GlobalOptions>();
    await doctor(loadConfig(opts.config));
  });

program
  .command('scan')
  .description('refresh quota metadata and generate wake candidates')
  .option('--dry-run', 'refresh quota and show candidates without saving them')
  .option('--limit-accounts <n>', 'maximum number of accounts to refresh')
  .action(async (options: { dryRun?: boolean; limitAccounts?: string }) => {
    const opts = program.opts<GlobalOptions>();
    await withStore(opts.config, async (config, store) => {
      const result = await scan(
        config,
        store,
        Boolean(options.dryRun),
        parseOptionalLimit(options.limitAccounts, '--limit-accounts')
      );
      logger.info({ candidates: result.candidates.length }, 'scan complete');
    });
  });

program
  .command('probe-candidates')
  .description('probe stored pending candidates')
  .option('--dry-run', 'show candidates without running codex exec')
  .option('--limit-probes <n>', 'maximum number of probes to run')
  .option('--probe-model <model>', 'override probe model for this run')
  .option('--probe-prompt <prompt>', 'override probe prompt for this run')
  .action(async (options: ProbeOptions) => {
    const opts = program.opts<GlobalOptions>();
    await withStore(opts.config, async (config, store) => {
      const accounts = await loadAuthAccounts(config.authDir);
      await runProbePhase(config, store, accounts, options);
    });
  });

program
  .command('run')
  .description('scan quota metadata, create candidates, then probe them')
  .option('--dry-run', 'refresh quota and show candidates without saving candidates or running codex exec')
  .option('--limit-probes <n>', 'maximum number of probes to run')
  .option('--limit-accounts <n>', 'maximum number of accounts to refresh')
  .option('--probe-model <model>', 'override probe model for this run')
  .option('--probe-prompt <prompt>', 'override probe prompt for this run')
  .action(async (options: ProbeOptions) => {
    const opts = program.opts<GlobalOptions>();
    await withStore(opts.config, async (config, store) => {
      const { accounts, candidates } = await scan(
        config,
        store,
        Boolean(options.dryRun),
        parseOptionalLimit(options.limitAccounts, '--limit-accounts')
      );
      logger.info({ candidates: candidates.length }, 'scan phase complete');
      if (options.dryRun) {
        logger.info({ candidates: candidates.length }, 'dry run complete; no probe executed');
        void accounts;
        return;
      }
      await runProbePhase(config, store, accounts, options);
    });
  });

program
  .command('show')
  .description('show recent accounts, candidates, snapshots, and probe runs')
  .action(async () => {
    const opts = program.opts<GlobalOptions>();
    await withStore(opts.config, async (_config, store) => {
      console.dir(store.showSummary(), { depth: 8, colors: true });
    });
  });

program
  .command('show-quota-resets')
  .description('view latest quota reset time per account, sorted by earliest reset')
  .option('--limit <n>', 'maximum number of accounts to show')
  .action(async (options: { limit?: string }) => {
    const opts = program.opts<GlobalOptions>();
    await withStore(opts.config, async (_config, store) => {
      showQuotaResets(store, parseOptionalLimit(options.limit, '--limit'));
    });
  });

program
  .command('set-cpa-priorities')
  .description('set CPA Codex auth file priorities from SQLite quota reset times')
  .option('--dry-run', 'show priority changes without writing auth files')
  .option('--keep-missing-reset-priority', 'leave enabled auth files without reset metadata unchanged')
  .option('--limit-accounts <n>', 'maximum number of existing auth files to update')
  .action(async (options: PriorityOptions) => {
    const opts = program.opts<GlobalOptions>();
    await withStore(opts.config, async (config, store) => {
      await setCpaPriorities(config, store, options);
    });
  });

program.parseAsync().catch((error: unknown) => {
  logger.error({ error: error instanceof Error ? error.message : String(error) }, 'command failed');
  process.exitCode = 1;
});
