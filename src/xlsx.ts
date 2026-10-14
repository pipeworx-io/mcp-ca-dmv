/**
 * Minimal, dependency-free XLSX reader — the XLSX half of mcps/georgia-energy/src/xlsx.ts,
 * copied pack-local (packs share no runtime deps beyond @pipeworx/shared). Runs on the
 * Workers runtime: ZIP central directory, inflated with the native DecompressionStream,
 * then read with targeted regexes.
 *
 * ⚠️ Empty cells are self-closing, so the self-closing alternative of CELL_RE MUST come
 * first, or a value silently lands under the neighbouring column letter.
 */

// ── ZIP ────────────────────────────────────────────────────────────────────

async function inflateRaw(payload: Uint8Array): Promise<Uint8Array> {
  const src = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
  const stream = src.pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const merged = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return merged;
}

/** Enumerate a ZIP's entries and inflate each one to text. */
async function unzipToMap(bytes: Uint8Array): Promise<Map<string, string>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('XLSX: no ZIP End Of Central Directory record found');
  const total = dv.getUint16(eocd + 10, true);
  let cd = dv.getUint32(eocd + 16, true);

  const out = new Map<string, string>();
  const dec = new TextDecoder('utf-8');
  for (let n = 0; n < total; n++) {
    if (dv.getUint32(cd, true) !== 0x02014b50) break;
    const method = dv.getUint16(cd + 10, true);
    const compSize = dv.getUint32(cd + 20, true);
    const fnLen = dv.getUint16(cd + 28, true);
    const extraLen = dv.getUint16(cd + 30, true);
    const commentLen = dv.getUint16(cd + 32, true);
    const localOffset = dv.getUint32(cd + 42, true);
    const name = dec.decode(bytes.subarray(cd + 46, cd + 46 + fnLen));
    cd += 46 + fnLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    // Only the XML parts matter; skip printerSettings*.bin, media, theme blobs.
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    if (dv.getUint32(localOffset, true) !== 0x04034b50) continue;
    const lFnLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lFnLen + lExtraLen;
    const payload = bytes.subarray(dataStart, dataStart + compSize);

    if (method === 0) out.set(name, dec.decode(payload));
    else if (method === 8) out.set(name, dec.decode(await inflateRaw(payload)));
  }
  return out;
}

// ── XLSX ───────────────────────────────────────────────────────────────────

export type Sheet = {
  name: string;
  /** row number (1-based, as written in the file) -> column letter -> value */
  rows: Map<number, Map<string, string | number>>;
};

export type Workbook = { sheets: Sheet[] };

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function unescapeXml(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

// Self-closing FIRST — see the header note. Getting this order wrong shifts
// values into neighbouring columns without erroring.
const CELL_RE = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
const ROW_RE = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;

export async function parseXlsx(bytes: Uint8Array): Promise<Workbook> {
  const parts = await unzipToMap(bytes);
  const wbXml = parts.get('xl/workbook.xml');
  if (!wbXml) throw new Error('XLSX: xl/workbook.xml missing — not an OOXML workbook');
  const relsXml = parts.get('xl/_rels/workbook.xml.rels') ?? '';

  const relMap = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/>/g)) {
    const id = /Id="([^"]+)"/.exec(m[1])?.[1];
    const target = /Target="([^"]+)"/.exec(m[1])?.[1];
    if (id && target) relMap.set(id, target);
  }

  const shared: string[] = [];
  const sstXml = parts.get('xl/sharedStrings.xml');
  if (sstXml) {
    for (const si of sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      let text = '';
      for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]);
      shared.push(text);
    }
  }

  const sheets: Sheet[] = [];
  for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const name = unescapeXml(/name="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const rid = /r:id="([^"]+)"/.exec(attrs)?.[1] ?? '';
    const target = relMap.get(rid);
    if (!target) continue;
    const clean = target.replace(/^\//, '');
    const path = clean.startsWith('xl/') ? clean : `xl/${clean}`;
    const sheetXml = parts.get(path);
    if (!sheetXml) continue;

    const rows = new Map<number, Map<string, string | number>>();
    for (const rm of sheetXml.matchAll(ROW_RE)) {
      const rowNum = Number(rm[1]);
      const cells = new Map<string, string | number>();
      for (const cm of rm[2].matchAll(CELL_RE)) {
        const attrsC = cm[1] !== undefined ? cm[1] : cm[2];
        const inner = cm[3] ?? '';
        const ref = /r="([A-Z]+)\d+"/.exec(attrsC ?? '')?.[1];
        if (!ref) continue;
        const type = /t="([^"]+)"/.exec(attrsC ?? '')?.[1] ?? 'n';
        let value: string | number | undefined;
        if (type === 'inlineStr') {
          let text = '';
          for (const t of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]);
          value = text;
        } else {
          const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
          if (raw === undefined) continue;
          if (type === 's') value = shared[Number(raw)] ?? '';
          else if (type === 'str' || type === 'e') value = unescapeXml(raw);
          else {
            const n = Number(raw);
            value = Number.isFinite(n) ? n : unescapeXml(raw);
          }
        }
        if (value === undefined || value === '') continue;
        cells.set(ref, value);
      }
      if (cells.size) rows.set(rowNum, cells);
    }
    sheets.push({ name, rows });
  }
  return { sheets };
}
