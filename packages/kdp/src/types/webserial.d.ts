// Minimal Web Serial API declarations (desktop Chromium).
// Kept local so the build has no dependency on lib.dom experimental types.
//
// Only the subset SerialTransport touches. Apps that call
// navigator.serial.requestPort() themselves declare the Navigator side —
// these are ambient globals, so each tsc program needs its own copy.

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

interface SerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): SerialPortInfo;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  forget(): Promise<void>;
}
