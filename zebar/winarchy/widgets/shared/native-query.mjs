import { invoke } from 'https://esm.sh/@tauri-apps/api@2.0.2/core';
import { listen } from 'https://esm.sh/@tauri-apps/api@2.0.2/event';
import { createShellQueryExecutor, spawnShellQuery } from './shell-query.mjs';

// Zebar 3.3.1's kill wrapper sends processId; the native command requires pid.
export const shellQuery = createShellQueryExecutor(
  (program, args) => spawnShellQuery(invoke, listen, program, args),
  process => process.kill(),
);
