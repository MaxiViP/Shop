import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { StaffGuard } from '../auth/staff.guard.js';
import { StaffService } from './staff.service.js';
import { extraSchema, editExtraSchema, cancelExtraSchema } from './extra.js';
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

  @Post(':id/extras')
  extra(@Param('id', { schema: idSchema }) id: number, @Req() request: AuthRequest,
    @Body({ schema: extraSchema }) body: z.infer<typeof extraSchema>) {
    return this.staff.extra(id, request.user.id, body);
  }

  @Patch(':id/extras/:extraId')
  editExtra(@Param('id', { schema: idSchema }) id: number, @Param('extraId', { schema: idSchema }) extraId: number,
    @Req() request: AuthRequest, @Body({ schema: editExtraSchema }) body: z.infer<typeof editExtraSchema>) {
    const { version, ...data } = body;
    return this.staff.extra(id, request.user.id, data, extraId, version);
  }

  @Post(':id/extras/:extraId/cancel')
  cancelExtra(@Param('id', { schema: idSchema }) id: number, @Param('extraId', { schema: idSchema }) extraId: number,
    @Req() request: AuthRequest, @Body({ schema: cancelExtraSchema }) body: z.infer<typeof cancelExtraSchema>) {
    return this.staff.extra(id, request.user.id, null, extraId, body.version);
  }

  @Post(':id/delivery/confirm')
  async confirmDelivery(@Param('id', { schema: idSchema }) id: number, @Req() request: AuthRequest,
    @Body({ schema: deliverySchema }) body: DeliveryInput) {
    await this.staff.confirmPayment(id, request.user.id, 'DELIVERY');
    return this.staff.delivery(id, body);
  }

  @Get()
  list() {
    return this.staff.list();
  }

  @Get('unread')
  unread() { return this.staff.unread(); }

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

  @Post(':id/assembly/reopen')
  reopen(@Param('id', { schema: idSchema }) id: number) {
    return this.staff.reopen(id);
  }

  @Post(':id/payment/confirm')
  confirmPayment(
    @Param('id', { schema: idSchema }) id: number,
    @Req() request: AuthRequest,
  ) {
    return this.staff.confirmPayment(id, request.user.id);
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
    @Req() request: AuthRequest,
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
    return this.staff.item(id, itemId, body, request.user.id);
  }
}
