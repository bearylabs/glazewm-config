import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { executeGlobalProtect } from '../shared/globalprotect-model.mjs';
import { retainPopupDuringInteraction } from '../shared/popup-controller.mjs';

export function renderGlobalProtect(root, reportError) {
  const section = document.createElement('section');
  section.className = 'network-section network-vpn';
  section.setAttribute('aria-label', 'GlobalProtect VPN');
  const header = document.createElement('div');
  header.className = 'network-section__heading';
  const title = document.createElement('h2');
  title.textContent = 'VPN';
  header.append(title);
  const row = document.createElement('div');
  row.className = 'network-vpn__row';
  const labels = document.createElement('div');
  labels.className = 'network-vpn__labels';
  const name = document.createElement('span');
  name.id = 'globalprotect-name';
  name.textContent = 'GlobalProtect';
  const state = document.createElement('span');
  state.className = 'network-section__state';
  state.setAttribute('role', 'status');
  labels.append(name, state);
  const controls = document.createElement('div');
  controls.className = 'network-vpn__actions';
  const toggle = document.createElement('button');
  toggle.id = 'globalprotect-toggle';
  toggle.type = 'button';
  toggle.className = 'network-vpn__switch';
  toggle.setAttribute('role', 'switch');
  const track = document.createElement('span');
  track.className = 'network-vpn__track';
  track.setAttribute('aria-hidden', 'true');
  const knob = document.createElement('span');
  knob.className = 'network-vpn__knob';
  track.append(knob);
  toggle.append(track);
  const open = document.createElement('button');
  open.id = 'globalprotect-open';
  open.type = 'button';
  open.textContent = '↗';
  open.className = 'network-vpn__open';
  open.setAttribute('aria-label', 'Open GlobalProtect client');
  open.title = 'Open GlobalProtect client';
  controls.append(open, toggle);
  row.append(labels, controls);
  const note = document.createElement('p');
  note.className = 'note network-note';
  note.hidden = true;
  section.title = 'Status reflects the VPN adapter, including split tunnels; not a reachability test.';
  section.append(header, row, note);
  root.append(section);

  let snapshot = null;
  let busy = false;
  let querying = false;
  let stopped = false;
  let pending = null;
  let error = '';
  let releaseRetention = () => {};
  function finishPending() {
    pending = null;
    releaseRetention();
    releaseRetention = () => {};
  }
  function render() {
    state.textContent = error ? 'Status unavailable' : !snapshot ? 'Checking…'
      : !snapshot.available ? 'Not installed' : pending ? (pending.connected ? 'Connecting…' : 'Disconnecting…')
        : snapshot.connected ? 'Connected' : 'Disconnected';
    const actionLabel = pending ? 'VPN operation in progress' : snapshot?.connected ? 'Disconnect GlobalProtect' : 'Connect GlobalProtect';
    toggle.setAttribute('aria-label', actionLabel);
    toggle.title = actionLabel;
    toggle.setAttribute('aria-checked', String(Boolean(snapshot?.connected)));
    section.dataset.connected = String(Boolean(snapshot?.connected));
    toggle.disabled = busy || Boolean(pending) || Boolean(error) || !snapshot?.available;
    open.disabled = busy || snapshot?.available === false;
    section.setAttribute('aria-busy', String(busy || Boolean(pending)));
    note.textContent = error || (pending?.connected ? 'Complete login/MFA in the GlobalProtect client.' : '');
    note.hidden = !note.textContent;
    note.classList.toggle('error', Boolean(error));
  }
  async function refresh() {
    if (querying || busy || stopped) return;
    querying = true;
    try {
      const next = await executeGlobalProtect(zebar.shellExec, 'status');
      if (stopped) return;
      snapshot = next;
      error = '';
      if (pending && snapshot.connected === pending.connected) finishPending();
      if (pending && Date.now() > pending.deadline) {
        finishPending();
        reportError(new Error('GlobalProtect did not reach the requested state. Check the client before retrying.'));
      }
    } catch (failure) {
      if (!stopped) error = failure.message;
    } finally {
      querying = false;
      if (!stopped) render();
    }
  }
  async function act(action) {
    if (busy || stopped || (action !== 'open' && (pending || error || !snapshot?.available))) return;
    busy = true;
    render();
    try {
      if (action !== 'open') releaseRetention = retainPopupDuringInteraction();
      await executeGlobalProtect(zebar.shellExec, action);
      if (stopped) return;
      if (action !== 'open') pending = { connected: action === 'connect', deadline: Date.now() + 120000 };
    } catch (failure) {
      finishPending();
      if (!stopped) reportError(failure);
    } finally {
      busy = false;
      if (!stopped) { render(); void refresh(); }
    }
  }
  toggle.addEventListener('click', () => void act(snapshot?.connected ? 'disconnect' : 'connect'));
  open.addEventListener('click', () => void act('open'));
  const interval = setInterval(() => void refresh(), 5000);
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearInterval(interval);
    finishPending();
  }, { once: true });
  render();
  void refresh();
}
