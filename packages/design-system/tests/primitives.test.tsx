import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, ClassicProgressBar, StatusLamp, TabStrip } from '../src';

describe('shared design-system primitives', () => {
  it('renders status as a symbol and text rather than colour alone', () => {
    const html = renderToStaticMarkup(<StatusLamp state="warn" label="Needs attention" />);
    expect(html).toContain('▲');
    expect(html).toContain('Needs attention');
    expect(html).toContain('kino-status-lamp--warn');
  });

  it('keeps a busy command focusable while exposing its state', () => {
    const html = renderToStaticMarkup(<Button busy>Publishing</Button>);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('disabled');
    expect(html).toContain('Publishing');
  });

  it('clamps progress semantics to its declared range', () => {
    const html = renderToStaticMarkup(
      <ClassicProgressBar value={140} max={100} label="Firmware transfer" />,
    );
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain('width:100%');
  });

  it('exposes selected tabs with the native ARIA tab pattern', () => {
    const html = renderToStaticMarkup(
      <TabStrip
        label="Capture views"
        tabs={[{ id: 'feed', label: 'Feed' }, { id: 'details', label: 'Details' }]}
        active="feed"
        onChange={() => {}}
      />,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
  });
});
