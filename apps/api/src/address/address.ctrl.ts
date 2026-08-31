import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthRequest } from '../auth/auth.guard.js';
import { AddressService } from './address.service.js';
import {
  addressSchema,
  addressUpdateSchema,
  type AddressInput,
  type AddressUpdate,
} from './schema.js';

const idSchema = z.coerce.number().int().positive();

@Controller('addresses')
@UseGuards(AuthGuard)
export class AddressCtrl {
  constructor(private readonly address: AddressService) {}

  @Get()
  list(@Req() request: AuthRequest) {
    return this.address.list(request.user.id);
  }

  @Post()
  create(
    @Req() request: AuthRequest,

    @Body({
      schema: addressSchema,
    })
    body: AddressInput,
  ) {
    return this.address.create(request.user.id, body);
  }

  @Patch(':id')
  update(
    @Req() request: AuthRequest,

    @Param('id', {
      schema: idSchema,
    })
    id: number,

    @Body({
      schema: addressUpdateSchema,
    })
    body: AddressUpdate,
  ) {
    return this.address.update(request.user.id, id, body);
  }

  @Patch(':id/default')
  setDefault(
    @Req() request: AuthRequest,

    @Param('id', {
      schema: idSchema,
    })
    id: number,
  ) {
    return this.address.setDefault(request.user.id, id);
  }

  @Delete(':id')
  remove(
    @Req() request: AuthRequest,

    @Param('id', {
      schema: idSchema,
    })
    id: number,
  ) {
    return this.address.remove(request.user.id, id);
  }
}
