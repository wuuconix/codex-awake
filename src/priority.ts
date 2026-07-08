import type { LatestQuotaSnapshotRow } from './db.js';
import type { AuthAccount } from './types.js';
import { boolValue, isRecord, normalizeNumber, readJsonFile, writeJsonFile } from './util.js';

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
  priorityAction: 'set' | 'clear' | 'keep';
  disabled: boolean;
  reason: 'reset-known' | 'missing-reset' | 'quota-exhausted' | 'disabled-with-quota' | 'disabled-cleanup';
};

export type CpaPriorityApplyResult = CpaPriorityPlanItem & {
  previousPriority: number | null;
  previousDisabled: boolean;
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

function hasRawPriority(account: AuthAccount): boolean {
  return isRecord(account.rawAuth) && Object.prototype.hasOwnProperty.call(account.rawAuth, 'priority');
}

function quotaAvailability(window: ResetWindow | null): 'available' | 'exhausted' | 'unknown' {
  const usedPercent = normalizeNumber(window?.usedPercent);
  if (usedPercent === null) return 'unknown';
  return usedPercent >= 100 ? 'exhausted' : 'available';
}

export function buildCpaPriorityPlan(
  accounts: AuthAccount[],
  rows: LatestQuotaSnapshotRow[],
  options: { clearMissingReset?: boolean } = {}
): CpaPriorityPlanItem[] {
  const clearMissingReset = options.clearMissingReset ?? true;
  const rowsByAccountKey = new Map(rows.map((row) => [row.accountKey, row]));
  const known: Array<{ account: AuthAccount; resetAtMs: number; reason: CpaPriorityPlanItem['reason'] }> = [];
  const missing: CpaPriorityPlanItem[] = [];
  const maintenance: CpaPriorityPlanItem[] = [];

  for (const account of accounts) {
    const row = rowsByAccountKey.get(account.accountKey);
    const window = row ? pickDisplayWindow(row) : null;
    const resetAtMs = row ? inferredResetAtMs(row, window) : null;
    const availability = quotaAvailability(window);

    if (availability === 'exhausted') {
      maintenance.push({
        account,
        resetAtMs,
        priority: 0,
        priorityAction: 'clear',
        disabled: true,
        reason: 'quota-exhausted'
      });
      continue;
    }

    if (account.disabled && availability !== 'available') {
      if (hasRawPriority(account)) {
        maintenance.push({
          account,
          resetAtMs,
          priority: 0,
          priorityAction: 'clear',
          disabled: true,
          reason: 'disabled-cleanup'
        });
      }
      continue;
    }

    if (resetAtMs !== null) {
      known.push({ account, resetAtMs, reason: account.disabled ? 'disabled-with-quota' : 'reset-known' });
    } else if (account.disabled && availability === 'available') {
      missing.push({
        account,
        resetAtMs: null,
        priority: 0,
        priorityAction: clearMissingReset ? 'clear' : 'keep',
        disabled: false,
        reason: 'disabled-with-quota'
      });
    } else if (clearMissingReset) {
      missing.push({
        account,
        resetAtMs: null,
        priority: 0,
        priorityAction: 'clear',
        disabled: false,
        reason: 'missing-reset'
      });
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
      priorityAction: 'set',
      disabled: false,
      reason: item.reason
    })),
    ...missing,
    ...maintenance
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
        results.push({
          ...item,
          previousPriority: null,
          previousDisabled: item.account.disabled,
          changed: false,
          skipped: true,
          error: 'auth file is not a JSON object'
        });
        continue;
      }

      const previousPriority = priorityFromRaw(raw.priority);
      const previousDisabled = boolValue(raw.disabled);
      const next = { ...raw };
      let changed = false;
      if (item.priorityAction === 'clear') {
        changed = Object.prototype.hasOwnProperty.call(next, 'priority');
        delete next.priority;
      } else if (item.priorityAction === 'set' && (previousPriority !== item.priority || typeof next.priority !== 'number')) {
        next.priority = item.priority;
        changed = true;
      }

      if (item.disabled) {
        if (next.disabled !== true) {
          next.disabled = true;
          changed = true;
        }
      } else if (Object.prototype.hasOwnProperty.call(next, 'disabled')) {
        delete next.disabled;
        changed = true;
      }

      if (!item.disabled && next.websockets !== true) {
        next.websockets = true;
        changed = true;
      }

      if (changed && !options.dryRun) {
        await writeJsonFile(item.account.filePath, next);
      }

      results.push({ ...item, previousPriority, previousDisabled, changed, skipped: false, error: null });
    } catch (error) {
      results.push({
        ...item,
        previousPriority: null,
        previousDisabled: item.account.disabled,
        changed: false,
        skipped: true,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return results;
}
