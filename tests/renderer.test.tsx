import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../src/renderer/App';

describe('desktop UI rendering smoke', () => {
  it('renders the Signal Studio shell with all monitoring workflows before data arrives', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('Codex Monitor');
    expect(html).toContain('决策台');
    expect(html).toContain('机器矩阵');
    expect(html).toContain('事件轨迹');
    expect(html).toContain('全部会话');
    expect(html).toContain('执行位置');
    expect(html).toContain('需要你的关注');
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
