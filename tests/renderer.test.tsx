import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../src/renderer/App';


afterEach(() => vi.unstubAllGlobals());

describe('reusable SignalSelect controls', () => {
  it('uses a styled combobox rather than an unthemed Windows native select', () => {
    const html = renderToStaticMarkup(createElement(App));
    // Radix retains one visually hidden native select for form integration.
    // The interactive trigger is a combobox; the native dropdown is never shown.
    expect(html).toContain('<select aria-hidden="true"');
    expect(html).not.toContain('<option');
    expect(html).toContain('aria-label="执行位置筛选"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('signal-select-trigger');
  });

  it('uses the same dropdown component for status and source in the sessions view', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({
        view: 'sessions', filter: 'waiting', recentOnly: true, showSubagents: false,
      }),
    });
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('aria-label="运行状态筛选"');
    expect(html).toContain('aria-label="执行位置筛选"');
    expect((html.match(/role="combobox"/g) || [])).toHaveLength(2);
    expect((html.match(/<select aria-hidden="true"/g) || [])).toHaveLength(2);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<SignalSelect label="运行状态筛选"');
    expect(source).toContain('<SignalSelect label="执行位置筛选"');
  });

  it('supports animated, collision-aware menus with reduced-motion fallback', () => {
    const component = readFileSync(new URL('../src/renderer/SignalSelect.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/renderer/signal-select.css', import.meta.url), 'utf8');
    expect(component).toContain('position="popper"');
    expect(component).toContain('avoidCollisions');
    expect(component).toContain('<Select.Portal>');
    expect(styles).toContain('[data-state="open"]');
    expect(styles).toContain('[data-highlighted]');
    expect(styles).toContain('prefers-reduced-motion:reduce');
  });
});

describe('decision desk and session drill-down interaction contract', () => {
  it('does not render session status filtering on the decision desk', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('signal-overview-stats');
    expect(html).toContain('查看可能待处理会话，共 0 条');
    expect(html).not.toContain('aria-label="运行状态筛选"');
    expect(html).not.toContain('返回决策台');
  });

  it('offers one-click return and clearing for saved filtered session lists', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({
        view: 'sessions', filter: 'waiting', recentOnly: true, showSubagents: false,
      }),
    });
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('aria-label="运行状态筛选"');
    expect(html).toContain('返回决策台');
    expect(html).toContain('清除状态筛选');
    expect(html).toContain('signal-filter-tag');
    expect(html).not.toContain('signal-overview-stats');
  });

  it('discard stale status after returning to a non-session saved view', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({
        view: 'board', filter: 'waiting', recentOnly: true, showSubagents: false,
      }),
    });
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('signal-overview-stats');
    expect(html).not.toContain('aria-label="运行状态筛选"');
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('filter: view === \'sessions\' ? filter : \'all\'');
    expect(source).toContain("setFilter('all');");
    expect(source).toContain("onClick={() => openOverview('waiting')}");
    expect(source).toContain("onClick={() => openOverview('abnormal')}");
    expect(source).toContain("onClick={() => openOverview('working')}");
  });
});

describe('Signal Studio view switching contract', () => {
  it('uses one persistent title container while changing the view animation', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    // A changing key remounts the heading on every navigation; in Electron this
    // produced a stack of stale animated heading layers.
    expect(source).toContain('className="signal-page-title" data-current-view={view}');
    expect(source).not.toContain('className="signal-page-title" key={view}');
    expect(source).toContain("className={'signal-view view-' + view}");
    expect(source).not.toContain('<div key={view} className="signal-view"');
    const html = renderToStaticMarkup(createElement(App));
    expect((html.match(/class="signal-page-title"/g) || [])).toHaveLength(1);
    expect((html.match(/class="signal-view view-board"/g) || [])).toHaveLength(1);
  });
});

describe('desktop UI rendering smoke', () => {
  it('renders the Signal Studio shell with all monitoring workflows before data arrives', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('Codex Monitor');
    expect(html).toContain('决策台');
    expect(html).toContain('机器矩阵');
    expect(html).toContain('事件轨迹');
    expect(html).toContain('全部会话');
    expect(html).toContain('执行位置');
    expect(html).toContain('可能待处理');
    expect(html).toContain('失败 / 中断');
    expect(html).toContain('当前没有待处理会话');
    expect(html).toContain('查看可能待处理会话，共 0 条');
    expect(html).toContain('查看失败和中断会话，共 0 条');
    expect(html).not.toContain('件待处理');
    expect(html).not.toContain('signal-focus');
    expect(html).toContain('最近变化');
    expect(html).toContain('数据源设置');
    expect(html).toContain('常驻设置');
    expect(html).toContain('显示子代理');
    // The decorative marketing hero and unused logo were deliberately removed.
    expect(html).toContain('任务概览');
    expect(html).not.toContain('今天的工作');
    expect(html).not.toContain('signal-brand-symbol');
    // Previously a literal <br/> in a string was visible in the task card.
    expect(html).not.toContain('&lt;br/&gt;');
    expect(html).toContain('signal-view');
    expect(html).toContain('nav-board');
  });
});
