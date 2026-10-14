import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../src/renderer/App';

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
