import { Controller, Get, Param, Query } from '@nestjs/common';
import { MarketMapService } from './market-map.service.js';
import { floorQuery, marketSlug } from './schema.js';

@Controller('market-map')
export class MarketMapCtrl {
  constructor(private readonly map: MarketMapService) {}

  @Get()
  list(@Query({ schema: floorQuery }) query: { floor: number }) {
    return this.map.list(query.floor, true);
  }

  @Get(':slug')
  get(@Param('slug', { schema: marketSlug }) slug: string) {
    return this.map.publicPoint(slug);
  }
}
