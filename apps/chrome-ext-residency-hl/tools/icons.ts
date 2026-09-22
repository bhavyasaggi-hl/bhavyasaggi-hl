/**
 * Generates the extension's PNG icons at build time.
 *
 * Chrome only accepts raster icons, and committing binaries makes the mark hard
 * to review. The glyph — a globe inside a rounded square — is described
 * analytically, rasterized with 4x supersampling and encoded as 8-bit RGBA PNG.
 */

import { deflateSync } from 'node:zlib';

export const ICON_SIZES = [16, 32, 48, 128] as const;

const SAMPLES = 4;
const BACKGROUND: readonly [number, number, number] = [47, 91, 234];
const FOREGROUND: readonly [number, number, number] = [255, 255, 255];
const GLOBE_RADIUS = 0.3;

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Signed distance to a rounded square centred on the origin. */
function roundedSquare({ x, y }: Point, half: number, radius: number): number {
  const dx = Math.max(Math.abs(x) - (half - radius), 0);
  const dy = Math.max(Math.abs(y) - (half - radius), 0);
  return Math.hypot(dx, dy) - radius;
}

function ring({ x, y }: Point, radius: number, thickness: number): number {
  return Math.abs(Math.hypot(x, y) - radius) - thickness / 2;
}

/**
 * First-order distance to an ellipse: `f / |grad f|`, which stays accurate near
 * the poles where a naive radial estimate bulges.
 */
function ellipseRing({ x, y }: Point, radiusX: number, radiusY: number, thickness: number): number {
  const f = (x / radiusX) ** 2 + (y / radiusY) ** 2 - 1;
  const gradient = 2 * Math.hypot(x / radiusX ** 2, y / radiusY ** 2);
  const approx = gradient === 0 ? -Math.min(radiusX, radiusY) : f / gradient;
  return Math.abs(approx) - thickness / 2;
}

/** A latitude line, clipped to the globe. */
function band(point: Point, halfHeight: number, thickness: number): number {
  const inside = Math.hypot(point.x, point.y) <= GLOBE_RADIUS;
  return inside ? Math.abs(Math.abs(point.y) - halfHeight) - thickness / 2 : 1;
}

/** True when the glyph covers the unit-square point. */
function inGlyph(point: Point, stroke: number): boolean {
  return (
    Math.min(
      ring(point, GLOBE_RADIUS, stroke),
      ellipseRing(point, GLOBE_RADIUS * 0.45, GLOBE_RADIUS, stroke),
      band(point, 0, stroke),
      band(point, GLOBE_RADIUS * 0.55, stroke * 0.85),
    ) <= 0
  );
}

interface Raster {
  readonly size: number;
  readonly stroke: number;
  readonly plateRadius: number;
}

function coverage(
  px: number,
  py: number,
  raster: Raster,
): { readonly plate: number; readonly glyph: number } {
  const { size, stroke, plateRadius } = raster;
  let plateHits = 0;
  let glyphHits = 0;
  for (let sy = 0; sy < SAMPLES; sy += 1) {
    for (let sx = 0; sx < SAMPLES; sx += 1) {
      const point: Point = {
        x: (px + (sx + 0.5) / SAMPLES) / size - 0.5,
        y: (py + (sy + 0.5) / SAMPLES) / size - 0.5,
      };
      if (roundedSquare(point, 0.5, plateRadius) <= 0) {
        plateHits += 1;
        if (inGlyph(point, stroke)) {
          glyphHits += 1;
        }
      }
    }
  }
  const total = SAMPLES * SAMPLES;
  return { plate: plateHits / total, glyph: glyphHits / total };
}

/** Renders one icon and returns its PNG bytes. */
export function renderIcon(size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const raster: Raster = {
    size,
    stroke: size <= 16 ? 0.075 : size <= 48 ? 0.05 : 0.04,
    plateRadius: size <= 16 ? 0.14 : 0.2,
  };

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const { plate, glyph } = coverage(px, py, raster);
      const offset = (py * size + px) * 4;
      const mix = plate === 0 ? 0 : Math.min(glyph / plate, 1);
      for (let channel = 0; channel < 3; channel += 1) {
        const base = BACKGROUND[channel] ?? 0;
        const mark = FOREGROUND[channel] ?? 0;
        rgba[offset + channel] = Math.round(base + (mark - base) * mix);
      }
      rgba[offset + 3] = Math.round(plate * 255);
    }
  }

  return encodePng(size, rgba);
}
