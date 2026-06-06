import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/public.decorator';

export class HealthStatusDto {
  ok!: boolean;

  uptimeSeconds!: number;
}

@Public()
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthStatusDto {
    return { ok: true, uptimeSeconds: 0 };
  }
}
