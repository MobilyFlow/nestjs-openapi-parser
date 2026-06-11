import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import { StatusSummary, SystemStatus } from './system-status';

export class HealthStatusDto {
  ok!: boolean;

  uptimeSeconds!: number;
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
    return { status: { uptimeSeconds: 0, region: 'us-east', services: [] }, checkedAt: new Date(), meta: { degraded: false } };
  }
}
