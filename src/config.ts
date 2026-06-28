import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AppConfig } from './types.js';

const ConfigSchema = z.object({
  authDir: z.string().min(1).default(path.join(os.homedir(), '.cli-proxy-api')),
  dbPath: z.string().min(1).default(path.join('data', 'codex-awake.sqlite')),
  quotaUrl: z.string().url().default('https://chatgpt.com/backend-api/wham/usage'),
  quotaConcurrency: z.number().int().min(1).max(10).default(2),
  quotaDelayMs: z.number().int().min(0).default(10_000),
  quotaTimeoutMs: z.number().int().min(1000).default(30_000),
  proxyUrl: z
    .string()
    .trim()
    .nullable()
    .optional()
    .default(process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.ALL_PROXY ?? null)
    .transform((value) => (value && value.length > 0 ? value : null)),
  probeMinIntervalMs: z.number().int().min(0).default(180_000),
  probeCooldownMs: z.number().int().min(0).default(86_400_000),
  probeTimeoutMs: z.number().int().min(10_000).default(120_000),
  probeVerifyDelayMs: z.number().int().min(0).default(60_000),
  probeVerifyAttempts: z.number().int().min(1).max(10).default(3),
  probeVerifyIntervalMs: z.number().int().min(0).default(60_000),
  dormantToleranceSeconds: z.number().int().min(0).default(180),
  dormantMaxUsedPercent: z.number().min(0).max(100).default(5),
  probeModel: z.string().min(1).default('gpt-5.4-mini'),
  probePrompt: z.string().min(1).default('hi'),
  codexBin: z.string().min(1).default('codex'),
  userAgent: z
    .string()
    .min(1)
    .default('codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal')
});

export function loadConfig(configPath?: string): AppConfig {
  const resolvedPath = configPath ?? path.resolve(process.cwd(), 'codex-awake.config.json');
  const raw = existsSync(resolvedPath) ? JSON.parse(readFileSync(resolvedPath, 'utf8')) : {};
  const parsed = ConfigSchema.parse(raw);
  return {
    ...parsed,
    authDir: path.resolve(parsed.authDir),
    dbPath: path.resolve(parsed.dbPath)
  };
}
