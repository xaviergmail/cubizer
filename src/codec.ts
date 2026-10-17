import type { AssemblyState, Panel, PanelType } from './model';
import { panelKey } from './model';

// Compact binary codec for the assembly share link. The JSON snapshot is
// verbose (a long link hits Discord's URL limit and gets attached as a text
// file), while the restore-relevant state is small: connectors are derived
// from the panel set on restore, so the codec stores only the table length,
// colors, the active type, the selected panel (as an index), types, and
// panels. Layout: 'CUB' magic + flag byte + deflate-raw body (uncompressed
// fallback when CompressionStream is unavailable), base64url-encoded.

// Panel spans (12×16 / 16×12) live on a separate branch; the wire format
// carries them anyway so share links stay forward-compatible if it lands.
type PanelWithSpan = Panel & { span?: [number, number] };

const MAGIC = [0x43, 0x55, 0x42]; // 'CUB'
const FLAG_DEFLATED = 0x01;
const FLAG_METAL_COLOR = 0x01;
const FLAG_CONNECTOR_COLOR = 0x02;

const PLANE_CODES = ['x', 'y', 'z'] as const;
const KIND_CODES = ['plain', 'grid', 'outline'] as const;

class ByteWriter {
  private bytes: number[] = [];

  byte(value: number): void {
    this.bytes.push(value & 0xff);
  }

  raw(values: number[] | Uint8Array): void {
    for (const value of values) this.bytes.push(value & 0xff);
  }

  // Unsigned LEB128 varint (values < 2^31).
  varint(value: number): void {
    let v = value >>> 0;
    for (;;) {
      let low = v & 0x7f;
      v >>>= 7;
      if (v !== 0) low |= 0x80;
      this.bytes.push(low);
      if (v === 0) break;
    }
  }

  // Zig-zag encoding for signed lattice coordinates.
  zig(value: number): void {
    this.varint((value << 1) ^ (value >> 31));
  }

  // 0 => custom type 'custom-<n>'; 1 => literal string id.
  typeId(id: string): void {
    const custom = /^custom-(\d+)$/.exec(id);
    if (custom) {
      this.byte(0);
      this.varint(Number(custom[1]));
    } else {
      const encoded = new TextEncoder().encode(id);
      this.byte(1);
      this.varint(encoded.length);
      this.raw(encoded);
    }
  }

  hexColor(hex: string | undefined): void {
    this.raw(hexToBytes(hex));
  }

  get finished(): number[] {
    return this.bytes;
  }
}

class ByteReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  private take(): number {
    if (this.offset >= this.bytes.length) throw new Error('truncated');
    return this.bytes[this.offset++]!;
  }

  byte(): number {
    return this.take();
  }

  raw(length: number): number[] {
    if (this.offset + length > this.bytes.length) throw new Error('truncated');
    const slice = Array.from(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return slice;
  }

  varint(): number {
    let result = 0;
    for (let shift = 0; shift < 32; shift += 7) {
      const value = this.take();
      result |= (value & 0x7f) << shift;
      if ((value & 0x80) === 0) return result >>> 0;
    }
    throw new Error('varint overflow');
  }

  zig(): number {
    const raw = this.varint();
    return (raw >>> 1) ^ -(raw & 1);
  }

  typeId(): string {
    const tag = this.take();
    if (tag === 0) return `custom-${this.varint()}`;
    if (tag === 1) return new TextDecoder().decode(new Uint8Array(this.raw(this.varint())));
    throw new Error('bad id tag');
  }

  hexColor(): string {
    const [r, g, b] = this.raw(3);
    const toHex = (v: number) => v.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  get atEnd(): boolean {
    return this.offset >= this.bytes.length;
  }
}

function hexToBytes(hex: string | undefined): number[] {
  const digits = (hex ?? '').replace('#', '').slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) return [0, 0, 0];
  return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
}

function serialize(state: AssemblyState): number[] {
  const out = new ByteWriter();
  const stateFlags =
    (typeof state.metalColor === 'string' ? FLAG_METAL_COLOR : 0)
    | (typeof state.connectorColor === 'string' ? FLAG_CONNECTOR_COLOR : 0);
  out.byte(stateFlags);
  out.varint(Math.max(0, Math.round(state.tableLength)));

  const types = state.types;
  const panels = state.panels;
  const typeIndex = new Map(types.map((type, index) => [type.id, index] as const));
  const panelIndex = new Map(panels.map((panel, index) => [panelKey(panel), index + 1] as const));
  out.varint(state.selectedKey ? panelIndex.get(state.selectedKey) ?? 0 : 0);
  out.varint(typeIndex.get(state.activeTypeId) ?? 0);

  out.varint(types.length);
  for (const type of types) {
    const kindCode = KIND_CODES.indexOf(type.kind);
    out.byte((kindCode === -1 ? 0 : kindCode) | (type.custom ? 0x80 : 0));
    out.hexColor(type.color);
    out.typeId(type.id);
  }

  out.varint(panels.length);
  for (const panel of panels) {
    const span = (panel as PanelWithSpan).span;
    const spanPresent = span !== undefined;
    const planeCode = PLANE_CODES.indexOf(panel.plane);
    out.varint(panel.id);
    out.varint(typeIndex.get(panel.typeId) ?? 0);
    out.byte((planeCode === -1 ? 1 : planeCode) | (spanPresent ? 0x04 : 0));
    out.zig(panel.i);
    out.zig(panel.j);
    out.zig(panel.k);
    if (spanPresent) {
      out.byte((span[0] === 16 ? 1 : 0) | (span[1] === 16 ? 2 : 0));
    }
  }

  if ((stateFlags & FLAG_METAL_COLOR) !== 0) out.hexColor(state.metalColor);
  if ((stateFlags & FLAG_CONNECTOR_COLOR) !== 0) out.hexColor(state.connectorColor);
  return out.finished;
}

function parseToState(payload: Uint8Array): AssemblyState {
  const reader = new ByteReader(payload);
  const stateFlags = reader.byte();
  const tableLength = reader.varint();
  const selectedPanelIndex = reader.varint();
  const activeTypeIndex = reader.varint();

  const typeCount = reader.varint();
  const types: PanelType[] = [];
  for (let i = 0; i < typeCount; i++) {
    const kindByte = reader.byte();
    if (kindByte < 0x80 && (kindByte & 0x7f) >= KIND_CODES.length) throw new Error('bad kind');
    const kind = KIND_CODES[kindByte & 0x7f]!;
    const color = reader.hexColor();
    const id = reader.typeId();
    types.push({ id, kind, color, custom: (kindByte & 0x80) !== 0 });
  }

  const panelCount = reader.varint();
  const panels: Panel[] = [];
  for (let i = 0; i < panelCount; i++) {
    const id = reader.varint();
    const typeIndex = reader.varint();
    const typeId = types[typeIndex]?.id;
    if (typeId === undefined) throw new Error('panel type out of range');
    const meta = reader.byte();
    const plane = PLANE_CODES[meta & 0x03];
    if (plane === undefined) throw new Error('bad plane');
    const position: Pick<Panel, 'i' | 'j' | 'k'> = { i: reader.zig(), j: reader.zig(), k: reader.zig() };
    if ((meta & 0x04) !== 0) {
      const spanByte = reader.byte();
      // span is unknown on this branch; carry it through for the sizes PR.
      const panel: PanelWithSpan = { id, ...position, plane, typeId };
      panel.span = [spanByte & 1 ? 16 : 12, spanByte & 2 ? 16 : 12];
      panels.push(panel);
    } else {
      panels.push({ id, ...position, plane, typeId });
    }
  }

  const metalColor = (stateFlags & FLAG_METAL_COLOR) !== 0 ? reader.hexColor() : undefined;
  const connectorColor = (stateFlags & FLAG_CONNECTOR_COLOR) !== 0 ? reader.hexColor() : undefined;
  if (!reader.atEnd) throw new Error('trailing bytes');

  return {
    version: 1,
    tableLength,
    activeTypeId: types[activeTypeIndex]?.id ?? 'plain',
    selectedKey:
      selectedPanelIndex > 0 && selectedPanelIndex <= panels.length
        ? panelKey(panels[selectedPanelIndex - 1]!)
        : null,
    metalColor,
    connectorColor,
    types,
    panels,
    connectors: [],
  };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new CompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
  } catch {
    return null;
  }
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new DecompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    writer.write(bytes);
    writer.close();
    return new Uint8Array(await new Response(stream.readable).arrayBuffer());
  } catch {
    return null;
  }
}

export async function encodeAssemblyLink(state: AssemblyState): Promise<string> {
  const deflated = await deflateRaw(new Uint8Array(serialize(state)));
  const payload = deflated
    ? [...MAGIC, FLAG_DEFLATED, ...deflated]
    : [...MAGIC, 0, ...serialize(state)];
  return bytesToBase64Url(new Uint8Array(payload));
}

export async function decodeAssemblyLink(raw: string): Promise<AssemblyState | null> {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(raw);
  } catch {
    return null;
  }
  if (bytes.length < 4) return null;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return null;
  }
  const flags = bytes[3]!;
  const body = bytes.subarray(4);
  try {
    const payload = (flags & FLAG_DEFLATED) !== 0 ? await inflateRaw(body) : body;
    return payload ? parseToState(payload) : null;
  } catch {
    return null;
  }
}
