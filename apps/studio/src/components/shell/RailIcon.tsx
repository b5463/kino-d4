// Monochrome line icons for the application frame: one 24-unit grid, 1.5 px
// strokes, currentColor. These are the rail's and the top bar's glyphs; the
// old coloured pixel set (components/Icon.tsx) stays for the pages.

export type RailIconName =
  | 'shoot'
  | 'wiggle'
  | 'quad'
  | 'looks'
  | 'calibration'
  | 'gallery'
  | 'roll'
  | 'device'
  | 'updates'
  | 'developer'
  | 'bringup'
  | 'bench'
  | 'gear'
  | 'sync'
  | 'test'
  | 'usb'
  | 'more'
  | 'chevron'
  | 'panel';

const PATHS: Record<RailIconName, string> = {
  // Camera body with a lens.
  shoot: 'M3 8h4l2-3h6l2 3h4v11H3z M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  // Three frames fanned out: the wigglegram.
  wiggle: 'M3 9h11v11H3z M7 6h11v11 M10 3h11v11',
  // Four frames.
  quad: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  // A lens with the blade of an aperture.
  looks: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 3v9l6.4 6.4 M12 12l-6.4 6.4 M12 12l7.8-4.5 M12 12L4.2 7.5',
  // Crosshair.
  calibration: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M12 2v4 M12 18v4 M2 12h4 M18 12h4',
  // Picture frame.
  gallery: 'M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 5 M16 8.5a1 1 0 1 0 0 .01',
  // Two linked frames: a Roll shared between people.
  roll: 'M9 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M15 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  // Sliders.
  device: 'M4 7h16 M4 12h16 M4 17h16 M8 5v4 M15 10v4 M10 15v4',
  // Arrow into a tray.
  updates: 'M12 3v12 M7 10l5 5 5-5 M4 17v3h16v-3',
  developer: 'M8 6l-5 6 5 6 M16 6l5 6-5 6 M14 4l-4 16',
  // A USB-C plug seen from the cable.
  bringup: 'M9 3h6v6H9z M7 9h10v5a5 5 0 0 1-10 0z M12 14v7',
  // A stopwatch.
  bench: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M12 9v4l3 2 M10 2h4 M12 2v3 M19 6l-1.5 1.5',
  gear:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.2 2.2 M16.9 16.9l2.2 2.2 M4.9 19.1l2.2-2.2 M16.9 7.1l2.2-2.2',
  sync: 'M20 12a8 8 0 0 1-14.5 4.6 M4 12a8 8 0 0 1 14.5-4.6 M4 4v5h5 M20 20v-5h-5',
  test: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12l3 3 5-6',
  usb: 'M9 3h6v6H9z M7 9h10v5a5 5 0 0 1-10 0z M12 14v7',
  more: 'M6 12a.5.5 0 1 0 0 .01 M12 12a.5.5 0 1 0 0 .01 M18 12a.5.5 0 1 0 0 .01',
  chevron: 'M6 9l6 6 6-6',
  // A panel with its right column.
  panel: 'M3 5h18v14H3z M15 5v14',
};

export function RailIcon({
  name,
  size = 20,
  className,
}: {
  name: RailIconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
