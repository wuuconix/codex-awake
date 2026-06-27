import type { AppConfig, AuthAccount, QuotaFetchResult, QuotaWindow, WakeCandidate } from './types.js';
import { fetch as undiciFetch, ProxyAgent, type Response } from 'undici';
import {
  MAX_MONTH_SECONDS,
  MIN_MONTH_SECONDS,
  WEEK_SECONDS,
  isRecord,
  normalizeNumber,
  normalizeString,
  sleep,
  truncate
} from './util.js';

function getMap(source: Record<string, unknown> | null, ...keys: string[]): Record<string, unknown> | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (isRecord(value)) return value;
  }
  return null;
}

function getArray(source: Record<string, unknown> | null, ...keys: string[]): Record<string, unknown>[] {
  if (!source) return [];
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function classifyWindow(limitWindowSeconds: number | null): QuotaWindow['kind'] {
  if (limitWindowSeconds === WEEK_SECONDS) return 'weekly';
  if (
    limitWindowSeconds !== null &&
    limitWindowSeconds >= MIN_MONTH_SECONDS &&
    limitWindowSeconds <= MAX_MONTH_SECONDS
  ) {
    return 'monthly';
  }
  return 'other';
}

function normalizeResetAtMs(value: number | null): number | null {
  if (value === null) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function parseWindow(scope: string, raw: Record<string, unknown> | null, observedAtMs: number): QuotaWindow | null {
  if (!raw) return null;
  const limitWindowSeconds = normalizeNumber(raw.limit_window_seconds ?? raw.limitWindowSeconds);
  const resetAfterSeconds = normalizeNumber(raw.reset_after_seconds ?? raw.resetAfterSeconds);
  const resetAtMs = normalizeResetAtMs(normalizeNumber(raw.reset_at ?? raw.resetAt));
  if (limitWindowSeconds === null && resetAfterSeconds === null && resetAtMs === null) return null;
  const remainingSeconds = resetAtMs !== null ? (resetAtMs - observedAtMs) / 1000 : resetAfterSeconds;
  return {
    scope,
    kind: classifyWindow(limitWindowSeconds),
    usedPercent: normalizeNumber(raw.used_percent ?? raw.usedPercent),
    limitWindowSeconds,
    resetAtMs,
    resetAfterSeconds,
    remainingSeconds
  };
}

function addRateLimitWindows(
  windows: QuotaWindow[],
  scope: string,
  raw: Record<string, unknown> | null,
  observedAtMs: number
): void {
  if (!raw) return;
  const primary = parseWindow(`${scope}.primary_window`, getMap(raw, 'primary_window', 'primaryWindow'), observedAtMs);
  const secondary = parseWindow(
    `${scope}.secondary_window`,
    getMap(raw, 'secondary_window', 'secondaryWindow'),
    observedAtMs
  );
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
}

export function collectQuotaWindows(payload: unknown, observedAtMs: number): QuotaWindow[] {
  if (!isRecord(payload)) return [];
  const windows: QuotaWindow[] = [];
  addRateLimitWindows(windows, 'rate_limit', getMap(payload, 'rate_limit', 'rateLimit'), observedAtMs);
  addRateLimitWindows(
    windows,
    'code_review_rate_limit',
    getMap(payload, 'code_review_rate_limit', 'codeReviewRateLimit'),
    observedAtMs
  );
  getArray(payload, 'additional_rate_limits', 'additionalRateLimits').forEach((item, index) => {
    const name =
      normalizeString(item.limit_name ?? item.limitName ?? item.metered_feature ?? item.meteredFeature) ??
      `additional_${index + 1}`;
    addRateLimitWindows(
      windows,
      `additional_rate_limits.${name}`,
      getMap(item, 'rate_limit', 'rateLimit'),
      observedAtMs
    );
  });
  return windows;
}

function compactUsageSummary(payload: unknown): unknown {
  if (!isRecord(payload)) return null;
  return {
    account_id: normalizeString(payload.account_id ?? payload.accountId),
    email: normalizeString(payload.email),
    plan_type: normalizeString(payload.plan_type ?? payload.planType),
    subscription_active_until: normalizeString(
      payload.subscription_active_until ?? payload.subscriptionActiveUntil
    ),
    rate_limit: payload.rate_limit ?? payload.rateLimit ?? null,
    code_review_rate_limit: payload.code_review_rate_limit ?? payload.codeReviewRateLimit ?? null,
    additional_rate_limits: payload.additional_rate_limits ?? payload.additionalRateLimits ?? null
  };
}

function observedAtFromResponse(response: Response): number {
  const date = response.headers.get('date');
  if (!date) return Date.now();
  const parsed = Date.parse(date);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    return `${error.message}: ${(cause as { code?: unknown }).code}`;
  }
  return error.message;
}

export async function fetchQuota(account: AuthAccount, config: AppConfig): Promise<QuotaFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.quotaTimeoutMs);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${account.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': config.userAgent
    };
    if (account.accountId) headers['Chatgpt-Account-Id'] = account.accountId;
    const dispatcher = config.proxyUrl ? new ProxyAgent(config.proxyUrl) : undefined;
    const response = await undiciFetch(config.quotaUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {})
    });
    const observedAtMs = observedAtFromResponse(response);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text.trim() ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = text;
    }
    const windows = response.ok ? collectQuotaWindows(body, observedAtMs) : [];
    const payload = isRecord(body) ? body : null;
    return {
      account,
      statusCode: response.status,
      ok: response.ok,
      observedAtMs,
      planType: normalizeString(payload?.plan_type ?? payload?.planType) ?? account.planType,
      subscriptionActiveUntil: normalizeString(
        payload?.subscription_active_until ?? payload?.subscriptionActiveUntil
      ),
      bodySummary: compactUsageSummary(body),
      windows,
      error: response.ok ? null : truncate(typeof body === 'string' ? body : JSON.stringify(body), 1000)
    };
  } catch (error) {
    return {
      account,
      statusCode: 0,
      ok: false,
      observedAtMs: Date.now(),
      planType: account.planType,
      subscriptionActiveUntil: null,
      bodySummary: null,
      windows: [],
      error: errorMessage(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

export function buildWakeCandidates(
  result: QuotaFetchResult,
  toleranceSeconds: number,
  maxUsedPercent: number,
  recentlyProbed: boolean
): WakeCandidate[] {
  if (!result.ok || recentlyProbed || result.account.disabled) return [];
  const candidates: WakeCandidate[] = [];
  for (const window of result.windows) {
    if (window.kind !== 'weekly' && window.kind !== 'monthly') continue;
    if (window.limitWindowSeconds === null || window.remainingSeconds === null) continue;
    if (window.usedPercent !== null && window.usedPercent > maxUsedPercent) continue;
    const deltaSeconds = Math.abs(window.remainingSeconds - window.limitWindowSeconds);
    if (deltaSeconds > toleranceSeconds) continue;
    candidates.push({
      accountKey: result.account.accountKey,
      authIndex: result.account.authIndex,
      fileName: result.account.fileName,
      accountId: result.account.accountId,
      email: result.account.email,
      reason: `${window.kind} window still has a full reset duration`,
      windowScope: window.scope,
      windowKind: window.kind,
      remainingSeconds: window.remainingSeconds,
      limitWindowSeconds: window.limitWindowSeconds,
      usedPercent: window.usedPercent
    });
  }
  return candidates;
}

export async function refreshQuotas(
  accounts: AuthAccount[],
  config: AppConfig,
  onResult: (result: QuotaFetchResult) => Promise<void> | void
): Promise<QuotaFetchResult[]> {
  const enabled = accounts.filter((account) => !account.disabled);
  const results: QuotaFetchResult[] = [];
  let nextIndex = 0;

  async function worker(workerIndex: number): Promise<void> {
    while (nextIndex < enabled.length) {
      const index = nextIndex;
      nextIndex += 1;
      if (index > 0 || workerIndex > 0) await sleep(config.quotaDelayMs);
      const result = await fetchQuota(enabled[index]!, config);
      results.push(result);
      await onResult(result);
    }
  }

  const workers = Array.from({ length: Math.min(config.quotaConcurrency, enabled.length) }, (_, index) =>
    worker(index)
  );
  await Promise.all(workers);
  return results;
}
