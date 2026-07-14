import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AuthAccount, QuotaFetchResult, QuotaSnapshot, WakeCandidate } from './types.js';

export type Store = ReturnType<typeof openStore>;

export function openStore(dbPath: string) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return {
    db,
    close: () => db.close(),
    upsertAccount: (account: AuthAccount, planType?: string | null) => upsertAccount(db, account, planType),
    insertQuotaSnapshot: (result: QuotaFetchResult) => insertQuotaSnapshot(db, result),
    replaceCandidates: (runId: string, candidates: WakeCandidate[]) => replaceCandidates(db, runId, candidates),
    listPendingCandidates: (limit?: number) => listPendingCandidates(db, limit),
    markCandidate: (id: number, status: string) => markCandidate(db, id, status),
    lastSuccessfulProbeStartedAt: (accountKey?: string) => lastSuccessfulProbeStartedAt(db, accountKey),
    hasRecentSuccessfulProbe: (accountKey: string, cooldownMs: number) =>
      hasRecentSuccessfulProbe(db, accountKey, cooldownMs),
    insertProbeStart: (candidate: StoredCandidate, command: string) => insertProbeStart(db, candidate, command),
    finishProbe: (id: number, status: string, exitCode: number | null, error: string | null, output?: string | null) =>
      finishProbe(db, id, status, exitCode, error, output),
    acquireLock: (name: string, ttlMs: number) => acquireLock(db, name, ttlMs),
    releaseLock: (name: string, owner: string) => releaseLock(db, name, owner),
    listLatestQuotaSnapshots: () => listLatestQuotaSnapshots(db),
    showSummary: () => showSummary(db)
  };
}

function migrate(db: Database.Database): void {
  db.exec(`
    create table if not exists accounts (
      account_key text primary key,
      auth_index text not null,
      file_name text not null,
      file_path text not null,
      email text,
      account_id text,
      plan_type text,
      disabled integer not null default 0,
      last_seen_at_ms integer not null,
      updated_at_ms integer not null
    );

    create table if not exists quota_snapshots (
      id integer primary key autoincrement,
      run_id text not null,
      account_key text not null,
      status_code integer not null,
      ok integer not null,
      observed_at_ms integer not null,
      plan_type text,
      subscription_active_until text,
      windows_json text not null,
      body_summary_json text,
      error text,
      created_at_ms integer not null
    );

    create table if not exists wake_candidates (
      id integer primary key autoincrement,
      run_id text not null,
      account_key text not null,
      auth_index text not null,
      file_name text not null,
      account_id text,
      email text,
      reason text not null,
      window_scope text not null,
      window_kind text not null,
      remaining_seconds real,
      limit_window_seconds real,
      used_percent real,
      status text not null,
      created_at_ms integer not null,
      updated_at_ms integer not null
    );

    create table if not exists probe_runs (
      id integer primary key autoincrement,
      candidate_id integer,
      account_key text not null,
      auth_index text not null,
      file_name text not null,
      command text not null,
      status text not null,
      started_at_ms integer not null,
      finished_at_ms integer,
      exit_code integer,
      error text
    );

    create table if not exists run_locks (
      name text primary key,
      owner text not null,
      expires_at_ms integer not null,
      updated_at_ms integer not null
    );

    create index if not exists idx_wake_candidates_status on wake_candidates(status, created_at_ms);
    create index if not exists idx_probe_runs_account on probe_runs(account_key, started_at_ms);
    create index if not exists idx_quota_snapshots_account on quota_snapshots(account_key, created_at_ms);
  `);
  const probeColumns = db.prepare(`pragma table_info(probe_runs)`).all() as Array<{ name: string }>;
  if (!probeColumns.some((column) => column.name === 'output')) {
    db.prepare(`alter table probe_runs add column output text`).run();
  }
}

function upsertAccount(db: Database.Database, account: AuthAccount, planType?: string | null): void {
  const now = Date.now();
  db.prepare(
    `insert into accounts (
      account_key, auth_index, file_name, file_path, email, account_id, plan_type, disabled, last_seen_at_ms, updated_at_ms
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(account_key) do update set
      auth_index = excluded.auth_index,
      file_name = excluded.file_name,
      file_path = excluded.file_path,
      email = excluded.email,
      account_id = excluded.account_id,
      plan_type = coalesce(excluded.plan_type, accounts.plan_type),
      disabled = excluded.disabled,
      last_seen_at_ms = excluded.last_seen_at_ms,
      updated_at_ms = excluded.updated_at_ms`
  ).run(
    account.accountKey,
    account.authIndex,
    account.fileName,
    account.filePath,
    account.email,
    account.accountId,
    planType ?? account.planType,
    account.disabled ? 1 : 0,
    now,
    now
  );
}

function insertQuotaSnapshot(db: Database.Database, result: QuotaFetchResult): void {
  db.prepare(
    `insert into quota_snapshots (
      run_id, account_key, status_code, ok, observed_at_ms, plan_type, subscription_active_until,
      windows_json, body_summary_json, error, created_at_ms
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    currentRunId(),
    result.account.accountKey,
    result.statusCode,
    result.ok ? 1 : 0,
    result.observedAtMs,
    result.planType,
    result.subscriptionActiveUntil,
    JSON.stringify(result.windows),
    result.bodySummary ? JSON.stringify(result.bodySummary) : null,
    result.error,
    Date.now()
  );
}

let runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
export function currentRunId(): string {
  return runId;
}

export function resetRunIdForTest(value: string): void {
  runId = value;
}

function replaceCandidates(db: Database.Database, runIdValue: string, candidates: WakeCandidate[]): void {
  const now = Date.now();
  const insert = db.prepare(
    `insert into wake_candidates (
      run_id, account_key, auth_index, file_name, account_id, email, reason, window_scope, window_kind,
      remaining_seconds, limit_window_seconds, used_percent, status, created_at_ms, updated_at_ms
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  );
  const tx = db.transaction(() => {
    db.prepare(`update wake_candidates set status = 'superseded', updated_at_ms = ? where status = 'pending'`).run(now);
    for (const candidate of candidates) {
      insert.run(
        runIdValue,
        candidate.accountKey,
        candidate.authIndex,
        candidate.fileName,
        candidate.accountId,
        candidate.email,
        candidate.reason,
        candidate.windowScope,
        candidate.windowKind,
        candidate.remainingSeconds,
        candidate.limitWindowSeconds,
        candidate.usedPercent,
        now,
        now
      );
    }
  });
  tx();
}

export type StoredCandidate = WakeCandidate & { id: number; status: string };

function listPendingCandidates(db: Database.Database, limit = 100): StoredCandidate[] {
  return db
    .prepare(
      `select id, account_key as accountKey, auth_index as authIndex, file_name as fileName,
        account_id as accountId, email, reason, window_scope as windowScope, window_kind as windowKind,
        remaining_seconds as remainingSeconds, limit_window_seconds as limitWindowSeconds,
        used_percent as usedPercent, status
       from wake_candidates
       where status = 'pending'
       order by created_at_ms asc
       limit ?`
    )
    .all(limit) as StoredCandidate[];
}

function markCandidate(db: Database.Database, id: number, status: string): void {
  db.prepare(`update wake_candidates set status = ?, updated_at_ms = ? where id = ?`).run(status, Date.now(), id);
}

function lastSuccessfulProbeStartedAt(db: Database.Database, accountKey?: string): number | null {
  const row = accountKey
    ? (db
        .prepare(`select max(started_at_ms) as startedAtMs from probe_runs where status = 'success' and account_key = ?`)
        .get(accountKey) as { startedAtMs: number | null })
    : (db
        .prepare(`select max(started_at_ms) as startedAtMs from probe_runs`)
        .get() as { startedAtMs: number | null });
  return row.startedAtMs ?? null;
}

function hasRecentSuccessfulProbe(db: Database.Database, accountKey: string, cooldownMs: number): boolean {
  if (cooldownMs <= 0) return false;
  const last = lastSuccessfulProbeStartedAt(db, accountKey);
  return last !== null && Date.now() - last < cooldownMs;
}

function insertProbeStart(db: Database.Database, candidate: StoredCandidate, command: string): number {
  const result = db
    .prepare(
      `insert into probe_runs (
        candidate_id, account_key, auth_index, file_name, command, status, started_at_ms
      ) values (?, ?, ?, ?, ?, 'running', ?)`
    )
    .run(candidate.id, candidate.accountKey, candidate.authIndex, candidate.fileName, command, Date.now());
  return Number(result.lastInsertRowid);
}

function finishProbe(
  db: Database.Database,
  id: number,
  status: string,
  exitCode: number | null,
  error: string | null,
  output?: string | null
): void {
  db.prepare(`update probe_runs set status = ?, finished_at_ms = ?, exit_code = ?, error = ?, output = ? where id = ?`).run(
    status,
    Date.now(),
    exitCode,
    error,
    output ?? null,
    id
  );
}

function acquireLock(db: Database.Database, name: string, ttlMs: number): string | null {
  const now = Date.now();
  const owner = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const tx = db.transaction(() => {
    db.prepare(`delete from run_locks where name = ? and expires_at_ms <= ?`).run(name, now);
    const result = db
      .prepare(`insert or ignore into run_locks(name, owner, expires_at_ms, updated_at_ms) values (?, ?, ?, ?)`)
      .run(name, owner, now + ttlMs, now);
    return result.changes > 0 ? owner : null;
  });
  return tx();
}

function releaseLock(db: Database.Database, name: string, owner: string): void {
  db.prepare(`delete from run_locks where name = ? and owner = ?`).run(name, owner);
}

export type LatestQuotaSnapshotRow = QuotaSnapshot & {
  accountKey: string;
  email: string | null;
  fileName: string;
  planType: string | null;
  disabled: number;
};

function listLatestQuotaSnapshots(db: Database.Database): LatestQuotaSnapshotRow[] {
  return db
    .prepare(
      `select
        a.account_key as accountKey,
        a.email,
        a.file_name as fileName,
        a.plan_type as planType,
        a.disabled,
        q.status_code as statusCode,
        q.ok,
        q.observed_at_ms as observedAtMs,
        q.created_at_ms as createdAtMs,
        q.windows_json as windowsJson,
        q.error
       from accounts a
       left join (
        select qs.*
        from quota_snapshots qs
        join (
          select account_key, max(id) as id
          from quota_snapshots
          group by account_key
        ) latest on latest.id = qs.id
       ) q on q.account_key = a.account_key`
    )
    .all() as LatestQuotaSnapshotRow[];
}

function showSummary(db: Database.Database): unknown {
  return {
    accounts: db.prepare(`select count(*) as count from accounts`).get(),
    pendingCandidates: db.prepare(`select count(*) as count from wake_candidates where status = 'pending'`).get(),
    recentCandidates: db
      .prepare(
        `select id, file_name as fileName, email, account_id as accountId, window_kind as windowKind,
          window_scope as windowScope, remaining_seconds as remainingSeconds, status, created_at_ms as createdAtMs
         from wake_candidates
         order by created_at_ms desc
         limit 20`
      )
      .all(),
    recentProbes: db
      .prepare(
        `select id, file_name as fileName, status, started_at_ms as startedAtMs, finished_at_ms as finishedAtMs,
          exit_code as exitCode, error, output
         from probe_runs
         order by started_at_ms desc
         limit 20`
      )
      .all(),
    recentSnapshots: db
      .prepare(
        `select account_key as accountKey, status_code as statusCode, ok, plan_type as planType,
          created_at_ms as createdAtMs, error
         from quota_snapshots
         order by created_at_ms desc
         limit 20`
      )
      .all()
  };
}
