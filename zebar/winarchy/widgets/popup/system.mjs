import { renderAudio } from './audio.mjs';
import { renderNetwork } from './network.mjs';
import { renderPower } from './power.mjs';
import { renderDisplay } from './display.mjs';
import { renderBluetooth } from './bluetooth.mjs';
import { renderGlobalProtect } from './globalprotect.mjs';
import { onPopupSessionEnd } from '../shared/popup-session.mjs';

export function renderSystemPopup(type, reportError) {
  const root = document.getElementById('system-content');
  const renderers = { audio: renderAudio, network: renderNetwork, globalprotect: renderGlobalProtect, bluetooth: renderBluetooth, display: renderDisplay, power: renderPower };
  if (!Object.hasOwn(renderers, type)) throw new Error(`Unknown system popup: ${type}`);
  document.documentElement.dataset.popupType = type;
  document.querySelector('header').hidden = true;
  document.querySelector('main').setAttribute('aria-labelledby', `${type}-title`);
  document.getElementById('month-label').textContent = {
    audio: 'Audio', network: 'Network', globalprotect: 'GlobalProtect', bluetooth: 'Bluetooth', display: 'Displays', power: 'Battery',
  }[type];
  let disposed = false;
  onPopupSessionEnd(() => { disposed = true; });
  return renderers[type](root, error => { if (!disposed) reportError(error); });
}
