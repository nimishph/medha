/**
 * NoopSyncAdapter — default no-op SyncPort when no sync is configured (spec §7.2).
 */

import type {
  Context,
  PullResult,
  PushResult,
  ReconcileResult,
  StorePort,
  SyncPort,
  SyncStatus,
} from '@cntxt-labs/medha-core';

export class NoopSyncAdapter implements SyncPort {
  readonly name = 'noop';
  private readonly store?: StorePort | undefined;

  constructor(options: { readonly store?: StorePort } = {}) {
    this.store = options.store;
  }

  async status(_context?: Context): Promise<SyncStatus> {
    const localCount = this.store ? (await this.store.list()).length : 0;
    return {
      state: 'uninitialized',
      localCount,
      message: 'NoopSyncAdapter: No synchronization configured',
    };
  }

  async pull(_context?: Context): Promise<PullResult> {
    const localTotal = this.store ? (await this.store.list()).length : 0;
    return {
      ok: true,
      updated: false,
      pulledCount: 0,
      localTotal,
    };
  }

  async push(_context?: Context): Promise<PushResult> {
    return {
      ok: true,
      pushedCount: 0,
    };
  }

  async reconcile(_context?: Context): Promise<ReconcileResult> {
    const totalCount = this.store ? (await this.store.list()).length : 0;
    return {
      ok: true,
      pulledCount: 0,
      pushedCount: 0,
      totalCount,
    };
  }
}
