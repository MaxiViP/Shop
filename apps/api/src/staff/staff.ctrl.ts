import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard.js';
import { StaffGuard } from '../auth/staff.guard.js';
import { StaffService } from './staff.service.js';
import {
  deliverySchema,
  itemSchema,
  type DeliveryInput,
  type ItemInput,
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

  @Post(':id/confirm')
  confirm(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
  ) {
    return this.staff.confirm(id);
  }

  @Post(':id/assembly/start')
  startAssembly(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
  ) {
    return this.staff.startAssembly(id);
  }

  @Post(':id/assembly/finish')
  finishAssembly(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
  ) {
    return this.staff.finishAssembly(id);
  }

  @Post(':id/pickup/complete')
  completePickup(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
  ) {
    return this.staff.completePickup(id);
  }

  @Post(':id/cancel')
  cancel(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
  ) {
    return this.staff.cancel(id);
  }

  @Put(':id/delivery')
  delivery(
    @Param('id', {
      schema: idSchema,
    })
    id: number,

    @Body({
      schema: deliverySchema,
    })
    body: DeliveryInput,
  ) {
    return this.staff.delivery(id, body);
  }

  @Post(':id/delivery/handoff')
  handoff(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
  ) {
    return this.staff.handoff(id);
  }

  @Post(':id/delivery/complete')
  completeDelivery(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
  ) {
    return this.staff.completeDelivery(id);
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
