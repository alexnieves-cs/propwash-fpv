import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  SphereGeometry,
  Vector2,
  type Material,
} from 'three';
import { MOTOR_LAYOUT, type DroneConfig } from '../sim/drone-config';
import type { TextureForge } from './textures';

const DEG = Math.PI / 180;

function propBlurTexture(blades: number): CanvasTexture {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, s, s);
  g.translate(s / 2, s / 2);
  // a faint disc, denser towards the tips, with soft ghost blades
  const rad = g.createRadialGradient(0, 0, s * 0.06, 0, 0, s * 0.5);
  rad.addColorStop(0, 'rgba(255,255,255,0.0)');
  rad.addColorStop(0.25, 'rgba(255,255,255,0.10)');
  rad.addColorStop(0.9, 'rgba(255,255,255,0.20)');
  rad.addColorStop(0.97, 'rgba(255,255,255,0.34)');
  rad.addColorStop(1, 'rgba(255,255,255,0.0)');
  g.fillStyle = rad;
  g.beginPath();
  g.arc(0, 0, s * 0.5, 0, Math.PI * 2);
  g.fill();
  for (let b = 0; b < blades; b++) {
    g.save();
    g.rotate((b / blades) * Math.PI * 2);
    const lg = g.createLinearGradient(0, -s * 0.09, 0, s * 0.09);
    lg.addColorStop(0, 'rgba(255,255,255,0)');
    lg.addColorStop(0.5, 'rgba(255,255,255,0.20)');
    lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg;
    g.fillRect(s * 0.05, -s * 0.09, s * 0.44, s * 0.18);
    g.restore();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function bladeGeometry(radius: number, blades: number): BufferGeometry {
  // one swept, tapered blade as a thin box, copied around the hub
  const parts: BufferGeometry[] = [];
  for (let b = 0; b < blades; b++) {
    const g = new BoxGeometry(radius * 0.92, radius * 0.02, radius * 0.24, 4, 1, 1);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + radius * 0.5;
      const t = x / radius;
      // taper, twist and a little sweep
      const z = p.getZ(i) * (1.1 - 0.65 * t * t) + radius * 0.07 * Math.sin(t * 2.4);
      const tw = (0.42 - 0.3 * t) * (p.getZ(i) > 0 ? 1 : -1) * radius * 0.07;
      p.setXYZ(i, x, p.getY(i) + tw, z);
    }
    g.computeVertexNormals();
    g.rotateY((b / blades) * Math.PI * 2);
    parts.push(g);
  }
  // merge by hand: tiny meshes, not worth importing the utility
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (const g of parts) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(n.getX(i), n.getY(i), n.getZ(i));
    }
    const ix = g.getIndex()!;
    for (let i = 0; i < ix.count; i++) idx.push(base + ix.getX(i));
    base += p.count;
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
  out.setIndex(idx);
  return out;
}

/**
 * A procedurally built quad matching a DroneConfig: carbon plates and arms, motors, props that
 * turn into a blur disc as they spin up, battery, FPV and action cameras, antenna and LEDs.
 */
export class DroneModel {
  readonly group = new Group();
  private props: { hub: Group; blades: Mesh; disc: Mesh; spin: number }[] = [];
  private materials: Material[] = [];
  private bladeMat: MeshStandardMaterial;
  private discMat: MeshStandardMaterial;
  private led: MeshStandardMaterial;

  constructor(readonly cfg: DroneConfig, forge: TextureForge, private ghost = false) {
    const accent = new Color(cfg.visual.accent);
    const mk = (m: MeshStandardMaterial): MeshStandardMaterial => {
      if (ghost) {
        m.transparent = true;
        m.opacity = 0.28;
        m.depthWrite = false;
        m.emissive = accent.clone();
        m.emissiveIntensity = 0.6;
      }
      this.materials.push(m);
      return m;
    };
    const cf = forge.get('carbon');
    const carbon = mk(new MeshStandardMaterial({ map: cf.map, normalMap: cf.normalMap, roughnessMap: cf.orm, roughness: 1, metalness: 0.1, normalScale: new Vector2(0.6, 0.6) }));
    const alu = mk(new MeshStandardMaterial({ color: accent, roughness: 0.32, metalness: 1 }));
    const steel = mk(new MeshStandardMaterial({ color: 0x8e9196, roughness: 0.3, metalness: 1 }));
    const black = mk(new MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.55, metalness: 0.1 }));
    const rubber = mk(new MeshStandardMaterial({ color: 0x18181a, roughness: 0.9 }));
    const pcb = mk(new MeshStandardMaterial({ color: 0x0f2b1c, roughness: 0.6 }));
    const lens = mk(new MeshStandardMaterial({ color: 0x05070a, roughness: 0.08, metalness: 0.4 }));
    const wrap = mk(new MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.45 }));
    const label = mk(new MeshStandardMaterial({ color: accent, roughness: 0.5 }));
    this.led = mk(new MeshStandardMaterial({ color: 0x000000, emissive: accent, emissiveIntensity: 6 }));
    this.bladeMat = mk(new MeshStandardMaterial({ color: accent.clone().multiplyScalar(0.55), roughness: 0.35, transparent: true, opacity: ghost ? 0.25 : 1 }));
    this.discMat = mk(
      new MeshStandardMaterial({ color: accent.clone().lerp(new Color(0xffffff), 0.55), map: propBlurTexture(cfg.blades), transparent: true, opacity: 0, side: DoubleSide, depthWrite: false, roughness: 0.4 }),
    );

    const add = (geo: BufferGeometry, mat: Material, x = 0, y = 0, z = 0, parent: Group = this.group): Mesh => {
      const m = new Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = !ghost;
      m.receiveShadow = !ghost;
      parent.add(m);
      return m;
    };

    const ax = cfg.armX;
    const az = cfg.armZ;
    const R = cfg.propRadius;
    const whoop = cfg.visual.frame === 'whoop';
    const k = whoop ? 0.3 : cfg.visual.frame === 'cinewhoop' ? 0.72 : 1; // overall part scale
    const bottom = -cfg.collider.body[1];
    const plateT = 0.004 * k + 0.0008;
    const stack = (whoop ? 0.012 : 0.026) * (whoop ? 1 : k);
    const bodyW = (cfg.visual.frame === 'race' ? 0.034 : 0.044) * k + (whoop ? 0.012 : 0);
    const bodyL = (cfg.visual.frame === 'race' ? 0.15 : 0.165) * k + (whoop ? 0.02 : 0);

    // plates and standoffs
    add(new BoxGeometry(bodyW, plateT, bodyL), carbon, 0, bottom + plateT / 2, 0);
    if (!whoop) {
      add(new BoxGeometry(bodyW, plateT * 0.8, bodyL * 0.94), carbon, 0, bottom + stack + plateT, 0);
      for (const sx of [-1, 1]) {
        for (const fz of [-0.42, 0, 0.42]) {
          add(new CylinderGeometry(0.0028 * k, 0.0028 * k, stack, 8), alu, sx * (bodyW / 2 - 0.004 * k), bottom + plateT + stack / 2, fz * bodyL);
        }
      }
      // flight stack
      add(new BoxGeometry(bodyW * 0.72, 0.004 * k, bodyW * 0.72), pcb, 0, bottom + plateT + 0.006 * k, 0.01 * k);
      add(new BoxGeometry(bodyW * 0.72, 0.005 * k, bodyW * 0.72), black, 0, bottom + plateT + 0.014 * k, 0.01 * k);
    }

    // arms
    for (const m of MOTOR_LAYOUT) {
      const len = Math.hypot(ax, az);
      const arm = add(new BoxGeometry(0.013 * k + 0.002, plateT * 1.25, len), carbon, (m.sx * ax) / 2, bottom + plateT * 0.6, (m.sz * az) / 2);
      arm.rotation.y = Math.atan2(m.sx * ax, m.sz * az);
    }

    // motors and props
    const motorR = whoop ? 0.0045 : 0.0145 * k;
    const motorH = whoop ? 0.008 : 0.02 * k;
    const propY = bottom + plateT + motorH + 0.004 * k;
    const blades = bladeGeometry(R, cfg.blades);
    for (const m of MOTOR_LAYOUT) {
      const x = m.sx * ax;
      const z = m.sz * az;
      add(new CylinderGeometry(motorR * 0.95, motorR * 0.95, motorH * 0.42, 16), black, x, bottom + plateT + motorH * 0.21, z);
      add(new CylinderGeometry(motorR, motorR, motorH * 0.56, 20), m.spin > 0 ? alu : steel, x, bottom + plateT + motorH * 0.7, z);
      add(new CylinderGeometry(motorR * 0.3, motorR * 0.3, 0.006 * k + 0.002, 8), steel, x, propY + 0.002, z);
      if (!whoop) add(new CylinderGeometry(0.012 * k, 0.014 * k, 0.004 * k, 10), rubber, x, bottom - 0.002 * k, z);
      const hub = new Group();
      hub.position.set(x, propY, z);
      this.group.add(hub);
      const bl = add(blades, this.bladeMat, 0, 0, 0, hub);
      bl.scale.z = m.spin; // mirror the blade pitch for the opposite rotation
      const disc = new Mesh(new CircleGeometry(R, 32), this.discMat);
      disc.rotation.x = -Math.PI / 2;
      disc.renderOrder = 5;
      hub.add(disc);
      this.props.push({ hub, blades: bl, disc, spin: m.spin });

      if (cfg.ducted) {
        // duct: a thin airfoil ring swept around the prop
        const h = R * 0.62;
        const pts = [new Vector2(R * 1.04, -h * 0.5), new Vector2(R * 1.1, -h * 0.1), new Vector2(R * 1.14, h * 0.5), new Vector2(R * 1.06, h * 0.5), new Vector2(R * 1.03, 0), new Vector2(R * 1.04, -h * 0.5)];
        add(new LatheGeometry(pts, 28), whoop ? label : black, x, propY - h * 0.1, z);
        for (let s = 0; s < 3; s++) {
          const strut = add(new BoxGeometry(R * 1.05, 0.0018 * (whoop ? 0.6 : 1), 0.004 * (whoop ? 0.5 : 1)), black, x, propY - h * 0.42, z);
          strut.rotation.y = (s / 3) * Math.PI + 0.4;
        }
      }
    }

    const tilt = cfg.camTilt * DEG;
    if (whoop) {
      // canopy
      const can = add(new SphereGeometry(0.014, 16, 10), label, 0, bottom + 0.012, -0.002);
      can.scale.set(1, 0.8, 1.35);
      const cam = add(new CylinderGeometry(0.004, 0.004, 0.006, 10), lens, 0, bottom + 0.014, -0.019);
      cam.rotation.x = Math.PI / 2 + tilt;
      add(new BoxGeometry(0.011, 0.006, 0.03), wrap, 0, bottom - 0.004, 0.002);
    } else {
      // battery on top, strapped down
      const bw = 0.036 * k;
      const bh = 0.034 * k;
      const bl2 = 0.078 * k;
      const top = bottom + stack + plateT * 2;
      add(new BoxGeometry(bw, bh, bl2), wrap, 0, top + bh / 2, 0.012 * k);
      add(new BoxGeometry(bw + 0.001, bh * 0.5, bl2 * 0.5), label, 0, top + bh / 2, 0.012 * k);
      add(new BoxGeometry(bw + 0.004, bh + 0.003, 0.016 * k), rubber, 0, top + bh / 2, 0.012 * k);
      // FPV camera between the plates, tilted up
      const camG = new Group();
      camG.position.set(0, bottom + plateT + stack * 0.55, -bodyL / 2 - 0.004 * k);
      camG.rotation.x = tilt;
      this.group.add(camG);
      add(new BoxGeometry(0.019 * k, 0.019 * k, 0.016 * k), black, 0, 0, 0, camG);
      const l = add(new CylinderGeometry(0.0075 * k, 0.0075 * k, 0.012 * k, 14), lens, 0, 0, -0.012 * k, camG);
      l.rotation.x = Math.PI / 2;
      for (const sx of [-1, 1]) add(new BoxGeometry(0.002, stack * 1.05, 0.03 * k), carbon, sx * (bodyW / 2 - 0.001), bottom + plateT + stack / 2, -bodyL / 2 + 0.006);
      // action camera
      if (cfg.visual.frame !== 'race') {
        const ac = new Group();
        ac.position.set(0, top + 0.02 * k, -bodyL / 2 + 0.018 * k);
        ac.rotation.x = tilt * 0.9;
        this.group.add(ac);
        add(new BoxGeometry(0.04 * k, 0.03 * k, 0.026 * k), mk(new MeshStandardMaterial({ color: 0x2c2e33, roughness: 0.5 })), 0, 0, 0, ac);
        const al = add(new CylinderGeometry(0.01 * k, 0.01 * k, 0.008 * k, 16), lens, 0.008 * k, 0.002 * k, -0.016 * k, ac);
        al.rotation.x = Math.PI / 2;
      }
      // antenna and rear LEDs
      const ant = add(new CylinderGeometry(0.0012, 0.0012, 0.07 * k, 6), black, 0, top + 0.02 * k, bodyL / 2 + 0.012 * k);
      ant.rotation.x = -0.5;
      add(new SphereGeometry(0.006 * k, 10, 8), black, 0, top + 0.05 * k, bodyL / 2 + 0.03 * k);
      add(new BoxGeometry(bodyW * 0.8, 0.004 * k, 0.003), this.led, 0, bottom + plateT + stack * 0.5, bodyL / 2 + 0.002);
    }
    if (ghost) this.group.traverse((o) => ((o as Mesh).renderOrder = 6));
  }

  /** Pose the props for the current rotor state. */
  update(propAngle: ArrayLike<number>, omega: ArrayLike<number>, maxOmega: number): void {
    let mean = 0;
    for (let i = 0; i < 4; i++) {
      const p = this.props[i];
      const frac = Math.min(1, Math.abs(omega[i]) / maxOmega);
      mean += frac;
      p.hub.rotation.y = propAngle[i];
      // the disc turns slowly, like the aliasing you see on camera
      p.disc.rotation.z = propAngle[i] * 0.013 * p.spin;
    }
    mean /= 4;
    const blur = Math.min(1, Math.max(0, (mean - 0.035) / 0.1));
    this.bladeMat.opacity = Math.max(0.0, 1 - blur) * (this.ghost ? 0.25 : 1);
    for (const p of this.props) p.blades.visible = blur < 0.98;
    this.discMat.opacity = blur * (this.ghost ? 0.3 : 0.85);
    for (const p of this.props) p.disc.visible = blur > 0.01;
  }

  setArmed(armed: boolean): void {
    this.led.emissiveIntensity = armed ? 9 : 2.5;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const m of this.materials) {
      const map = (m as MeshStandardMaterial).map;
      if (map && map instanceof CanvasTexture) map.dispose();
      m.dispose();
    }
  }
}
