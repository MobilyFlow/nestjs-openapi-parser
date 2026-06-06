/**
 * An actor that triggered an audit event.
 *
 * Intentionally orphan — no endpoint references it. Used by tests to verify the
 * `additionalModels` config knob, including transitive registration.
 */
export class AuditActor {
  id!: string;

  displayName!: string;

  kind!: 'USER' | 'SYSTEM';
}

/**
 * A single audit log entry.
 *
 * Intentionally orphan — no endpoint references it.
 */
export class AuditEvent {
  eventId!: string;

  occurredAt!: Date;

  actor!: AuditActor;

  message!: string;
}
