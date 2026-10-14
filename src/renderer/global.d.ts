import type { MonitorApi } from '../shared/types';

declare global {
  interface Window { monitorApi: MonitorApi }
}
export {};
