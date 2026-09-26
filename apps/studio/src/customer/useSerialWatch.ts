import { useEffect } from 'react';
import { canStartConnection, useConnectionStore } from '../state/connectionStore';
import { connectSerialPort } from '../app/session';

/**
 * "Plug it back in and it will carry on."
 *
 * The browser raises `connect` on `navigator.serial` when a port it has
 * already granted reappears. While Studio is waiting for a camera that left
 * unexpectedly, or one that did not come back after a restart, that event is
 * the camera returning, and it is connected without a click. A first-ever
 * connection still goes through the picker: nothing has been granted yet.
 */
export function useSerialWatch(): void {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serial' in navigator)) return;
    const serial = navigator.serial;
    const onConnect = (e: Event) => {
      const { phase, fault } = useConnectionStore.getState();
      const waiting = phase === 'recovery' || (phase === 'error' && fault === 'hardware');
      if (!waiting || !canStartConnection(phase)) return;
      const port = (e as Event & { target: SerialPort | null }).target;
      if (port && typeof port.open === 'function') void connectSerialPort(port);
    };
    serial.addEventListener('connect', onConnect);
    return () => serial.removeEventListener('connect', onConnect);
  }, []);
}
