import {
  ACESFilmicToneMapping, AmbientLight, BoxGeometry, BufferGeometry, CanvasTexture, CircleGeometry,
  Color, CylinderGeometry, DirectionalLight, DoubleSide, ExtrudeGeometry,
  Fog, Group, HemisphereLight, Line, LineBasicMaterial, Mesh, MeshBasicMaterial,
  MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry,
  PMREMGenerator, RingGeometry, Scene, Shape, ShapeGeometry, SRGBColorSpace,
  TorusGeometry, Vector3, WebGLRenderer, PCFSoftShadowMap, Texture, Material,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PHONE, CAMERA, MAX_FRAGMENTS } from './config';
import { renderQuality, type RenderQuality } from './quality';
import { deviceClock } from './clock';
import { ScreenTexture } from './screenTexture';
import { FoldScreenMaterial, followScreen, screenTarget } from './screenEffect';
import type { Object3D } from 'three';
import type { BodyPose, ContactMaterial, DamageState, FeedbackEvent, FragmentPose, Grip, HalfId, PhysicsSample, RetiredPhone } from './types';

const { width: W, height: H, thickness: T } = PHONE;
const FRONT = T / 2;

function panelShape(w: number, h: number, outer: number, inner = outer, half?: HalfId): Shape {
  const l = -w / 2, r = w / 2, b = -h / 2, t = h / 2;
  const rl = half === 1 ? inner : outer;
  const rr = half === 0 ? inner : outer;
  return new Shape().moveTo(l + rl, b).lineTo(r - rr, b)
    .quadraticCurveTo(r, b, r, b + rr).lineTo(r, t - rr)
    .quadraticCurveTo(r, t, r - rr, t).lineTo(l + rl, t)
    .quadraticCurveTo(l, t, l, t - rl).lineTo(l, b + rl)
    .quadraticCurveTo(l, b, l + rl, b);
}

function surface(w: number, h: number, half?: HalfId, wallpaper = false, xOffset = 0): ShapeGeometry {
  const geometry = new ShapeGeometry(panelShape(w, h, PHONE.cornerRadius - .008, .0015, half), 22);
  const p = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) / w + .5;
    const continuousU = (p.getX(i) + xOffset + ((half ?? 0) === 0 ? W / 2 : W * 1.5)) / (W * 2);
    uv.setXY(i, wallpaper ? continuousU : u, p.getY(i) / h + .5);
  }
  return geometry;
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  draw(canvas.getContext('2d')!);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}


function seeded(seed: number): () => number {
  let v = seed;
  return () => { v = (v * 1664525 + 1013904223) >>> 0; return v / 4294967296; };
}

function tableReferenceTexture(): CanvasTexture {
  return canvasTexture(1024, 1024, ctx => {
    const unit = 1024 / 4.4;
    const x = unit * .2, y = unit * .45, w = unit * 4, h = unit * 3.5;
    ctx.fillStyle = '#cbd2d82e';
    ctx.beginPath(); ctx.roundRect(x, y, w, h, unit * .15); ctx.fill();
    ctx.save(); ctx.clip();
    // Etched half-unit marks give a fixed depth reference without competing with the phone.
    ctx.strokeStyle = '#75828e13'; ctx.lineWidth = .8;
    for (let mark = -4; mark <= 4; mark++) {
      const p = 512 + mark * unit * .5;
      ctx.beginPath(); ctx.moveTo(p, y); ctx.lineTo(p, y + h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, p); ctx.lineTo(x + w, p); ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#8c98a43b'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, unit * .15); ctx.stroke();
    ctx.strokeStyle = '#73808b38'; ctx.lineWidth = 1.6;
    for (const px of [x + unit * .2, x + w - unit * .2]) {
      for (const py of [y + unit * .2, y + h - unit * .2]) {
        ctx.beginPath(); ctx.moveTo(px - unit * .035, py); ctx.lineTo(px + unit * .035, py);
        ctx.moveTo(px, py - unit * .035); ctx.lineTo(px, py + unit * .035); ctx.stroke();
      }
    }
  });
}

function crackTexture(half: HalfId): CanvasTexture {
  return canvasTexture(512, 1024, ctx => {
    const random = seeded(3192 + half * 37);
    const cx = half ? 357 : 121, cy = half ? 630 : 410;
    ctx.lineCap = 'round';
    for (let ray = 0; ray < 18; ray++) {
      let x = cx, y = cy;
      const a = ray * Math.PI * 2 / 18 + random() * .2;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let j = 0; j < 10; j++) {
        x += Math.cos(a) * (22 + random() * 50) + (random() - .5) * 20;
        y += Math.sin(a) * (36 + random() * 70) + (random() - .5) * 32;
        ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#041522b3'; ctx.lineWidth = 3.2; ctx.stroke();
      ctx.strokeStyle = '#d2ffffba'; ctx.lineWidth = .85; ctx.stroke();
    }
    for (let i = 0; i < 6; i++) {
      ctx.strokeStyle = '#c4f3f37a'; ctx.lineWidth = .6;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 18 + i * 20, 24 + i * 30, .6, 0, Math.PI * 2); ctx.stroke();
    }
  });
}

interface ScreenParts {
  material: FoldScreenMaterial;
  cracks: MeshBasicMaterial;
  glitch: MeshBasicMaterial;
  tear: Group;
  outer: boolean;
  power: number;
  frost: number;
}

interface ArchivedView {
  root: Group;
  halves: [Group, Group];
  hinge: Group;
  screens: ScreenParts[];
  materials: Set<Material>;
  pickables: Mesh[];
  source: RetiredPhone;
  angle: number;
}

interface ContactEffect {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  remaining: number;
  duration: number;
  size: number;
}

export class DuoView {
  public readonly camera = new PerspectiveCamera(33, 1, .05, 80);
  public readonly halves: [Group, Group] = [new Group(), new Group()];
  public readonly pickables: Mesh[] = [];
  public readonly scene = new Scene();
  private readonly renderer: WebGLRenderer;
  private readonly keyLight: DirectionalLight;
  private currentQuality: RenderQuality;
  private readonly screens: ScreenParts[] = [];
  private readonly activePickables: Mesh[] = [];
  private readonly archives = new Map<number, ArchivedView>();
  private readonly contactEffects: ContactEffect[] = [];
  private readonly effectContacts = new Map<number, number>();
  private readonly fragmentMaterials: Record<ContactMaterial, MeshPhysicalMaterial>;
  private readonly fragmentMeshes: Mesh[] = [];
  private readonly gripRings: Mesh<RingGeometry, MeshBasicMaterial>[] = [];
  private readonly gripLines: Line<BufferGeometry, LineBasicMaterial>[] = [];
  private readonly hinge = new Group();
  private readonly shadow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly environment: Texture;
  private readonly wallpaper: ScreenTexture;
  private readonly coverWallpaper: ScreenTexture;
  private health = 100;
  private broken = false;
  private fold = 180;
  private load = 0;
  private displayInitialized = false;
  private lastRenderTime: number | null = null;
  private readonly worldPoint = new Vector3();
  private readonly target = new Vector3(0, .25, 0);

  get quality(): Readonly<RenderQuality> { return this.currentQuality; }

  constructor(public readonly canvas: HTMLCanvasElement) {
    this.currentQuality = this.chooseQuality(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.currentQuality.pixelRatio);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.14;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.scene.background = new Color('#f4f5f7');
    this.scene.fog = new Fog('#f4f5f7', 14, 30);
    const pmrem = new PMREMGenerator(this.renderer);
    const studio = new RoomEnvironment();
    this.environment = pmrem.fromScene(studio, .04).texture;
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = .85;
    studio.dispose(); pmrem.dispose();

    this.scene.add(new HemisphereLight('#f2f8ff', '#afb7bd', 2.1), new AmbientLight('#ffffff', .3));
    const key = new DirectionalLight('#fffaf2', 3.8);
    this.keyLight = key;
    key.position.set(-3.5, 7.5, 3.5);
    key.castShadow = true;
    key.shadow.mapSize.set(this.currentQuality.shadowMapSize, this.currentQuality.shadowMapSize);
    key.shadow.camera.left = -4; key.shadow.camera.right = 4;
    key.shadow.camera.top = 4; key.shadow.camera.bottom = -4;
    key.shadow.camera.near = .5; key.shadow.camera.far = 16;
    key.shadow.normalBias = .012; key.shadow.bias = -.00025;
    key.shadow.radius = 3;
    this.scene.add(key);
    const rim = new DirectionalLight('#d5e7ff', 1.9);
    rim.position.set(4, 2.5, -4); this.scene.add(rim);

    const floor = new Mesh(new PlaneGeometry(100, 100), new MeshStandardMaterial({ color: '#f4f5f7', roughness: .92, metalness: .03 }));
    floor.name = 'floor';
    floor.rotation.x = -Math.PI / 2; floor.position.y = 0; floor.receiveShadow = true;
    this.scene.add(floor);
    // A flush printed surface, aligned with the physical floor rather than a raised display plinth.
    const tableReference = new Mesh(new PlaneGeometry(4.4, 4.4), new MeshBasicMaterial({
      map: tableReferenceTexture(), transparent: true, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    tableReference.name = 'table-reference';
    tableReference.rotation.x = -Math.PI / 2;
    tableReference.position.y = .0002;
    this.scene.add(tableReference);
    const shadowMap = canvasTexture(128, 128, ctx => {
      const g = ctx.createRadialGradient(64, 64, 3, 64, 64, 64);
      g.addColorStop(0, '#26343b55'); g.addColorStop(.35, '#26343b2e'); g.addColorStop(1, '#26343b00');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    });
    this.shadow = new Mesh(new PlaneGeometry(2.8, 2.6), new MeshBasicMaterial({ map: shadowMap, transparent: true, depthWrite: false, opacity: .6 }));
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.y = .0005;
    this.scene.add(this.shadow);

    const clock = deviceClock();
    this.wallpaper = new ScreenTexture(false, clock);
    this.coverWallpaper = new ScreenTexture(true, clock);
    this.buildHalf(0); this.buildHalf(1);
    this.buildHinge();
    this.scene.add(...this.halves);
    this.activePickables.push(...this.pickables);

    this.fragmentMaterials = {
      glass: new MeshPhysicalMaterial({ color: '#23343e', metalness: .15, roughness: .28, clearcoat: 1 }),
      metal: new MeshPhysicalMaterial({ color: '#bfc5c7', metalness: .94, roughness: .24, clearcoat: .3 }),
      back: new MeshPhysicalMaterial({ color: '#e8e7df', metalness: .035, roughness: .62, clearcoat: .2 }),
    };
    const shardGeometry = new BoxGeometry(1, 1, 1);
    for (let i = 0; i < MAX_FRAGMENTS; i++) {
      const fragment = new Mesh(shardGeometry, this.fragmentMaterials.glass);
      fragment.scale.set(.05, .07, .012);
      fragment.visible = false; fragment.castShadow = true;
      this.fragmentMeshes.push(fragment); this.scene.add(fragment);
    }
    const contactMap = canvasTexture(64, 64, ctx => {
      const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
      gradient.addColorStop(0, '#59615f70'); gradient.addColorStop(.38, '#59615f2a'); gradient.addColorStop(1, '#59615f00');
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
    });
    const contactGeometry = new PlaneGeometry(1, 1);
    for (let i = 0; i < 6; i++) {
      const mesh = new Mesh(contactGeometry, new MeshBasicMaterial({ map: contactMap, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
      mesh.name = `contact-feedback-${i}`; mesh.rotation.x = -Math.PI / 2; mesh.visible = false;
      this.contactEffects.push({ mesh, remaining: 0, duration: .18, size: .1 }); this.scene.add(mesh);
    }
    for (let i = 0; i < 2; i++) {
      const ring = new Mesh(new RingGeometry(.042, .051, 40), new MeshBasicMaterial({ color: '#4caca4', transparent: true, opacity: .8, side: DoubleSide, depthTest: false, depthWrite: false }));
      ring.renderOrder = 30; ring.visible = false;
      const line = new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]), new LineBasicMaterial({ color: '#469f9c', transparent: true, opacity: .3, depthTest: false, depthWrite: false }));
      line.renderOrder = 29; line.visible = false;
      this.gripRings.push(ring); this.gripLines.push(line); this.scene.add(ring, line);
    }
    this.camera.position.set(3.0, 4.5, 5.8);
    this.camera.lookAt(this.target);
    this.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  }

  private solid(half: HalfId, geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0, inner = false): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.half = half; mesh.userData.inner = inner;
    this.halves[half].add(mesh); this.pickables.push(mesh);
    return mesh;
  }

  private buildHalf(half: HalfId): void {
    this.halves[half].name = `phone-half-${half}`;
    const silver = new MeshStandardMaterial({ color: '#c5c7c6', metalness: 1, roughness: .145, envMapIntensity: 1.15 });
    const body = new ExtrudeGeometry(panelShape(W - .012, H - .012, PHONE.cornerRadius - .006, .006, half), { depth: T - .012, steps: 1, bevelEnabled: true, bevelSize: .006, bevelThickness: .006, bevelSegments: 5, curveSegments: 24 });
    body.translate(0, 0, -T / 2 + .006);
    this.solid(half, body, silver).name = `titanium-frame-${half}`;
    const ceramic = new MeshPhysicalMaterial({ color: '#f3f2ed', roughness: .24, metalness: .035, clearcoat: .8, clearcoatRoughness: .18 });
    const back = this.solid(half, surface(W - .014, H - .014, half === 0 ? 1 : 0), ceramic, 0, 0, -FRONT - .0004);
    back.rotation.y = Math.PI; back.name = `ceramic-back-${half}`;

    const tear = new Group();
    for (let j = 0; j < 5; j++) {
      const wire = new Mesh(new CylinderGeometry(.0018, .0018, .035 + (j % 2) * .01, 5), new MeshStandardMaterial({ color: j % 2 ? '#ae723b' : '#383b3f', roughness: .65, metalness: .65 }));
      wire.position.set((half ? -1 : 1) * (W / 2 + .002), (j - 2) * .012, .009);
      wire.rotation.z = (half ? -1 : 1) * (1.0 + j * .08); tear.add(wire);
    }
    tear.visible = false; this.halves[half].add(tear);

    const screenX = half === 0 ? .006 : -.006;
    const innerBezel = this.solid(half, surface(W - .004, H - .006, half), new MeshStandardMaterial({ color: '#14171a', roughness: .27, metalness: .45 }), (half ? -1 : 1) * .001, 0, FRONT + .0004);
    innerBezel.name = `inner-bezel-${half}`;
    this.addScreen(half, surface(W - .014, H - .026, half, true, screenX), this.wallpaper, screenX, FRONT + .0013, false, tear);
    const crease = new Mesh(new PlaneGeometry(.0015, H - .03), new MeshBasicMaterial({ color: '#887b66', transparent: true, opacity: .24, depthWrite: false }));
    crease.position.set((half ? -1 : 1) * (W / 2 - .00075), 0, FRONT + .0017); this.halves[half].add(crease);

    if (half === 1) {
      const bezel = this.solid(half, surface(W - .006, H - .006), new MeshStandardMaterial({ color: '#101418', roughness: .19, metalness: .5 }), 0, 0, -FRONT - .0008);
      bezel.rotation.y = Math.PI; bezel.name = 'outer-bezel';
      this.addScreen(half, surface(W - .029, H - .029), this.coverWallpaper, 0, -FRONT - .0021, true, tear);
      const pill = this.solid(half, new ShapeGeometry(panelShape(.028, .078, .014)), new MeshBasicMaterial({ color: '#010407' }), -W * .365, H * .386, -FRONT - .0037);
      pill.rotation.y = Math.PI; pill.name = 'outer-front-camera';
      const lens = this.solid(half, new CircleGeometry(.0053, 18), new MeshBasicMaterial({ color: '#172434' }), -W * .365, H * .397, -FRONT - .0039);
      lens.rotation.y = Math.PI;
    }

    const outside = half ? 1 : -1;
    const buttonMat = new MeshStandardMaterial({ color: '#c0c3c3', roughness: .16, metalness: 1 });
    for (let n = 0; n < (half ? 1 : 2); n++) {
      const buttonGeo = new ExtrudeGeometry(panelShape(.009, H * (n ? .12 : .15), .0045), { depth: .007, bevelEnabled: false });
      const button = this.solid(half, buttonGeo, buttonMat, outside * (W / 2 - .001), H * (.1 + n * .21), -.002);
      button.rotation.y = outside * Math.PI / 2;
    }
    const slotMat = new MeshStandardMaterial({ color: '#28323b', roughness: .9 });
    for (const end of [-1, 1]) for (let j = 0; j < 7; j++) {
      this.solid(half, new CylinderGeometry(.0027, .0027, .0015, 8), slotMat, (j - 3) * W * .022 + (half ? -.18 : .18), end * (H / 2 + .0002), 0);
    }
    const port = this.solid(half, new ShapeGeometry(panelShape(.075, .011, .0055)), slotMat, 0, -H / 2 - .0006, 0);
    port.rotation.x = Math.PI / 2;
    for (const y of [-H * .39, H * .39]) {
      const antenna = this.solid(half, new PlaneGeometry(.0045, T * .68), new MeshBasicMaterial({ color: '#7d8589' }), outside * (W / 2 + .0001), y, 0);
      antenna.rotation.y = outside * Math.PI / 2;
    }
    if (!half) { this.buildCameras(half); this.buildMark(half); }
  }

  private addScreen(half: HalfId, geometry: ShapeGeometry, map: ScreenTexture, x: number, z: number, outer: boolean, tear: Group): void {
    const material = new FoldScreenMaterial(map.sharp, map.blurred, outer);
    const mesh = this.solid(half, geometry, material, x, 0, z, !outer);
    mesh.name = outer ? 'outer-screen' : `inner-screen-${half}`;
    if (outer) mesh.rotation.y = Math.PI;
    const crackMat = new MeshBasicMaterial({ map: crackTexture(half), transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    const cracks = new Mesh(surface(outer ? W - .029 : W - .014, outer ? H - .029 : H - .026, outer ? undefined : half), crackMat);
    cracks.position.set(x, 0, z + (outer ? -.0008 : .0008)); cracks.renderOrder = 4;
    if (outer) cracks.rotation.y = Math.PI;
    this.halves[half].add(cracks);
    const glitchMap = canvasTexture(128, 256, ctx => {
      const random = seeded(half + 491);
      for (let j = 0; j < 18; j++) {
        ctx.fillStyle = ['#2dffc0d0', '#6578ffbd', '#f179f3cc', '#101c2fe6'][j % 4];
        ctx.fillRect(random() * 128, 0, 1 + random() * 6, 256);
      }
      ctx.fillStyle = '#02060b'; ctx.fillRect(half ? 78 : 0, 0, 50, 256);
    });
    const glitchMat = new MeshBasicMaterial({ map: glitchMap, transparent: true, opacity: 0, depthWrite: false });
    const glitch = new Mesh(cracks.geometry, glitchMat);
    glitch.position.set(x, 0, z + (outer ? -.001 : .001)); glitch.renderOrder = 3;
    if (outer) glitch.rotation.y = Math.PI;
    this.halves[half].add(glitch);
    this.screens.push({ material, cracks: crackMat, glitch: glitchMat, tear, outer, power: 1, frost: 0 });
  }

  private buildMark(half: HalfId): void {
    const mark = canvasTexture(512, 512, ctx => {
      ctx.translate(248, 266); ctx.scale(1.1, 1.1); ctx.fillStyle = '#d9d8d3';
      ctx.beginPath(); ctx.moveTo(0, -91);
      ctx.bezierCurveTo(-42, -113, -96, -106, -123, -60);
      ctx.bezierCurveTo(-158, 10, -115, 125, -64, 150);
      ctx.bezierCurveTo(-31, 166, -20, 146, 12, 146);
      ctx.bezierCurveTo(43, 146, 48, 167, 80, 145);
      ctx.bezierCurveTo(111, 123, 134, 77, 143, 48);
      ctx.bezierCurveTo(91, 29, 87, -31, 138, -57);
      ctx.bezierCurveTo(112, -96, 74, -111, 35, -98);
      ctx.bezierCurveTo(17, -91, 11, -85, 0, -91); ctx.fill();
      ctx.beginPath(); ctx.moveTo(14, -107);
      ctx.bezierCurveTo(11, -142, 48, -177, 80, -178);
      ctx.bezierCurveTo(81, -144, 49, -108, 14, -107); ctx.fill();
    });
    const logo = new Mesh(new PlaneGeometry(W * .24, W * .24), new MeshStandardMaterial({ map: mark, transparent: true, depthWrite: false, roughness: .5, metalness: .12 }));
    logo.position.set(0, -H * .075, -FRONT - .0013); logo.rotation.y = Math.PI;
    logo.name = 'apple-mark'; this.halves[half].add(logo);
  }

  private buildCameras(half: HalfId): void {
    const island = this.solid(half, new ExtrudeGeometry(panelShape(CAMERA.width - .008, CAMERA.height - .008, CAMERA.height * .31), { depth: CAMERA.islandDepth - .003, bevelEnabled: true, bevelSize: .004, bevelThickness: .003, bevelSegments: 4 }), new MeshPhysicalMaterial({ color: '#ecece7', metalness: .025, roughness: .28, clearcoat: .7 }), CAMERA.centerX, CAMERA.centerY, -FRONT);
    island.rotation.y = Math.PI; island.name = 'camera-island';
    const rim = new MeshStandardMaterial({ color: '#b7b9b7', roughness: .13, metalness: 1 });
    const lensMat = new MeshPhysicalMaterial({ color: '#05090f', metalness: .25, roughness: .085, clearcoat: 1, clearcoatRoughness: .025 });
    const radius = W * .111;
    for (const [index, x] of [W * .20, -W * .06].entries()) {
      const mount = this.solid(half, new CylinderGeometry(radius, radius, .018, 48), rim, x, CAMERA.centerY, -FRONT - .016); mount.rotation.x = Math.PI / 2; mount.name = `rear-lens-rim-${index}`;
      const lens = this.solid(half, new CylinderGeometry(radius * .875, radius * .875, .004, 48), lensMat, x, CAMERA.centerY, -FRONT - CAMERA.lensProtrusion + .002); lens.rotation.x = Math.PI / 2; lens.name = `rear-lens-${index}`;
      const interior = this.solid(half, new CircleGeometry(radius * .34, 32), new MeshStandardMaterial({ color: '#142b3b', metalness: .65, roughness: .1 }), x, CAMERA.centerY, -FRONT - CAMERA.lensProtrusion - .0001); interior.rotation.y = Math.PI;
      const pupil = this.solid(half, new CircleGeometry(radius * .18, 24), new MeshBasicMaterial({ color: '#081118' }), x, CAMERA.centerY, -FRONT - CAMERA.lensProtrusion - .0002); pupil.rotation.y = Math.PI;
      const ring = new Mesh(new TorusGeometry(radius * .63, .0014, 6, 40), new MeshStandardMaterial({ color: '#263a50', metalness: .7, roughness: .2 }));
      ring.position.set(x, CAMERA.centerY, -FRONT - CAMERA.lensProtrusion - .0003); ring.rotation.y = Math.PI; this.halves[half].add(ring);
    }
    const flashX = -W * .30;
    const flash = this.solid(half, new CircleGeometry(.019, 24), new MeshStandardMaterial({ color: '#f9f4de', roughness: .4 }), flashX, CAMERA.centerY - CAMERA.height * .19, -FRONT - CAMERA.islandDepth - .001); flash.rotation.y = Math.PI;
    const mic = this.solid(half, new ShapeGeometry(panelShape(.018, .009, .0045)), new MeshBasicMaterial({ color: '#5d6261' }), flashX, CAMERA.centerY + CAMERA.height * .19, -FRONT - CAMERA.islandDepth - .001); mic.rotation.y = Math.PI;
  }

  private buildHinge(): void {
    const metal = new MeshStandardMaterial({ color: '#b9bdbc', metalness: 1, roughness: .18, transparent: true, opacity: 1 });
    const cover = new Mesh(new CylinderGeometry(PHONE.spineOverhang, PHONE.spineOverhang, H - .035, 40, 1, false, 0, Math.PI), metal);
    cover.scale.z = PHONE.closedThickness / 2 / PHONE.spineOverhang;
    cover.name = 'hinge-spine-shell'; cover.castShadow = true; this.hinge.add(cover);
    this.hinge.name = 'hinge-cover';
    this.hinge.position.set(W / 2 + PHONE.gap / 2, 0, PHONE.hingeZ);
    this.halves[0].add(this.hinge);
  }

  resize(width: number, height: number): void {
    width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
    const quality = this.chooseQuality(width, height);
    if (quality.pixelRatio !== this.currentQuality.pixelRatio) this.renderer.setPixelRatio(quality.pixelRatio);
    if (quality.shadowMapSize !== this.currentQuality.shadowMapSize) {
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
      this.keyLight.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    }
    this.currentQuality = quality;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    const distance = this.camera.position.distanceTo(this.target);
    const viewHeight = Math.max(3.25, 2.35 / this.camera.aspect);
    this.camera.fov = 2 * Math.atan(viewHeight / (2 * distance)) * 180 / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  private chooseQuality(width: number, height: number): RenderQuality {
    const device = navigator as Navigator & { deviceMemory?: number };
    return renderQuality({
      width, height, devicePixelRatio: window.devicePixelRatio || 1,
      coarsePointer: window.matchMedia('(pointer: coarse)').matches,
      deviceMemory: device.deviceMemory, hardwareConcurrency: device.hardwareConcurrency,
    });
  }

  private archivePhone(source: RetiredPhone): ArchivedView {
    const root = new Group(); root.name = `retired-phone-${source.id}`;
    const halves = this.halves.map(half => half.clone(true)) as [Group, Group];
    const nodes = new Map<Object3D, Object3D>();
    const materials = new Map<Material, Material>();
    const screenKinds = new Map(this.screens.map(screen => [screen.material, screen.outer]));
    const pickables: Mesh[] = [];
    for (const half of [0, 1] as const) {
      const originals: Object3D[] = [], copies: Object3D[] = [];
      this.halves[half].traverse(object => originals.push(object));
      halves[half].traverse(object => copies.push(object));
      copies.forEach((object, index) => {
        const original = originals[index]; nodes.set(original, object);
        object.name = `retired-phone-${source.id}-${original.name || index}`;
        object.userData.retired = true; object.userData.retiredId = source.id;
        if (!(object instanceof Mesh) || !(original instanceof Mesh)) return;
        const overlay = this.screens.some(screen => original.material === screen.cracks || original.material === screen.glitch);
        object.userData.archiveMajor = overlay || /^(titanium-frame|ceramic-back|inner-bezel|inner-screen|outer-bezel|outer-screen|outer-front-camera|camera-island|rear-lens|hinge-spine-shell|apple-mark)/.test(original.name);
        // The solid shell already casts the leaf silhouette; tiny ports and coplanar screens add no useful shadow.
        object.castShadow = original.castShadow && /^(titanium-frame|camera-island|rear-lens-rim|hinge-spine-shell)/.test(original.name);
        const cloneMaterial = (material: Material): Material => {
          let copy = materials.get(material);
          if (!copy) {
            if (material instanceof FoldScreenMaterial) {
              copy = new FoldScreenMaterial(material.map!, material.blurredMap, screenKinds.get(material) ?? false);
              (copy as FoldScreenMaterial).color.copy(material.color);
            } else copy = material.clone();
            materials.set(material, copy);
          }
          return copy;
        };
        object.material = Array.isArray(original.material) ? original.material.map(cloneMaterial) : cloneMaterial(original.material);
        pickables.push(object);
      });
    }
    const screens = this.screens.map(screen => ({ ...screen,
      material: materials.get(screen.material) as FoldScreenMaterial,
      cracks: materials.get(screen.cracks) as MeshBasicMaterial,
      glitch: materials.get(screen.glitch) as MeshBasicMaterial,
      tear: nodes.get(screen.tear) as Group,
    }));
    for (const screen of screens) screen.material.setFrost(screen.frost);
    root.add(...halves); this.scene.add(root);
    return { root, halves, hinge: nodes.get(this.hinge) as Group, screens,
      materials: new Set(materials.values()), pickables, source, angle: this.fold };
  }

  private applyArchiveBudget(archive: ArchivedView): void {
    for (const mesh of archive.pickables) {
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      mesh.visible = (!(this.currentQuality.mobile || this.currentQuality.tier === 'low') || mesh.userData.archiveMajor === true)
        && !(material.transparent && material.opacity < .001);
    }
  }

  private syncHinge(hinge: Group, angle: number, broken: boolean, visible: [boolean, boolean]): void {
    const coverVisibility = Math.min(1, Math.max(0, (165 - angle) / 35));
    hinge.visible = !broken && visible[0] && visible[1] && coverVisibility > 0;
    const shell = hinge.children[0] as Mesh<CylinderGeometry, MeshStandardMaterial>;
    shell.material.opacity = coverVisibility;
    shell.scale.z = (FRONT + (PHONE.closedThickness / 2 - FRONT) * (1 - Math.min(180, Math.max(0, angle)) / 180)) / PHONE.spineOverhang;
  }

  private applyScreenDamage(screens: ScreenParts[], damage: DamageState): void {
    const damageAmount = Math.max(0, (90 - damage.screen) / 90);
    for (const screen of screens) {
      screen.cracks.opacity = damageAmount * .92;
      screen.glitch.opacity = damage.screen < 40 && damage.screen > 0 ? (40 - damage.screen) / 40 * .9 : 0;
      screen.tear.visible = damage.broken;
      if (damage.screen <= 0) screen.material.color.setScalar(0);
    }
  }

  private syncArchives(retired: RetiredPhone[]): void {
    const ids = new Set(retired.map(phone => phone.id));
    for (const [id, archive] of this.archives) {
      if (ids.has(id)) continue;
      this.scene.remove(archive.root);
      archive.materials.forEach(material => material.dispose());
      this.archives.delete(id);
    }
    for (const phone of retired) {
      let archive = this.archives.get(phone.id);
      if (!archive) { archive = this.archivePhone(phone); this.archives.set(phone.id, archive); }
      archive.source = phone;
      archive.halves.forEach((half, index) => {
        half.position.copy(phone.poses[index].position); half.quaternion.copy(phone.poses[index].quaternion);
        half.visible = phone.visible[index]; half.updateMatrixWorld(true);
      });
      const n0 = new Vector3(0, 0, 1).applyQuaternion(phone.poses[0].quaternion);
      const n1 = new Vector3(0, 0, 1).applyQuaternion(phone.poses[1].quaternion);
      archive.angle = 180 - Math.acos(Math.max(-1, Math.min(1, n0.dot(n1)))) * 180 / Math.PI;
      this.applyScreenDamage(archive.screens, phone.damage);
      this.syncHinge(archive.hinge, archive.angle, phone.damage.broken, phone.visible);
      this.applyArchiveBudget(archive);
    }
  }

  sync(poses: [BodyPose, BodyPose], damage: DamageState, sample: PhysicsSample, fragments: FragmentPose[],
    retired: RetiredPhone[] = [], activeVisible: [boolean, boolean] = [true, true]): void {
    // Clone new retired phones while the previous active phone still has its own appearance.
    this.syncArchives(retired);
    for (let i = 0; i < 2; i++) {
      this.halves[i].position.copy(poses[i].position);
      this.halves[i].quaternion.copy(poses[i].quaternion);
      this.halves[i].visible = activeVisible[i];
      this.halves[i].updateMatrixWorld(true);
    }
    this.health = damage.screen; this.broken = damage.broken; this.fold = sample.angle; this.load = sample.strain;
    this.applyScreenDamage(this.screens, damage);
    if (!this.displayInitialized) this.updateDisplay(0, this.lastRenderTime ?? 0);
    this.syncHinge(this.hinge, sample.angle, damage.broken, activeVisible);
    const visiblePoses = poses.filter((_, index) => activeVisible[index]);
    this.shadow.visible = visiblePoses.length > 0;
    const meanHeight = visiblePoses.reduce((sum, pose) => sum + pose.position.y, 0) / (visiblePoses.length || 1);
    this.shadow.position.x = visiblePoses.reduce((sum, pose) => sum + pose.position.x, 0) / (visiblePoses.length || 1);
    this.shadow.position.z = visiblePoses.reduce((sum, pose) => sum + pose.position.z, 0) / (visiblePoses.length || 1);
    this.shadow.material.opacity = .58 / (1 + Math.max(0, meanHeight) * 2);
    this.shadow.scale.setScalar(1 + Math.max(0, meanHeight) * .2);
    for (let i = 0; i < MAX_FRAGMENTS; i++) {
      const mesh = this.fragmentMeshes[i]; mesh.visible = i < fragments.length;
      if (fragments[i]) {
        const fragment = fragments[i];
        mesh.position.copy(fragment.position); mesh.quaternion.copy(fragment.quaternion);
        mesh.scale.copy(fragment.size ?? new Vector3(.05, .07, .012));
        mesh.material = this.fragmentMaterials[fragment.material ?? 'glass'];
        mesh.name = `fragment-${fragment.id ?? i}`;
        mesh.userData.generation = fragment.generation ?? 0;
      }
    }
    this.pickables.length = 0;
    this.pickables.push(...this.activePickables.filter(mesh => activeVisible[mesh.userData.half as HalfId]));
    for (const archive of this.archives.values()) archive.root.traverseVisible(object => {
      if (object instanceof Mesh) this.pickables.push(object);
    });
    this.scene.updateMatrixWorld(true);
  }

  render(time: number, grips: Iterable<Grip>): void {
    this.refreshClock();
    const dt = this.lastRenderTime === null ? 0 : Math.max(0, time - this.lastRenderTime);
    this.lastRenderTime = time;
    this.updateDisplay(dt, time);
    for (const archive of this.archives.values()) {
      this.animateScreens(archive.screens, archive.source.damage.screen, archive.source.damage.broken, archive.angle, true, dt, time);
    }
    for (const effect of this.contactEffects) {
      effect.remaining = Math.max(0, effect.remaining - dt);
      effect.mesh.visible = effect.remaining > 0;
      const progress = 1 - effect.remaining / effect.duration;
      effect.mesh.material.opacity = .16 * (1 - progress) * (1 - progress);
      effect.mesh.scale.setScalar(effect.size * (1 + progress * .22));
    }
    let i = 0;
    for (const grip of grips) {
      if (i >= 2) break;
      this.worldPoint.copy(grip.localPoint); this.halves[grip.half].localToWorld(this.worldPoint);
      const ring = this.gripRings[i]; ring.visible = true; ring.position.copy(this.worldPoint); ring.quaternion.copy(this.camera.quaternion);
      const stretch = this.worldPoint.distanceTo(grip.target);
      const stress = Math.max(this.load, stretch * .7);
      const color = stress > 1 ? '#c76e53' : stress > .65 ? '#ad935a' : '#4c9a8b';
      ring.material.color.set(color);
      ring.scale.setScalar(1 + Math.min(.08, stretch * .05));
      this.gripLines[i].material.color.set(color);
      this.gripLines[i].material.opacity = .15 + Math.min(.23, stretch * .15);
      const positions = this.gripLines[i].geometry.attributes.position;
      positions.setXYZ(0, this.worldPoint.x, this.worldPoint.y, this.worldPoint.z);
      positions.setXYZ(1, grip.target.x, grip.target.y, grip.target.z);
      positions.needsUpdate = true; this.gripLines[i].geometry.computeBoundingSphere(); this.gripLines[i].visible = true;
      i++;
    }
    for (; i < 2; i++) { this.gripRings[i].visible = false; this.gripLines[i].visible = false; }
    this.renderer.render(this.scene, this.camera);
  }

  resetDisplay(): void {
    this.displayInitialized = false;
    this.lastRenderTime = null;
  }

  feedback(event: FeedbackEvent): void {
    if (!event.table || !event.point || (event.kind !== 'impact' && event.kind !== 'chip') || event.strength < .25) return;
    if (!Number.isFinite(event.point.x + event.point.y + event.point.z) || Math.abs(event.point.y) > .1) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const now = performance.now();
    if (event.contactId !== undefined && now - (this.effectContacts.get(event.contactId) ?? -Infinity) < 120) return;
    if (event.contactId !== undefined) this.effectContacts.set(event.contactId, now);
    for (const [id, at] of this.effectContacts) if (now - at > 1500) this.effectContacts.delete(id);
    const effect = this.contactEffects.find(entry => entry.remaining <= 0)
      ?? this.contactEffects.reduce((oldest, entry) => entry.remaining < oldest.remaining ? entry : oldest);
    effect.duration = event.kind === 'chip' ? .15 : .19;
    effect.remaining = effect.duration;
    effect.size = (event.kind === 'chip' ? .055 : .09) + Math.min(1, Math.max(0, event.strength)) * .12;
    effect.mesh.position.set(event.point.x, .0012, event.point.z);
    effect.mesh.scale.setScalar(effect.size);
    effect.mesh.material.opacity = .16;
    effect.mesh.visible = true;
  }

  clearFeedback(): void {
    for (const effect of this.contactEffects) { effect.remaining = 0; effect.mesh.visible = false; }
    this.effectContacts.clear();
  }

  private refreshClock(): void {
    const clock = deviceClock();
    this.wallpaper.refresh(clock);
    this.coverWallpaper.refresh(clock);
  }

  private updateDisplay(dt: number, time: number): void {
    this.animateScreens(this.screens, this.health, this.broken, this.fold, this.displayInitialized, dt, time);
    this.displayInitialized = true;
  }

  private animateScreens(screens: ScreenParts[], health: number, broken: boolean, fold: number, initialized: boolean, dt: number, time: number): void {
    const flicker = health > 0 && health < 25 ? (Math.sin(time * 71) > .88 ? .15 : .8) : 1;
    for (const screen of screens) {
      const target = screenTarget(fold, screen.outer, broken);
      const state = initialized ? followScreen(screen, target, dt) : target;
      screen.power = state.power;
      screen.frost = state.frost;
      screen.material.setFrost(screen.frost);
      // Compose damage and the handoff once, so a glass transition cannot revive a failed display.
      screen.material.color.setScalar(health <= 0 ? 0 : screen.power * flicker);
    }
  }

  capture(): string {
    this.refreshClock();
    const feedback = [...this.gripRings, ...this.gripLines, ...this.contactEffects.map(effect => effect.mesh)];
    const visibility = feedback.map(object => object.visible);
    feedback.forEach(object => object.visible = false);
    this.renderer.render(this.scene, this.camera);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const p = new Vector3();
    for (const half of this.halves) {
      half.traverseVisible(object => {
        if (!(object instanceof Mesh)) return;
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        const bounds = object.geometry.boundingBox;
        if (!bounds) return;
        for (let corner = 0; corner < 8; corner++) {
          p.set(corner & 1 ? bounds.max.x : bounds.min.x, corner & 2 ? bounds.max.y : bounds.min.y, corner & 4 ? bounds.max.z : bounds.min.z);
          p.applyMatrix4(object.matrixWorld).project(this.camera);
          if (p.z < -1 || p.z > 1) continue;
          const x = (p.x + 1) * this.canvas.width / 2;
          const y = (1 - p.y) * this.canvas.height / 2;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      });
    }
    const crop = document.createElement('canvas');
    const context = crop.getContext('2d')!;
    if (Number.isFinite(minX) && maxX > minX && maxY > minY) {
      const bodyW = maxX - minX, bodyH = maxY - minY;
      const padding = Math.max(bodyW, bodyH) * .13;
      const ratio = 20 / 13;
      const width = Math.max(bodyW + padding * 2, (bodyH + padding * 2) * ratio);
      const height = width / ratio;
      crop.width = Math.ceil(width); crop.height = Math.ceil(height);
      context.fillStyle = '#f4f5f7'; context.fillRect(0, 0, crop.width, crop.height);
      context.drawImage(this.canvas, width / 2 - (minX + maxX) / 2, height / 2 - (minY + maxY) / 2);
    } else {
      crop.width = this.canvas.width; crop.height = this.canvas.height;
      context.drawImage(this.canvas, 0, 0);
    }
    feedback.forEach((object, i) => object.visible = visibility[i]);
    this.renderer.render(this.scene, this.camera);
    return crop.toDataURL('image/png');
  }

  dispose(): void {
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    Object.values(this.fragmentMaterials).forEach(material => materials.add(material));
    const textures = new Set<Texture>();
    for (const screen of [this.wallpaper, this.coverWallpaper]) {
      textures.add(screen.sharp); textures.add(screen.blurred);
    }
    this.scene.traverse(object => {
      if (object instanceof Mesh || object instanceof Line) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(material);
          for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
        }
      }
    });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
    this.environment.dispose(); this.renderer.dispose();
  }
}
