/** Deployment region — a string-literal-union `type` alias (emitted inline as an enum). */
export type Region = 'us-east' | 'eu-west' | 'asia';

/** Health of a single downstream service. */
export interface ServiceHealth {
  /** Service identifier. */
  name: string;

  healthy: boolean;

  /** Round-trip latency in milliseconds, when measured. */
  latencyMs?: number;
}

/** Base status fields shared via interface `extends` heritage. */
interface BaseStatus {
  /** Seconds since the process started. */
  uptimeSeconds: number;
}

/**
 * Aggregated system status — returned as an `interface` with `extends` heritage
 * and a nested array of `$ref`d models.
 */
export interface SystemStatus extends BaseStatus {
  region: Region;

  services: ServiceHealth[];
}

/**
 * A `type` alias over an object literal — references an interface, a `Date`, an
 * optional field and an anonymous inline object.
 */
export type StatusSummary = {
  status: SystemStatus;

  checkedAt: Date;

  /** Optional operator note. */
  note?: string;

  meta: { degraded: boolean };
};

/**
 * Orphan interface — no endpoint reaches it. Force-included via the
 * `additionalModels` string form to prove non-class models can be pinned.
 */
export interface MaintenanceWindow {
  start: Date;

  end: Date;

  reason: string;
}
