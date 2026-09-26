import { useDeviceStore } from '../state/deviceStore';
import { App } from './App';
import { APP_VERSION } from './version';

/**
 * Service: the engineering surface, at its own address. Every bench, table,
 * counter and worksheet lives under here, with the vocabulary they need.
 * The permanent band is the point: a screenshot of Service can never be
 * mistaken for the customer product.
 *
 * "Back to Studio" is a page load. The Service stylesheet is global and
 * unscoped, so the two surfaces do not share a document; the camera link
 * is re-opened with one click on the other side.
 */
export function ServiceShell() {
  const info = useDeviceStore((s) => s.info);
  return (
    <div className="service-frame">
      <div className="service-band" role="banner">
        <span className="service-band-word">SERVICE</span>
        <span className="service-band-unit">{info ? `${info.product} ${info.hardware} · ${info.serial} · ${info.p4Firmware}` : 'no camera'}</span>
        <span className="service-band-version">Studio {APP_VERSION}</span>
        <a className="service-band-back" href="./">
          Back to Studio
        </a>
      </div>
      <App />
    </div>
  );
}
