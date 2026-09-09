import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { AuthService, SID } from '../auth/auth.service.js';
import { GID } from '../common/guest.js';
import { AuthGuard, type AuthRequest } from '../auth/auth.guard.js';
import { StaffGuard } from '../auth/staff.guard.js';
import {
  CoordinationService,
  type OrderActor,
} from './coordination.service.js';
import {
  recordId,
  chatSchema,
  cursorSchema,
  decisionSchema,
  proposalSchema,
  readSchema,
} from './coordination.schema.js';

@Controller('orders/:publicId')
export class CustomerCoordinationCtrl {
  constructor(
    private readonly service: CoordinationService,
    private readonly auth: AuthService,
  ) {}
  private async actor(publicId: string, request: Request): Promise<OrderActor> {
    const user = await this.auth.me(request.cookies?.[SID]);
    return {
      publicId,
      userId: user?.id ?? null,
      guestToken: request.cookies?.[GID],
    };
  }
  @Get('coordination')
  async get(
    @Param('publicId', { schema: z.string().uuid() }) id: string,
    @Req() request: Request,
  ) {
    return this.service.view(await this.actor(id, request));
  }
  @Post('issues/:issueId/decision')
  async decide(
    @Param('publicId', { schema: z.string().uuid() }) id: string,
    @Param('issueId', { schema: recordId }) issueId: number,
    @Req() request: Request,
    @Body({ schema: decisionSchema }) body: z.infer<typeof decisionSchema>,
  ) {
    return this.service.decide(await this.actor(id, request), issueId, body);
  }
  @Get('messages')
  async messages(
    @Param('publicId', { schema: z.string().uuid() }) id: string,
    @Req() request: Request,
    @Query({ schema: cursorSchema }) query: z.infer<typeof cursorSchema>,
  ) {
    return this.service.messages(await this.actor(id, request), query);
  }
  @Post('messages')
  async post(
    @Param('publicId', { schema: z.string().uuid() }) id: string,
    @Req() request: Request,
    @Body({ schema: chatSchema }) body: z.infer<typeof chatSchema>,
  ) {
    return this.service.post(await this.actor(id, request), body.text);
  }
  @Post('messages/read')
  async read(
    @Param('publicId', { schema: z.string().uuid() }) id: string,
    @Req() request: Request,
    @Body({ schema: readSchema }) body: z.infer<typeof readSchema>,
  ) {
    return this.service.read(await this.actor(id, request), body.through);
  }
}

@Controller('staff/orders/:id')
@UseGuards(AuthGuard, StaffGuard)
export class StaffCoordinationCtrl {
  constructor(private readonly service: CoordinationService) {}
  private actor(orderId: number, request: AuthRequest): OrderActor {
    // StaffGuard verified this server-side role; never accept a role from the body.
    return {
      orderId,
      userId: request.user.id,
      role: request.user.role === 'ADMIN' ? 'ADMIN' : 'SELLER',
    };
  }
  @Get('coordination')
  get(
    @Param('id', { schema: recordId }) id: number,
    @Req() request: AuthRequest,
  ) {
    return this.service.view(this.actor(id, request));
  }
  @Post('issues/:issueId/proposal')
  propose(
    @Param('id', { schema: recordId }) id: number,
    @Param('issueId', { schema: recordId }) issueId: number,
    @Req() request: AuthRequest,
    @Body({ schema: proposalSchema }) body: z.infer<typeof proposalSchema>,
  ) {
    return this.service.propose(this.actor(id, request), issueId, body);
  }
  @Post('issues/:issueId/sms')
  retry(
    @Param('id', { schema: recordId }) id: number,
    @Param('issueId', { schema: recordId }) issueId: number,
    @Req() request: AuthRequest,
  ) {
    return this.service.retry(this.actor(id, request), issueId);
  }
  @Get('messages')
  messages(
    @Param('id', { schema: recordId }) id: number,
    @Req() request: AuthRequest,
    @Query({ schema: cursorSchema }) query: z.infer<typeof cursorSchema>,
  ) {
    return this.service.messages(this.actor(id, request), query);
  }
  @Post('messages')
  post(
    @Param('id', { schema: recordId }) id: number,
    @Req() request: AuthRequest,
    @Body({ schema: chatSchema }) body: z.infer<typeof chatSchema>,
  ) {
    return this.service.post(this.actor(id, request), body.text);
  }
  @Post('messages/read')
  read(
    @Param('id', { schema: recordId }) id: number,
    @Req() request: AuthRequest,
    @Body({ schema: readSchema }) body: z.infer<typeof readSchema>,
  ) {
    return this.service.read(this.actor(id, request), body.through);
  }
}
