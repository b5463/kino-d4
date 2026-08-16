// Bitmap-informed icon set. Every glyph is hand-placed on a 16×16 pixel
// grid (rects only, crispEdges) so it renders like era-correct toolbar art:
// 1px dark outline, two or three interior tones, top-left light.

export type IconName =
  | 'overview'
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
  | 'usb'
  | 'connect'
  | 'sync'
  | 'test'
  | 'download'
  | 'camera'
  | 'sd'
  | 'battery'
  | 'flash'
  | 'warning'
  | 'heart';

const OUTLINE = '#31435c';
const STEEL = '#8fa3bb';
const STEEL_HI = '#dbe6f2';
const BLUE = '#2f70c9';
const BLUE_HI = '#7cb0ee';
const GREEN = '#48a83e';
const ORANGE = '#f28a2e';
const YELLOW = '#f4c542';
const RED = '#c83a3a';
const WHITE = '#ffffff';

// Compact pixel format: [x, y, w, h, color]
type Px = [number, number, number, number, string];

function cameraBody(y = 3): Px[] {
  return [
    [1, y, 14, 9, OUTLINE],
    [2, y + 1, 12, 7, STEEL],
    [2, y + 1, 12, 2, STEEL_HI],
    [5, y - 1, 5, 2, OUTLINE],
    [6, y, 3, 1, STEEL],
  ];
}

function lens(cx: number, cy: number): Px[] {
  return [
    [cx - 2, cy - 2, 5, 5, OUTLINE],
    [cx - 1, cy - 1, 3, 3, BLUE],
    [cx - 1, cy - 1, 1, 1, BLUE_HI],
  ];
}

const ICONS: Record<IconName, Px[]> = {
  camera: [...cameraBody(), ...lens(7, 7), [12, 4, 2, 1, GREEN]],
  overview: [
    [1, 2, 14, 12, OUTLINE],
    [2, 3, 12, 3, BLUE],
    [2, 3, 12, 1, BLUE_HI],
    [2, 7, 5, 6, STEEL_HI],
    [8, 7, 6, 2, STEEL],
    [8, 10, 6, 3, STEEL],
    [3, 8, 3, 1, GREEN],
    [3, 10, 3, 1, GREEN],
  ],
  shoot: [...cameraBody(), ...lens(7, 7), [12, 5, 2, 2, RED], [12, 5, 1, 1, '#e88a8a']],
  wiggle: [
    [1, 6, 3, 4, OUTLINE],
    [2, 7, 1, 2, BLUE],
    [5, 6, 3, 4, OUTLINE],
    [6, 7, 1, 2, BLUE_HI],
    [9, 6, 3, 4, OUTLINE],
    [10, 7, 1, 2, BLUE_HI],
    [13, 6, 3, 4, OUTLINE],
    [14, 7, 1, 2, BLUE],
    [3, 2, 10, 1, OUTLINE],
    [12, 1, 1, 3, OUTLINE],
    [3, 13, 10, 1, OUTLINE],
    [3, 12, 1, 3, OUTLINE],
  ],
  quad: [
    [1, 1, 6, 6, OUTLINE],
    [2, 2, 4, 4, ORANGE],
    [2, 2, 4, 1, '#f6ab60'],
    [9, 1, 6, 6, OUTLINE],
    [10, 2, 4, 4, BLUE],
    [10, 2, 4, 1, BLUE_HI],
    [1, 9, 6, 6, OUTLINE],
    [2, 10, 4, 4, GREEN],
    [2, 10, 4, 1, '#8fd484'],
    [9, 9, 6, 6, OUTLINE],
    [10, 10, 4, 4, STEEL],
    [10, 10, 4, 1, STEEL_HI],
  ],
  looks: [
    [1, 3, 14, 10, OUTLINE],
    [2, 4, 3, 8, ORANGE],
    [5, 4, 3, 8, YELLOW],
    [8, 4, 3, 8, GREEN],
    [11, 4, 3, 8, BLUE],
    [2, 4, 12, 1, WHITE],
    [2, 2, 2, 1, OUTLINE],
    [12, 2, 2, 1, OUTLINE],
  ],
  calibration: [
    [7, 1, 2, 14, OUTLINE],
    [1, 7, 14, 2, OUTLINE],
    [4, 4, 8, 8, OUTLINE],
    [5, 5, 6, 6, STEEL_HI],
    [7, 7, 2, 2, RED],
    [5, 5, 6, 1, WHITE],
  ],
  gallery: [
    [1, 2, 11, 9, OUTLINE],
    [2, 3, 9, 7, '#7ec3e8'],
    [2, 3, 9, 2, '#c8e8f8'],
    [3, 7, 3, 3, GREEN],
    [7, 5, 4, 5, '#3f8c36'],
    [4, 4, 2, 2, YELLOW],
    [4, 12, 11, 3, OUTLINE],
    [5, 13, 9, 1, STEEL],
  ],
  // Photos leaving the camera: a stack of frames with an upload arrow.
  roll: [
    [1, 5, 10, 9, OUTLINE],
    [2, 6, 8, 7, '#7ec3e8'],
    [2, 6, 8, 2, '#c8e8f8'],
    [3, 10, 3, 3, GREEN],
    [6, 9, 4, 4, '#3f8c36'],
    [2, 3, 10, 1, OUTLINE],
    [3, 1, 10, 1, OUTLINE],
    [12, 3, 2, 6, OUTLINE],
    [10, 5, 2, 2, OUTLINE],
    [14, 5, 2, 2, OUTLINE],
    [12, 3, 2, 1, ORANGE],
  ],
  device: [
    [2, 1, 12, 14, OUTLINE],
    [3, 2, 10, 12, STEEL],
    [3, 2, 10, 2, STEEL_HI],
    [4, 5, 8, 6, OUTLINE],
    [5, 6, 6, 4, '#1d2733'],
    [5, 6, 6, 1, '#3a4a5e'],
    [6, 12, 4, 2, OUTLINE],
  ],
  updates: [
    [2, 2, 12, 12, OUTLINE],
    [3, 3, 10, 10, '#2b3a4d'],
    [5, 5, 6, 6, STEEL],
    [5, 5, 6, 1, STEEL_HI],
    [1, 5, 1, 2, OUTLINE],
    [1, 9, 1, 2, OUTLINE],
    [14, 5, 1, 2, OUTLINE],
    [14, 9, 1, 2, OUTLINE],
    [5, 1, 2, 1, OUTLINE],
    [9, 1, 2, 1, OUTLINE],
    [5, 14, 2, 1, OUTLINE],
    [9, 14, 2, 1, OUTLINE],
    [7, 7, 2, 2, GREEN],
  ],
  developer: [
    [2, 3, 3, 2, OUTLINE],
    [1, 4, 3, 3, OUTLINE],
    [2, 5, 2, 2, STEEL],
    [3, 6, 9, 8, OUTLINE],
    [4, 7, 7, 6, STEEL],
    [4, 7, 7, 2, STEEL_HI],
    [11, 11, 4, 4, OUTLINE],
    [12, 12, 2, 2, ORANGE],
  ],
  usb: [
    [7, 1, 2, 9, OUTLINE],
    [6, 9, 4, 5, OUTLINE],
    [7, 10, 2, 3, STEEL],
    [3, 4, 2, 4, OUTLINE],
    [3, 3, 2, 1, GREEN],
    [11, 3, 2, 4, OUTLINE],
    [11, 7, 2, 1, GREEN],
    [4, 7, 4, 1, OUTLINE],
    [8, 5, 4, 1, OUTLINE],
  ],
  connect: [
    [1, 6, 6, 4, OUTLINE],
    [2, 7, 4, 2, STEEL],
    [2, 7, 4, 1, STEEL_HI],
    [7, 7, 2, 2, OUTLINE],
    [11, 4, 4, 8, OUTLINE],
    [12, 5, 2, 6, GREEN],
    [12, 5, 2, 1, '#8fd484'],
    [9, 7, 2, 2, YELLOW],
  ],
  sync: [
    [3, 2, 8, 2, OUTLINE],
    [11, 2, 2, 4, OUTLINE],
    [13, 5, 1, 2, GREEN],
    [11, 6, 5, 2, GREEN],
    [5, 12, 8, 2, OUTLINE],
    [3, 10, 2, 4, OUTLINE],
    [2, 9, 1, 2, ORANGE],
    [0, 8, 5, 2, ORANGE],
  ],
  test: [
    [2, 13, 12, 2, OUTLINE],
    [5, 2, 6, 2, OUTLINE],
    [6, 4, 1, 5, OUTLINE],
    [9, 4, 1, 5, OUTLINE],
    [4, 9, 8, 5, OUTLINE],
    [5, 10, 6, 3, '#9fd8f0'],
    [5, 10, 6, 1, '#d5effa'],
    [6, 11, 2, 2, GREEN],
  ],
  download: [
    [7, 1, 2, 8, OUTLINE],
    [4, 6, 3, 2, OUTLINE],
    [9, 6, 3, 2, OUTLINE],
    [5, 8, 6, 2, OUTLINE],
    [6, 10, 4, 1, OUTLINE],
    [7, 9, 2, 1, BLUE],
    [2, 12, 12, 3, OUTLINE],
    [3, 13, 10, 1, GREEN],
  ],
  sd: [
    [3, 1, 9, 14, OUTLINE],
    [4, 2, 7, 12, BLUE],
    [4, 2, 7, 2, BLUE_HI],
    [11, 1, 2, 4, OUTLINE],
    [5, 3, 1, 3, YELLOW],
    [7, 3, 1, 3, YELLOW],
    [9, 3, 1, 3, YELLOW],
    [5, 9, 6, 4, WHITE],
    [6, 10, 4, 2, STEEL],
  ],
  battery: [
    [1, 5, 12, 7, OUTLINE],
    [13, 7, 2, 3, OUTLINE],
    [2, 6, 10, 5, STEEL_HI],
    [3, 7, 3, 3, GREEN],
    [7, 7, 3, 3, GREEN],
    [2, 6, 10, 1, WHITE],
  ],
  flash: [
    [8, 1, 4, 1, OUTLINE],
    [6, 2, 4, 3, OUTLINE],
    [5, 5, 4, 3, OUTLINE],
    [7, 3, 2, 2, YELLOW],
    [6, 6, 2, 2, YELLOW],
    [7, 8, 3, 3, OUTLINE],
    [8, 9, 1, 2, ORANGE],
    [5, 11, 3, 4, OUTLINE],
    [6, 12, 1, 2, ORANGE],
  ],
  warning: [
    [7, 1, 2, 2, OUTLINE],
    [6, 3, 4, 3, OUTLINE],
    [5, 6, 6, 3, OUTLINE],
    [4, 9, 8, 3, OUTLINE],
    [3, 12, 10, 3, OUTLINE],
    [7, 3, 2, 2, YELLOW],
    [6, 6, 4, 3, YELLOW],
    [5, 9, 6, 3, YELLOW],
    [4, 12, 8, 2, YELLOW],
    [7, 5, 2, 5, OUTLINE],
    [7, 11, 2, 2, OUTLINE],
  ],
  heart: [
    [2, 3, 4, 2, OUTLINE],
    [10, 3, 4, 2, OUTLINE],
    [1, 5, 14, 3, OUTLINE],
    [2, 8, 12, 2, OUTLINE],
    [4, 10, 8, 2, OUTLINE],
    [6, 12, 4, 2, OUTLINE],
    [3, 5, 4, 2, RED],
    [9, 5, 4, 2, RED],
    [3, 8, 10, 1, RED],
    [5, 9, 6, 1, '#a02525'],
    [7, 11, 2, 1, '#a02525'],
    [3, 4, 2, 1, '#e88a8a'],
  ],
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  const pixels = ICONS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {pixels.map(([x, y, w, h, fill], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill={fill} />
      ))}
    </svg>
  );
}
