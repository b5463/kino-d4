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
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/\sdisabled(?:=|>)/);
    expect(html).toContain('Publishing');
  });

  it('announces meaningful state changes and preserves a compact lamp name', () => {
    const html = renderToStaticMarkup(
      <StatusLamp state="ok" label="" accessibleLabel="KINO connected" announce />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-label="KINO connected"');
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
    expect(html).toContain('data-tab-id="feed" aria-selected="true" tabindex="0"');
    expect(html).toContain('data-tab-id="details" aria-selected="false" tabindex="-1"');
  });
});
