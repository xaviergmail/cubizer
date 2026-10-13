import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import panelsUrl from '../assets/Panels.glb?url';
import {
  STEP,
  panelCenter,
  parsePointKey,
  panelKey,
  panelSpan,
  type Connector,
  type PanelType,
  type Placement,
  type World,
} from './model';
export interface GhostSpec {
  placement: Placement;
  type: PanelType;
  connectors: Map<string, Connector>;
  invalid?: boolean;
}

// Blender-exported panel models (assets/Panels.glb), one per panel kind.
// Geometries are normalized at load: rotated so thickness runs along local z,
interface PanelAsset {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
}

export interface ModelMaterialDefaults {
  panel: string;
  metal: string;
  connector: string;
}

interface ModelMaterials {
  panel: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  connector: THREE.MeshStandardMaterial;
}

const SHARED_MATERIAL = 'artistAlleySharedMaterial';
let modelMaterials: ModelMaterials | null = null;
const customPanelMaterials = new Map<string, THREE.MeshStandardMaterial>();
let panelAssets: Record<'grid' | 'outline' | 'plain', PanelAsset> | null = null;
let connectorAsset: PanelAsset | null = null;

export interface ConnectorAnchors {
  cross: string[];
  bottom: string[];
}

export let connectorAnchors: ConnectorAnchors | null = null;

function standardMaterial(material: THREE.Material, name: string): THREE.MeshStandardMaterial {
  if (!(material instanceof THREE.MeshStandardMaterial)) throw new Error(`Panels.glb: "${name}" is not a standard material`);
  return material;
}

function sharedClone(material: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const clone = material.clone();
  clone.userData[SHARED_MATERIAL] = true;
  return clone;
}

function namedMaterial(materials: THREE.Material[], names: readonly string[]): THREE.MeshStandardMaterial {
  const material = materials.find((candidate) => names.includes(candidate.name));
  if (!material) throw new Error(`Panels.glb: missing material "${names.join('" or "')}"`);
  return standardMaterial(material, names[0]);
}

function surfaceMaterial(type: PanelType): THREE.MeshStandardMaterial | null {
  if (!modelMaterials) return null;
  if (!type.custom) return modelMaterials.panel;
  let material = customPanelMaterials.get(type.id);
  if (!material) {
    material = sharedClone(modelMaterials.panel);
    customPanelMaterials.set(type.id, material);
  }
  material.color.set(type.color);
  return material;
}

// Resolves the default named GLB material colors used to seed assembly state.
export function loadPanelAssets(): Promise<ModelMaterialDefaults | null> {
  const { promise, resolve } = Promise.withResolvers<ModelMaterialDefaults | null>();
  const fail = (err: unknown) => {
    console.error('failed to load Panels.glb, falling back to procedural panels', String(err));
    resolve(null);
  };
  new GLTFLoader().load(
    panelsUrl,
    (gltf) => {
      try {
        const out = {} as Record<'grid' | 'outline' | 'plain', PanelAsset>;
        const panelSources: THREE.Material[] = [];
        for (const kind of ['grid', 'outline', 'plain'] as const) {
          // glTF node names are capitalized; app kind ids are lowercase.
          const node = gltf.scene.getObjectByName(kind[0].toUpperCase() + kind.slice(1));
          if (!node) throw new Error(`Panels.glb: missing mesh "${kind}"`);
          node.updateMatrixWorld(true);
          const rootInv = new THREE.Matrix4().copy(node.matrixWorld).invert();
          // Variant detail lives in child meshes (grid wires, plain bars):
          // merge the whole subtree, keeping per-mesh materials as groups.
          const geos: THREE.BufferGeometry[] = [];
          const mats: THREE.Material[] = [];
          node.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            const g = m.geometry.clone();
            g.applyMatrix4(new THREE.Matrix4().copy(m.matrixWorld).premultiply(rootInv));
            geos.push(g);
            mats.push(Array.isArray(m.material) ? m.material[0] : m.material);
          });
          let geo = mergeGeometries(geos, true);
          if (!geo) {
            // Attribute/index mismatch: de-index everything and retry, else
            // settle for the body mesh alone so one odd child can't kill the kind.
            geo = mergeGeometries(geos.map((g) => (g.getIndex() ? g.toNonIndexed() : g)), true)
              ?? mergeGeometries(geos.slice(0, 1).map((g) => (g.getIndex() ? g.toNonIndexed() : g)), true)
              ?? geos[0];
            console.warn(`Panels.glb: degraded merge for "${kind}"`);
          }
          // GLB native frame: panel lies flat in XZ, thickness along +Y.
          geo.computeBoundingBox();
          const bb = geo.boundingBox!;
          const size = new THREE.Vector3();
          const center = new THREE.Vector3();
          bb.getSize(size);
          bb.getCenter(center);
          const scale = STEP / Math.max(size.x, size.z);
          geo.translate(-center.x, -center.y, -center.z);
          geo.scale(scale, scale, scale);
          out[kind] = { geometry: geo, materials: mats };
          panelSources.push(...mats);
        }
        // Connector hub mesh (no children, origin = the connection point:
        // the bbox is asymmetric toward the cross-side protrusion, so
        // DO NOT recenter - the origin must stay on the lattice corner).
        // Unlike panels, this mesh is authored Z-up: its raw plate is XY and
        // the cross side protrudes toward -Z. Convert it into the app's Y-up
        // canonical frame (plate XZ, cross +Y) before applying ORIENT_QUATS.
        const connNode = gltf.scene.getObjectByName('Connector') as THREE.Mesh | undefined;
        if (!connNode) throw new Error('Panels.glb: missing Connector mesh');
        connNode.updateMatrixWorld(true);
        const cgeo = connNode.geometry.clone();
        cgeo.rotateX(Math.PI / 2);
        const cmat = Array.isArray(connNode.material) ? connNode.material[0] : connNode.material;
        const connectorSource = namedMaterial([cmat], ['Connector', 'Black Plastic Connector', 'Black Plastic']);
        const cscale = STEP / 30;
        connectorAsset = { geometry: shareGeometry(cgeo.scale(cscale, cscale, cscale)), materials: [connectorSource] };

        for (const material of [...panelSources, connectorSource]) material.userData[SHARED_MATERIAL] = true;
        modelMaterials = {
          // No alias here: panel meshes must come from a real panel material.
          // A stale export would fail loudly (procedural fallback) rather
          // than paint panels with the connector's black plastic.
          panel: sharedClone(namedMaterial(panelSources, ['Panel'])),
          metal: sharedClone(namedMaterial(panelSources, ['Metal', 'Black'])),
          connector: sharedClone(connectorSource),
        };
        const defaults = {
          panel: `#${modelMaterials.panel.color.getHexString()}`,
          metal: `#${modelMaterials.metal.color.getHexString()}`,
          connector: `#${modelMaterials.connector.color.getHexString()}`,
        };
        panelAssets = out;

        // Armature slot data: the connector's 8 mount anchors (4 cross-side
        // SW/NW/NE/SE for in-plane panels + 4 bottom-tangential B* for the
        // perpendicular axis) and the panel's 4 corner bones. The exported
        // anchor bones carry orientation frames only - their rest positions
        // all sit at the armature origin - so the runtime slot matrix in
        // model.ts is geometric; this profile asserts the asset still
        // matches the matrix's 4+4 structure.
        const anchors = (gltf.scene.getObjectByName('Connector_Connections')?.children ?? []).map((b) => b.name);
        const panelBones = (gltf.scene.getObjectByName('Panels_Connections')?.children ?? []).map((b) => b.name);
        const cross = ['SW', 'NW', 'NE', 'SE'];
        const bottom = ['BSW', 'BNW', 'BNE', 'BSE'];
        if (anchors.length === 8 && panelBones.length === 4 && cross.every((n) => anchors.includes(n)) && bottom.every((n) => anchors.includes(n))) {
          connectorAnchors = { cross, bottom };
        } else {
          console.warn('Panels.glb armature does not match the 4+4 connector slot matrix; using geometric fallback', anchors, panelBones);
        }
        resolve(defaults);
      } catch (err) {
        fail(err);
      }
    },
    undefined,
    fail,
  );
  return promise;
}
const THICK = 0.5;
const GHOST = 0x3b82f6;
const GHOST_BAD = 0xef4444;
const TABLE_DEPTH = 24;
const TABLE_TOP_T = 1.5;
const FLOOR_Y = -30;

function createContactOcclusionTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(128, 128, 12, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(51, 65, 85, 0.34)');
  gradient.addColorStop(0.58, 'rgba(51, 65, 85, 0.15)');
  gradient.addColorStop(1, 'rgba(51, 65, 85, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}
// Geometries (and the few cached materials) reused by every panel/connector
// mesh. Rebuilds must never clone or dispose these: cloning the ~50k-triangle
// GLB panel per placement was the source of the add/remove lag spikes.
const sharedGeometries = new WeakSet<THREE.BufferGeometry>();

function shareGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
  sharedGeometries.add(geometry);
  return geometry;
}


const CONTACT_OCCLUSION = createContactOcclusionTexture();

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      if (!sharedGeometries.has(o.geometry)) o.geometry.dispose();
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const material of materials) {
        if (!material.userData[SHARED_MATERIAL]) material.dispose();
      }
    }
  });
}

const HIT_GEO = shareGeometry(new THREE.BoxGeometry(STEP + 0.4, THICK + 0.9, STEP + 0.4));
const GHOST_PANEL_GEO = shareGeometry(new THREE.BoxGeometry(STEP, THICK, STEP));
const GHOST_CUBE_GEO = shareGeometry(new THREE.BoxGeometry(1.5, 1.5, 1.5));
const GHOST_MATS: Record<'ok' | 'bad', THREE.MeshBasicMaterial> = {
  ok: new THREE.MeshBasicMaterial({ color: GHOST, transparent: true, opacity: 0.35, depthWrite: false }),
  bad: new THREE.MeshBasicMaterial({ color: GHOST_BAD, transparent: true, opacity: 0.35, depthWrite: false }),
};
for (const material of [...Object.values(GHOST_MATS)]) material.userData[SHARED_MATERIAL] = true;
const HIT_MAT = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
HIT_MAT.userData[SHARED_MATERIAL] = true;
const GHOST_CONNECTOR_MATS: Record<'ok' | 'bad', THREE.MeshBasicMaterial> = {
  ok: new THREE.MeshBasicMaterial({ color: GHOST, transparent: true, opacity: 0.45, depthWrite: false }),
  bad: new THREE.MeshBasicMaterial({ color: GHOST_BAD, transparent: true, opacity: 0.45, depthWrite: false }),
};
for (const material of Object.values(GHOST_CONNECTOR_MATS)) material.userData[SHARED_MATERIAL] = true;


function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}

function ghostMaterial(invalid = false): THREE.MeshBasicMaterial {
  return invalid ? GHOST_MATS.bad : GHOST_MATS.ok;
}
function hitMaterial(): THREE.MeshBasicMaterial {
  return HIT_MAT;
}

function panelMaterial(source: THREE.Material, type: PanelType): THREE.Material {
  if (source.name === 'Panel') return surfaceMaterial(type) ?? source;
  if (source.name === 'Metal' || source.name === 'Black') return modelMaterials?.metal ?? source;
  return source;
}

// Panel content in its native GLB frame: x/z span [-6, 6], thickness along y.
function buildPanelContent(type: PanelType, ghost: boolean, invalid = false, metalColor = '#2f3945'): THREE.Group {
  const g = new THREE.Group();
  if (ghost) {
    g.add(new THREE.Mesh(GHOST_PANEL_GEO, ghostMaterial(invalid)));
  } else {
    const asset = panelAssets?.[type.kind];
    if (asset) {
      // Named GLB materials are shared across the assembly. Only custom
      // panel types need an isolated Panel clone to retain their own color.
      const mesh = new THREE.Mesh(asset.geometry, asset.materials.map((material) => panelMaterial(material, type)));
      mesh.castShadow = false;
      g.add(mesh);
    } else {
      // Fallback while the model loads (or if it failed): procedural boxes.
      g.add(new THREE.Mesh(
        GHOST_PANEL_GEO,
        new THREE.MeshStandardMaterial({ color: type.kind === 'plain' ? type.color : metalColor, roughness: 0.55, metalness: 0.05 }),
      ));
    }
  }
  // Uniform clickbox for every panel kind, matching the solid panel footprint.
  const hit = new THREE.Mesh(HIT_GEO, hitMaterial());
  g.add(hit);
  return g;
}

function placePanel(obj: THREE.Group, p: Placement): void {
  const c = panelCenter(p);
  obj.position.set(c[0], c[1], c[2]);
  if (p.plane === 'x') obj.rotation.z = -Math.PI / 2;
  if (p.plane === 'z') obj.rotation.x = Math.PI / 2;
  // GLB panel frame: face spans local x/z, thickness local y. The span's
  // (a, b) axes map onto local x/z for every plane rotation, so one scale
  // vector covers 12x12 and 16-inch panels alike.
  const [a, b] = panelSpan(p);
  obj.scale.set(a / STEP, 1, b / STEP);
}

// After Z-up -> Y-up normalization the connector plate is in XZ and its
// cross-side structure points toward +Y. Placed orientation rotates that
// cross axis (0,1,0) onto the connector's cross-panel direction (plate normal
// * sign). All six targets stay aligned with the lattice.
const ORIENT_QUATS: Record<string, THREE.Quaternion> = {
  'y1': new THREE.Quaternion(),
  'y-1': new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI),
  'z1': new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
  'z-1': new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
  'x1': new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2),
  'x-1': new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2),
};

// Connector orientation math. Object3D.rotateY post-multiplies a local-Y
// spin onto the base orientation, so `q_base * qY(turn)` reproduces the
// quaternion a mesh gets from `quaternion.copy(ORIENT)` + `rotateY(turn)`.
const QUARTER_TURN_Y = [0, 1, 2, 3].map((turn) =>
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (turn * Math.PI) / 2),
);

function connectorQuaternion(conn: Connector, out: THREE.Quaternion): THREE.Quaternion {
  out.copy(ORIENT_QUATS[`${conn.plane}${conn.sign}`]);
  if (conn.turn) out.multiply(QUARTER_TURN_Y[conn.turn]);
  return out;
}

// One connector hub differs from the next only by lattice position and
// orientation, so every hub of a batch shares one geometry, one material,
// and one InstancedMesh: a rebuild becomes N matrix writes + 1 draw call
// instead of N Group/Mesh allocations. The orientation quaternion rides in
// the instance matrix, so no per-orientation bucketing is needed.
function batchConnectors(
  connectors: Map<string, Connector>,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  group: THREE.Group,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, connectors.size);
  mesh.castShadow = false;
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const matrix = new THREE.Matrix4();
  let index = 0;
  for (const [key, conn] of connectors) {
    const corner = parsePointKey(key);
    position.set(corner[0] * STEP, corner[1] * STEP, corner[2] * STEP);
    connectorQuaternion(conn, quaternion);
    mesh.setMatrixAt(index++, matrix.compose(position, quaternion, scale));
  }
  group.add(mesh);
  return mesh;
}

// InstancedMesh.dispose() only frees the per-instance buffers; geometry and
// material are shared and must survive batch replacement.
function disposeBatch(batch: THREE.InstancedMesh | null): null {
  if (batch) {
    batch.parent?.remove(batch);
    batch.dispose();
  }
  return null;
}

let connectorFallbackMaterial: THREE.MeshStandardMaterial | null = null;
function darkCubeMaterial(color: string): THREE.MeshStandardMaterial {
  if (!connectorFallbackMaterial) {
    connectorFallbackMaterial = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.4 });
    connectorFallbackMaterial.userData[SHARED_MATERIAL] = true;
  }
  connectorFallbackMaterial.color.set(color);
  return connectorFallbackMaterial;
}

export interface ScreenPos {
  x: number;
  y: number;
  visible: boolean;
}

export class SceneCtx {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly tableGroup = new THREE.Group();
  readonly panelGroup = new THREE.Group();
  readonly ghostGroup = new THREE.Group();
  readonly markerGroup = new THREE.Group();
  readonly connectorGroup = new THREE.Group();
  tableTop: THREE.Mesh | null = null;
  private tableLength = 0;
  private panelMeshes = new Map<string, THREE.Object3D>();
  private connectorBatch: THREE.InstancedMesh | null = null;
  private ghostConnectorBatch: THREE.InstancedMesh | null = null;
  private selectionHelper: THREE.Mesh;
  private hoverOutline: THREE.LineSegments;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xe8edf2);
    this.camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.5, 4000);
    const ambient = new THREE.AmbientLight(0xffffff, 0.72);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x9aa7b6, 1.15);
    const overhead = new THREE.DirectionalLight(0xffffff, 1.55);
    overhead.position.set(0, 260, 40);
    overhead.castShadow = true;
    overhead.shadow.mapSize.set(2048, 2048);
    overhead.shadow.camera.left = -220;
    overhead.shadow.camera.right = 220;
    overhead.shadow.camera.top = 220;
    overhead.shadow.camera.bottom = -220;
    overhead.shadow.camera.far = 600;
    overhead.shadow.radius = 8;
    overhead.shadow.normalBias = 0.03;
    const fill = new THREE.DirectionalLight(0xdbeafe, 0.42);
    fill.position.set(-140, 90, -100);
    this.scene.add(ambient, hemi, overhead, fill);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 2400),
      new THREE.MeshStandardMaterial({ color: 0xc2ccd4, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = FLOOR_Y;
    ground.receiveShadow = true;
    this.scene.add(ground, this.tableGroup, this.panelGroup, this.connectorGroup, this.ghostGroup, this.markerGroup);

    this.selectionHelper = new THREE.Mesh(
      new THREE.BoxGeometry(STEP + 1, THICK + 2, STEP + 1),
      new THREE.MeshBasicMaterial({ color: GHOST, transparent: true, opacity: 0.28, depthWrite: false })
    );
    this.selectionHelper.visible = false;
    // Normal-mode hover outline: hugs the candidate ghost marker under the
    // cursor. Scaled with the marker so the half-size previews get a snug box.
    this.hoverOutline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(STEP, THICK, STEP)),
      new THREE.LineBasicMaterial({ color: GHOST }),
    );
    this.hoverOutline.visible = false;
    this.scene.add(this.hoverOutline);
    this.scene.add(this.selectionHelper);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    // Coarse-pointer devices need a slower orbit to map finger movement more
    // closely to visible scene rotation. Mouse input restores the desktop rate.
    this.controls.rotateSpeed = window.matchMedia('(pointer: coarse)').matches ? 0.5 : 1;
    this.controls.maxPolarAngle = Math.PI / 2;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 800;
    this.setTableLength(72);
  }

  panelMesh(key: string): THREE.Object3D | undefined {
    return this.panelMeshes.get(key);
  }

  setPlacementMode(_mode: 'normal' | 'quick'): void {
    // Left-drag orbits in both modes — except when a press starts on a
    // legal placement target, which main.ts steals for continuous
    // placement (paint) by disabling controls for that gesture.
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    } as unknown as typeof this.controls.mouseButtons;
  }

  setTableLength(len: number, reframe = true): void {
    const rebuild = len !== this.tableLength;
    this.tableLength = len;
    if (rebuild) {
      clearGroup(this.tableGroup);
      const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.8 });
      const top = new THREE.Mesh(new THREE.BoxGeometry(len, TABLE_TOP_T, TABLE_DEPTH), wood);
      top.position.set(len / 2, -TABLE_TOP_T / 2, 0);
      top.castShadow = true;
      top.receiveShadow = true;
      this.tableGroup.add(top);
      this.tableTop = top;
      const legGeom = new THREE.BoxGeometry(2.4, 28.5, 2.4);
      for (const x of [2.5, len - 2.5]) {
        for (const z of [-(TABLE_DEPTH / 2 - 1.6), TABLE_DEPTH / 2 - 1.6]) {
          const leg = new THREE.Mesh(legGeom, wood);
          leg.position.set(x, FLOOR_Y + 28.5 / 2, z);
          leg.castShadow = true;
          this.tableGroup.add(leg);
        }
      }
      const ao = new THREE.Mesh(
        new THREE.PlaneGeometry(len + 52, TABLE_DEPTH + 52),
        new THREE.MeshBasicMaterial({ map: CONTACT_OCCLUSION, transparent: true, depthWrite: false }),
      );
      ao.rotation.x = -Math.PI / 2;
      ao.position.set(len / 2, FLOOR_Y + 0.04, 0);
      this.tableGroup.add(ao);
      this.addChair(len);
    }
    if (reframe) {
      this.controls.target.set(len / 2, 12, 0);
      this.camera.position.set(len / 2 + 70, 65, 110);
    }
  }

  resetView(): void {
    this.controls.target.set(this.tableLength / 2, 12, 0);
    this.camera.position.set(this.tableLength / 2 + 70, 65, 110);
  }

  private addChair(tableLength: number): void {
    const chair = new THREE.Group();
    chair.name = 'artist-chair';
    chair.position.set(tableLength / 2, 0, -(TABLE_DEPTH / 2 + 9));
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5, metalness: 0.45 });
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.82, metalness: 0.02 });
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      chair.add(mesh);
    };
    add(new THREE.BoxGeometry(17, 2, 17), seatMat, 0, FLOOR_Y + 14, 0);
    for (const x of [-7, 7]) for (const z of [-7, 7]) {
      add(new THREE.BoxGeometry(1.4, 14, 1.4), frameMat, x, FLOOR_Y + 7, z);
    }
    add(new THREE.BoxGeometry(17, 18, 1.6), seatMat, 0, FLOOR_Y + 23, -7);
    this.tableGroup.add(chair);
  }
  syncModelMaterials(world: World): void {
    if (!modelMaterials) return;
    const plain = world.types.get('plain');
    if (plain) modelMaterials.panel.color.set(plain.color);
    modelMaterials.metal.color.set(world.metalColor);
    modelMaterials.connector.color.set(world.connectorColor);
    for (const type of world.types.values()) {
      if (type.custom) surfaceMaterial(type);
    }
    for (const [id, material] of customPanelMaterials) {
      if (!world.types.has(id)) {
        material.dispose();
        customPanelMaterials.delete(id);
      }
    }
  }


  rebuild(world: World, showSelection = true): void {
    this.syncModelMaterials(world);
    clearGroup(this.panelGroup);
    this.connectorBatch = disposeBatch(this.connectorBatch);
    this.panelMeshes.clear();
    for (const panel of world.panels.values()) {
      const type = world.types.get(panel.typeId);
      if (!type) continue;
      const obj = buildPanelContent(type, false, false, world.metalColor);
      placePanel(obj, panel);
      obj.userData.panelKey = panelKey(panel);
      this.panelGroup.add(obj);
      this.panelMeshes.set(panelKey(panel), obj);
    }
    if (world.connectors.size > 0) {
      const material = connectorAsset
        ? modelMaterials?.connector ?? connectorAsset.materials[0]
        : darkCubeMaterial(world.connectorColor);
      this.connectorBatch = batchConnectors(world.connectors, connectorAsset ? connectorAsset.geometry : GHOST_CUBE_GEO, material, this.connectorGroup);
    }
    this.updateSelection(world, showSelection);
  }


  private updateSelection(world: World, showSelection: boolean): void {
    const mesh = showSelection && world.selectedKey ? this.panelMeshes.get(world.selectedKey) : undefined;
    if (!mesh) {
      this.selectionHelper.visible = false;
      return;
    }
    this.selectionHelper.visible = true;
    this.selectionHelper.position.copy(mesh.position);
    this.selectionHelper.rotation.copy(mesh.rotation);
    this.selectionHelper.scale.copy(mesh.scale);
  }

  setGhost(ghost: GhostSpec | null): void {
    // Dispose the ghost hub batch before clearGroup: the meshes live in the
    // group but their instance buffers are not reachable from disposeObject.
    this.ghostConnectorBatch = disposeBatch(this.ghostConnectorBatch);
    clearGroup(this.ghostGroup);
    if (!ghost) return;
    const obj = buildPanelContent(ghost.type, true, ghost.invalid === true);
    placePanel(obj, ghost.placement);
    this.ghostGroup.add(obj);
    if (ghost.connectors.size > 0) {
      const material = ghost.invalid === true ? GHOST_CONNECTOR_MATS.bad : GHOST_CONNECTOR_MATS.ok;
      this.ghostConnectorBatch = batchConnectors(ghost.connectors, connectorAsset ? connectorAsset.geometry : GHOST_CUBE_GEO, material, this.ghostGroup);
    }
  }

  setHoveredMarker(marker: THREE.Object3D | null): void {
    if (!marker) {
      this.hoverOutline.visible = false;
      return;
    }
    this.hoverOutline.position.copy(marker.position);
    this.hoverOutline.quaternion.copy(marker.quaternion);
    this.hoverOutline.scale.copy(marker.scale);
    this.hoverOutline.visible = true;
  }

  setCandidateGhosts(candidates: Array<{ placement: Placement; type: PanelType }>): void {
    clearGroup(this.markerGroup);
    for (const candidate of candidates) {
      const obj = buildPanelContent(candidate.type, true);
      placePanel(obj, candidate.placement);
      obj.scale.multiplyScalar(0.5);
      obj.userData.candidateKey = panelKey(candidate.placement);
      this.markerGroup.add(obj);
    }
  }

  projectToScreen(v: [number, number, number], out: ScreenPos, container: HTMLElement): void {
    const vec = new THREE.Vector3(v[0], v[1], v[2]).project(this.camera);
    out.x = (vec.x * 0.5 + 0.5) * container.clientWidth;
    out.y = (-vec.y * 0.5 + 0.5) * container.clientHeight;
    out.visible = vec.z < 1;
  }
}

