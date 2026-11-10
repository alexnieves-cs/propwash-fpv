import type { MapDef } from '../world/types';
import { airfield } from './airfield';
import { alpine } from './alpine';
import { bando } from './bando';

export const MAPS: MapDef[] = [alpine, bando, airfield];

export function getMap(id: string): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}
