import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { executeGlobalProtect } from '../shared/globalprotect-model.mjs';
import { retainPopupDuringInteraction } from '../shared/popup-controller.mjs';
import { readSnapshot, writeSnapshot, clearSnapshot, vpnSnapshotValid } from '../shared/snapshot-cache.mjs';
import { readBackgroundSnapshot } from '../shared/network-background.mjs';
import { onPopupSessionEnd } from '../shared/popup-session.mjs';
import { createIcon } from '../shared/icons.mjs';
import { shellQuery } from '../shared/native-query.mjs';

// A timed-out native mutation may still run after this render session ends.
let nativeMutation = null;

export function renderGlobalProtect(root, reportError) {
  const section = document.createElement('section');
  section.className = 'network-section network-vpn';
  section.setAttribute('aria-label', 'GlobalProtect VPN');
  const header = document.createElement('div');
  header.className = 'network-section__heading';
  const title = document.createElement('h2');
  title.id = 'globalprotect-title';
  title.textContent = 'GlobalProtect';
  const icon = createIcon('globalprotect');
  const labels = document.createElement('div');
  labels.className = 'network-vpn__labels';
  const state = document.createElement('span');
  state.className = 'network-section__state';
  state.setAttribute('role', 'status');
  labels.append(title, state);
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
  const openIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  openIcon.setAttribute('viewBox', '0 0 24 24');
  openIcon.setAttribute('aria-hidden', 'true');
  openIcon.setAttribute('focusable', 'false');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', 'M6 18 18 6M6 6h12v12');
  arrow.setAttribute('fill', 'none');
  arrow.setAttribute('stroke', 'currentColor');
  arrow.setAttribute('stroke-width', '2');
  arrow.setAttribute('stroke-linecap', 'round');
  arrow.setAttribute('stroke-linejoin', 'round');
  openIcon.append(arrow);
  open.append(openIcon);
  open.className = 'network-vpn__open';
  open.setAttribute('aria-label', 'Open GlobalProtect client');
  open.title = 'Open GlobalProtect client';
  controls.append(open, toggle);
  header.append(icon, labels, controls);
  const note = document.createElement('p');
  note.className = 'note network-note';
  note.hidden = true;
  section.title = 'Status reflects the VPN adapter, including split tunnels; not a reachability test.';
  section.append(header, note);
  root.append(section);

  const cacheKey = 'winarchy.network.vpn.v1';
  let snapshot = readSnapshot(cacheKey, vpnSnapshotValid);
  let verified = false;
  let busy = false;
  let querying = false;
  let initialized = false;
  let stopped = false;
  let pending = null;
  let pendingTimer = null;
  const actionCleanups = new Set();
  let error = '';
  let releaseRetention = () => {};
  function finishPending() {
    pending = null;
    clearTimeout(pendingTimer);
    pendingTimer = null;
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
    toggle.disabled = !verified || busy || Boolean(nativeMutation) || Boolean(pending) || Boolean(error) || !snapshot?.available;
    open.disabled = busy || snapshot?.available === false;
    section.setAttribute('aria-busy', String(busy || Boolean(pending)));
    note.textContent = error || (nativeMutation && !busy
      ? 'A previous native action is still running. Check the official client; VPN controls remain disabled until it exits.'
      : pending?.connected ? 'Complete login/MFA in the GlobalProtect client.' : '');
    note.hidden = !note.textContent;
    note.classList.toggle('error', Boolean(error));
  }
  async function refresh() {
    if (querying || busy || stopped) return;
    querying = true;
    try {
      const backgroundVpn = !initialized && !pending ? readBackgroundSnapshot(cacheKey, vpnSnapshotValid) : null;
      initialized = true;
      const next = backgroundVpn ?? await executeGlobalProtect(shellQuery, 'status');
      if (stopped) return;
      snapshot = next;
      verified = true;
      if (!backgroundVpn) writeSnapshot(cacheKey, snapshot);
      error = '';
      if (pending && snapshot.connected === pending.connected) {
        const dismissClient = pending.dismissClient;
        finishPending();
        if (dismissClient) await act('hide');
      }
    } catch (failure) {
      if (!stopped) {
        verified = false;
        clearSnapshot(cacheKey);
        error = failure.message;
      }
    } finally {
      querying = false;
      if (!stopped) render();
    }
  }
  async function act(action) {
    if (busy || stopped || (action !== 'open' && (nativeMutation || !verified || pending || error || !snapshot?.available))) return;
    // An explicit Open client request overrides automatic dismissal for this operation.
    if (action === 'open' && pending) pending.dismissClient = false;
    busy = true;
    render();
    const operation = { expired: false };
    const startedAt = Date.now();
    let actionTimer;
    let expireAction;
    const deadline = new Promise((_, reject) => {
      expireAction = () => {
        operation.expired = true;
        reject(new Error('GlobalProtect action timed out; its outcome is unknown. Check the official client. No action was retried.'));
      };
      actionTimer = setTimeout(expireAction, 120000);
    });
    const endAction = () => { clearTimeout(actionTimer); expireAction(); };
    actionCleanups.add(endAction);
    let native;
    try {
      if (['connect', 'disconnect'].includes(action)) releaseRetention = retainPopupDuringInteraction();
      native = executeGlobalProtect(zebar.shellExec, action);
      if (action !== 'open') {
        nativeMutation = native;
        const releaseMutation = () => {
          if (nativeMutation === native) nativeMutation = null;
        };
        void native.then(releaseMutation, failure => {
          releaseMutation();
          if (operation.expired) console.error('Late GlobalProtect action failure:', failure);
        });
      }
      const response = await Promise.race([native, deadline]);
      if (stopped || operation.expired) return;
      clearTimeout(actionTimer);
      if (['connect', 'disconnect'].includes(action)) {
        clearSnapshot(cacheKey);
        pending = { connected: action === 'connect', dismissClient: true };
        pendingTimer = setTimeout(() => {
          finishPending();
          if (!stopped) {
            reportError(new Error('GlobalProtect did not reach the requested state. Check the client before retrying.'));
            render();
          }
        }, Math.max(0, 120000 - (Date.now() - startedAt)));
        if (response.placementWarning) {
          reportError(new Error(`VPN action requested, but the client window could not be placed beside the popup: ${response.placementWarning}`));
        }
      }
    } catch (failure) {
      finishPending();
      if (!stopped) reportError(action === 'hide'
        ? new Error(`VPN state confirmed, but the client window could not be hidden: ${failure.message}`)
        : failure);
    } finally {
      clearTimeout(actionTimer);
      actionCleanups.delete(endAction);
      busy = false;
      if (!stopped) { render(); void refresh(); }
    }
  }
  toggle.addEventListener('click', () => void act(snapshot?.connected ? 'disconnect' : 'connect'));
  open.addEventListener('click', () => void act('open'));
  const interval = setInterval(() => void refresh(), 1000);
  const onStorage = event => { if (event.key === cacheKey) void refresh(); };
  window.addEventListener('storage', onStorage);
  onPopupSessionEnd(() => {
    window.removeEventListener('storage', onStorage);
    stopped = true;
    clearInterval(interval);
    finishPending();
    for (const expire of actionCleanups) expire();
    actionCleanups.clear();
  });
  render();
  void refresh();
}
