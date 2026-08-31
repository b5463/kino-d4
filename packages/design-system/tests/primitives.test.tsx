import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, ClassicProgressBar, StatusLamp, TabStrip, UtilitySlider, tabIds } from '../src';

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

  it('gives a named but silent lamp a role, so the name is not discarded', () => {
    // A bare aria-label on a roleless <span> names nothing — the reader is free
    // to read the visible text instead, which here is the empty string.
    const html = renderToStaticMarkup(<StatusLamp state="err" label="" accessibleLabel="SD card missing" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="SD card missing"');
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
    expect(html).toContain('data-tab-id="feed" aria-selected="true"');
    expect(html).toContain('data-tab-id="details" aria-selected="false"');
    // Only the selected tab is in the tab sequence; arrows move within the strip.
    expect(html).toMatch(/data-tab-id="feed"[^>]*tabindex="0"/);
    expect(html).toMatch(/data-tab-id="details"[^>]*tabindex="-1"/);
  });

  it('names the panel each tab controls, on both ends of the pair', () => {
    const html = renderToStaticMarkup(
      <TabStrip
        label="Capture views"
        idPrefix="gallery"
        tabs={[{ id: 'feed', label: 'Feed' }, { id: 'details', label: 'Details' }]}
        active="feed"
        onChange={() => {}}
      />,
    );
    // A role="tab" that cannot say what it shows leaves the panel an
    // unlabelled region the reader has to go and find.
    expect(html).toContain('id="gallery-tab-feed"');
    expect(html).toContain('aria-controls="gallery-panel-feed"');
    expect(html).toContain('id="gallery-tab-details"');
    expect(html).toContain('aria-controls="gallery-panel-details"');
    // The panel author derives the same two strings from one function, so the
    // pair cannot drift apart.
    expect(tabIds('feed', 'gallery')).toEqual({
      tab: 'gallery-tab-feed',
      panel: 'gallery-panel-feed',
    });
  });

  it('keeps an unavailable tab announced instead of dropping it from the tree', () => {
    const html = renderToStaticMarkup(
      <TabStrip
        label="Capture views"
        tabs={[{ id: 'feed', label: 'Feed' }, { id: 'roll', label: 'Roll', disabled: true }]}
        active="feed"
        onChange={() => {}}
      />,
    );
    expect(html).toMatch(/data-tab-id="roll"[^>]*aria-disabled="true"/);
    // The `disabled` attribute is what removed it from the accessibility tree,
    // turning "this camera does not advertise Roll" into "this tab is gone".
    expect(html).not.toMatch(/\sdisabled(?:=|>)/);
    expect(html).toContain('Roll');
  });

  it('reports a slider value without renaming the slider on every drag', () => {
    const html = renderToStaticMarkup(
      <UtilitySlider id="brightness" label="Brightness" valueLabel="7" min={1} max={10} value={7} readOnly />,
    );
    // The label names the input once, and its whole content is the label text:
    // with the readout nested inside, the accessible name was "Brightness 7"
    // and changed on every drag.
    expect(html).toContain('<label class="kino-slider-label" for="brightness">Brightness</label>');
    expect(html).toContain('id="brightness"');
    // The output points at the same input from outside the label.
    expect(html).toMatch(/<\/label>[\s\S]*<output[^>]*for="brightness"[^>]*>7<\/output>/);
  });
});
