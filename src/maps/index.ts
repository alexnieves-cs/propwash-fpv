import type { MapDef } from '../world/types';
import { alpine } from './alpine';

export const MAPS: MapDef[] = [alpine];

export function getMap(id: string): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}
