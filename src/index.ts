interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}
/**
 * California DMV MCP — registered vehicles and EV adoption by ZIP code, field offices,
 * the official forms catalog, and insurer NAIC codes. Keyless.
 *
 * One pack per state agency: California's grain (a ZIP × make × model-year × fuel snapshot,
 * one CKAN resource per year) has nothing in common with New York's record-level file or
 * Washington's monthly transaction counts, so each state gets its own tools with its own
 * real arguments instead of a union schema where most arguments are ignored.
 *
 * Sources (verified live 2026-07-29):
 *   data.ca.gov CKAN  — "Vehicle Fuel Type Count by Zip Code", one resource per annual
 *                       snapshot 2019–2026; "Driver Licenses Outstanding by County" (an
 *                       XLSX download since 2026-10-01, parsed in ./xlsx.ts)
 *   dmv.ca.gov WP REST — field offices (hours + per-office service tags), forms catalog,
 *                        insurance-carrier (NAIC) lookup
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be answered
 * comes back as { found: false, reason, hint }.
 */

import { parseXlsx } from './xlsx.js';

const UA = 'pipeworx-mcp-ca-dmv/1.0 (+https://pipeworx.io)';
const CKAN_DOMAIN = 'data.ca.gov';
const WP = 'https://www.dmv.ca.gov/portal/wp-json';

/**
 * One CKAN resource per annual snapshot. The label year is the snapshot date (1/1/YYYY);
 * the rows themselves carry the prior 12/31 in their `Date` column, which is the real as-of.
 */
const FUEL_RESOURCES: Record<string, string> = {
  '2026': 'b459d957-5d94-4b10-999d-770419870364',
  '2025': '66b0121e-5eab-4fcf-aa0d-2b1dfb5510ab',
  '2024': 'd599c3d3-87af-4e8c-8694-9c01f49e3d93',
  '2023': '9aa5b4c5-252c-4d68-b1be-ffe19a2f1d26',
  '2022': '1856386b-a196-4e7c-be81-44174e29ad50',
  '2021': '888bbb6c-09b4-469c-82e6-1b2a47439736',
  '2020': '4254a06d-9937-4083-9441-65597dd267e8',
  '2019': 'd304108a-06c1-462f-a144-981dd0109900',
};
const LATEST_YEAR = '2026';
const AVAILABLE_YEARS = Object.keys(FUEL_RESOURCES).sort();
const DL_RESOURCE = '0abef7f0-285f-4887-9b4e-69e86d89ceb1';

// Exact `Fuel` labels as published.
const PLUGIN_FUELS = ['Battery Electric', 'Plug-in Hybrid'];
const ELECTRIFIED_FUELS = ['Battery Electric', 'Plug-in Hybrid', 'Hybrid Gasoline', 'Hydrogen Fuel Cell'];

/** Plain words agents actually pass → the exact label California publishes. */
const FUEL_ALIASES: Record<string, string> = {
  gas: 'Gasoline', gasoline: 'Gasoline', petrol: 'Gasoline',
  diesel: 'Diesel and Diesel Hybrid',
  electric: 'Battery Electric', ev: 'Battery Electric', bev: 'Battery Electric',
  phev: 'Plug-in Hybrid', 'plug-in hybrid': 'Plug-in Hybrid', 'plug in hybrid': 'Plug-in Hybrid',
  hybrid: 'Hybrid Gasoline',
  hydrogen: 'Hydrogen Fuel Cell', 'fuel cell': 'Hydrogen Fuel Cell',
  'flex-fuel': 'Flex-Fuel', flex: 'Flex-Fuel',
  'natural gas': 'Natural Gas', cng: 'Natural Gas',
};

const GROUP_COLUMNS: Record<string, string> = {
  fuel: 'Fuel', zip: 'ZIP Code', make: 'Make', model_year: 'Model Year', duty: 'Duty',
};

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DAY_ABBR: Record<string, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

function resolveYear(args: Record<string, unknown>): { year: string; resource: string } | Record<string, unknown> {
  const year = govString(args, 'year') ?? LATEST_YEAR;
  const resource = FUEL_RESOURCES[year];
  if (!resource) {
    return govNotFound(
      'year_unavailable',
      `California publishes annual snapshots for ${AVAILABLE_YEARS.join(', ')}. Retry with one of those years.`,
      { requested_year: year, available_years: AVAILABLE_YEARS },
    );
  }
  return { year, resource };
}

/** WHERE fragments shared by the registration and EV tools. */
function buildFilters(args: Record<string, unknown>): { clauses: string[]; applied: Record<string, unknown> } {
  const clauses: string[] = [];
  const zip = govString(args, 'zip');
  if (zip) clauses.push(`"ZIP Code" = '${zip.replace(/'/g, "''")}'`);
  const rawFuel = govString(args, 'fuel_type');
  const fuel = rawFuel ? FUEL_ALIASES[rawFuel.toLowerCase()] ?? rawFuel : undefined;
  if (fuel) clauses.push(`"Fuel" ILIKE '%${fuel.replace(/'/g, "''")}%'`);
  const make = govString(args, 'make');
  if (make) clauses.push(`"Make" ILIKE '%${make.replace(/'/g, "''")}%'`);
  const modelYear = govString(args, 'model_year');
  if (modelYear) clauses.push(`"Model Year" = '${modelYear.replace(/'/g, "''")}'`);
  const duty = govString(args, 'duty');
  if (duty) clauses.push(`"Duty" ILIKE '%${duty.replace(/'/g, "''")}%'`);
  return { clauses, applied: { zip, fuel_type: fuel, make, model_year: modelYear, duty } };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ca_dmv_vehicle_registrations',
    description:
      'Count vehicles registered in California from official DMV data, broken down by ZIP code, make, model year, fuel type or light/heavy duty. Each row is a count of registered vehicles from the California DMV "Vehicle Fuel Type Count by Zip Code" file, with annual snapshots back to 2019, so it answers "how many vehicles are registered in ZIP 90210", "how many Toyotas are registered in California", or "how many 2024-model-year vehicles are on California roads". For electric-vehicle share of the fleet use ca_dmv_ev_adoption; for a DMV office address use ca_dmv_offices.',
    inputSchema: {
      type: 'object',
      properties: {
        zip: { type: 'string', description: 'Five-digit California ZIP code, e.g. "90210".' },
        fuel_type: { type: 'string', description: 'Fuel/drivetrain; plain words are mapped to California\'s labels, e.g. "electric", "diesel", "gas", "hybrid", "plug-in hybrid", "hydrogen".' },
        make: { type: 'string', description: 'Vehicle make, matched as a substring, e.g. "TESLA", "FORD".' },
        model_year: { type: 'string', description: 'Four-digit model year, e.g. "2024".' },
        duty: { type: 'string', description: 'Vehicle weight class: "Light", "Heavy" or "Unk".' },
        year: { type: 'string', description: `Snapshot year, ${AVAILABLE_YEARS[0]}–${LATEST_YEAR}. Defaults to ${LATEST_YEAR} (the most recent).` },
        group_by: { type: 'string', description: 'Breakdown dimension: fuel (default), zip, make, model_year, duty.' },
        limit: { type: ['number', 'string'], description: 'Max rows to return (default 25, max 200).' },
      },
    },
  },
  {
    name: 'ca_dmv_ev_adoption',
    description:
      'Measure electric-vehicle adoption in California from DMV registration counts: how many battery-electric and plug-in hybrid vehicles are registered in a ZIP code or statewide, and what share of all registered vehicles that represents. Returns the full fuel mix with a plug-in share and an electrified share (which also counts conventional hybrids and hydrogen), or a breakdown of plug-in vehicles by make, ZIP or model year. Answers "EV share in ZIP 94002", "which ZIP codes in California have the most EVs", "how many Teslas are registered in California", and trend questions via the year argument (snapshots back to 2019).',
    inputSchema: {
      type: 'object',
      properties: {
        zip: { type: 'string', description: 'Five-digit California ZIP code, e.g. "94002".' },
        make: { type: 'string', description: 'Vehicle make, matched as a substring, e.g. "TESLA", "RIVIAN".' },
        model_year: { type: 'string', description: 'Four-digit model year, e.g. "2025".' },
        year: { type: 'string', description: `Snapshot year, ${AVAILABLE_YEARS[0]}–${LATEST_YEAR}. Defaults to ${LATEST_YEAR}.` },
        group_by: { type: 'string', description: 'fuel (default) returns the whole mix plus EV share; zip, make or model_year return plug-in counts by that dimension.' },
        limit: { type: ['number', 'string'], description: 'Max rows to return (default 25, max 200).' },
      },
    },
  },
  {
    name: 'ca_dmv_offices',
    description:
      'Find California DMV field offices with street address, per-day opening hours, coordinates and the services each office actually performs (behind-the-wheel retest, duplicate title, ID cards, self-service terminals, CDL medical and more). Answers "DMV office in Sacramento", "which California DMV near San Jose does driving tests", or "DMV offices in ZIP 95814". Covers all 187 field offices from the DMV\'s own directory. For live wait times, California publishes none — nc_dmv_wait_times and or_dmv_wait_times are the only state feeds that exist.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, matched as a substring, e.g. "Sacramento", "San Jose".' },
        zip: { type: 'string', description: 'Five-digit ZIP code, e.g. "95814".' },
        name: { type: 'string', description: 'Office-name substring, e.g. "Express", "Commercial".' },
        service: { type: 'string', description: 'Require a service, e.g. "dl retest", "duplicate title", "id cards", "self service terminals".' },
        limit: { type: ['number', 'string'], description: 'Max offices to return (default 50, max 200).' },
      },
    },
  },
  {
    name: 'ca_dmv_forms',
    description:
      'Search the official California DMV forms catalog by topic and get each form\'s name, its REG/DL/BOAT form number, and the page to download it from. Answers "which California DMV form transfers a title", "CA DMV form for a duplicate registration", "form to report the sale of a vehicle", or a lookup by number like "REG 227". Results follow the DMV site\'s own relevance ranking, so a broad phrase can surface a vessel form alongside the vehicle one.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the form is for, e.g. "title transfer", "duplicate registration", "change of address", or a form number like "REG 227".' },
        limit: { type: ['number', 'string'], description: 'Max forms to return (default 10, max 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ca_dmv_insurance_lookup',
    description:
      'Look up an auto insurer\'s five-digit NAIC code from the California DMV insurance-carrier list by company name. California requires the NAIC number when reporting insurance for a registered vehicle, so this answers "NAIC code for State Farm", "what is Geico\'s NAIC number", or "insurer codes matching Progressive". The list is California\'s; NAIC codes themselves are national.',
    inputSchema: {
      type: 'object',
      properties: {
        insurer: { type: 'string', description: 'Insurance company name or fragment, e.g. "State Farm", "Geico", "Progressive".' },
      },
      required: ['insurer'],
    },
  },
  {
    name: 'ca_dmv_driver_licenses',
    description:
      'Count driver licenses outstanding in California by county of residence, as an annual series from 2008 onward, with the statewide total and the statewide count of DMV ID cards. Answers "how many licensed drivers are in Los Angeles County", "which California county has the most driver licenses", or how a county\'s licensed-driver count has changed over time. Counts people holding a license, which is a different question from how many vehicles are registered — for that use ca_dmv_vehicle_registrations.',
    inputSchema: {
      type: 'object',
      properties: {
        county: { type: 'string', description: 'County name, matched as a substring, e.g. "Los Angeles", "Alameda".' },
        year: { type: 'string', description: 'Four-digit year from 2008 to the latest published (2024 as of October 2026), e.g. "2024". Defaults to the most recent.' },
        limit: { type: ['number', 'string'], description: 'Max counties to return (default 30, max 60).' },
      },
    },
  },
];

// ── Handlers ────────────────────────────────────────────────────────

async function vehicleRegistrations(args: Record<string, unknown>): Promise<unknown> {
  const resolved = resolveYear(args);
  if ('found' in resolved) return resolved;
  const { year, resource } = resolved as { year: string; resource: string };

  const groupKey = (govString(args, 'group_by') ?? 'fuel').toLowerCase();
  const groupCol = GROUP_COLUMNS[groupKey];
  if (!groupCol) {
    return govNotFound('unsupported_group_by', `California supports group_by of ${Object.keys(GROUP_COLUMNS).join(', ')}.`, {
      supported_group_by: Object.keys(GROUP_COLUMNS),
    });
  }

  const { clauses, applied } = buildFilters(args);
  const limit = govLimit(args.limit, 25, 200);
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const sql =
    `SELECT "${groupCol}" AS grouped, SUM("Vehicles"::numeric) AS vehicles FROM "${resource}"${where} ` +
    `GROUP BY "${groupCol}" ORDER BY vehicles DESC LIMIT ${limit}`;
  const records = await ckanSql<{ grouped: string; vehicles: string }>(CKAN_DOMAIN, sql, { userAgent: UA });
  if (!records.length) {
    return govNotFound(
      'no_matching_records',
      'No California registrations matched those filters. Widen them — drop `make`, or check the ZIP is a California ZIP.',
      { filters_applied: applied },
    );
  }
  const total = records.reduce((a, r) => a + (govNumber(r.vehicles) ?? 0), 0);
  const truncated = records.length >= limit;
  return {
    state: 'CA',
    grain: `registered vehicle counts by ${groupKey}${applied.zip ? ` for ZIP ${applied.zip}` : ', statewide'}`,
    as_of: `${Number(year) - 1}-12-31`,
    source: `data.ca.gov — California DMV Vehicle Fuel Type Count by Zip Code (${year} snapshot)`,
    // Grouping by fuel returns every category, so its sum is the real fleet total; any other
    // grouping can be cut off by `limit` and must not be presented as a total.
    ...(groupKey === 'fuel' && !truncated ? { total_vehicles: total } : {}),
    sum_of_returned_rows: total,
    truncated,
    rows: records.map((r) => ({ [groupKey]: r.grouped, vehicles: govNumber(r.vehicles) })),
    ...(groupKey === 'zip'
      ? { note: 'A literal "OOS" bucket holds out-of-state registrants and outranks every real ZIP; ignore it when ranking ZIPs.' }
      : {}),
  };
}

async function evAdoption(args: Record<string, unknown>): Promise<unknown> {
  const resolved = resolveYear(args);
  if ('found' in resolved) return resolved;
  const { year, resource } = resolved as { year: string; resource: string };

  const groupKey = (govString(args, 'group_by') ?? 'fuel').toLowerCase();
  const { clauses, applied } = buildFilters(args);
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const asOf = `${Number(year) - 1}-12-31`;
  const source = `data.ca.gov — California DMV Vehicle Fuel Type Count by Zip Code (${year} snapshot)`;

  if (groupKey === 'fuel') {
    const sql =
      `SELECT "Fuel" AS grouped, SUM("Vehicles"::numeric) AS vehicles FROM "${resource}"${where} ` +
      `GROUP BY "Fuel" ORDER BY vehicles DESC`;
    const records = await ckanSql<{ grouped: string; vehicles: string }>(CKAN_DOMAIN, sql, { userAgent: UA });
    if (!records.length) {
      return govNotFound('no_matching_records', 'No California vehicles matched those filters — check the ZIP is a California ZIP.', {
        filters_applied: applied,
      });
    }
    const total = records.reduce((a, r) => a + (govNumber(r.vehicles) ?? 0), 0);
    const sumOf = (labels: string[]) =>
      records.filter((r) => labels.includes(r.grouped)).reduce((a, r) => a + (govNumber(r.vehicles) ?? 0), 0);
    const plugin = sumOf(PLUGIN_FUELS);
    const electrified = sumOf(ELECTRIFIED_FUELS);
    const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : null);
    return {
      state: 'CA',
      grain: `fuel mix for ${applied.zip ? `ZIP ${applied.zip}` : 'all of California'}`,
      as_of: asOf,
      source,
      total_vehicles: total,
      plugin_vehicles: plugin,
      plugin_share_pct: pct(plugin),
      electrified_vehicles: electrified,
      electrified_share_pct: pct(electrified),
      rows: records.map((r) => ({ fuel: r.grouped, vehicles: govNumber(r.vehicles) })),
      note: 'plugin counts Battery Electric + Plug-in Hybrid; electrified additionally counts Hybrid Gasoline and Hydrogen Fuel Cell.',
    };
  }

  const groupCol = GROUP_COLUMNS[groupKey];
  if (!groupCol) {
    return govNotFound('unsupported_group_by', 'California EV data supports group_by of fuel, zip, make, model_year, duty.', {
      supported_group_by: Object.keys(GROUP_COLUMNS),
    });
  }
  const limit = govLimit(args.limit, 25, 200);
  const fuelList = PLUGIN_FUELS.map((f) => `'${f}'`).join(', ');
  const evWhere = where ? `${where} AND "Fuel" IN (${fuelList})` : ` WHERE "Fuel" IN (${fuelList})`;
  const sql =
    `SELECT "${groupCol}" AS grouped, SUM("Vehicles"::numeric) AS vehicles FROM "${resource}"${evWhere} ` +
    `GROUP BY "${groupCol}" ORDER BY vehicles DESC LIMIT ${limit}`;
  const records = await ckanSql<{ grouped: string; vehicles: string }>(CKAN_DOMAIN, sql, { userAgent: UA });
  if (!records.length) {
    return govNotFound('no_matching_records', 'No California plug-in vehicles matched those filters.', { filters_applied: applied });
  }
  return {
    state: 'CA',
    grain: `plug-in vehicle counts by ${groupKey}`,
    as_of: asOf,
    source,
    plugin_vehicles: records.reduce((a, r) => a + (govNumber(r.vehicles) ?? 0), 0),
    truncated: records.length >= limit,
    rows: records.map((r) => ({ [groupKey]: r.grouped, vehicles: govNumber(r.vehicles) })),
    ...(groupKey === 'make'
      ? { note: 'An "OTHER/UNK" make absorbs small-count suppression and can outrank real makes.' }
      : {}),
    ...(groupKey === 'zip'
      ? { note: 'A literal "OOS" bucket holds out-of-state registrants; ignore it when ranking ZIPs.' }
      : {}),
  };
}

interface Office {
  name: string;
  address: string | null;
  city: string | null;
  zip: string | null;
  hours: string | null;
  latitude: number | null;
  longitude: number | null;
  services: string[];
  appointment_url: string | null;
  url: string | null;
}

async function loadOffices(): Promise<Office[]> {
  // 187 offices, and WP REST caps per_page at 100.
  const pages = await Promise.all(
    [1, 2].map((page) =>
      govFetchJson<Array<Record<string, any>>>(
        `${WP}/wp/v2/dmv_field-office?per_page=100&page=${page}`,
        { userAgent: UA },
      ).catch(() => [] as Array<Record<string, any>>),
    ),
  );
  return pages.flat().map((it) => {
    const meta = (it.meta ?? {}) as Record<string, any>;
    const hoursObj = Array.isArray(meta.dmv_field_office_hours) ? meta.dmv_field_office_hours[0] : null;
    const hours = hoursObj
      ? govJoinHours(
          DAY_KEYS.map((d) => {
            const h = hoursObj[d];
            const range = h && h.start && h.end && !/^closed$/i.test(String(h.start)) ? `${h.start}-${h.end}` : null;
            return [DAY_ABBR[d], range] as [string, unknown];
          }),
        )
      : null;
    const services = (Array.isArray(it.class_list) ? it.class_list : [])
      .filter((c: unknown) => typeof c === 'string' && c.startsWith('dmv_services-'))
      .map((c: string) => c.replace('dmv_services-', '').replace(/-/g, ' '));
    return {
      name: String(it.title?.rendered ?? '').trim(),
      address: meta.dmv_field_office_street ?? null,
      city: meta.dmv_field_office_city ?? null,
      zip: meta.dmv_field_office_zipcode ?? null,
      hours,
      latitude: govNumber(meta.dmv_field_office_latitude),
      longitude: govNumber(meta.dmv_field_office_longitude),
      services,
      appointment_url: meta.dmv_field_office_appointment ? String(meta.dmv_field_office_appointment) : null,
      url: it.link ?? null,
    };
  });
}

async function offices(args: Record<string, unknown>): Promise<unknown> {
  let list = await loadOffices();
  const city = govString(args, 'city');
  if (city) list = list.filter((o) => govContains(o.city, city));
  const zip = govString(args, 'zip');
  if (zip) list = list.filter((o) => (o.zip ?? '').startsWith(zip));
  const name = govString(args, 'name');
  if (name) list = list.filter((o) => govContains(o.name, name));
  const service = govString(args, 'service');
  if (service) list = list.filter((o) => o.services.some((s) => govContains(s, service)));
  if (!list.length) {
    return govNotFound(
      'no_matching_offices',
      'No California DMV office matched those filters. Drop the narrowest one — `service` and `city` are the usual culprits — or call with no arguments for the full list of 187.',
      { filters_applied: { city, zip, name, service } },
    );
  }
  const limit = govLimit(args.limit, 50, 200);
  return {
    state: 'CA',
    source: 'dmv.ca.gov field-office directory',
    office_count: list.length,
    offices: list.slice(0, limit).map((o) => ({ state: 'CA', office_type: 'Field office', ...o })),
  };
}

async function forms(args: Record<string, unknown>): Promise<unknown> {
  const query = govString(args, 'query');
  if (!query) {
    return govNotFound('missing_query', 'Pass what the form is for, e.g. query="title transfer" or query="REG 227".');
  }
  const limit = govLimit(args.limit, 10, 50);
  const rows = await govFetchJson<Array<Record<string, any>>>(
    `${WP}/wp/v2/dmv_forms?search=${encodeURIComponent(query)}&per_page=${limit}`,
    { userAgent: UA },
  );
  if (!rows.length) {
    return govNotFound(
      'no_matching_forms',
      `No California DMV form matched "${query}". Try a plainer phrase such as "title", "registration" or "address change".`,
      { query },
    );
  }
  return {
    state: 'CA',
    source: 'dmv.ca.gov official forms catalog',
    query,
    form_count: rows.length,
    forms: rows.map((f) => {
      const title = String(f.title?.rendered ?? '')
        .replace(/&#8217;/g, "'")
        .replace(/&amp;/g, '&');
      const code = title.match(/\(([A-Z]{2,5}\s?\d+[A-Z]?)\)\s*$/);
      return {
        title: title.replace(/\s*\([A-Z]{2,5}\s?\d+[A-Z]?\)\s*$/, '').trim(),
        form_number: code ? code[1].replace(/\s+/g, ' ') : null,
        url: f.link ?? null,
        last_modified: typeof f.modified === 'string' ? f.modified.slice(0, 10) : null,
      };
    }),
  };
}

async function insuranceLookup(args: Record<string, unknown>): Promise<unknown> {
  const insurer = govString(args, 'insurer');
  if (!insurer) {
    return govNotFound('missing_insurer', 'Pass an insurance company name, e.g. insurer="State Farm".');
  }
  const rows = await govFetchJson<Array<{ naic?: string; insurer?: string }>>(
    `${WP}/dmv/v1/naic-lookup?s=${encodeURIComponent(insurer)}`,
    { userAgent: UA },
  );
  if (!Array.isArray(rows) || !rows.length) {
    return govNotFound(
      'no_matching_insurer',
      `No insurer on the California DMV list matched "${insurer}". Try a shorter fragment — "State Farm" rather than the full legal name.`,
      { insurer },
    );
  }
  return {
    state: 'CA',
    source: 'dmv.ca.gov insurance carrier (NAIC) lookup',
    query: insurer,
    match_count: rows.length,
    insurers: rows.map((r) => ({ naic_code: r.naic ?? null, insurer: r.insurer ?? null })),
  };
}

/**
 * "Driver Licenses Outstanding by County" lost its CKAN datastore on 2026-10-01 and is now
 * only an 18 KB XLSX (fleet #3069), so datastore_search 404s deterministically. Resolve
 * the file through resource_show on every cache miss rather than hard-coding its URL: the
 * filename embeds the year range ("…-2008-2024.xlsx") and moves on each annual republish.
 *
 * Sheet layout (verified 2026-10-14): a title row, a header row "COUNTIES | 2024 | 2023 …",
 * one row per county, then OUT OF STATE, TOTAL, and — below a blank row — a statewide
 * "ID CARDS OUTSTANDING" line. The county rows are driver licenses only; ID cards are
 * published statewide, never by county.
 */
interface DlTable {
  years: string[];
  counties: Array<{ county: string; counts: Record<string, number> }>;
  outOfState: Record<string, number>;
  total: Record<string, number>;
  idCards: Record<string, number>;
  fileUrl: string;
  dataAsOf: string | null;
}

const DL_TTL_MS = 6 * 60 * 60 * 1000;
let dlCache: { table: DlTable; fetchedAt: number } | null = null;

/** Upstream misspells one county; agents will type it correctly. */
const COUNTY_FIXES: Record<string, string> = { 'SANTA BARABARA': 'SANTA BARBARA' };

async function loadDriverLicenseTable(): Promise<DlTable> {
  if (dlCache && Date.now() - dlCache.fetchedAt < DL_TTL_MS) return dlCache.table;

  const meta = await govFetchJson<{ result?: { url?: string; last_modified?: string | null; metadata_modified?: string | null } }>(
    `https://${CKAN_DOMAIN}/api/3/action/resource_show?id=${DL_RESOURCE}`,
    { userAgent: UA },
  );
  const fileUrl = meta.result?.url;
  if (!fileUrl) throw new Error(`layout changed: resource ${DL_RESOURCE} has no download url`);
  const res = await fetch(fileUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`upstream ${res.status} fetching the driver-license workbook`);
  const wb = await parseXlsx(new Uint8Array(await res.arrayBuffer()));
  const sheet = wb.sheets[0];
  if (!sheet) throw new Error('layout changed: driver-license workbook has no sheets');

  // Header row = the row whose column A reads COUNTIES; every other column is a year.
  let headerRow: number | null = null;
  const yearByCol = new Map<string, string>();
  for (const [rowNum, cells] of [...sheet.rows].sort((a, b) => a[0] - b[0])) {
    if (String(cells.get('A') ?? '').trim().toUpperCase() !== 'COUNTIES') continue;
    headerRow = rowNum;
    for (const [col, v] of cells) if (/^\d{4}$/.test(String(v).trim())) yearByCol.set(col, String(v).trim());
    break;
  }
  if (headerRow === null || !yearByCol.size) {
    throw new Error('layout changed: no "COUNTIES | <year> …" header row in the driver-license workbook');
  }

  const counts = (cells: Map<string, string | number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [col, year] of yearByCol) {
      const n = govNumber(cells.get(col));
      if (n !== null) out[year] = n;
    }
    return out;
  };

  const table: DlTable = {
    years: [...yearByCol.values()].sort((a, b) => Number(b) - Number(a)),
    counties: [],
    outOfState: {},
    total: {},
    idCards: {},
    fileUrl,
    dataAsOf: (meta.result?.last_modified ?? meta.result?.metadata_modified ?? null)?.slice(0, 10) ?? null,
  };
  for (const [rowNum, cells] of sheet.rows) {
    if (rowNum <= headerRow) continue;
    const label = String(cells.get('A') ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
    if (!label) continue;
    if (label === 'TOTAL') table.total = counts(cells);
    else if (label === 'OUT OF STATE') table.outOfState = counts(cells);
    else if (label.startsWith('ID CARDS')) table.idCards = counts(cells);
    else table.counties.push({ county: COUNTY_FIXES[label] ?? label, counts: counts(cells) });
  }
  // California has 58 counties; far fewer means the parse silently lost rows.
  if (table.counties.length < 50) {
    throw new Error(`layout changed: parsed only ${table.counties.length} county rows from the driver-license workbook`);
  }
  dlCache = { table, fetchedAt: Date.now() };
  return table;
}

async function driverLicenses(args: Record<string, unknown>): Promise<unknown> {
  const table = await loadDriverLicenseTable();
  const yearCols = table.years;
  const requested = govString(args, 'year');
  if (requested && !yearCols.includes(requested)) {
    return govNotFound(
      'year_unavailable',
      `California publishes ${yearCols[yearCols.length - 1]}–${yearCols[0]}. Retry with one of those years.`,
      { requested_year: requested, available_years: yearCols },
    );
  }
  const year = requested ?? yearCols[0];
  const county = govString(args, 'county');
  const limit = govLimit(args.limit, 30, 60);
  let rows = table.counties
    .map((r) => ({ county: r.county, driver_licenses: r.counts[year] ?? null }))
    .filter((r) => r.driver_licenses !== null);
  if (county) rows = rows.filter((r) => govContains(r.county, county));
  rows.sort((a, b) => (b.driver_licenses ?? 0) - (a.driver_licenses ?? 0));
  if (!rows.length) {
    return govNotFound(
      'no_matching_records',
      `No California county matched "${county ?? ''}". Use a bare county name such as "Los Angeles".`,
      { filters_applied: { county, year } },
    );
  }
  return {
    state: 'CA',
    grain: `driver licenses outstanding, by county of residence, for ${year}`,
    as_of: year,
    data_as_of: table.dataAsOf,
    source: 'California DMV — Driver Licenses Outstanding by County (data.ca.gov)',
    available_years: yearCols,
    statewide: {
      driver_licenses_total: table.total[year] ?? null,
      driver_licenses_out_of_state: table.outOfState[year] ?? null,
      id_cards_outstanding: table.idCards[year] ?? null,
    },
    truncated: rows.length > limit,
    rows: rows.slice(0, limit),
    note: 'County rows count driver licenses only. ID cards are published as one statewide figure (statewide.id_cards_outstanding), not by county. statewide.driver_licenses_total includes out-of-state addresses.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'ca_dmv_vehicle_registrations': return await vehicleRegistrations(args);
      case 'ca_dmv_ev_adoption': return await evAdoption(args);
      case 'ca_dmv_offices': return await offices(args);
      case 'ca_dmv_forms': return await forms(args);
      case 'ca_dmv_insurance_lookup': return await insuranceLookup(args);
      case 'ca_dmv_driver_licenses': return await driverLicenses(args);
      default:
        return govNotFound('unknown_tool', `ca-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `ca-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'data.ca.gov timed out. Retry once, and lower `limit` or add a filter to reduce the work upstream.'
        : /upstream 404|layout changed/i.test(message)
          ? 'Not transient: California moved or reshaped this dataset, so a retry returns the same error. Use another ca_dmv tool, or report it with pipeworx_feedback.'
          : 'data.ca.gov refused the request (rate limit or outage). Retry once; if it persists the source is down.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
