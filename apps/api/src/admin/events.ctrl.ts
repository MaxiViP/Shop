import {
  Controller,
  Get,
  HttpException,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthService, SID } from '../auth/auth.service.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { EventsService } from './events.service.js';
import { eventsQuery, type EventsQuery } from './events-query.js';

@Controller('admin/events')
@UseGuards(AdminGuard)
export class EventsCtrl {
  private readonly streams = new Map<number, number>();
  constructor(
    private readonly events: EventsService,
    private readonly auth: AuthService,
  ) {}
  @Get()
  list(
    @Req() request: AuthRequest,
    @Query({ schema: eventsQuery }) query: EventsQuery,
  ) {
    return this.events.list(request.user.id, query);
  }
  @Get('stream')
  async stream(
    @Req() request: AuthRequest,
    @Res() response: Response,
    @Query({ schema: eventsQuery }) query: EventsQuery,
  ) {
    const userId = request.user.id;
    if ((this.streams.get(userId) ?? 0) >= 3)
      throw new HttpException('Открыто слишком много лент', 429);
    // Reserve synchronously so concurrent connects cannot bypass the limit.
    this.streams.set(userId, (this.streams.get(userId) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = (this.streams.get(userId) ?? 1) - 1;
      if (count) this.streams.set(userId, count);
      else this.streams.delete(userId);
    };
    response.once('close', release);
    const raw = request.headers['last-event-id'] ?? request.query.cursor;
    const token = typeof raw === 'string' ? raw : undefined;
    // Validate cursor/rights before committing SSE headers.
    let change;
    try {
      try {
        change = await this.events.changes(userId, query, token);
      } catch (error) {
        if (!(error instanceof HttpException) || error.getStatus() !== 400)
          throw error;
        change = { ...(await this.events.changes(userId, query)), reset: true };
      }
    } catch (error) {
      release();
      throw error;
    }
    if (response.destroyed) {
      release();
      return;
    }
    response.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    response.flushHeaders();
    let cursor = change.cursor,
      busy = false,
      closed = false;
    const send = (
      event: string,
      data: { cursor?: string; count?: number; reset?: boolean },
    ) => {
      if (closed) return;
      if (
        !response.write(
          `${data.cursor ? `id: ${data.cursor}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
        )
      )
        response.end();
    };
    response.write('retry: 3000\n\n');
    send('reset' in change ? 'reset' : 'sync', change);
    const timer = setInterval(() => {
      void tick();
    }, 3000);
    const expires = setTimeout(() => response.end(), 30 * 60000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearTimeout(expires);
      release();
    };
    response.on('close', cleanup);
    const tick = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const user = await this.auth.me(request.cookies?.[SID]);
        if (!user || user.id !== userId || user.role !== 'ADMIN') {
          send('denied', {});
          response.end();
          return;
        }
        const next = await this.events.changes(userId, query, cursor);
        if (closed) return;
        cursor = next.cursor;
        send('sync', next);
      } catch (error) {
        send(
          error instanceof HttpException && error.getStatus() === 403
            ? 'denied'
            : 'reset',
          {},
        );
        response.end();
      } finally {
        busy = false;
      }
    };
  }
}
