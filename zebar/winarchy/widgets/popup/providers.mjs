import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { onPopupSessionEnd } from '../shared/popup-session.mjs';

export function subscribe(config, render) {
  const group = zebar.createProviderGroup(config);
  let disposed = false;
  const update = () => { if (!disposed) render(group.outputMap, group.errorMap); };
  group.onOutput(update);
  group.onError(update);
  onPopupSessionEnd(() => {
    disposed = true;
    return group.stopAll().catch(error => console.error('Stopping popup providers:', error));
  });
  update();
  return group;
}
