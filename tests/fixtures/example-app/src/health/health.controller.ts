import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/public.decorator';

export class HealthStatusDto {
  ok!: boolean;

  uptimeSeconds!: number;
}

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
}
