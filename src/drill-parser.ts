/**
 * Custom Excellon NC Drill file parser.
 *
 * The @tracespace/parser does not correctly render drill graphics from
 * Excellon files that use trailing-zero suppression (TZ format), which is
 * the most common format produced by KiCad and other EDA tools.
 *
 * This parser handles:
 *  - INCH / METRIC units
 *  - LZ  (Leading Zeros present)  → fixed-point: int_digits.dec_digits
 *  - TZ  (Trailing Zeros present) → last dec_digits of the integer string
 *    are the fractional part  (same as LZ but reversed padding)
 *  - FILE_FORMAT comment for int/dec digit counts
 *  - Tool definitions: T01C0.0200  or  T01F00S00C0.0200
 *  - Tool changes:     T01
 *  - Coordinate lines: X##### Y#####  (X or Y may be absent → sticky)
 *  - Slot cutter lines: X###Y###G85X###Y### (skipped – treated as single hit at start)
 *
 * Returns an SVG string with <circle> elements for every drill hit.
 */
export interface DrillParseResult {
  svg: string;
  bbox: [number, number, number, number];
}

export function parseDrillToSvg(content: string, color: string): DrillParseResult | null {
  const lines = content.split(/\r?\n/);


  // ---------- Header state ----------
  let metric       = false;      // false = INCH
  let zeroMode     = 'TZ';       // 'LZ' or 'TZ'
  let intDigits    = 2;
  let decDigits    = 4;
  let inHeader     = true;       // M48 … %

  // Tool table: key = 'T01', value = diameter in mm
  const tools: Record<string, number> = {};
  let currentTool: string | null = null;

  // Accumulated drill hits
  const holes: { x: number; y: number; r: number }[] = [];

  // Sticky coordinates (modal)
  let curX = 0;
  let curY = 0;

  // --------- Coordinate decoder ---------
  function parseCoord(raw: string): number {
    if (!raw || raw === '') return 0;

    // Handle explicit decimal point (some files do this)
    if (raw.includes('.')) return parseFloat(raw);

    const negative = raw.startsWith('-');
    const digits   = negative ? raw.slice(1) : raw;

    let value: number;
    if (zeroMode === 'TZ') {
      // Trailing zeros present → leading zeros suppressed
      // The last `decDigits` digits = fractional part, rest = integer
      if (digits.length <= decDigits) {
        value = parseInt(digits) / Math.pow(10, decDigits);
      } else {
        const intPart  = digits.slice(0, digits.length - decDigits);
        const decPart  = digits.slice(digits.length - decDigits);
        value = parseInt(intPart) + parseInt(decPart) / Math.pow(10, decDigits);
      }
    } else {
      // LZ: Leading zeros present → trailing zeros suppressed
      // The first `intDigits` digits = integer part, rest = decimal
      const intPart  = digits.slice(0, intDigits).padStart(intDigits, '0');
      const decPart  = digits.slice(intDigits).padEnd(decDigits, '0');
      value = parseInt(intPart) + parseInt(decPart) / Math.pow(10, decDigits);
    }

    return negative ? -value : value;
  }

  // --------- Convert to mm ---------
  function toMm(v: number): number {
    return metric ? v : v * 25.4;
  }

  // --------- Main parse loop ---------
  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line === 'M48') { inHeader = true; continue; }
    if (line === '%') { inHeader = false; continue; }
    if (line === 'M30' || line === 'M00') break;    // End of file

    // ---- Header parsing ----
    if (inHeader) {
      // FILE_FORMAT comment: ;FILE_FORMAT=2:4
      const fmtMatch = line.match(/FILE_FORMAT=(\d+):(\d+)/i);
      if (fmtMatch) {
        intDigits = parseInt(fmtMatch[1]);
        decDigits = parseInt(fmtMatch[2]);
      }
      // Units
      if (/^METRIC/i.test(line)) metric = true;
      if (/^INCH/i.test(line))   metric = false;
      // Zero mode on the same line as METRIC/INCH
      if (/\bLZ\b/.test(line)) zeroMode = 'LZ';
      else if (/\bTZ\b/.test(line)) zeroMode = 'TZ';
      // Standalone LZ / TZ declarations
      if (line === 'LZ') zeroMode = 'LZ';
      if (line === 'TZ') zeroMode = 'TZ';
    }

    // ---- Tool definitions - both in header and body ----
    // Match T##...C#.#### variants  (tool def must have 'C')
    const toolDefMatch = line.match(/^T(\d+).*?C([\d.]+)/);
    if (toolDefMatch && !line.startsWith(';TYPE')) {
      const key      = 'T' + toolDefMatch[1];
      const diam     = parseFloat(toolDefMatch[2]);
      // diameter is in inches if INCH mode, mm otherwise
      tools[key] = metric ? diam : diam * 25.4;
      continue;
    }

    // ---- Tool selection (body) ----
    const toolSelectMatch = line.match(/^T(\d+)$/);
    if (toolSelectMatch) {
      const key = 'T' + toolSelectMatch[1];
      // T00 = unload
      if (toolSelectMatch[1] === '00') {
        currentTool = null;
      } else {
        currentTool = key;
      }
      continue;
    }

    // ---- Coordinate line ----
    if ((line.startsWith('X') || line.startsWith('Y')) && currentTool && tools[currentTool] !== undefined) {
      // Strip G85 routing commands (slots) - treat start as a single hit
      const coordLine = line.split('G85')[0];

      const xMatch = coordLine.match(/X(-?[\d.]+)/);
      const yMatch = coordLine.match(/Y(-?[\d.]+)/);

      if (xMatch) curX = toMm(parseCoord(xMatch[1]));
      if (yMatch) curY = toMm(parseCoord(yMatch[1]));

      const r = tools[currentTool] / 2;
      holes.push({ x: curX, y: curY, r });
    }
  }

  if (holes.length === 0) return null;

  // --------- Build SVG ---------
  const xs     = holes.map(h => h.x);
  const ys     = holes.map(h => h.y);
  const rs     = holes.map(h => h.r);
  const minX   = Math.min(...xs.map((x, i) => x - rs[i]));
  const maxX   = Math.max(...xs.map((x, i) => x + rs[i]));
  const minY   = Math.min(...ys.map((y, i) => y - rs[i]));
  const maxY   = Math.max(...ys.map((y, i) => y + rs[i]));


  const w   = maxX - minX;
  const h   = maxY - minY;

  // SVG's Y-axis points down; Excellon/Gerber's Y-axis points up.
  // We flip with a transform.
  let circles = '';
  for (const hole of holes) {
    circles += `<circle cx="${hole.x.toFixed(5)}" cy="${hole.y.toFixed(5)}" r="${hole.r.toFixed(5)}" fill="${color}" />\n`;
  }

  const svg = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg"
    viewBox="${minX.toFixed(5)} ${minY.toFixed(5)} ${w.toFixed(5)} ${h.toFixed(5)}"
    width="${w.toFixed(3)}mm" height="${h.toFixed(3)}mm">
  <g>
    ${circles}
  </g>
</svg>`;

  return { svg, bbox: [minX, minY, maxX, maxY] };
}

/** Returns true if the file content looks like an Excellon drill file. */
export function isDrillFile(filename: string, content: string): boolean {
  const name = filename.toLowerCase();
  // Extension heuristics
  if (name.endsWith('.drl') || name.endsWith('.exc') || name.endsWith('.xln')) return true;
  // Content heuristics: M48 header or INCH/METRIC with tool defs
  if (content.startsWith('M48') || /^(METRIC|INCH)[,;]/m.test(content)) return true;
  // KiCad drill files end in -drill.txt
  if (name.includes('drill') && name.endsWith('.txt')) return true;
  return false;
}
