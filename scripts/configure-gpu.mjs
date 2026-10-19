import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GPU_MODES, gpuConfigPath, readGpuMode, saveGpuMode } from './runtime/gpu-startup.mjs';

export function configureGpuCli(args, { platform = process.platform, env = process.env,
  log = console.log } = {}) {
  const mode = args[0];
  if (args.length !== 1 || ![...GPU_MODES, 'status'].includes(mode)) {
    log('Usage: node scripts/configure-gpu.mjs <default|software|compat|status>');
    return 1;
  }
  if (platform !== 'win32') {
    log('GPU startup compatibility settings apply to Windows only; nothing changed.');
    return 1;
  }
  try {
    const file = gpuConfigPath(env.APPDATA);
    if (mode === 'status') {
      const choice = readGpuMode(env.APPDATA);
      log(`Saved GPU mode: ${choice.mode} (${choice.source})\nConfig: ${file}`);
      if (choice.warning) { log(choice.warning); return 1; }
    } else {
      if (mode === 'compat')
        log('Compatibility mode disables ONLY the GPU sandbox, reducing GPU process isolation. Renderer sandbox settings are unchanged.');
      saveGpuMode(env.APPDATA, mode);
      log(`Saved GPU mode: ${mode}\nConfig: ${file}\nFully quit Codex Monitor, then start normally. This choice survives updates and new terminals.`);
    }
    if (env.CODEX_MONITOR_DISABLE_GPU_SANDBOX === '1' || env.CODEX_MONITOR_DISABLE_GPU_SANDBOX === '0')
      log(`Temporary environment override is active (${env.CODEX_MONITOR_DISABLE_GPU_SANDBOX}); remove CODEX_MONITOR_DISABLE_GPU_SANDBOX to use the saved mode.`);
    return 0;
  } catch (error) {
    log(`Unable to save/read GPU settings: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = configureGpuCli(process.argv.slice(2));
