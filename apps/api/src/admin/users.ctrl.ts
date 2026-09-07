import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { AdminUsersService } from './users.service.js';
import { idSchema, roleSchema, userQuery, type UserQuery } from './schema.js';
@Controller('admin/users')
@UseGuards(AdminGuard)
export class AdminUsersCtrl {
  constructor(private readonly users: AdminUsersService) {}
  @Get()
  list(@Query({ schema: userQuery }) query: UserQuery) {
    return this.users.list(query);
  }
  @Get(':id')
  get(@Param('id', { schema: idSchema }) id: number) {
    return this.users.get(id);
  }
  @Patch(':id/role')
  role(
    @Param('id', { schema: idSchema }) id: number,
    @Body({ schema: roleSchema }) body: { role: 'USER' | 'SELLER' },
  ) {
    return this.users.role(id, body.role);
  }
}
