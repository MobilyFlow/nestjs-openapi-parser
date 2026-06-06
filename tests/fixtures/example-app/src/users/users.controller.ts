import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { PaginatedResponse } from '../common/paginated-response';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './user.entity';

@Controller('users')
export class UsersController {
  /**
   * Paginated list of users.
   */
  @Get()
  list(
    @Query('limit') _limit?: string,
    @Query('offset') _offset?: string,
  ): Promise<PaginatedResponse<User>> {
    return Promise.resolve(new PaginatedResponse<User>());
  }

  /**
   * Fetch a single user by UUID.
   */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) _id: string): Promise<User> {
    return Promise.resolve(new User());
  }

  @Post()
  create(@Body() _dto: CreateUserDto): Promise<User> {
    return Promise.resolve(new User());
  }

  @Put(':id')
  update(@Param('id', ParseUUIDPipe) _id: string, @Body() _dto: UpdateUserDto): Promise<User> {
    return Promise.resolve(new User());
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) _id: string): Promise<void> {
    return Promise.resolve();
  }
}
