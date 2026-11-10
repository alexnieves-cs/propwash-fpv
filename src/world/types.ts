import type { Group, PerspectiveCamera, Vector3 } from 'three';
import type { SkyParams } from '../render/atmosphere';
import type { Engine } from '../render/engine';
import type { LookSettings } from '../render/post';
import type { TextureForge } from '../render/textures';
import type { PhysicsWorld } from '../sim/physics-world';

export interface WorldCtx {
  engine: Engine;
  forge: TextureForge;
  physics: PhysicsWorld;
  /** everything a map creates hangs off this, so it can be torn down in one go */
  root: Group;
}

export type GateKind = 'square' | 'arch' | 'hoop' | 'dive' | 'tower' | 'flag';

export interface GateDef {
  kind: GateKind;
  /** centre of the opening */
  x: number;
  y: number;
  z: number;
  /** heading the pilot flies through it, degrees clockwise from north (-Z) */
  heading: number;
  /** opening size in metres (width for rectangular gates, diameter for hoops) */
  size?: number;
  /** y is height above ground at (x, z) rather than absolute */
  agl?: boolean;
}

export interface TrackDef {
  id: string;
  name: string;
  blurb: string;
  laps: number;
  gates: GateDef[];
  /** start position: where the quad sits before the first gate */
  start: { x: number; z: number; heading: number };
  /** gold / silver / bronze total times, seconds */
  medals: [number, number, number];
}

export interface Spawn {
  pos: Vector3;
  /** degrees clockwise from north */
  heading: number;
}

export interface BuiltWorld {
  spawn: Spawn;
  tracks: TrackDef[];
  heightAt(x: number, z: number): number;
  waterLevel: number;
  /** horizontal radius of the flyable area, metres */
  boundsRadius: number;
  ceiling: number;
  wind: { x: number; z: number; gust: number };
  update(dt: number, time: number, camera: PerspectiveCamera): void;
  dispose(): void;
}

export interface MapDef {
  id: string;
  name: string;
  tagline: string;
  description: string;
  sky: SkyParams;
  look: LookSettings;
  build(ctx: WorldCtx, progress: (fraction: number, label: string) => Promise<void>): Promise<BuiltWorld>;
}
