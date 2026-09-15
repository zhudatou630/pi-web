import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { removeExactProviderPatterns, samePickerPatterns } from "@/lib/model-picker";

/** ponytail: global enabledModels only; project overlay still warns */
export async function clearExactEnabledModelsForProvider(provider: string): Promise<void> {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(agentDir, agentDir);
  const current = settings.getGlobalSettings().enabledModels;
  const next = removeExactProviderPatterns(current, provider);
  if (samePickerPatterns(current, next)) return;
  settings.setEnabledModels(next.length > 0 ? next : undefined);
  await settings.flush();
}
