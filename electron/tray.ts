import { Menu, Tray, nativeImage } from 'electron';
import type { MonitorService } from './monitor-service';
import type { FloatingWindowController } from './floating';
import type { MainWindowController } from './main-window';
import type { ResidentStore } from './resident-store';

const TRAY_ICON = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA80lEQVR42u2XvQ0CMQyFL0+3Bw0TsAMSYhGGoEnDELfI6SR2yARpMglUoCg/IrZsX0OqKEW+52dHsadp5+Vah8fD6aUBiylUPFjBe3fDCt5jwBLeYsEaXoqYuRcsfqvObv7CewUUB1pgrpCYghsWMAKmCokpOEhFzXUBGgVGqYWZG30LsviNXIiQjJDzCiCde1EBUlGaF+FfgKoA6cKEZcGJpUDShaHPiAKkuDb8GWm6o/Yd505cn/fvfj0/eP0AtyHJ4aWImIIjt2Sfy6VaMnZPKPVE0ZtYpFae89L+ajSzas/zgPFrdtOeDzEyQGoOp7uvN74HbbP3jZ3UAAAAAElFTkSuQmCC';

export class TrayController {
  private tray: Tray | null = null;
  /** A native Windows menu should only be rebuilt when one of its options
   * changes, not after every session/status, dock animation or alert update.
   */
  private lastMenuKey: string | null = null;
  private lastTooltip: string | null = null;

  constructor(private readonly main: MainWindowController,
    private readonly floating: FloatingWindowController,
    private readonly monitor: MonitorService,
    private readonly store: ResidentStore,
    private readonly quit: () => void,
    private readonly showDiagnostics: () => void = () => {}) {}

  start(): void {
    if (this.tray) return;
    this.tray = new Tray(nativeImage.createFromBuffer(Buffer.from(TRAY_ICON, 'base64')));
    this.lastTooltip = 'Codex Monitor · 监控后台运行';
    this.tray.setToolTip(this.lastTooltip);
    this.tray.on('double-click', () => this.main.show());
    this.refresh();
  }

  refresh(): void {
    if (!this.tray) return;
    const dock = this.floating.state();
    const floatingVisible = dock.visible;
    const current = this.monitor.state();
    const muted = current.muted;
    const prefs = this.store.snapshot().preferences;
    const menuKey = JSON.stringify([floatingVisible, muted, prefs.keepRunningOnClose,
      dock.opacity]);
    if (menuKey !== this.lastMenuKey) {
      this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Codex Monitor', click: () => this.main.show() },
      { label: '诊断中心 / 原生状态', click: () => this.showDiagnostics() },
      { label: '显示悬浮窗', type: 'checkbox', checked: floatingVisible,
        click: () => { this.floating.setVisible(!floatingVisible); this.refresh(); } },
      { label: '系统通知静音', type: 'checkbox', checked: muted,
        click: () => { this.monitor.setMuted(!muted); this.refresh(); } },
      { label: '悬浮窗不透明度', submenu: [1, 0.85, 0.7, 0.55, 0.4].map(value => ({
        label: Math.round(value * 100) + '%',
        type: 'radio' as const, checked: Math.abs(dock.opacity - value) < 0.015,
        click: () => this.floating.setOpacity(value),
      })) },
      { type: 'separator' },
      { label: '关闭主窗口时后台运行', type: 'checkbox', checked: prefs.keepRunningOnClose,
        click: () => {
          this.store.updatePreferences({
            ...prefs, keepRunningOnClose: !prefs.keepRunningOnClose,
          });
          this.refresh();
        } },
      { type: 'separator' },
      { label: '完全退出（停止监控）', click: () => this.quit() },
      ]));
      this.lastMenuKey = menuKey;
    }
    const scan = current.scan;
    if (scan) {
      let count = 0;
      for (const source of scan.sources) {
        for (const item of source.sessions)
          if (item.status === 'working' && !item.isSubagent) count++;
      }
      const unread = current.alerts.filter(alert => !alert.read).length;
      const tooltip = 'Codex Monitor · 可能执行中 ' + count + ' · 未读 ' + unread;
      if (tooltip !== this.lastTooltip) {
        this.lastTooltip = tooltip;
        this.tray.setToolTip(tooltip);
      }
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
    this.lastMenuKey = null;
    this.lastTooltip = null;
  }
}
