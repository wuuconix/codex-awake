export type AppConfig = {
  authDir: string;
  dbPath: string;
  quotaUrl: string;
  quotaConcurrency: number;
  quotaDelayMs: number;
  quotaTimeoutMs: number;
  proxyUrl: string | null;
  codexHomeParentDir: string;
  probeMinIntervalMs: number;
  probeCooldownMs: number;
  probeTimeoutMs: number;
  probeVerifyDelayMs: number;
  probeVerifyAttempts: number;
  probeVerifyIntervalMs: number;
  probeVerifyToleranceSeconds: number;
  dormantToleranceSeconds: number;
  dormantMaxUsedPercent: number;
  cpaMinRemainingPercent: number;
  probeModel: string;
  probePrompt: string;
  codexBin: string;
  userAgent: string;
};

export type AuthAccount = {
  accountKey: string;
  authIndex: string;
  filePath: string;
  fileName: string;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  disabled: boolean;
  accessToken: string;
  idToken: string | null;
  refreshToken: string | null;
  rawAuth: unknown;
};

export type QuotaWindow = {
  scope: string;
  kind: 'weekly' | 'monthly' | 'other';
  usedPercent: number | null;
  limitWindowSeconds: number | null;
  resetAtMs: number | null;
  resetAfterSeconds: number | null;
  remainingSeconds: number | null;
};

export type QuotaFetchResult = {
  account: AuthAccount;
  statusCode: number;
  ok: boolean;
  observedAtMs: number;
  planType: string | null;
  subscriptionActiveUntil: string | null;
  bodySummary: unknown;
  windows: QuotaWindow[];
  error: string | null;
};

/** The fields needed to select wake candidates from a persisted quota refresh. */
export type QuotaSnapshot = {
  statusCode: number | null;
  ok: number | null;
  observedAtMs: number | null;
  createdAtMs: number | null;
  planType: string | null;
  windowsJson: string | null;
  error: string | null;
};

export type WakeCandidate = {
  accountKey: string;
  authIndex: string;
  fileName: string;
  accountId: string | null;
  email: string | null;
  reason: string;
  windowScope: string;
  windowKind: 'weekly' | 'monthly';
  remainingSeconds: number | null;
  limitWindowSeconds: number | null;
  usedPercent: number | null;
};
