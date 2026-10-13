import './style.css';
import '@fortawesome/fontawesome-free/css/all.min.css';
import * as THREE from 'three';
import {
  STEP,
  World,
  panelCenter,
  panelCornersIn,
  panelKey,
  baseKey,
  spanForSize,
  SIZE_MODES,
  sharedPanelEdge,
  type AssemblyState,
  type Placement,
  type SizeMode,
} from './model';
import { SceneCtx, loadPanelAssets, connectorAnchors } from './scene';
import { UI } from './ui';

const viewport = document.getElementById('viewport');
const sidebar = document.getElementById('sidebar');
if (!viewport || !sidebar) throw new Error('missing #viewport/#sidebar');
const viewportEl: HTMLElement = viewport;

const SHARE_PARAM = 'assembly';
const LEGACY_SAVE_KEY = 'artist-alley-display-builder:assembly-v1';
const DESIGN_INDEX_KEY = 'artist-alley-display-builder:designs-v1';
const DESIGN_KEY_PREFIX = 'artist-alley-display-builder:design-v1:';
const QUICK_MODE_KEY = 'artist-alley-display-builder:quick-mode';

function restoreFromUrl(target: World): boolean {
  const url = new URL(window.location.href);
  const hashState = new URLSearchParams(url.hash.slice(1)).get(SHARE_PARAM);
  // Read an existing query-link once; the first refresh rewrites it into the
  // fragment form below, so newly copied URLs never put state in a request.
  const raw = hashState ?? url.searchParams.get(SHARE_PARAM);
  if (!raw) return false;
  try {
    return target.restore(JSON.parse(raw) as AssemblyState);
  } catch {
    return false;
  }
}

function syncUrl(target: World): void {
  const url = new URL(window.location.href);
  // Fragments are deliberately excluded from HTTP requests, avoiding
  // oversized request headers for large shared assemblies.
  url.searchParams.delete(SHARE_PARAM);
  url.hash = new URLSearchParams([[SHARE_PARAM, JSON.stringify(target.toJSON())]]).toString();
  history.replaceState(null, '', url);
}

let defaultPlainColor = '#000000';

function seedDefaultTypes(target: World): void {
  target.types.set('plain', { id: 'plain', kind: 'plain', color: defaultPlainColor, custom: false });
  target.types.set('grid', { id: 'grid', kind: 'grid', color: '#000000', custom: false });
  target.types.set('outline', { id: 'outline', kind: 'outline', color: '#000000', custom: false });
}

const world = new World();
seedDefaultTypes(world);
const restoredFromUrl = restoreFromUrl(world);
const sceneCtx = new SceneCtx(viewport);
const canvas = sceneCtx.renderer.domElement;
sceneCtx.setTableLength(world.tableLength);
canvas.style.touchAction = 'none';
// ---------------------------------------------------------------- picking

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
// The portrait-phone layout rotates #app 90° clockwise (style.css). Pointer
// events report screen coordinates, so map them through the inverse rotation
// into the canvas's local space before any NDC or pixel math.
function forcedLandscape(): boolean {
  return window.matchMedia('(max-width: 767px) and (orientation: portrait) and (pointer: coarse)').matches;
}

function canvasPoint(clientX: number, clientY: number, rect: DOMRect): { x: number; y: number } {
  let x = clientX - rect.left;
  let y = clientY - rect.top;
  if (forcedLandscape()) {
    const sx = x;
    x = y;
    y = rect.width - sx;
  }
  return { x, y };
}

function setNdc(clientX: number, clientY: number): void {
  const rect = canvas.getBoundingClientRect();
  const pt = canvasPoint(clientX, clientY, rect);
  // Under rotation the canvas's local width/height swap, which also swaps
  // the screen-space AABB's height/width.
  const w = forcedLandscape() ? rect.height : rect.width;
  const h = forcedLandscape() ? rect.width : rect.height;
  ndc.x = (pt.x / w) * 2 - 1;
  ndc.y = -(pt.y / h) * 2 + 1;
}

function firstHit(objects: THREE.Object3D[]): THREE.Intersection | null {
  const hits = raycaster.intersectObjects(objects, true);
  return hits.length > 0 ? hits[0] : null;
}

function userDataValue(o: THREE.Object3D, field: string): unknown {
  let cur: THREE.Object3D | null = o;
  while (cur) {
    const v: unknown = cur.userData[field];
    if (v !== undefined) return v;
    cur = cur.parent;
  }
  return undefined;
}

interface PickResult {
  panelKeyHit: string | null;
  tablePoint: THREE.Vector3 | null;
}

function pick(): PickResult {
  sceneCtx.scene.updateMatrixWorld(true);
  const panelHit = firstHit([sceneCtx.panelGroup]);
  const key = panelHit ? userDataValue(panelHit.object, 'panelKey') : undefined;
  if (typeof key === 'string') return { panelKeyHit: key, tablePoint: null };
  const tableHit = sceneCtx.tableTop ? firstHit([sceneCtx.tableTop]) : null;
  if (tableHit) return { panelKeyHit: null, tablePoint: tableHit.point.clone() };
  return { panelKeyHit: null, tablePoint: null };
}

function pickCandidate(): string | null {
  const hit = firstHit([sceneCtx.markerGroup]);
  const key = hit ? userDataValue(hit.object, 'candidateKey') : undefined;
  return typeof key === 'string' ? key : null;
}

type BuildMode = 'normal' | 'quick';

const SIZE_MODE_KEY = 'artist-alley-display-builder:size-mode';
const storedSize = localStorage.getItem(SIZE_MODE_KEY);
let sizeMode: SizeMode = SIZE_MODES.includes(storedSize as SizeMode) ? (storedSize as SizeMode) : '12x12';

// Every placement path routes through here so validity, rendering, and keys
// all judge the panel at the size the user currently has selected.
function withSize(p: Placement): Placement {
  return { ...p, span: spanForSize(p.plane, sizeMode) };
}

let buildMode: BuildMode = localStorage.getItem(QUICK_MODE_KEY) === 'true' ? 'quick' : 'normal';
let hoverPanelKey: string | null = null;
// Edge-hover placement is retained only by quick build mode.
let edgeHover: { panelKey: string; edge: number } | null = null;
let ghostPlacement: Placement | null = null;
let ghostInvalid = false;
let camDragging = false;
let rightDown: { panelKey: string | null; x: number; y: number } | null = null;
let lastMouse: { x: number; y: number } = { x: 0, y: 0 };
let touchGesture = false;
const activePointers = new Map<number, { x: number; y: number; cx: number; cy: number; moved: boolean; type: string }>();
interface NormalCandidate {
  placement: Placement;
}

const normalCandidates = new Map<string, NormalCandidate>();

const EDGE_ACTIVATE_PX = 45; // start showing the ghost this close to an edge
const EDGE_EXTINGUISH_PX = 130; // ghost gone beyond this distance
const EDGE_SECTOR_DEG = 75; // mouse must sit roughly in a candidate's sector
function panelEdges(p: Placement): Array<[[number, number, number], [number, number, number]]> {
  const c = panelCornersIn(p);
  return [
    [c[0]!, c[1]!],
    [c[0]!, c[2]!],
    [c[1]!, c[3]!],
    [c[2]!, c[3]!],
  ];
}

function projectPx(v: [number, number, number]): { x: number; y: number; visible: boolean } {
  const out = { x: 0, y: 0, visible: false };
  sceneCtx.projectToScreen(v, out, viewportEl);
  return out;
}

// Nearest panel edge to the mouse in screen space.
function nearestEdge(p: Placement, mx: number, my: number): { edge: number; dist: number } | null {
  let best: { edge: number; dist: number } | null = null;
  const edges = panelEdges(p);
  for (let n = 0; n < 4; n++) {
    const a = projectPx(edges[n][0]);
    const b = projectPx(edges[n][1]);
    if (!a.visible || !b.visible) continue;
    const ax = b.x - a.x, ay = b.y - a.y;
    const len2 = ax * ax + ay * ay;
    let t = len2 > 0 ? ((mx - a.x) * ax + (my - a.y) * ay) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = mx - (a.x + t * ax), dy = my - (a.y + t * ay);
    const dist = Math.hypot(dx, dy);
    if (!best || dist < best.dist) best = { edge: n, dist };
  }
  return best;
}

// Squares adjacent to one of the panel's edges: the coplanar continuation
// plus the two perpendicular squares sharing the edge (one per face side).
function edgeNeighbors(p: Placement, edge: number): Placement[] {
  const { plane, i, j, k } = p;
  if (plane === 'z') {
    // edges: 0 bottom (x, y=j), 1 left (y, x=i), 2 right (y, x=i+1), 3 top (x, y=j+1)
    if (edge === 0) return [{ plane: 'z', i, j: j - 1, k }, { plane: 'y', i, j, k: k - 1 }, { plane: 'y', i, j, k }];
    if (edge === 1) return [{ plane: 'z', i: i - 1, j, k }, { plane: 'x', i, j, k: k - 1 }, { plane: 'x', i, j, k }];
    if (edge === 2) return [{ plane: 'z', i: i + 1, j, k }, { plane: 'x', i: i + 1, j, k: k - 1 }, { plane: 'x', i: i + 1, j, k }];
    return [{ plane: 'z', i, j: j + 1, k }, { plane: 'y', i, j: j + 1, k: k - 1 }, { plane: 'y', i, j: j + 1, k }];
  }
  if (plane === 'y') {
    // 0 (x, z=k), 1 (z, x=i), 2 (z, x=i+1), 3 (x, z=k+1)
    if (edge === 0) return [{ plane: 'y', i, j, k: k - 1 }, { plane: 'z', i, j: j - 1, k }, { plane: 'z', i, j, k }];
    if (edge === 1) return [{ plane: 'y', i: i - 1, j, k }, { plane: 'x', i, j: j - 1, k }, { plane: 'x', i, j, k }];
    if (edge === 2) return [{ plane: 'y', i: i + 1, j, k }, { plane: 'x', i: i + 1, j: j - 1, k }, { plane: 'x', i: i + 1, j, k }];
    return [{ plane: 'y', i, j, k: k + 1 }, { plane: 'z', i, j: j - 1, k: k + 1 }, { plane: 'z', i, j, k: k + 1 }];
  }
  // plane 'x': 0 (y, z=k), 1 (z, y=j), 2 (z, y=j+1), 3 (y, z=k+1)
  if (edge === 0) return [{ plane: 'x', i, j, k: k - 1 }, { plane: 'z', i: i - 1, j, k }, { plane: 'z', i, j, k }];
  if (edge === 1) return [{ plane: 'x', i, j: j - 1, k }, { plane: 'y', i: i - 1, j, k }, { plane: 'y', i, j, k }];
  if (edge === 2) return [{ plane: 'x', i, j: j + 1, k }, { plane: 'y', i: i - 1, j: j + 1, k }, { plane: 'y', i, j: j + 1, k }];
  return [{ plane: 'x', i, j, k: k + 1 }, { plane: 'z', i: i - 1, j, k: k + 1 }, { plane: 'z', i, j, k: k + 1 }];
}

function tableCandidate(point: THREE.Vector3): Placement | null {
  const span = spanForSize('y', sizeMode);
  const candidate: Placement = {
    plane: 'y',
    i: Math.round(point.x / STEP - span[0] / (2 * STEP)),
    j: 0,
    k: Math.round(point.z / STEP - span[1] / (2 * STEP)),
    span,
  };
  return world.canPlace(candidate) ? candidate : null;
}

function clearHover(): void {
  edgeHover = null;
  hoverPanelKey = null;
  ghostPlacement = null;
  ghostInvalid = false;
  sceneCtx.setGhost(null);
  sceneCtx.setHoveredMarker(null);
}

function clearNormalCandidates(): void {
  normalCandidates.clear();
  sceneCtx.setCandidateGhosts([]);
  sceneCtx.setHoveredMarker(null);
}

function updateNormalHover(clientX: number, clientY: number): void {
  setNdc(clientX, clientY);
  raycaster.setFromCamera(ndc, sceneCtx.camera);
  sceneCtx.scene.updateMatrixWorld(true);

  // Candidate markers take precedence over a table ghost at the same screen
  // point so their hover outline remains a precise placement affordance.
  const hit = firstHit([sceneCtx.markerGroup]);
  let marker: THREE.Object3D | null = null;
  if (hit) {
    marker = hit.object;
    while (marker && marker.parent !== sceneCtx.markerGroup) marker = marker.parent;
  }
  sceneCtx.setHoveredMarker(marker);

  ghostPlacement = null;
  ghostInvalid = false;
  sceneCtx.setGhost(null);
  if (!marker) {
    const picked = pick();
    if (picked.tablePoint) {
      const placement = tableCandidate(picked.tablePoint);
      const type = world.types.get(world.activeTypeId);
      if (placement && type) {
        ghostPlacement = placement;
        sceneCtx.setGhost({
          placement,
          type,
          connectors: world.orientationsFor(placement),
          invalid: false,
        });
      }
    }
  }
  canvas.style.cursor = marker || ghostPlacement ? 'pointer' : 'default';
  renderFrame();
}

function showNormalCandidates(candidates: NormalCandidate[]): void {
  const type = world.types.get(world.activeTypeId);
  clearNormalCandidates();
  if (!type) return;
  for (const candidate of candidates) normalCandidates.set(panelKey(candidate.placement), candidate);
  sceneCtx.setCandidateGhosts([...normalCandidates.values()].map((candidate) => ({ ...candidate, type })));
  renderFrame();
}

function candidatesForPanel(panel: Placement): NormalCandidate[] {
  // Normal mode mirrors quick build: only squares sharing a real edge with the
  // selected panel (coplanar continuation or perpendicular along that edge).
  // Corner-only diagonals stay placeable elsewhere but are never previewed.
  return world.candidates(sizeMode).flatMap((candidate) =>
    sharedPanelEdge(candidate, panel) ? [{ placement: candidate }] : [],
  );
}

// Recompute the ghost for the remembered edge: pick the candidate square
// whose screen direction from the edge midpoint best matches the mouse.
function updateEdgeGhost(mx: number, my: number): void {
  ghostPlacement = null;
  ghostInvalid = false;
  sceneCtx.setGhost(null);
  if (!edgeHover) return;
  const panel = world.panel(edgeHover.panelKey);
  if (!panel) {
    edgeHover = null;
    return;
  }
  const edges = panelEdges(panel);
  const e = edges[edgeHover.edge];
  const mid = projectPx([(e[0][0] + e[1][0]) / 2, (e[0][1] + e[1][1]) / 2, (e[0][2] + e[1][2]) / 2]);
  if (!mid.visible) return;
  const dist = distanceToSegmentPx(mx, my, e);
  if (dist > EDGE_EXTINGUISH_PX) {
    edgeHover = null;
    return;
  }
  const mdx = mx - mid.x, mdy = my - mid.y;
  const mlen = Math.hypot(mdx, mdy);
  let best: { p: Placement; angle: number } | null = null;
  const occupied = new Set([...world.panels.keys()].map((key) => key.split('@')[0]!));
  if (mlen >= 1) {
    for (const base of edgeNeighbors(panel, edgeHover.edge)) {
      if (occupied.has(baseKey(base))) continue; // occupied: not a candidate
      const cand = withSize(base);
      const c = panelCenter(cand);
      const s = projectPx(c);
      if (!s.visible) continue;
      const cdx = s.x - mid.x, cdy = s.y - mid.y;
      const clen = Math.hypot(cdx, cdy);
      if (clen < 1) continue;
      const angle = Math.acos(Math.max(-1, Math.min(1, (mdx * cdx + mdy * cdy) / (mlen * clen))));
      if (!best || angle < best.angle) best = { p: cand, angle };
    }
  }
  if (best && (best.angle * 180) / Math.PI < EDGE_SECTOR_DEG) {
    ghostPlacement = best.p;
  } else if (dist <= EDGE_ACTIVATE_PX) {
    // Right at the edge (or on the panel beside it): the tangential
    // (coplanar continuation) square is the default candidate.
    const coplanar = edgeNeighbors(panel, edgeHover.edge)[0];
    if (!occupied.has(baseKey(coplanar))) ghostPlacement = withSize(coplanar);
  }
  if (ghostPlacement) {
    ghostInvalid = !world.canPlace(ghostPlacement);
    const type = world.types.get(world.activeTypeId);
    if (type) {
      sceneCtx.setGhost({
        placement: ghostPlacement,
        type,
        connectors: world.orientationsFor(ghostPlacement),
        invalid: ghostInvalid,
      });
    }
  }
}

function distanceToSegmentPx(mx: number, my: number, e: [[number, number, number], [number, number, number]]): number {
  const a = projectPx(e[0]);
  const b = projectPx(e[1]);
  if (!a.visible || !b.visible) return Infinity;
  const ax = b.x - a.x, ay = b.y - a.y;
  const len2 = ax * ax + ay * ay;
  let t = len2 > 0 ? ((mx - a.x) * ax + (my - a.y) * ay) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(mx - (a.x + t * ax), my - (a.y + t * ay));
}

function updateHover(clientX: number, clientY: number): void {
  setNdc(clientX, clientY);
  raycaster.setFromCamera(ndc, sceneCtx.camera);
  const picked = pick();
  // Edge math works in container-relative pixels (same frame as
  // projectToScreen), so convert the page-space mouse once here.
  const pt = canvasPoint(clientX, clientY, canvas.getBoundingClientRect());
  const mx = pt.x;
  const my = pt.y;
  hoverPanelKey = picked.panelKeyHit;
  if (picked.panelKeyHit) {
    const panel = world.panel(picked.panelKeyHit);
    const near = panel ? nearestEdge(panel, mx, my) : null;
    if (near && near.dist < EDGE_ACTIVATE_PX) edgeHover = { panelKey: picked.panelKeyHit, edge: near.edge };
    else edgeHover = null;
  } else if (edgeHover) {
    const panel = world.panel(edgeHover.panelKey);
    if (panel) {
      const d = distanceToSegmentPx(mx, my, panelEdges(panel)[edgeHover.edge]);
      if (d > EDGE_EXTINGUISH_PX) edgeHover = null;
    } else edgeHover = null;
  }
  updateEdgeGhost(mx, my);
  if (!ghostPlacement && !edgeHover && picked.tablePoint) {
    const s = tableCandidate(picked.tablePoint);
    if (s) {
      ghostPlacement = s;
      ghostInvalid = false;
      const type = world.types.get(world.activeTypeId);
      if (type) {
        sceneCtx.setGhost({ placement: s, type, connectors: world.orientationsFor(s), invalid: false });
      }
    }
  }
  canvas.style.cursor = ghostPlacement || hoverPanelKey ? 'pointer' : 'default';
  renderFrame();
}

function refresh(): void {
  sceneCtx.rebuild(world, buildMode === 'quick');
  ui.updateTypes(world.types, world.activeTypeId);
  ui.updateMaterials(world.metalColor, world.connectorColor);
  ui.setTableActive(world.tableLength);
  ui.setAssemblyCounts(world.types, world.panels, world.connectors.size);
  ui.setHistoryState(historyPointer > 0, historyPointer < assemblyHistory.length - 1);
  syncUrl(world);
  renderFrame();
}

function placePanelAt(p: Placement, typeId: string = world.activeTypeId, deferCommit = false): void {
  if (!world.canPlace(p)) return;
  const panel = world.place(p, typeId);
  if (buildMode === 'quick') {
    world.selectedKey = null;
    clearNormalCandidates();
    refresh();
    updateHover(lastMouse.x, lastMouse.y);
  } else {
    // Keep building: select the new panel so its edge candidates preview
    // immediately and the next click continues the chain.
    world.selectedKey = panelKey(panel);
    refresh();
    showNormalCandidates(candidatesForPanel(p));
  }
  // Paint strokes defer their history entry so one drag = one undo step;
  // the session commits once on pointer-up.
  if (!deferCommit) commitHistory();
}

// ---------------------------------------------------------------- undo

const HISTORY_LIMIT = 100;
// Pointer-based undo/redo: assemblyHistory[i] holds the assembly snapshot
// after step i (index 0 is the initial state). Mutators call commitHistory()
// once their world mutation is complete; it drops the redo tail past the
// pointer before appending, so branching mutations discard their redo path.
const assemblyHistory: AssemblyState[] = [world.toJSON()];
let historyPointer = 0;

function commitHistory(): void {
  assemblyHistory.splice(historyPointer + 1);
  assemblyHistory.push(world.toJSON());
  if (assemblyHistory.length > HISTORY_LIMIT) assemblyHistory.shift();
  historyPointer = assemblyHistory.length - 1;
  // Sync the footer buttons here: mutators tend to refresh() before they
  // commit, and the button state must reflect the new pointer.
  ui.setHistoryState(historyPointer > 0, historyPointer < assemblyHistory.length - 1);
}

function restoreHistoryEntry(): void {
  sceneCtx.setTableLength(world.tableLength, false);
  clearHover();
  clearNormalCandidates();
  refresh();
}

function undoHistory(): boolean {
  if (historyPointer <= 0) {
    ui.notify('Nothing left to undo', 'error');
    return false;
  }
  historyPointer -= 1;
  if (!world.restore(assemblyHistory[historyPointer]!)) {
    historyPointer += 1;
    ui.notify('Could not undo that change', 'error');
    return false;
  }
  restoreHistoryEntry();
  ui.notify('Undid the last change');
  return true;
}

function redoHistory(): boolean {
  if (historyPointer >= assemblyHistory.length - 1) {
    ui.notify('Nothing left to redo', 'error');
    return false;
  }
  historyPointer += 1;
  if (!world.restore(assemblyHistory[historyPointer]!)) {
    historyPointer -= 1;
    ui.notify('Could not redo that change', 'error');
    return false;
  }
  restoreHistoryEntry();
  return true;
}

function assemblyJson(): string {
  return JSON.stringify(world.toJSON(), null, 2);
}

function fallbackCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

async function copyText(text: string, label: string): Promise<boolean> {
  let clipboardError: unknown;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      clipboardError = error;
    }
  }
  if (fallbackCopy(text)) return true;
  console.error(`Could not copy ${label}`, clipboardError);
  return false;
}

interface DesignSummary {
  name: string;
  updatedAt: number;
}

interface DesignIndex {
  version: 1;
  designs: DesignSummary[];
}

function readDesignIndex(): DesignIndex {
  try {
    const parsed = JSON.parse(localStorage.getItem(DESIGN_INDEX_KEY) ?? 'null') as Partial<DesignIndex> | null;
    if (parsed?.version === 1 && Array.isArray(parsed.designs)) {
      return { version: 1, designs: parsed.designs.filter((item): item is DesignSummary =>
        typeof item?.name === 'string' && typeof item.updatedAt === 'number') };
    }
  } catch { /* Recover as an empty browser-local library. */ }
  return { version: 1, designs: [] };
}

function writeDesignIndex(index: DesignIndex): void {
  localStorage.setItem(DESIGN_INDEX_KEY, JSON.stringify(index));
}

function designKey(name: string): string {
  return `${DESIGN_KEY_PREFIX}${encodeURIComponent(name)}`;
}

function migrateLegacySave(): void {
  const index = readDesignIndex();
  if (index.designs.length || !localStorage.getItem(LEGACY_SAVE_KEY)) return;
  const name = 'Saved design';
  localStorage.setItem(designKey(name), localStorage.getItem(LEGACY_SAVE_KEY)!);
  writeDesignIndex({ version: 1, designs: [{ name, updatedAt: Date.now() }] });
}

function designNames(): string[] {
  migrateLegacySave();
  return readDesignIndex().designs.sort((a, b) => b.updatedAt - a.updatedAt).map((design) => design.name);
}

function saveDesign(rawName: string): boolean {
  const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!name) return false;
  try {
    migrateLegacySave();
    localStorage.setItem(designKey(name), assemblyJson());
    const index = readDesignIndex();
    const updatedAt = Date.now();
    const existing = index.designs.find((design) => design.name === name);
    if (existing) existing.updatedAt = updatedAt;
    else index.designs.push({ name, updatedAt });
    writeDesignIndex(index);
    return true;
  } catch (error) {
    console.error('Could not save design', error);
    return false;
  }
}

function loadDesign(name: string): boolean {
  try {
    migrateLegacySave();
    const raw = localStorage.getItem(designKey(name));
    if (!raw) return false;
    // The snapshot is committed after the restore so undo steps back to
    // exactly what the user had before loading.
    if (!world.restore(JSON.parse(raw) as AssemblyState)) return false;
    commitHistory();
    restoreHistoryEntry();
    return true;
  } catch (error) {
    console.error('Could not load design', error);
    return false;
  }
}

function startNewAssembly(): void {
  const fresh = new World();
  seedDefaultTypes(fresh);
  // `world` is shared by the renderer and picking helpers, so restore its
  // canonical empty state instead of replacing its object identity.
  if (!world.restore(fresh.toJSON())) throw new Error('Could not reset assembly state');
  commitHistory();
  clearNormalCandidates();
  refresh();
}

async function copyAssemblyJson(): Promise<boolean> {
  return copyText(assemblyJson(), 'assembly JSON');
}

async function copyShareUrl(): Promise<boolean> {
  syncUrl(world);
  return copyText(window.location.href, 'share URL');
}

function logRejectedGhostClick(placement: Placement): void {
  ui.notify('That square cannot hold a panel', 'error');
  console.warn(JSON.stringify({
    event: 'rejected-red-ghost-placement',
    attempted: {
      action: 'place-panel',
      placement,
      panelTypeId: world.activeTypeId,
      sourceEdge: edgeHover,
      hoveredPanelKey: hoverPanelKey,
      pointer: lastMouse,
    },
    assembly: world.toJSON(),
  }, null, 2));
}

function handleClick(): void {
  // A tap landing on a placed panel selects it, even when an edge ghost is
  // pending: the capture path would have started a paint session for any
  // placeable ghost, so a ghost that survives to the tap is either invalid
  // or unreachable — the user's click is on the panel.
  if (hoverPanelKey) {
    world.selectedKey = world.selectedKey === hoverPanelKey ? null : hoverPanelKey;
    refresh();
    return;
  }
  if (ghostPlacement) {
    if (ghostInvalid) logRejectedGhostClick(ghostPlacement);
    else placePanelAt(ghostPlacement);
    return;
  }
  if (world.selectedKey) {
    world.selectedKey = null;
    refresh();
  }
}

function handleNormalTap(clientX: number, clientY: number): void {
  setNdc(clientX, clientY);
  raycaster.setFromCamera(ndc, sceneCtx.camera);
  const candidate = normalCandidates.get(pickCandidate() ?? '');
  if (candidate) {
    placePanelAt(candidate.placement);
    return;
  }
  const picked = pick();
  if (picked.panelKeyHit) {
    const panel = world.panel(picked.panelKeyHit);
    if (!panel) return;
    world.selectedKey = picked.panelKeyHit;
    refresh();
    showNormalCandidates(candidatesForPanel(panel));
    return;
  }
  if (picked.tablePoint) {
    const candidateOnTable = tableCandidate(picked.tablePoint);
    if (candidateOnTable) {
      placePanelAt(candidateOnTable);
      return;
    }
  }
  if (world.selectedKey) world.selectedKey = null;
  clearNormalCandidates();
  refresh();
}


const ui = new UI(sidebar, viewport, {
  onTypeClick: (id) => {
    world.activeTypeId = id;
    const selected = world.selectedKey ? world.panel(world.selectedKey) : null;
    if (world.selectedKey && selected && selected.typeId !== id) {
      world.retype(world.selectedKey, id);
      commitHistory();
    }
    refresh();
    if (buildMode === 'quick') updateHover(lastMouse.x, lastMouse.y);
    else if (normalCandidates.size > 0) showNormalCandidates([...normalCandidates.values()]);
  },
  onAddCustom: (color) => {
    const type = world.addCustomType(color);
    world.activeTypeId = type.id;
    refresh();
    commitHistory();
    return type.id;
  },
  onSetTypeColor: (id, color) => {
    world.setTypeColor(id, color);
    sceneCtx.syncModelMaterials(world);
    ui.updateTypes(world.types, world.activeTypeId);
    syncUrl(world);
    renderFrame();
    commitHistory();
  },
  onSetMaterialColor: (target, color) => {
    world.setMaterialColor(target, color);
    sceneCtx.syncModelMaterials(world);
    ui.updateMaterials(world.metalColor, world.connectorColor);
    syncUrl(world);
    renderFrame();
    commitHistory();
  },
  onRemoveType: (id, replacementId) => {
    world.removeType(id, replacementId);
    clearNormalCandidates();
    refresh();
    commitHistory();
  },
  onRemoveSelected: () => {
    if (!world.selectedKey) return;
    world.removePanel(world.selectedKey);
    clearNormalCandidates();
    refresh();
    commitHistory();
  },
  onTableSelect: (len) => {
    if (world.tableLength === len) return;
    world.tableLength = len;
    sceneCtx.setTableLength(len);
    clearNormalCandidates();
    refresh();
    commitHistory();
  },
  onSizeSelect: (mode) => {
    sizeMode = mode;
    localStorage.setItem(SIZE_MODE_KEY, mode);
    // Clear and refresh only: re-running hover at the stale cursor position
    // would latch an edge ghost computed against the previous size. The next
    // pointermove computes fresh state at the real cursor.
    clearHover();
    clearNormalCandidates();
    refresh();
  },
  onQuickModeChange: (enabled) => {
    buildMode = enabled ? 'quick' : 'normal';
    localStorage.setItem(QUICK_MODE_KEY, String(enabled));
    sceneCtx.setPlacementMode(buildMode);
    world.selectedKey = null;
    clearHover();
    clearNormalCandidates();
    refresh();
  },
  onSaveNamed: (name) => saveDesign(name),
  onLoadNamed: (name) => loadDesign(name),
  onListDesignNames: () => designNames(),
  onNew: () => startNewAssembly(),
  onShare: () => copyShareUrl(),
  onDumpState: () => copyAssemblyJson(),
  onUndo: undoHistory,
  onRedo: redoHistory,
  onTypePointerDown: startTypeDrag,
  onResetView: () => {
    sceneCtx.resetView();
    renderFrame();
  },
});
sceneCtx.setPlacementMode(buildMode);
ui.setQuickMode(buildMode === 'quick', false);
ui.setSizeMode(sizeMode);

window.addEventListener('popstate', () => {
  if (!restoreFromUrl(world)) return;
  sceneCtx.setTableLength(world.tableLength);
  clearHover();
  clearNormalCandidates();
  refresh();
});

// ---------------------------------------------------------------- events

// Continuous placement: a mouse press that starts on a legal placement
// target (candidate marker, edge ghost, or open table square) becomes a
// paint session — the drag places every new legal square the cursor
// crosses, and the whole stroke lands as ONE history entry. Presses that
// start on empty space keep the left-drag camera orbit.
let paintSession: { lastKey: string; placed: number } | null = null;

function paintTarget(clientX: number, clientY: number): Placement | null {
  if (buildMode === 'quick') {
    updateHover(clientX, clientY);
    return ghostPlacement && !ghostInvalid ? ghostPlacement : null;
  }
  setNdc(clientX, clientY);
  raycaster.setFromCamera(ndc, sceneCtx.camera);
  const markerCandidate = normalCandidates.get(pickCandidate() ?? '');
  if (markerCandidate) return markerCandidate.placement;
  updateNormalHover(clientX, clientY);
  return ghostPlacement ? ghostPlacement : null;
}

function paintStep(clientX: number, clientY: number): void {
  if (!paintSession) return;
  const placement = paintTarget(clientX, clientY);
  if (!placement) return;
  const key = panelKey(placement);
  if (key === paintSession.lastKey || !world.canPlace(placement)) return;
  paintSession.lastKey = key;
  paintSession.placed += 1;
  placePanelAt(placement, world.activeTypeId, true);
}

function endPaintSession(): void {
  if (!paintSession) return;
  if (paintSession.placed > 0) {
    commitHistory();
  }
  paintSession = null;
  sceneCtx.controls.enabled = true;
}

viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || typeDrag) return;
  if (e.pointerType === 'mouse') {
    const target = paintTarget(e.clientX, e.clientY);
    if (target && world.canPlace(target)) {
      // Steal the gesture from OrbitControls before its pointerdown runs.
      sceneCtx.controls.enabled = false;
      paintSession = { lastKey: panelKey(target), placed: 1 };
      placePanelAt(target, world.activeTypeId, true);
    }
    return;
  }
  // Rotated touch: OrbitControls' rotate math assumes an unrotated canvas,
  // so we drive orbit and pinch zoom ourselves while the layout is forced
  // landscape (main.ts forcedLandscape()).
  if (e.pointerType === 'touch' && forcedLandscape()) {
    sceneCtx.controls.enabled = false;
  }
}, { capture: true });

// Rotated-mode camera control. Deltas are measured in screen pixels and
// mapped through the inverse of the +90° layout rotation: local dx = dy,
// local dy = -dx. Sensitivity matches OrbitControls' 2π-per-height sweep.
let pinchDist = 0;

function rotatedOrbit(dScreenX: number, dScreenY: number): void {
  const dLocalX = dScreenY;
  const dLocalY = -dScreenX;
  const camera = sceneCtx.camera;
  const target = sceneCtx.controls.target;
  const offset = camera.position.clone().sub(target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  const speed = 2 * Math.PI * sceneCtx.controls.rotateSpeed / canvas.clientHeight;
  spherical.theta -= speed * dLocalX;
  spherical.phi -= speed * dLocalY;
  spherical.phi = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, spherical.phi));
  camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(spherical));
  camera.lookAt(target);
  renderFrame();
}

function rotatedPinch(): void {
  const points = [...activePointers.values()];
  if (points.length !== 2) return;
  const dist = Math.hypot(points[0].cx - points[1].cx, points[0].cy - points[1].cy);
  if (pinchDist > 0 && dist > 0) {
    const camera = sceneCtx.camera;
    const target = sceneCtx.controls.target;
    const offset = camera.position.clone().sub(target);
    const len = Math.max(20, Math.min(790, offset.length() * pinchDist / dist));
    offset.setLength(len);
    camera.position.copy(target).add(offset);
    renderFrame();
  }
  pinchDist = dist;
}

canvas.addEventListener('pointermove', (e) => {
  lastMouse = { x: e.clientX, y: e.clientY };
  if (typeDrag) return;
  const pointer = activePointers.get(e.pointerId);
  if (pointer) {
    const slop = e.pointerType === 'mouse' ? 5 : 10;
    if (Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) >= slop) {
      pointer.moved = true;
      if (!paintSession) clearHover();
    }
    if (paintSession) {
      if (pointer.moved && !camDragging && !touchGesture) paintStep(e.clientX, e.clientY);
      pointer.cx = e.clientX;
      pointer.cy = e.clientY;
      return;
    }
    if (forcedLandscape() && e.pointerType === 'touch') {
      const dScreenX = e.clientX - pointer.cx;
      const dScreenY = e.clientY - pointer.cy;
      pointer.cx = e.clientX;
      pointer.cy = e.clientY;
      if (pointer.moved) {
        if (activePointers.size === 1) rotatedOrbit(dScreenX, dScreenY);
        else rotatedPinch();
      }
      return;
    }
    if (pointer.moved) return;
  }
  if (e.pointerType !== 'mouse' || camDragging) return;
  if (buildMode === 'quick') updateHover(e.clientX, e.clientY);
  else updateNormalHover(e.clientX, e.clientY);
});

canvas.addEventListener('pointerdown', (e) => {
  sceneCtx.controls.rotateSpeed = e.pointerType === 'touch' ? 0.5 : 1;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY, moved: false, type: e.pointerType });
  if (e.pointerType === 'touch' && [...activePointers.values()].filter((pointer) => pointer.type === 'touch').length > 1) touchGesture = true;
  if (e.button === 2) {
    setNdc(e.clientX, e.clientY);
    raycaster.setFromCamera(ndc, sceneCtx.camera);
    rightDown = { panelKey: pick().panelKeyHit, x: e.clientX, y: e.clientY };
    camDragging = true;
    clearHover();
    canvas.style.cursor = 'move';
    renderFrame();
  } else if (e.button === 1) {
    camDragging = true;
    clearHover();
    canvas.style.cursor = 'move';
    renderFrame();
  }
});


canvas.addEventListener('pointerup', (e) => {
  const pointer = activePointers.get(e.pointerId);
  activePointers.delete(e.pointerId);
  // Capture before endPaintSession(): a press that started a paint session
  // already placed on pointer-down, so its tap must not place again.
  const wasPainting = e.button === 0 && !!paintSession;
  if (wasPainting) endPaintSession();
  if (e.button === 2) {
    const panelKeyHit = rightDown && Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) < 5 ? rightDown.panelKey : null;
    rightDown = null;
    camDragging = false;
    canvas.style.cursor = 'default';
    if (panelKeyHit && buildMode === 'quick') {
      world.removePanel(panelKeyHit);
      clearHover();
      clearNormalCandidates();
      refresh();
      commitHistory();
    } else if (buildMode === 'quick') {
      updateHover(e.clientX, e.clientY);
    }
  } else if (e.button === 1) {
    camDragging = false;
    canvas.style.cursor = 'default';
    if (buildMode === 'quick') updateHover(e.clientX, e.clientY);
  } else if (e.button === 0 && pointer && !pointer.moved && !camDragging && !touchGesture && !wasPainting) {
    if (buildMode === 'quick') {
      // Touch taps carry no preceding pointermove, so quick mode has no
      // hover state yet — derive it from the tap point first.
      if (e.pointerType === 'touch') updateHover(e.clientX, e.clientY);
      handleClick();
    } else {
      handleNormalTap(e.clientX, e.clientY);
    }
  }
  if (activePointers.size === 0) {
    camDragging = false;
    touchGesture = false;
    // Re-enable OrbitControls after any gesture that disabled it (paint
    // sessions, rotated-mode touch camera control).
    sceneCtx.controls.enabled = true;
    pinchDist = 0;
  }
});

function cancelPointer(e: PointerEvent): void {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.delete(e.pointerId);
  rightDown = null;
  camDragging = false;
  // A cancellation terminates the current gesture. Only an outstanding
  // companion pointer keeps the multi-touch tap guard alive.
  touchGesture = activePointers.size > 0;
  endPaintSession();
  clearHover();
  renderFrame();
}

canvas.addEventListener('pointercancel', cancelPointer);
canvas.addEventListener('lostpointercapture', cancelPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Wheel zoom is camera interaction too: drop only the transient quick ghost.
canvas.addEventListener('wheel', () => { clearHover(); renderFrame(); }, { passive: true });

const resize3D = (): void => {
  sceneCtx.camera.aspect = viewport.clientWidth / viewport.clientHeight;
  sceneCtx.camera.updateProjectionMatrix();
  sceneCtx.renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  renderFrame();
};
window.addEventListener('resize', resize3D);
// The portrait layout rotates #app via CSS, which changes the viewport's
// local box without a window resize event — observe the box directly so the
// renderer always matches the rotated canvas size.
new ResizeObserver(resize3D).observe(viewport);

// ---------------------------------------------------------------- drag-to-place

type DragMode = 'place' | 'replace' | 'none';
let typeDrag: { typeId: string } | null = null;
const DRAG_START_PX = 6;

interface DragTarget {
  mode: DragMode;
  panelKeyHit: string | null;
  placement: Placement | null;
}

function dragTarget(clientX: number, clientY: number): DragTarget {
  const rect = canvas.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return { mode: 'none', panelKeyHit: null, placement: null };
  }
  setNdc(clientX, clientY);
  raycaster.setFromCamera(ndc, sceneCtx.camera);
  const picked = pick();
  if (picked.panelKeyHit) return { mode: 'replace', panelKeyHit: picked.panelKeyHit, placement: null };
  const placement = picked.tablePoint ? tableCandidate(picked.tablePoint) : null;
  return { mode: placement ? 'place' : 'none', panelKeyHit: null, placement };
}

function updateTypeDrag(clientX: number, clientY: number): void {
  if (!typeDrag) return;
  const type = world.types.get(typeDrag.typeId);
  if (!type) {
    endTypeDrag(false, clientX, clientY);
    return;
  }
  const target = dragTarget(clientX, clientY);
  sceneCtx.setGhost(target.mode === 'place' && target.placement
    ? { placement: target.placement, type, connectors: world.orientationsFor(target.placement), invalid: false }
    : null);
  canvas.style.cursor = target.mode === 'none' ? 'default' : 'copy';
  ui.setDragChip(target.mode === 'none'
    ? null
    : { kind: type.kind, color: type.color, x: clientX, y: clientY, mode: target.mode });
  renderFrame();
}

function endTypeDrag(commit: boolean, clientX: number, clientY: number): void {
  const drag = typeDrag;
  typeDrag = null;
  document.body.classList.remove('type-dragging');
  ui.setDragChip(null);
  sceneCtx.setGhost(null);
  canvas.style.cursor = 'default';
  if (!drag) return;
  if (commit) {
    const type = world.types.get(drag.typeId);
    const target = dragTarget(clientX, clientY);
    if (type && target.mode === 'replace' && target.panelKeyHit) {
      const panel = world.panel(target.panelKeyHit);
      if (panel && panel.typeId !== type.id) {
        const from = panel.typeId;
        world.retype(target.panelKeyHit, type.id);
        world.activeTypeId = type.id;
        refresh();
        commitHistory();
        ui.notify(`Panel re-typed: “${from}” → “${type.id}”`);
      }
    } else if (type && target.mode === 'place' && target.placement) {
      world.activeTypeId = type.id;
      placePanelAt(target.placement);
      ui.notify(`Placed “${type.id}” panel`);
    }
  }
  renderFrame();
}

function startTypeDrag(id: string, event: PointerEvent): void {
  if (event.button !== 0 || event.pointerType !== 'mouse' || !world.types.has(id)) return;
  const originX = event.clientX;
  const originY = event.clientY;
  document.body.classList.add('type-dragging');
  const move = (ev: PointerEvent) => {
    if (!typeDrag) {
      if (Math.hypot(ev.clientX - originX, ev.clientY - originY) < DRAG_START_PX) return;
      typeDrag = { typeId: id };
      clearHover();
      clearNormalCandidates();
    }
    updateTypeDrag(ev.clientX, ev.clientY);
  };
  const finish = (commit: boolean) => (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    endTypeDrag(commit, ev.clientX, ev.clientY);
  };
  const up = finish(true);
  const cancel = finish(false);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

window.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.altKey) {
    e.preventDefault();
    if (e.shiftKey) redoHistory();
    else undoHistory();
  } else if ((e.ctrlKey || e.metaKey) && key === 'y' && !e.altKey) {
    e.preventDefault();
    redoHistory();
  }
});

// ---------------------------------------------------------------- rendering

const screenPos = { x: 0, y: 0, visible: false };

function updateOverlays(): void {
  if (world.selectedKey) {
    const mesh = sceneCtx.panelMesh(world.selectedKey);
    if (mesh) {
      sceneCtx.projectToScreen([mesh.position.x, mesh.position.y, mesh.position.z], screenPos, viewportEl);
      ui.setSelectedTrash(screenPos);
    } else {
      ui.setSelectedTrash({ ...screenPos, visible: false });
    }
  } else {
    ui.setSelectedTrash({ x: 0, y: 0, visible: false });
  }


}

// Headless/hidden pages never tick requestAnimationFrame, so render on demand:
// camera moves, hover changes, and state edits each trigger an explicit render.
// The guard stops the controls 'change' -> render -> controls.update loop.
let rendering = false;
function renderFrame(): void {
  if (rendering) return;
  rendering = true;
  sceneCtx.controls.update();
  sceneCtx.renderer.render(sceneCtx.scene, sceneCtx.camera);
  updateOverlays();
  rendering = false;
}
sceneCtx.controls.addEventListener('change', () => {
  if (activePointers.size > 0) {
    camDragging = true;
    for (const pointer of activePointers.values()) pointer.moved = true;
    clearHover();
  }
  renderFrame();
});

function debugInfo(): {
  mode: BuildMode;
  hoverPanelKey: string | null;
  edgeHover: unknown;
  ghostPlacement: unknown;
  ghostInvalid: boolean;
  normalCandidateCount: number;
  pickedPanel: string | null;
  hasTablePoint: boolean;
} {
  setNdc(lastMouse.x, lastMouse.y);
  raycaster.setFromCamera(ndc, sceneCtx.camera);
  const picked = pick();
  return {
    mode: buildMode,
    hoverPanelKey,
    edgeHover,
    ghostPlacement,
    ghostInvalid,
    normalCandidateCount: normalCandidates.size,
    pickedPanel: picked.panelKeyHit,
    hasTablePoint: picked.tablePoint !== null,
  };
}


 (window as unknown as Record<string, unknown>).__builder = { world, sceneCtx, undo: undoHistory, redo: redoHistory, get undoDepth() { return historyPointer; }, get redoDepth() { return assemblyHistory.length - 1 - historyPointer; }, startTypeDrag, debug: { info: debugInfo, raycaster, ndc, setNdc, updateHover, get anchors() { return connectorAnchors; }, get gesture() { return { camDragging, touchGesture, activePointerCount: activePointers.size, normalCandidateCount: normalCandidates.size }; } } };

loadPanelAssets().then((defaults) => {
  if (defaults) {
    defaultPlainColor = defaults.panel;
    if (!restoredFromUrl && world.panels.size === 0) {
      world.setTypeColor('plain', defaults.panel);
      world.metalColor = defaults.metal;
      world.connectorColor = defaults.connector;
    }
    sceneCtx.syncModelMaterials(world);
  }
  refresh();
});
refresh();
