import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { OrderStatus } from '../db/gen/client.js';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { StaffGuard } from '../auth/staff.guard.js';
import { StaffService } from './staff.service.js';
import { staffActor } from './audit.js';
import { extraSchema, editExtraSchema, cancelExtraSchema } from './extra.js';
import {
  deliverySchema,
  itemSchema,
  type DeliveryInput,
  type ItemInput,
} from './schema.js';

const idSchema = z.coerce.number().int().positive();
const cancelSchema = z.object({ reason: z.string().trim().max(1000).optional() }).strict().default({});
const restoreSchema = z.object({ cancellationId: z.number().int().positive() }).strict();

@Controller('staff/orders')
@UseGuards(AuthGuard, StaffGuard)
export class StaffCtrl {
  constructor(private readonly staff: StaffService) {}

  @Post(':id/extras')
  extra(@Param('id', { schema: idSchema }) id: number, @Req() request: AuthRequest,
    @Body({ schema: extraSchema }) body: z.infer<typeof extraSchema>) {
    return this.staff.extra(id, request.user.id, body, undefined, undefined, staffActor(request.user));
  }

  @Patch(':id/extras/:extraId')
  editExtra(@Param('id', { schema: idSchema }) id: number, @Param('extraId', { schema: idSchema }) extraId: number,
    @Req() request: AuthRequest, @Body({ schema: editExtraSchema }) body: z.infer<typeof editExtraSchema>) {
    const { version, ...data } = body;
    return this.staff.extra(id, request.user.id, data, extraId, version, staffActor(request.user));
  }

  @Post(':id/extras/:extraId/cancel')
  cancelExtra(@Param('id', { schema: idSchema }) id: number, @Param('extraId', { schema: idSchema }) extraId: number,
    @Req() request: AuthRequest, @Body({ schema: cancelExtraSchema }) body: z.infer<typeof cancelExtraSchema>) {
    return this.staff.extra(id, request.user.id, null, extraId, body.version, staffActor(request.user));
  }

  @Post(':id/delivery/confirm')
  async confirmDelivery(@Param('id', { schema: idSchema }) id: number, @Req() request: AuthRequest,
    @Body({ schema: deliverySchema }) body: DeliveryInput) {
    await this.staff.confirmPayment(id, request.user.id, 'DELIVERY', staffActor(request.user));
    return this.staff.delivery(id, body, staffActor(request.user));
  }

  @Get()
  list(@Query('status', { schema: z.enum(OrderStatus).optional() }) status?: OrderStatus) {
    return this.staff.list(status);
  }

  @Get('unread')
  unread() { return this.staff.unread(); }

  @Get('new-summary')
  newSummary() { return this.staff.newSummary(); }

  @Post(':id/restore')
  restore(@Param('id', { schema: idSchema }) id: number, @Req() request: AuthRequest,
    @Body({ schema: restoreSchema }) body: z.infer<typeof restoreSchema>) {
    return this.staff.restore(id, request.user.id, request.user.role, body.cancellationId, staffActor(request.user));
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
    @Req() request: AuthRequest,
  ) {
    return this.staff.confirm(id, staffActor(request.user));
  }

  @Post(':id/assembly/start')
  startAssembly(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
    @Req() request: AuthRequest,
  ) {
    return this.staff.startAssembly(id, staffActor(request.user));
  }

  @Post(':id/assembly/finish')
  finishAssembly(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
    @Req() request: AuthRequest,
  ) {
    return this.staff.finishAssembly(id, staffActor(request.user));
  }

  @Post(':id/pickup/complete')
  completePickup(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
    @Req() request: AuthRequest,
  ) {
    return this.staff.completePickup(id, staffActor(request.user));
  }

  @Post(':id/assembly/reopen')
  reopen(@Param('id', { schema: idSchema }) id: number, @Req() request: AuthRequest) {
    return this.staff.reopen(id, staffActor(request.user));
  }

  @Post(':id/payment/confirm')
  confirmPayment(
    @Param('id', { schema: idSchema }) id: number,
    @Req() request: AuthRequest,
  ) {
    return this.staff.confirmPayment(id, request.user.id, undefined, staffActor(request.user));
  }

  @Post(':id/cancel')
  cancel(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
    @Req() request: AuthRequest,
    @Body({ schema: cancelSchema }) body: z.infer<typeof cancelSchema>,
  ) {
    return this.staff.cancel(id, request.user.id, request.user.role, body.reason, staffActor(request.user));
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
    @Req() request: AuthRequest,
  ) {
    return this.staff.delivery(id, body, staffActor(request.user));
  }

  @Post(':id/delivery/handoff')
  handoff(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
    @Req() request: AuthRequest,
  ) {
    return this.staff.handoff(id, staffActor(request.user));
  }

  @Post(':id/delivery/complete')
  completeDelivery(
    @Param('id', {
      schema: idSchema,
    })
    id: number,
    @Req() request: AuthRequest,
  ) {
    return this.staff.completeDelivery(id, staffActor(request.user));
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
    return this.staff.item(id, itemId, body, request.user.id, staffActor(request.user));
  }
}
