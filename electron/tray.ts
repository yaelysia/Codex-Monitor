import { Menu, Tray, nativeImage } from 'electron';
import type { MonitorService } from './monitor-service';
import type { FloatingWindowController } from './floating';
import type { MainWindowController } from './main-window';
import type { ResidentStore } from './resident-store';

const TRAY_ICON = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA80lEQVR42u2XvQ0CMQyFL0+3Bw0TsAMSYhGGoEnDELfI6SR2yARpMglUoCg/IrZsX0OqKEW+52dHsadp5+Vah8fD6aUBiylUPFjBe3fDCt5jwBLeYsEaXoqYuRcsfqvObv7CewUUB1pgrpCYghsWMAKmCokpOEhFzXUBGgVGqYWZG30LsviNXIiQjJDzCiCde1EBUlGaF+FfgKoA6cKEZcGJpUDShaHPiAKkuDb8GWm6o/Yd505cn/fvfj0/eP0AtyHJ4aWImIIjt2Sfy6VaMnZPKPVE0ZtYpFae89L+ajSzas/zgPFrdtOeDzEyQGoOp7uvN74HbbP3jZ3UAAAAAElFTkSuQmCC';

export class TrayController {
  private tray: Tray | null = null;

  constructor(private readonly main: MainWindowController,
    private readonly floating: FloatingWindowController,
    private readonly monitor: MonitorService,
    private readonly store: ResidentStore,
    private readonly quit: () => void) {}

  start(): void {
    if (this.tray) return;
    this.tray = new Tray(nativeImage.createFromBuffer(Buffer.from(TRAY_ICON, 'base64')));
    this.tray.setToolTip('Codex Monitor · 监控后台运行');
    this.tray.on('double-click', () => this.main.show());
    this.refresh();
  }

  refresh(): void {
    if (!this.tray) return;
    const floatingVisible = this.floating.state().visible;
    const muted = this.monitor.state().muted;
    const prefs = this.store.snapshot().preferences;
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Codex Monitor', click: () => this.main.show() },
      { label: '显示悬浮窗', type: 'checkbox', checked: floatingVisible,
        click: () => { this.floating.setVisible(!floatingVisible); this.refresh(); } },
      { label: '系统通知静音', type: 'checkbox', checked: muted,
        click: () => { this.monitor.setMuted(!muted); this.refresh(); } },
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
    const scan = this.monitor.state().scan;
    if (scan) {
      const count = scan.sources.flatMap(source => source.sessions)
        .filter(item => item.status === 'working' && !item.isSubagent).length;
      const unread = this.monitor.state().alerts.filter(alert => !alert.read).length;
      this.tray.setToolTip('Codex Monitor · 可能执行中 ' + count + ' · 未读 ' + unread);
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
