import { PCFShadowMap, PerspectiveCamera, Scene, Vector3, WebGLRenderer, NoToneMapping, type Texture } from 'three';
import { Sky, makeNoiseTexture, type SkyParams, type SunState } from './atmosphere';
import { PostPipeline, type LookSettings } from './post';
import { SunShadows } from './shadows';

export type QualityId = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  id: QualityId;
  label: string;
  hint: string;
  /** render resolution as a multiple of CSS pixels (capped by the display's pixel ratio) */
  pixelRatio: number;
  msaa: number;
  shadowSize: number;
  cascades: number[];
  ao: boolean;
  bloom: boolean;
  motionBlurTaps: number;
  /** multiplier on grass instance count */
  grass: number;
  /** multiplier on the distances at which foliage drops detail */
  lod: number;
  anisotropy: number;
}

export const QUALITY: Record<QualityId, QualityPreset> = {
  low: {
    id: 'low',
    label: 'Low',
    hint: 'Integrated graphics',
    pixelRatio: 0.85,
    msaa: 0,
    shadowSize: 1024,
    cascades: [28, 170],
    ao: false,
    bloom: true,
    motionBlurTaps: 1,
    grass: 0.3,
    lod: 0.6,
    anisotropy: 2,
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    hint: 'Older laptops',
    pixelRatio: 1,
    msaa: 2,
    shadowSize: 1536,
    cascades: [16, 70, 300],
    ao: false,
    bloom: true,
    motionBlurTaps: 6,
    grass: 0.6,
    lod: 0.8,
    anisotropy: 4,
  },
  high: {
    id: 'high',
    label: 'High',
    hint: 'Recommended',
    pixelRatio: 1.25,
    msaa: 4,
    shadowSize: 2048,
    cascades: [12, 46, 180, 560],
    ao: true,
    bloom: true,
    motionBlurTaps: 8,
    grass: 1,
    lod: 1,
    anisotropy: 8,
  },
  ultra: {
    id: 'ultra',
    label: 'Ultra',
    hint: 'Discrete GPU',
    pixelRatio: 1.75,
    msaa: 4,
    shadowSize: 3072,
    cascades: [12, 46, 180, 620],
    ao: true,
    bloom: true,
    motionBlurTaps: 12,
    grass: 1.5,
    lod: 1.35,
    anisotropy: 16,
  },
};

/** Owns the WebGL renderer, the scene, lighting and the post pipeline. */
export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(100, 1.6, 0.1, 18000);
  readonly noise: Texture;
  readonly sky: Sky;
  readonly shadows: SunShadows;
  readonly post: PostPipeline;
  quality: QualityPreset;
  sun!: SunState;
  look!: LookSettings;
  time = 0;
  /** dynamic resolution factor, 0.6..1 */
  dynamicScale = 1;
  dynamicResolution = true;
  private frameTimes: number[] = [];
  private lastScaleChange = 0;
  private cssW = 2;
  private cssH = 2;
  private readonly sunRgb = new Vector3();

  constructor(readonly canvas: HTMLCanvasElement, quality: QualityPreset) {
    this.quality = quality;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: false,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.info.autoReset = false;

    this.noise = makeNoiseTexture();
    this.sky = new Sky(this.renderer, this.noise);
    this.scene.add(this.sky.mesh);
    this.shadows = new SunShadows(this.scene);
    this.shadows.configure({ radii: quality.cascades, mapSize: quality.shadowSize });
    this.post = new PostPipeline(this.renderer, this.sky.skyTexture, this.noise, this.sky.cloudOffset, {
      ao: quality.ao,
      bloom: quality.bloom,
      motionBlurTaps: quality.motionBlurTaps,
      msaa: quality.msaa,
    });
    this.scene.add(this.camera);
    this.resize();
  }

  get maxAnisotropy(): number {
    return Math.min(this.quality.anisotropy, this.renderer.capabilities.getMaxAnisotropy());
  }

  setQuality(q: QualityPreset): void {
    this.quality = q;
    this.shadows.configure({ radii: q.cascades, mapSize: q.shadowSize });
    if (this.sun) this.shadows.setSun(this.sun.direction, this.sun.color, this.sun.intensity);
    this.post.applySettings({ ao: q.ao, bloom: q.bloom, motionBlurTaps: q.motionBlurTaps, msaa: q.msaa });
    this.dynamicScale = 1;
    this.resize();
  }

  /** Set time of day, weather and grade for a map. */
  setEnvironment(sky: SkyParams, look: LookSettings): void {
    this.look = look;
    this.sun = this.sky.apply(sky);
    this.scene.environment = this.sky.envTexture;
    this.scene.environmentIntensity = 1;
    this.shadows.setSun(this.sun.direction, this.sun.color, this.sun.intensity);
    this.sunRgb.set(this.sun.color.r, this.sun.color.g, this.sun.color.b).multiplyScalar(this.sun.intensity);
    this.post.setLook(look, this.sun.direction, this.sunRgb, sky.cloudCover);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.cssW = w;
    this.cssH = h;
    const ratio = Math.min(this.quality.pixelRatio, window.devicePixelRatio || 1) * this.dynamicScale;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(Math.round(w * ratio), Math.round(h * ratio), false);
    this.post.setSize(Math.round(w * ratio), Math.round(h * ratio));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get renderHeight(): number {
    return this.renderer.domElement.height;
  }

  /** Nudge the render resolution to hold a playable frame rate. */
  private govern(dt: number): void {
    if (!this.dynamicResolution) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 90) return;
    const sorted = this.frameTimes.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.frameTimes.length = 0;
    if (this.time - this.lastScaleChange < 2.5) return;
    let next = this.dynamicScale;
    if (median > 1 / 44) next = Math.max(0.6, this.dynamicScale - 0.1);
    else if (median < 1 / 58 && this.dynamicScale < 1) next = Math.min(1, this.dynamicScale + 0.05);
    if (next !== this.dynamicScale) {
      this.dynamicScale = next;
      this.lastScaleChange = this.time;
      this.resize();
    }
  }

  render(dt: number, windX = 0, windZ = 0): void {
    this.time += dt;
    this.govern(dt);
    if (this.canvas.clientWidth !== this.cssW || this.canvas.clientHeight !== this.cssH) this.resize();
    this.camera.updateMatrixWorld();
    this.sky.update(this.time, this.camera, windX, windZ, dt);
    this.shadows.update(this.camera);
    this.renderer.info.reset();
    this.post.render(this.scene, this.camera, this.time);
  }
}
