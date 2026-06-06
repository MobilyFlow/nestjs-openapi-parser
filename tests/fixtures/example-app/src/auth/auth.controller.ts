import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';

@Controller('auth')
export class AuthController {
  /**
   * Exchange credentials for an access token.
   */
  @Public()
  @Post('login')
  login(@Body() _dto: LoginDto): Promise<LoginResponseDto> {
    return Promise.resolve(new LoginResponseDto());
  }
}
