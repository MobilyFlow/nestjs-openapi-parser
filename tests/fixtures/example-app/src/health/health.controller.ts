import { All, Controller, Get, Head, Options, RequestMethod, Sse } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { Observable, of } from 'rxjs';
import { Public } from '../common/public.decorator';
import { StatusSummary, SystemStatus } from './system-status';

export class HealthStatusDto {
  ok!: boolean;

  uptimeSeconds!: number;
}

/** A single heartbeat pushed over the SSE stream. */
export class HeartbeatEvent {
  data!: { uptimeSeconds: number };
}

/**
 * @Tag System Health
 */
@Public()
@Controller('health')
export class HealthController {
  /**
   * Liveness probe.
   *
   * <internal>Internal note: returns the in-memory uptime, not the process clock.</internal>
   */
  @Get()
  check(): HealthStatusDto {
    return { ok: true, uptimeSeconds: 0 };
  }

  /** Aggregated status returned as an `interface`. */
  @Get('status')
  status(): SystemStatus {
    return { uptimeSeconds: 0, region: 'us-east', services: [] };
  }

  /** Status snapshot returned as a `type` alias. */
  @Get('summary')
  summary(): StatusSummary {
    return {
      status: { uptimeSeconds: 0, region: 'us-east', services: [] },
      checkedAt: new Date(),
      meta: { degraded: false },
    };
  }

  /** Live uptime stream over Server-Sent Events. */
  @Sse('stream')
  stream(): Observable<HeartbeatEvent> {
    return of({ data: { uptimeSeconds: 0 } });
  }

  /** SSE stream whose verb is overridden to POST (NestJS v11 option). */
  // @ts-expect-error fixture pins @nestjs/common@10, whose Sse(path?) takes no
  // options arg; this exercises the v11 Sse(path, options) method override.
  @Sse('stream-post', { [METHOD_METADATA]: RequestMethod.POST })
  streamPost(): Observable<HeartbeatEvent> {
    return of({ data: { uptimeSeconds: 0 } });
  }

  /** Cheap liveness check with no body. */
  @Head('ping')
  ping(): void {}

  /** CORS preflight / capability probe. */
  @Options('probe')
  probe(): void {}

  /** Catch-all echo handler, registered for every verb. */
  @All('echo')
  echo(): HealthStatusDto {
    return { ok: true, uptimeSeconds: 0 };
  }
}
