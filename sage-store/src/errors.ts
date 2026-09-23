import type { CorruptLocation } from '@cntxt-labs/medha-core';
import { type ErrorInit, MedhaError } from '@cntxt-labs/medha-core';

/**
 * Typed errors for the store subsystem. Everything a backend can fail with is a `MedhaError`
 * subclass branching on `code`; no bare `Error` crosses a store boundary.
 */

/** The store's log is damaged past a known sequence. Reads are snapshot-backed; writes refuse. */
export class CorruptStoreError extends MedhaError {
  readonly code = 'STORE_LOG_CORRUPT';
  readonly subsystem = 'store' as const;
  readonly location: CorruptLocation;

  constructor(location: CorruptLocation, message: string, init: ErrorInit = {}) {
    super(message, {
      ...init,
      context: { source: location.source, atSeq: location.atSeq, ...init.context },
    });
    this.location = location;
  }
}

/** The backend was not opened (or was already closed) when an operation ran. */
export class StoreClosedError extends MedhaError {
  readonly code = 'STORE_NOT_OPEN';
  readonly subsystem = 'store' as const;

  constructor(operation: string, init: ErrorInit = {}) {
    super(`Store is not open; cannot ${operation}`, {
      ...init,
      context: { operation, ...init.context },
    });
  }
}

/** The store already folded the rebuild and found it diverged from what it keeps. */
export class StoreIntegrityError extends MedhaError {
  readonly code = 'STORE_FOLD_MISMATCH';
  readonly subsystem = 'store' as const;

  constructor(key: string, init: ErrorInit = {}) {
    super(`Rebuilt state for '${key}' differs from the stored projection`, {
      ...init,
      context: { key, ...init.context },
    });
  }
}

/** The on-disk store was written by a newer (or unknown) layout than this build reads. */
export class StoreLayoutError extends MedhaError {
  readonly code = 'STORE_LAYOUT_UNSUPPORTED';
  readonly subsystem = 'store' as const;

  constructor(layoutVersion: number, supported: number, init: ErrorInit = {}) {
    super(
      `Store layout version ${layoutVersion} is not supported by this build (supports up to ${supported})`,
      { ...init, context: { layoutVersion, supported, ...init.context } },
    );
  }
}
