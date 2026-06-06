import { Controller, Get } from '@nestjs/common';
import { AdminMeta } from './admin-meta';

/**
 * Admin-only ops.
 *
 * @Scope admin
 */
@Controller('admin')
export class AdminController {
  @Get('whoami')
  whoami(): Promise<AdminMeta> {
    return Promise.resolve(new AdminMeta());
  }
}
