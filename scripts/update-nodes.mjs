import fs from 'node:fs/promises';
import path from 'node:path';

const API_URL = process.env.API_URL ?? 'https://www.qilan.de/api/nodes';
const COOKIE = normalizeHeaderValue(process.env.COOKIE ?? process.env.QILAN_COOKIE ?? '');
const FORCE_PUBLIC = isTruthy(process.env.FORCE_PUBLIC);
const DEBUG = isTruthy(process.env.DEBUG ?? process.env.QILAN_DEBUG);
const USER_AGENT = normalizeHeaderValue(process.env.USER_AGENT ?? '');
const AUTHORIZATION = normalizeHeaderValue(process.env.AUTHORIZATION ?? process.env.QILAN_AUTHORIZATION ?? '');
const EXTRA_HEADERS_JSON = normalizeHeaderValue(process.env.EXTRA_HEADERS_JSON ?? process.env.QILAN_EXTRA_HEADERS_JSON ?? '');
const ORIGIN = normalizeHeaderValue(process.env.ORIGIN ?? process.env.QILAN_ORIGIN ?? 'https://www.qilan.de');
const REFERER = normalizeHeaderValue(process.env.REFERER ?? process.env.QILAN_REFERER ?? 'https://www.qilan.de/');
const ACCEPT_LANGUAGE = normalizeHeaderValue(process.env.ACCEPT_LANGUAGE ?? process.env.QILAN_ACCEPT_LANGUAGE ?? 'zh-CN,zh;q=0.9,en;q=0.8');
const OUTPUT_FILE = normalizeHeaderValue(process.env.OUTPUT_FILE ?? process.env.OUT_FILE ?? 'nodes.txt') || 'nodes.txt';
const MIN_LINKS = clampInt(process.env.MIN_LINKS, 0, 0, 20000);

const NODE_COUNT = clampInt(process.env.NODE_COUNT, 1000, 1, 20000);
const MIN_SCORE = clampInt(process.env.MIN_SCORE, 0, 0, 101);
const MAX_SCORE = clampInt(process.env.MAX_SCORE, 101, 0, 101);
const SORT = (process.env.SORT ?? 'newest').trim() || 'newest';
const REGION = (process.env.REGION ?? '').trim();

const API_LIMIT = clampInt(process.env.API_LIMIT, Math.min(NODE_COUNT, 20000), 1, 20000);
const MAX_PAGES = clampInt(process.env.MAX_PAGES, 200, 1, 2000);
const PUBLIC_LIMIT = clampInt(process.env.PUBLIC_LIMIT, 1000, 1, 1000);
const RETRY_COUNT = clampInt(process.env.RETRY_COUNT, 3, 0, 10);
const RETRY_DELAY_MS = clampInt(process.env.RETRY_DELAY_MS, 600, 0, 60_000);

if (MIN_SCORE > MAX_SCORE) {
  throw new Error(`Invalid score range: MIN_SCORE (${MIN_SCORE}) > MAX_SCORE (${MAX_SCORE})`);
}

const outPath = path.resolve(process.cwd(), OUTPUT_FILE);

try {
  await main();
} catch (err) {
  const msg = typeof err?.stack === 'string' ? err.stack : String(err);
  process.stderr.write(msg + '\n');
  process.exitCode = 1;
}

async function main() {
  const mode = FORCE_PUBLIC ? 'public' : (COOKIE ? 'member' : 'public');

  let links = [];
  try {
    links = await fetchLinks({
      apiUrl: API_URL,
      cookie: COOKIE,
      nodeCount: NODE_COUNT,
      apiLimit: API_LIMIT,
      maxPages: MAX_PAGES,
      minScore: MIN_SCORE,
      maxScore: MAX_SCORE,
      sort: SORT,
      region: REGION,
      mode,
      publicLimit: PUBLIC_LIMIT,
      userAgent: USER_AGENT,
      authorization: AUTHORIZATION,
      extraHeadersJson: EXTRA_HEADERS_JSON,
      origin: ORIGIN,
      referer: REFERER,
      acceptLanguage: ACCEPT_LANGUAGE,
      debug: DEBUG,
      retryCount: RETRY_COUNT,
      retryDelayMs: RETRY_DELAY_MS,
    });
  } catch (err) {
    if (isRegistrationRequired(err)) {
      const existing = await tryReadFile(outPath);
      const hasExisting = Boolean(existing && existing.trim().length > 0);

      if (mode === 'member') {
      process.stdout.write('Got 403 registration_required, retry with public parameters.\n');
        try {
          links = await fetchLinks({
            apiUrl: API_URL,
            cookie: '',
            nodeCount: NODE_COUNT,
            apiLimit: API_LIMIT,
            maxPages: 1,
            minScore: MIN_SCORE,
            maxScore: MAX_SCORE,
            sort: SORT,
            region: REGION,
            mode: 'public',
            publicLimit: PUBLIC_LIMIT,
            userAgent: USER_AGENT,
            authorization: AUTHORIZATION,
            extraHeadersJson: EXTRA_HEADERS_JSON,
            origin: ORIGIN,
            referer: REFERER,
            acceptLanguage: ACCEPT_LANGUAGE,
            debug: DEBUG,
            retryCount: RETRY_COUNT,
            retryDelayMs: RETRY_DELAY_MS,
          });
        } catch (err2) {
          if (isRegistrationRequired(err2)) {
            if (hasExisting) {
              process.stdout.write(`Still registration_required, keep existing ${outPath}\n`);
              return;
            }
            throw err2;
          }
          if (isLinkMasked(err2)) {
            if (hasExisting) {
              process.stdout.write(`Link masked, keep existing ${outPath}\n`);
              return;
            }
            throw err2;
          }
          throw err2;
        }
      } else if (hasExisting) {
        process.stdout.write(`Got registration_required, keep existing ${outPath}\n`);
        return;
      }
    }
    if (isLinkMasked(err)) {
      const existing = await tryReadFile(outPath);
      if (existing && existing.trim().length > 0) {
        process.stdout.write(`Link masked, keep existing ${outPath}\n`);
        return;
      }
    }
    throw err;
  }

  if (links.length < MIN_LINKS) {
    const existing = await tryReadFile(outPath);
    if (existing && existing.trim().length > 0) {
      process.stdout.write(`Fetched ${links.length} links (< MIN_LINKS=${MIN_LINKS}), keep existing ${outPath}\n`);
      return;
    }
    throw new Error(`Fetched ${links.length} links (< MIN_LINKS=${MIN_LINKS}). Refusing to overwrite ${outPath}.`);
  }

  const content = links.join('\n') + (links.length ? '\n' : '');
  await fs.writeFile(outPath, content, 'utf8');
  process.stdout.write(`Wrote ${links.length} links to ${outPath}\n`);
}

function clampInt(value, defaultValue, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  const chosen = Number.isFinite(n) ? n : defaultValue;
  return Math.min(max, Math.max(min, chosen));
}

function isTruthy(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function normalizeHeaderValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

async function fetchLinks({
  apiUrl,
  cookie,
  nodeCount,
  apiLimit,
  maxPages,
  minScore,
  maxScore,
  sort,
  region,
  mode,
  publicLimit,
  userAgent,
  authorization,
  extraHeadersJson,
  origin,
  referer,
  acceptLanguage,
  debug,
  retryCount,
  retryDelayMs,
}) {
  const ua = userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': acceptLanguage || 'zh-CN,zh;q=0.9,en;q=0.8',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    origin: origin || 'https://www.qilan.de',
    'user-agent': ua,
    referer: referer || 'https://www.qilan.de/',
  };
  if (cookie) headers.cookie = cookie;
  if (authorization) headers.authorization = authorization;
  Object.assign(headers, parseExtraHeaders(extraHeadersJson));

  if (debug) {
    const headerNames = Object.keys(headers).sort();
    process.stdout.write(`Debug: mode=${mode}, cookieLen=${cookie ? cookie.length : 0}, authLen=${authorization ? authorization.length : 0}\n`);
    process.stdout.write(`Debug: headers=${headerNames.filter((h) => h !== 'cookie' && h !== 'authorization').join(',')}\n`);
  }

  const seen = new Set();
  const links = [];
  let totalItems = 0;
  let maskedLinkFields = 0;

  const effectiveLimit = mode === 'public' ? Math.min(apiLimit, publicLimit) : apiLimit;
  const effectiveMaxPages = mode === 'public' ? 1 : maxPages;
  let inferredPageSize = effectiveLimit;

  for (let page = 1; page <= effectiveMaxPages && links.length < nodeCount; page += 1) {
    const url = new URL(apiUrl);
    const params = mode === 'public'
      ? {
          page: String(page),
          limit: String(effectiveLimit),
        }
      : {
          page: String(page),
          limit: String(effectiveLimit),
          q: '',
          protocol: '',
          region,
          status: 'online',
          ip_type: '',
          features: '',
          min_score: String(minScore),
          max_score: String(maxScore),
          sort,
        };
    url.search = new URLSearchParams(params).toString();

    const res = await fetchWithRetry(url, { method: 'GET', headers }, { retryCount, retryDelayMs });
    if (!res.ok) {
      const body = await safeReadText(res);
      const error = new Error(`Request failed: ${res.status} ${res.statusText}\n${body}`);
      error.status = res.status;
      error.body = body;
      throw error;
    }

    const json = await res.json();
    const data = json?.data;
    if (!Array.isArray(data)) {
      throw new Error('Unexpected response: missing array field "data"');
    }
    if (page === 1 && data.length > 0 && data.length < inferredPageSize) {
      inferredPageSize = data.length;
      if (debug) process.stdout.write(`Debug: inferredPageSize=${inferredPageSize}\n`);
    }
    if (debug && page === 1) {
      const sample = data[0]?.link;
      const len = typeof sample === 'string' ? sample.trim().length : 0;
      process.stdout.write(`Debug: page1 items=${data.length}, sampleLinkLen=${len}\n`);
    }

    for (const item of data) {
      totalItems += 1;
      if (Object.prototype.hasOwnProperty.call(item ?? {}, 'link')) {
        const raw = item?.link;
        if (raw == null) maskedLinkFields += 1;
        if (typeof raw === 'string' && raw.trim().length === 0) maskedLinkFields += 1;
      }

      const link = typeof item?.link === 'string' ? item.link.trim() : '';
      if (!link) continue;
      if (seen.has(link)) continue;
      seen.add(link);
      links.push(link);
      if (links.length >= nodeCount) break;
    }

    if (data.length === 0) break;
    if (data.length < inferredPageSize) break;
  }

  if (links.length === 0 && totalItems > 0 && maskedLinkFields > 0) {
    const error = new Error('Links are masked. The API returned items but link fields are empty. Provide a registered-member Cookie (QILAN_COOKIE) and any additional required headers (QILAN_AUTHORIZATION / QILAN_EXTRA_HEADERS_JSON).');
    error.code = 'LINK_MASKED';
    throw error;
  }

  return links.slice(0, nodeCount);
}

async function fetchWithRetry(url, init, { retryCount, retryDelayMs }) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        lastErr = new Error(`Retryable response: ${res.status} ${res.statusText}`);
        await safeDrain(res);
        if (attempt < retryCount) await sleep(retryDelayMs * Math.max(1, attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retryCount) {
        await sleep(retryDelayMs * Math.max(1, attempt + 1));
        continue;
      }
      break;
    }
  }
  throw lastErr ?? new Error('Request failed');
}

async function safeDrain(res) {
  try {
    await res.arrayBuffer();
  } catch {
    // ignore
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRegistrationRequired(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return false;
  const status = typeof err.status === 'number' ? err.status : Number.parseInt(String(err.status ?? ''), 10);
  if (status !== 403) {
    const msg = typeof err.message === 'string' ? err.message : '';
    return msg.includes('403') && msg.includes('registration_required');
  }
  const body = typeof err.body === 'string' ? err.body : '';
  const msg = typeof err.message === 'string' ? err.message : '';
  return body.includes('registration_required') || msg.includes('registration_required');
}

function isLinkMasked(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return false;
  if (err.code === 'LINK_MASKED') return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  return msg.includes('LINK_MASKED') || msg.includes('Links are masked');
}

function parseExtraHeaders(json) {
  if (!json) return {};
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid EXTRA_HEADERS_JSON: must be a JSON object of string header values.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid EXTRA_HEADERS_JSON: must be a JSON object of string header values.');
  }
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof k !== 'string' || !k.trim()) continue;
    if (typeof v !== 'string') continue;
    out[k] = v;
  }
  return out;
}

async function tryReadFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
