import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard.js';
import { StaffGuard } from '../auth/staff.guard.js';
import { StaffService } from './staff.service.js';
import {
  itemSchema,
  statusSchema,
  type ItemInput,
  type StatusInput,
} from './schema.js';

const idSchema = z.coerce.number().int().positive();

@Controller('staff/orders')
@UseGuards(AuthGuard, StaffGuard)
export class StaffCtrl {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list() {
    return this.staff.list();
  }

  @Get(':id')
  get(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
  ) {
    return this.staff.get(id);
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
    return this.staff.status(id, body.status);
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
    return this.staff.item(id, itemId, body);
  }
}
