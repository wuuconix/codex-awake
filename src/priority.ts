import type { LatestQuotaSnapshotRow } from './db.js';
import type { AuthAccount } from './types.js';
import { isRecord, normalizeNumber, readJsonFile, writeJsonFile } from './util.js';

export type ResetWindow = {
  scope?: string;
  kind?: string;
  resetAtMs?: number | null;
  remainingSeconds?: number | null;
  limitWindowSeconds?: number | null;
  usedPercent?: number | null;
};

export type CpaPriorityPlanItem = {
  account: AuthAccount;
  resetAtMs: number | null;
  priority: number;
  reason: 'reset-known' | 'missing-reset';
};

export type CpaPriorityApplyResult = CpaPriorityPlanItem & {
  previousPriority: number | null;
  changed: boolean;
  skipped: boolean;
  error: string | null;
};

export function parseWindows(windowsJson: string | null): ResetWindow[] {
  if (!windowsJson) return [];
  try {
    const parsed = JSON.parse(windowsJson) as unknown;
    return Array.isArray(parsed) ? (parsed.filter((item) => item && typeof item === 'object') as ResetWindow[]) : [];
  } catch {
    return [];
  }
}

export function pickDisplayWindow(row: LatestQuotaSnapshotRow): ResetWindow | null {
  const windows = parseWindows(row.windowsJson);
  return (
    windows.find((item) => item.scope === 'rate_limit.primary_window') ??
    windows.find((item) => item.kind === 'monthly') ??
    windows.find((item) => item.kind === 'weekly') ??
    windows[0] ??
    null
  );
}

export function inferredResetAtMs(row: LatestQuotaSnapshotRow, window: ResetWindow | null): number | null {
  if (!window) return null;
  if (typeof window.resetAtMs === 'number' && Number.isFinite(window.resetAtMs)) return window.resetAtMs;
  if (
    typeof window.remainingSeconds === 'number' &&
    Number.isFinite(window.remainingSeconds) &&
    typeof row.observedAtMs === 'number' &&
    Number.isFinite(row.observedAtMs)
  ) {
    return row.observedAtMs + window.remainingSeconds * 1000;
  }
  return null;
}

function priorityFromRaw(value: unknown): number | null {
  const parsed = normalizeNumber(value);
  if (parsed === null || !Number.isInteger(parsed) || !Number.isSafeInteger(parsed)) return null;
  return parsed;
}

export function buildCpaPriorityPlan(
  accounts: AuthAccount[],
  rows: LatestQuotaSnapshotRow[],
  options: { clearMissingReset?: boolean } = {}
): CpaPriorityPlanItem[] {
  const clearMissingReset = options.clearMissingReset ?? true;
  const rowsByAccountKey = new Map(rows.map((row) => [row.accountKey, row]));
  const known: Array<{ account: AuthAccount; resetAtMs: number }> = [];
  const missing: AuthAccount[] = [];

  for (const account of accounts) {
    if (account.disabled) continue;

    const row = rowsByAccountKey.get(account.accountKey);
    const resetAtMs = row ? inferredResetAtMs(row, pickDisplayWindow(row)) : null;
    if (resetAtMs !== null) {
      known.push({ account, resetAtMs });
    } else if (clearMissingReset) {
      missing.push(account);
    }
  }

  known.sort((left, right) => {
    const resetDiff = left.resetAtMs - right.resetAtMs;
    if (resetDiff !== 0) return resetDiff;
    return left.account.fileName.localeCompare(right.account.fileName);
  });

  const maxPriority = known.length;
  return [
    ...known.map<CpaPriorityPlanItem>((item, index) => ({
      account: item.account,
      resetAtMs: item.resetAtMs,
      priority: maxPriority - index,
      reason: 'reset-known'
    })),
    ...missing.map<CpaPriorityPlanItem>((account) => ({
      account,
      resetAtMs: null,
      priority: 0,
      reason: 'missing-reset'
    }))
  ];
}

export async function applyCpaPriorityPlan(
  plan: CpaPriorityPlanItem[],
  options: { dryRun?: boolean } = {}
): Promise<CpaPriorityApplyResult[]> {
  const results: CpaPriorityApplyResult[] = [];

  for (const item of plan) {
    try {
      const raw = await readJsonFile(item.account.filePath);
      if (!isRecord(raw)) {
        results.push({ ...item, previousPriority: null, changed: false, skipped: true, error: 'auth file is not a JSON object' });
        continue;
      }

      const previousPriority = priorityFromRaw(raw.priority);
      const next = { ...raw };
      let changed = false;
      if (item.priority <= 0) {
        changed = Object.prototype.hasOwnProperty.call(next, 'priority');
        delete next.priority;
      } else if (previousPriority !== item.priority || typeof next.priority !== 'number') {
        next.priority = item.priority;
        changed = true;
      }

      if (changed && !options.dryRun) {
        await writeJsonFile(item.account.filePath, next);
      }

      results.push({ ...item, previousPriority, changed, skipped: false, error: null });
    } catch (error) {
      results.push({
        ...item,
        previousPriority: null,
        changed: false,
        skipped: true,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return results;
}
