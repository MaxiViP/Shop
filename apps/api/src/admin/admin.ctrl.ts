import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminService } from './admin.service.js';
import {
  itemSchema,
  statusSchema,
  type ItemInput,
  type StatusInput,
} from './schema.js';

const idSchema = z.coerce.number().int().positive();

@Controller('admin/orders')
@UseGuards(AuthGuard, AdminGuard)
export class AdminCtrl {
  constructor(private readonly admin: AdminService) {}

  @Get()
  list() {
    return this.admin.list();
  }

  @Get(':id')
  get(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
  ) {
    return this.admin.get(id);
  }

  @Patch(':id/status')
  status(
    @Param('id', {
      schema: idSchema,
    })
    id: number,

    @Body({
      schema: statusSchema,
    })
    body: StatusInput,
  ) {
    return this.admin.status(id, body.status);
  }

  @Patch(':id/items/:itemId')
  item(
    @Param('id', {
      schema: idSchema,
    })
    id: number,

    @Param('itemId', {
      schema: idSchema,
    })
    itemId: number,

    @Body({
      schema: itemSchema,
    })
    body: ItemInput,
  ) {
    return this.admin.item(id, itemId, body);
  }
}
