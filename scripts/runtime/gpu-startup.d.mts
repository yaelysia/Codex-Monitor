export type GpuMode = 'default' | 'software' | 'compat';
export type GpuChoice = {
  mode: GpuMode; source: 'default' | 'saved' | 'environment' | 'platform'; warning?: string;
};
export const GPU_MODES: readonly GpuMode[];
export function gpuConfigPath(appData: string): string;
export function readGpuMode(appData: string): GpuChoice;
export function saveGpuMode(appData: string, mode: GpuMode): string;
export function configureGpuStartup(
  app: Pick<import('electron').App, 'isReady' | 'getPath' | 'disableHardwareAcceleration' | 'commandLine'>,
  options?: { platform?: string; env?: NodeJS.ProcessEnv; log?: (message: string) => void },
): GpuChoice;
