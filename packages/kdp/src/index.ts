// KDP — the KINO Device Protocol: framing, commands, wire types, timing
// analysis and the byte transports underneath. Everything here is the
// firmware contract; nothing here knows about any particular app.

export * from './protocol/crc32';
export * from './protocol/packet';
export * from './protocol/commands';
export * from './protocol/types';
export * from './protocol/timing';
export * from './protocol/flash';
export * from './protocol/KinoProtocolClient';

export * from './transport/Transport';
export * from './transport/SerialTransport';
// Safe in the barrel because it imports nothing Node-only: the caller supplies
// the port object. See the header of NodeSerialTransport.ts.
export * from './transport/NodeSerialTransport';
export * from './transport/MockTransport';
export * from './transport/BroadcastTransport';
export * from './transport/WebSocketTransport';
export * from './transport/twinWire';
