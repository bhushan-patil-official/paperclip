import type { Agent } from "@paperclipai/shared";
import type { ModelProfileKey } from "@paperclipai/shared";

export interface AgentModelProfileOverlay {
  enabled?: boolean;
  adapterConfig?: Record<string, unknown>;
  /** When true, the patch removes this profile key from runtimeConfig.modelProfiles. */
  cleared?: boolean;
}

export interface AgentModelTierRulesOverlay {
  priority?: Partial<Record<string, ModelProfileKey | null>>;
  default?: ModelProfileKey | null;
  cleared?: boolean;
}

export interface AgentConfigOverlay {
  identity: Record<string, unknown>;
  adapterType?: string;
  adapterConfig: Record<string, unknown>;
  heartbeat: Record<string, unknown>;
  runtime: Record<string, unknown>;
  modelProfiles?: Partial<Record<ModelProfileKey, AgentModelProfileOverlay>>;
  modelTierRules?: AgentModelTierRulesOverlay;
}

const ADAPTER_AGNOSTIC_KEYS = [
  "env",
  "promptTemplate",
  "instructionsFilePath",
  "cwd",
  "timeoutSec",
  "graceSec",
  "bootstrapPromptTemplate",
] as const;

const TIER_PROFILE_KEYS = ["simple", "standard", "advanced", "expert"] as const satisfies readonly ModelProfileKey[];

function omitUndefinedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function mergeModelProfileOverlay(
  existingProfiles: Record<string, unknown>,
  key: ModelProfileKey,
  overlay: AgentModelProfileOverlay | undefined,
): Record<string, unknown> {
  const nextProfiles = { ...existingProfiles };
  if (!overlay) return nextProfiles;

  if (overlay.cleared) {
    delete nextProfiles[key];
    return nextProfiles;
  }

  const existingProfile = (nextProfiles[key] ?? {}) as Record<string, unknown>;
  const existingAdapterConfig = (existingProfile.adapterConfig ?? {}) as Record<string, unknown>;
  const mergedAdapterConfig = {
    ...existingAdapterConfig,
    ...(overlay.adapterConfig ?? {}),
  };
  const enabled = overlay.enabled ?? (existingProfile.enabled !== false);
  nextProfiles[key] = {
    ...existingProfile,
    enabled,
    adapterConfig: mergedAdapterConfig,
  };
  return nextProfiles;
}

export function buildAgentUpdatePatch(agent: Agent, overlay: AgentConfigOverlay) {
  const patch: Record<string, unknown> = {};

  if (Object.keys(overlay.identity).length > 0) {
    Object.assign(patch, overlay.identity);
  }

  if (overlay.adapterType !== undefined) {
    patch.adapterType = overlay.adapterType;
  }

  if (overlay.adapterType !== undefined || Object.keys(overlay.adapterConfig).length > 0) {
    const existing = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const nextAdapterConfig =
      overlay.adapterType !== undefined
        ? {
            ...Object.fromEntries(
              ADAPTER_AGNOSTIC_KEYS
                .filter((key) => existing[key] !== undefined)
                .map((key) => [key, existing[key]]),
            ),
            ...overlay.adapterConfig,
          }
        : {
            ...existing,
            ...overlay.adapterConfig,
          };

    patch.adapterConfig = omitUndefinedEntries(nextAdapterConfig);
    patch.replaceAdapterConfig = true;
  }

  const hasModelProfileChange = overlay.modelProfiles !== undefined;
  const hasModelTierRulesChange = overlay.modelTierRules !== undefined;

  if (Object.keys(overlay.heartbeat).length > 0 || hasModelProfileChange || hasModelTierRulesChange) {
    const existingRc = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
    const nextRuntimeConfig: Record<string, unknown> = (patch.runtimeConfig as Record<string, unknown> | undefined)
      ?? { ...existingRc };

    if (Object.keys(overlay.heartbeat).length > 0) {
      const existingHb = (existingRc.heartbeat ?? {}) as Record<string, unknown>;
      nextRuntimeConfig.heartbeat = { ...existingHb, ...overlay.heartbeat };
    }

    if (hasModelProfileChange) {
      let nextProfiles = { ...((existingRc.modelProfiles ?? {}) as Record<string, unknown>) };
      const cheapOverlay = overlay.modelProfiles?.cheap;
      nextProfiles = mergeModelProfileOverlay(nextProfiles, "cheap", cheapOverlay);
      for (const tierKey of TIER_PROFILE_KEYS) {
        nextProfiles = mergeModelProfileOverlay(nextProfiles, tierKey, overlay.modelProfiles?.[tierKey]);
      }
      if (Object.keys(nextProfiles).length === 0) {
        delete nextRuntimeConfig.modelProfiles;
      } else {
        nextRuntimeConfig.modelProfiles = nextProfiles;
      }
    }

    if (hasModelTierRulesChange) {
      const tierOverlay = overlay.modelTierRules;
      if (tierOverlay?.cleared) {
        delete nextRuntimeConfig.modelTierRules;
      } else if (tierOverlay) {
        const existingRules = (existingRc.modelTierRules ?? {}) as Record<string, unknown>;
        const existingPriority = (existingRules.priority ?? {}) as Record<string, unknown>;
        const nextPriority = { ...existingPriority };
        if (tierOverlay.priority) {
          for (const [priorityKey, tierKey] of Object.entries(tierOverlay.priority)) {
            if (tierKey === null) {
              delete nextPriority[priorityKey];
            } else {
              nextPriority[priorityKey] = tierKey;
            }
          }
        }
        const nextRules: Record<string, unknown> = { ...existingRules };
        if (Object.keys(nextPriority).length > 0) {
          nextRules.priority = nextPriority;
        } else {
          delete nextRules.priority;
        }
        if (tierOverlay.default !== undefined) {
          if (tierOverlay.default === null) {
            delete nextRules.default;
          } else {
            nextRules.default = tierOverlay.default;
          }
        }
        if (Object.keys(nextRules).length === 0) {
          delete nextRuntimeConfig.modelTierRules;
        } else {
          nextRuntimeConfig.modelTierRules = nextRules;
        }
      }
    }

    patch.runtimeConfig = nextRuntimeConfig;
  }

  if (Object.keys(overlay.runtime).length > 0) {
    Object.assign(patch, overlay.runtime);
  }

  return patch;
}
