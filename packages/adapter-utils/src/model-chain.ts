/**
 * Shared multi-model fallback chain for agent adapters.
 * Tries ordered provider/model entries immediately when rate-limited instead of
 * waiting for heartbeat transient retries on the same exhausted model.
 */

import type { AdapterExecutionResult } from "./types.js";

export interface ModelChainEntry {
  model: string;
  variant?: string;
  env?: Record<string, string>;
}

export const GENERIC_RATE_LIMIT_RE =
  /(?:rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|resource_exhausted|quota\s+exceeded|FreeUsageLimitError|maxRetriesExceeded)/i;

export function isGenericRateLimitedText(text: string): boolean {
  return GENERIC_RATE_LIMIT_RE.test(text);
}

function parseChainEntryEnv(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string" && entryValue.trim().length > 0) {
      env[key] = entryValue;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function readConfigString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Builds the ordered chain: primary `config.model` first, then `config.modelChain` fallbacks.
 */
export function parseModelChainFromConfig(config: Record<string, unknown>): ModelChainEntry[] {
  const chain: ModelChainEntry[] = [];
  const primaryModel = readConfigString(config, "model");
  const primaryVariant = readConfigString(config, "variant");
  if (primaryModel) {
    chain.push({
      model: primaryModel,
      ...(primaryVariant ? { variant: primaryVariant } : {}),
    });
  }

  const rawChain = config.modelChain;
  if (!Array.isArray(rawChain)) return chain;

  for (const rawEntry of rawChain) {
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Record<string, unknown>;
    const model = readConfigString(entry, "model");
    if (!model) continue;
    const variant = readConfigString(entry, "variant");
    const env = parseChainEntryEnv(entry.env);
    chain.push({
      model,
      ...(variant ? { variant } : {}),
      ...(env ? { env } : {}),
    });
  }

  return chain;
}

export function mergeChainEntryIntoConfig(
  baseConfig: Record<string, unknown>,
  entry: ModelChainEntry,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...baseConfig,
    model: entry.model,
  };
  if (entry.variant !== undefined) {
    merged.variant = entry.variant;
  }
  if (entry.env) {
    const baseEnv =
      typeof baseConfig.env === "object" && baseConfig.env !== null && !Array.isArray(baseConfig.env)
        ? (baseConfig.env as Record<string, unknown>)
        : {};
    merged.env = { ...baseEnv, ...entry.env };
  }
  return merged;
}

export async function runWithModelFallbackChain<TAttempt>(opts: {
  chain: ModelChainEntry[];
  sessionId: string | null;
  execute: (entry: ModelChainEntry, sessionId: string | null, index: number) => Promise<TAttempt>;
  isRateLimited: (attempt: TAttempt) => boolean;
  onSwitch: (from: ModelChainEntry, to: ModelChainEntry, index: number) => Promise<void>;
}): Promise<{ attempt: TAttempt; exhausted: boolean; chainIndex: number }> {
  if (opts.chain.length === 0) {
    throw new Error("model fallback chain is empty");
  }

  let lastAttempt: TAttempt | null = null;
  for (let index = 0; index < opts.chain.length; index++) {
    const entry = opts.chain[index]!;
    const sessionForAttempt = index === 0 ? opts.sessionId : null;
    const attempt = await opts.execute(entry, sessionForAttempt, index);
    lastAttempt = attempt;
    if (!opts.isRateLimited(attempt)) {
      return { attempt, exhausted: false, chainIndex: index };
    }
    if (index < opts.chain.length - 1) {
      await opts.onSwitch(entry, opts.chain[index + 1]!, index + 1);
    }
  }

  return { attempt: lastAttempt!, exhausted: true, chainIndex: opts.chain.length - 1 };
}

export const MODEL_CHAIN_EXHAUSTED_MESSAGE =
  "All models in the fallback chain are rate-limited. Configure additional fallback models or wait for quota reset.";

export const MODEL_CHAIN_EXHAUSTED_ERROR_CODE = "model_chain_rate_limited";

export function isAdapterResultRateLimited(result: AdapterExecutionResult): boolean {
  if (result.errorFamily === "rate_limited" || result.errorFamily === "transient_upstream") {
    return true;
  }
  const haystack = [result.errorMessage ?? "", JSON.stringify(result.resultJson ?? {})].join("\n");
  return isGenericRateLimitedText(haystack);
}

export function applyModelChainExhaustionToResult(
  result: AdapterExecutionResult,
  exhausted: boolean,
): AdapterExecutionResult {
  if (!exhausted || !isAdapterResultRateLimited(result)) return result;
  return {
    ...result,
    errorFamily: "rate_limited",
    errorCode: MODEL_CHAIN_EXHAUSTED_ERROR_CODE,
    errorMessage: MODEL_CHAIN_EXHAUSTED_MESSAGE,
    retryNotBefore: null,
    resultJson: {
      ...(result.resultJson ?? {}),
      errorFamily: "rate_limited",
      modelChainExhausted: true,
    },
  };
}

export function resolveEffectiveModelChain(config: Record<string, unknown>): ModelChainEntry[] {
  const chain = parseModelChainFromConfig(config);
  if (chain.length > 0) return chain;
  const primaryModel = readConfigString(config, "model");
  return primaryModel ? [{ model: primaryModel }] : [];
}

/**
 * Runs adapter execution across an optional multi-entry model chain.
 * Skips chain orchestration when only one model entry is configured.
 */
export async function executeWithOptionalModelChain(opts: {
  config: Record<string, unknown>;
  sessionId: string | null;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  executeEntry: (
    entry: ModelChainEntry,
    sessionId: string | null,
    index: number,
  ) => Promise<AdapterExecutionResult>;
  isRateLimited?: (result: AdapterExecutionResult) => boolean;
}): Promise<AdapterExecutionResult> {
  const chain = resolveEffectiveModelChain(opts.config);
  if (chain.length <= 1) {
    // When no model is configured, pass an empty-model entry so the adapter can use
    // its CLI's built-in default (all adapters guard `if (model)` before --model flag).
    const entry = chain[0] ?? { model: readConfigString(opts.config, "model") };
    return opts.executeEntry(entry, opts.sessionId, 0);
  }

  const isRateLimited = opts.isRateLimited ?? isAdapterResultRateLimited;
  const chainResult = await runWithModelFallbackChain({
    chain,
    sessionId: opts.sessionId,
    execute: async (entry, sessionId, index) => opts.executeEntry(entry, sessionId, index),
    isRateLimited,
    onSwitch: async (from, to, index) => {
      await opts.onLog(
        "stdout",
        `[paperclip] Primary model ${from.model} is rate-limited. Switching to ${to.model} (fallback ${index} of ${chain.length - 1}).\n`,
      );
    },
  });

  return applyModelChainExhaustionToResult(chainResult.attempt, chainResult.exhausted);
}
