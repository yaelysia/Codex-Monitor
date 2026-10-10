import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../src/renderer/App';

describe('desktop UI rendering smoke', () => {
  it('renders a status-first board with all navigation destinations before data arrives', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('Codex Monitor');
    expect(html).toContain('任务状态');
    expect(html).toContain('全部会话');
    expect(html).toContain('执行位置');
    expect(html).toContain('状态待确认');
    expect(html).toContain('最近完成');
    expect(html).toContain('数据源设置');
  });
});
