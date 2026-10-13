// Lattice model. Units: 1 = 12 inches (one panel). y is up; table top at y = 0.
// A panel is a unit square on an axis-aligned plane named by its normal axis:
//   plane 'x' -> x = i*STEP fixed, varies y (j..j+1) and z (k..k+1)
//   plane 'y' -> horizontal, y = j*STEP fixed, varies x and z
//   plane 'z' -> z = k*STEP fixed, varies x and y
// Connectors live at lattice points. A connector has a plate plane (same naming)
// and a sign along the plate normal: it serves the 4 in-plane squares around the
// point, plus the 4 perpendicular squares that extend along `sign` of the normal.

export type Plane = 'x' | 'y' | 'z';
export const STEP = 12;

export interface PanelType {
  id: string;
  kind: 'plain' | 'grid' | 'outline';
  color: string;
  custom: boolean;
}

export interface Panel {
  id: number;
  plane: Plane;
  i: number;
  j: number;
  k: number;
  typeId: string;
  span?: Span;
}

export type Placement = Pick<Panel, 'plane' | 'i' | 'j' | 'k' | 'span'>;
export type Corner = [number, number, number];
// In-plane extents in inches along the plane's two varying axes, in the same
// order panelCorners uses them. Absent = the standard 12x12 panel.
export type Span = [number, number];
export type SizeMode = '12x12' | '12x16' | '16x12';
export const SIZE_MODES = ['12x12', '12x16', '16x12'] as const;

// sizeMode names its dimensions width x height for standing panels; for a
// flat (y-plane) panel "height" runs along z. A 16" dimension always extends
// off the 12" connector lattice; its far corners therefore host no connectors.
export function spanForSize(plane: Plane, size: SizeMode): Span {
  if (size === '12x12') return [STEP, STEP];
  // plane 'x' varies (y, z): its first axis is vertical, so the modes swap.
  const [w, h] = size === '12x16' ? [STEP, 16] : [16, STEP];
  return plane === 'x' ? [h, w] : [w, h];
}

export function panelSpan(p: Placement): Span {
  return p.span ?? [STEP, STEP];
}

// Only 12"/16" extents with at most one 16" dimension are real products.
export function isValidSpan(span: unknown): span is Span {
  return Array.isArray(span) && span.length === 2
    && span.every((v) => v === STEP || v === 16)
    && span.filter((v) => v === 16).length <= 1;
}

export interface Connector {
  plane: Plane;
  sign: 1 | -1;
  // Cosmetic quarter-turn around the cross-side axis. Pointy-side direction
  // is determined structurally by plane and sign.
  turn?: 0 | 1 | 2 | 3;
}

export interface AssemblyState {
  version: 1;
  tableLength: number;
  activeTypeId: string;
  selectedKey: string | null;
  metalColor?: string;
  connectorColor?: string;
  types: PanelType[];
  panels: Panel[];
  connectors: Array<{ point: Corner; plane: Plane; sign: 1 | -1; turn?: 0 | 1 | 2 | 3 }>;
}

export const baseKey = (p: Placement) => `${p.plane}:${p.i},${p.j},${p.k}`;
export const panelKey = (p: Placement) => {
  const [a, b] = panelSpan(p);
  return a === STEP && b === STEP ? baseKey(p) : `${baseKey(p)}@${a}x${b}`;
};
export const pointKey = (c: Corner) => `${c[0]},${c[1]},${c[2]}`;

export function parsePointKey(key: string): Corner {
  const [i, j, k] = key.split(',').map(Number);
  return [i, j, k];
}

// Physical corners in inches, ordered origin, +first axis, +second axis, far.
export function panelCornersIn(p: Placement): Array<[number, number, number]> {
  const [a, b] = panelSpan(p);
  const { i, j, k } = p;
  const x = i * STEP, y = j * STEP, z = k * STEP;
  if (p.plane === 'x') return [[x, y, z], [x, y + a, z], [x, y, z + b], [x, y + a, z + b]];
  if (p.plane === 'y') return [[x, y, z], [x + a, y, z], [x, y, z + b], [x + a, y, z + b]];
  return [[x, y, z], [x + a, y, z], [x, y + b, z], [x + a, y + b, z]];
}

// Lattice-unit corners: the physical corners lying on the 12" grid. A 16"
// dimension never lands on the lattice, so sized panels expose only their
// 12-inch-edge corners — exactly the points that can host connectors.
export function panelCorners(p: Placement): Corner[] {
  return panelCornersIn(p)
    .filter((c) => c.every((v) => v % STEP === 0))
    .map((c) => [c[0] / STEP, c[1] / STEP, c[2] / STEP] as Corner);
}
// Returns the common boundary segment when two panels share a full edge.
// One shared corner is merely a diagonal connection; four means the same square.
export function sharedPanelEdge(a: Placement, b: Placement): [Corner, Corner] | null {
  const bCorners = new Set(panelCornersIn(b).map(pointKey));
  const shared = panelCornersIn(a).filter((corner) => bCorners.has(pointKey(corner)));
  return shared.length === 2 ? [shared[0], shared[1]] : null;
}

export function panelCenter(p: Placement): Corner {
  const [a, b] = panelSpan(p);
  if (p.plane === 'x') return [p.i * STEP, p.j * STEP + a / 2, p.k * STEP + b / 2];
  if (p.plane === 'y') return [p.i * STEP + a / 2, p.j * STEP, p.k * STEP + b / 2];
  return [p.i * STEP + a / 2, p.j * STEP + b / 2, p.k * STEP];
}

function touchesCorner(p: Placement, c: Corner): boolean {
  const near = (min: number, cv: number, extent: number) => min === cv || min + extent === cv;
  const [a, b] = panelSpan(p);
  const { i, j, k } = p;
  if (p.plane === 'x') return i * STEP === c[0] * STEP && near(j * STEP, c[1] * STEP, a) && near(k * STEP, c[2] * STEP, b);
  if (p.plane === 'y') return j * STEP === c[1] * STEP && near(i * STEP, c[0] * STEP, a) && near(k * STEP, c[2] * STEP, b);
  return k * STEP === c[2] * STEP && near(i * STEP, c[0] * STEP, a) && near(j * STEP, c[1] * STEP, b);
}


// Extent direction of a panel from a shared corner along an axis (0=i,1=j,2=k).
function quad(p: Placement, c: Corner, axis: 0 | 1 | 2): 1 | -1 {
  const min = axis === 0 ? p.i : axis === 1 ? p.j : p.k;
  return min === c[axis] ? 1 : -1;
}

export function connectorServes(conn: Connector, p: Placement, c: Corner): boolean {
  if (p.plane === conn.plane) return true; // in-plane: any quadrant
  const axis: 0 | 1 | 2 = conn.plane === 'x' ? 0 : conn.plane === 'y' ? 1 : 2;
  return quad(p, c, axis) === conn.sign;
}

export function validOrientations(panels: Placement[], c: Corner): Connector[] {
  const out: Connector[] = [];
  for (const plane of ['y', 'z', 'x'] as const) {
    for (const sign of [1, -1] as const) {
      const conn: Connector = { plane, sign };
      if (panels.every((p) => connectorServes(conn, p, c))) out.push(conn);
    }
  }
  return out;
}


// The 12 lattice squares that share a corner point.
export function squaresAtCorner(c: Corner): Placement[] {
  const out: Placement[] = [];
  for (const plane of ['x', 'y', 'z'] as const) {
    for (const a of [-1, 0] as const) {
      for (const b of [-1, 0] as const) {
        if (plane === 'x') out.push({ plane, i: c[0], j: c[1] + a, k: c[2] + b });
        else if (plane === 'y') out.push({ plane, i: c[0] + a, j: c[1], k: c[2] + b });
        else out.push({ plane, i: c[0] + a, j: c[1] + b, k: c[2] });
      }
    }
  }
  return out;
}

// A connector is warranted wherever panels meet, and at every panel corner
// touching the table. Vertical panels therefore receive hubs at both ends of
// their bottom edge even when no other panel has joined them yet.
export function cornerNeedsConnector(panels: Placement[], c: Corner): boolean {
  return panels.length > 0 && (panels.length >= 2 || c[1] === 0);
}

// The connector's pointed/domed side is its cross-side structure. Scene
// orientation maps the model's local +Y onto this signed plate normal.
function pointyDirection(conn: Pick<Connector, 'plane' | 'sign'>): Corner {
  if (conn.plane === 'x') return [conn.sign, 0, 0];
  if (conn.plane === 'y') return [0, conn.sign, 0];
  return [0, 0, conn.sign];
}

// Preserve the authored chair-facing turn for a free horizontal deck hub.
// This does not control the pointy side; plane/sign do.
function connectorTurn(panels: Placement[], conn: Pick<Connector, 'plane'>): 0 | 1 | 2 | 3 {
  return conn.plane === 'y' && panels.every((panel) => panel.plane === 'y') ? 2 : 0;
}

function centreFacingOrientation(
  valid: Connector[],
  c: Corner,
  tableLength: number,
  anchorPlane: Plane,
): Connector | undefined {
  const towardCentre: Corner = [tableLength / 2 - c[0] * STEP, 0, -c[2] * STEP];
  let chosen: Connector | undefined;
  let bestScore = 0;
  for (const candidate of valid) {
    const direction = pointyDirection(candidate);
    const score = direction[0] * towardCentre[0] + direction[2] * towardCentre[2];
    if (
      score > bestScore
      || (score === bestScore && score > 0 && candidate.plane === anchorPlane && chosen?.plane !== anchorPlane)
    ) {
      bestScore = score;
      chosen = candidate;
    }
  }
  return chosen;
}

export function chooseOrientation(panels: Placement[], c: Corner, tableLength = 72): Connector {
  const valid = validOrientations(panels, c);
  if (valid.length === 0) {
    // Invalid placement (ghost preview of an illegal move): pick the orientation
    // serving the most panels so a red preview can still be rendered.
    let best: Pick<Connector, 'plane' | 'sign'> = { plane: panels[0].plane, sign: 1 };
    let bestScore = -1;
    for (const plane of ['y', 'z', 'x'] as const) {
      for (const sign of [1, -1] as const) {
        const conn = { plane, sign };
        const score = panels.filter((p) => connectorServes(conn, p, c)).length;
        if (score > bestScore) {
          bestScore = score;
          best = conn;
        }
      }
    }
    return { ...best, turn: connectorTurn(panels, best) };
  }

  const anchorPlane = panels[0].plane;
  const up = valid.find((candidate) => candidate.plane === 'y' && candidate.sign === 1);
  const down = valid.find((candidate) => candidate.plane === 'y' && candidate.sign === -1);
  const chosen =
    // A table-contact hub must retain a horizontal plate and point up so the
    // connector's flat side rests on the table.
    (c[1] === 0 ? up : undefined) ??
    centreFacingOrientation(valid, c, tableLength, anchorPlane) ??
    // When centre-facing is structurally unavailable, prefer down; only an
    // unavoidably non-vertical connection falls through to the anchor plane.
    down ??
    up ??
    valid.find((candidate) => candidate.plane === anchorPlane && candidate.sign === 1) ??
    valid.find((candidate) => candidate.plane === anchorPlane) ??
    valid[0];
  return { ...chosen, turn: connectorTurn(panels, chosen) };
}

// Axis-aligned sheet intersection. Each panel is a zero-thickness sheet on
// its plane axis. Two panels conflict when their sheets cross: either they
// are coplanar with a positive-area overlap, or one sheet's plane lies
// strictly inside the other's extent (a deck slicing through a wall).
// Edge and corner contact stay legal.
function panelIntervals(p: Placement): Array<[number, number]> {
  const [a, b] = panelSpan(p);
  const pos = [p.i * STEP, p.j * STEP, p.k * STEP];
  const planeAxis = p.plane === 'x' ? 0 : p.plane === 'y' ? 1 : 2;
  return [0, 1, 2].map((axis) => {
    if (axis === planeAxis) return [pos[axis], pos[axis]] as [number, number];
    const ext = p.plane === 'x' ? (axis === 1 ? a : b) : p.plane === 'y' ? (axis === 0 ? a : b) : (axis === 0 ? a : b);
    return [pos[axis], pos[axis] + ext] as [number, number];
  });
}

export function panelsOverlap(a: Placement, b: Placement): boolean {
  const A = panelIntervals(a), B = panelIntervals(b);
  for (let axis = 0; axis < 3; axis++) {
    if (Math.max(A[axis]![0], B[axis]![0]) > Math.min(A[axis]![1], B[axis]![1])) return false;
  }
  const inside = (pos: number, [lo, hi]: [number, number]) => pos > lo && pos < hi;
  const thinA = a.plane === 'x' ? 0 : a.plane === 'y' ? 1 : 2;
  const thinB = b.plane === 'x' ? 0 : b.plane === 'y' ? 1 : 2;
  if (thinA === thinB) {
    const others = [0, 1, 2].filter((axis) => axis !== thinA);
    return others.every((axis) => Math.max(A[axis]![0], B[axis]![0]) < Math.min(A[axis]![1], B[axis]![1]));
  }
  return inside(A[thinA]![0], B[thinA]!) || inside(B[thinB]![0], A[thinB]!);
}

export class World {
  panels = new Map<string, Panel>();
  connectors = new Map<string, Connector>();
  types = new Map<string, PanelType>();
  activeTypeId = 'plain';
  selectedKey: string | null = null;
  tableLength = 72; // inches; 6 ft default
  metalColor = '#2f3945';
  connectorColor = '#2b2f33';
  private nextPanelId = 1;
  private nextCustomType = 1;

  panel(key: string): Panel | undefined {
    return this.panels.get(key);
  }

  panelsAt(c: Corner): Placement[] {
    const out: Placement[] = [];
    for (const p of this.panels.values()) {
      if (touchesCorner(p, c)) out.push(p);
    }
    return out;
  }

  canPlace(s: Placement): boolean {
    if (s.j < 0) return false;
    if (this.panels.has(panelKey(s))) return false;
    for (const existing of this.panels.values()) {
      if (panelsOverlap(s, existing)) return false;
    }
    for (const c of panelCorners(s)) {
      const existing = this.panelsAt(c);
      if (existing.length > 0 && validOrientations([...existing, s], c).length === 0) return false;
    }
    return true;
  }

  // Connector orientation this placement would get at each of its corners.
  orientationsFor(s: Placement): Map<string, Connector> {
    const out = new Map<string, Connector>();
    for (const c of panelCorners(s)) {
      const panels = [...this.panelsAt(c), s];
      out.set(pointKey(c), chooseOrientation(panels, c, this.tableLength));
    }
    return out;
  }

  place(s: Placement, typeId: string): Panel {
    const panel: Panel = { ...s, id: this.nextPanelId++, typeId };
    this.panels.set(panelKey(panel), panel);
    for (const c of panelCorners(panel)) {
      const pk = pointKey(c);
      const here = this.panelsAt(c);
      if (cornerNeedsConnector(here, c)) {
        this.connectors.set(pk, chooseOrientation(here, c, this.tableLength));
      } else {
        this.connectors.delete(pk);
      }
    }
    return panel;
  }

  removePanel(key: string): void {
    const panel = this.panels.get(key);
    if (!panel) return;
    this.panels.delete(key);
    for (const c of panelCorners(panel)) {
      const pk = pointKey(c);
      const remaining = this.panelsAt(c);
      if (remaining.length === 0 || !cornerNeedsConnector(remaining, c)) this.connectors.delete(pk);
      else this.connectors.set(pk, chooseOrientation(remaining, c, this.tableLength));
    }
    if (this.selectedKey === key) this.selectedKey = null;
  }
  retype(key: string, typeId: string): void {
    const panel = this.panels.get(key);
    if (panel) panel.typeId = typeId;
  }

  setTypeColor(id: string, color: string): void {
    const type = this.types.get(id);
    if (type?.kind === 'plain') type.color = color;
  }

  setMaterialColor(target: 'metal' | 'connector', color: string): void {
    if (target === 'metal') this.metalColor = color;
    else this.connectorColor = color;
  }

  addCustomType(color: string): PanelType {
    const t: PanelType = { id: `custom-${this.nextCustomType++}`, kind: 'plain', color, custom: true };
    this.types.set(t.id, t);
    this.activeTypeId = t.id;
    return t;
  }

  removeType(id: string, replacementId: string | null): void {
    if (!this.types.get(id)?.custom) return; // the 3 default types cannot be removed
    if (replacementId && replacementId !== id && this.types.has(replacementId)) {
      for (const panel of this.panels.values()) {
        if (panel.typeId === id) panel.typeId = replacementId;
      }
    } else {
      for (const key of [...this.panels.keys()]) {
        if (this.panels.get(key)!.typeId === id) this.removePanel(key);
      }
    }
    this.types.delete(id);
    if (this.activeTypeId === id) this.activeTypeId = replacementId && this.types.has(replacementId) ? replacementId : 'plain';
  }

  // Stable, plain-data representation for clipboard export and diagnostics.
  // Maps and counters are intentionally omitted: they are implementation state,
  // not part of the assembly someone needs to reproduce.
  toJSON(): AssemblyState {
    return {
      version: 1,
      tableLength: this.tableLength,
      activeTypeId: this.activeTypeId,
      selectedKey: this.selectedKey,
      metalColor: this.metalColor,
      connectorColor: this.connectorColor,
      types: [...this.types.values()].map((type) => ({ ...type })),
      panels: [...this.panels.values()].map((panel) => ({ ...panel })),
      connectors: [...this.connectors.entries()].map(([key, connector]) => ({
        point: parsePointKey(key),
        plane: connector.plane,
        sign: connector.sign,
        turn: connector.turn,
      })),
    };
  }

  // Restore a shared URL snapshot. Connectors are derived from the panel set
  // so a stale or hand-edited connector list cannot corrupt the assembly.
  restore(state: AssemblyState): boolean {
    if (
      state?.version !== 1
      || !Number.isFinite(state.tableLength) || state.tableLength <= 0
      || !Array.isArray(state.types) || !Array.isArray(state.panels)
    ) return false;

    const types = new Map<string, PanelType>();
    for (const type of state.types) {
      if (
        !type || typeof type.id !== 'string' || !['plain', 'grid', 'outline'].includes(type.kind)
        || typeof type.color !== 'string' || typeof type.custom !== 'boolean' || types.has(type.id)
      ) return false;
      types.set(type.id, { ...type });
    }
    if (!types.has('plain') || !types.has('grid') || !types.has('outline')) return false;

    const panels = new Map<string, Panel>();
    let maxPanelId = 0;
    for (const panel of state.panels) {
      if (
        !panel || !['x', 'y', 'z'].includes(panel.plane)
        || !Number.isInteger(panel.i) || !Number.isInteger(panel.j) || !Number.isInteger(panel.k)
        || !Number.isInteger(panel.id) || !types.has(panel.typeId)
      ) return false;
      if (panel.span !== undefined && !isValidSpan(panel.span)) return false;
      const key = panelKey(panel);
      if (panels.has(key)) return false;
      panels.set(key, { ...panel });
      maxPanelId = Math.max(maxPanelId, panel.id);
    }

    this.types = types;
    this.panels = panels;
    this.connectors = new Map();
    this.tableLength = state.tableLength;
    this.metalColor = typeof state.metalColor === 'string' ? state.metalColor : '#2f3945';
    this.connectorColor = typeof state.connectorColor === 'string' ? state.connectorColor : '#2b2f33';
    this.activeTypeId = types.has(state.activeTypeId) ? state.activeTypeId : 'plain';
    this.nextPanelId = maxPanelId + 1;
    this.nextCustomType = Math.max(
      1,
      ...[...types.keys()].flatMap((id) => {
        const match = /^custom-(\d+)$/.exec(id);
        return match ? [Number(match[1]) + 1] : [];
      }),
    );

    const corners = new Map<string, Corner>();
    for (const panel of panels.values()) {
      for (const corner of panelCorners(panel)) corners.set(pointKey(corner), corner);
    }
    for (const [key, corner] of corners) {
      const here = this.panelsAt(corner);
      if (cornerNeedsConnector(here, corner)) {
        this.connectors.set(key, chooseOrientation(here, corner, this.tableLength));
      }
    }
    return true;
  }
  // Empty connectable squares for the active panel size. Candidates are
  // deduplicated per lattice anchor regardless of span, and each carries the
  // active size's span so validity (overlap included) is judged as placed.
  candidates(size: SizeMode = '12x12'): Placement[] {
    const seen = new Set<string>();
    const out: Placement[] = [];
    for (const panel of this.panels.values()) {
      for (const c of panelCorners(panel)) {
        for (const s of squaresAtCorner(c)) {
          if (s.j < 0) continue;
          const withSpan: Placement = { ...s, span: spanForSize(s.plane, size) };
          const base = baseKey(s);
          if (seen.has(base)) continue;
          seen.add(base);
          if (this.canPlace(withSpan)) out.push(withSpan);
        }
      }
    }
    return out;
  }
}
