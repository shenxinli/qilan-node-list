import fs from 'node:fs/promises';
import path from 'node:path';

const API_URL = process.env.API_URL ?? 'https://www.qilan.de/api/nodes';
const COOKIE = process.env.COOKIE ?? process.env.QILAN_COOKIE ?? '';

const NODE_COUNT = clampInt(process.env.NODE_COUNT, 1000, 1, 20000);
const MIN_SCORE = clampInt(process.env.MIN_SCORE, 0, 0, 101);
const MAX_SCORE = clampInt(process.env.MAX_SCORE, 101, 0, 101);
const SORT = (process.env.SORT ?? 'newest').trim() || 'newest';
const REGION = (process.env.REGION ?? '').trim();

const API_LIMIT = clampInt(process.env.API_LIMIT, Math.min(NODE_COUNT, 20000), 1, 20000);
const MAX_PAGES = clampInt(process.env.MAX_PAGES, 200, 1, 2000);

if (MIN_SCORE > MAX_SCORE) {
  throw new Error(`Invalid score range: MIN_SCORE (${MIN_SCORE}) > MAX_SCORE (${MAX_SCORE})`);
}

const outPath = path.resolve(process.cwd(), 'nodes.txt');

await main();

async function main() {
  const mode = COOKIE ? 'member' : 'public';

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
          });
        } catch (err2) {
          if (isRegistrationRequired(err2)) {
            if (hasExisting) {
              process.stdout.write(`Still registration_required, keep existing ${outPath}\n`);
              return;
            }
            await fs.writeFile(outPath, '', 'utf8');
            process.stdout.write(`Still registration_required, wrote empty ${outPath}\n`);
            return;
          }
          throw err2;
        }
      } else if (hasExisting) {
        process.stdout.write(`Got registration_required, keep existing ${outPath}\n`);
        return;
      } else {
        await fs.writeFile(outPath, '', 'utf8');
        process.stdout.write(`Got registration_required, wrote empty ${outPath}\n`);
        return;
      }
    }
    throw err;
  }

  if (links.length === 0) {
    const existing = await tryReadFile(outPath);
    if (existing && existing.trim().length > 0) {
      process.stdout.write(`Fetched 0 links, keep existing ${outPath}\n`);
      return;
    }
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
}) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'user-agent': 'qilan-node-list/1.0',
    referer: 'https://www.qilan.de/',
  };
  if (cookie) headers.cookie = cookie;

  const seen = new Set();
  const links = [];

  const effectiveLimit = mode === 'public' ? Math.min(apiLimit, 1000) : apiLimit;
  const effectiveMaxPages = mode === 'public' ? 1 : maxPages;

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

    const res = await fetch(url, { method: 'GET', headers });
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

    for (const item of data) {
      const link = typeof item?.link === 'string' ? item.link.trim() : '';
      if (!link) continue;
      if (seen.has(link)) continue;
      seen.add(link);
      links.push(link);
      if (links.length >= nodeCount) break;
    }

    if (data.length < effectiveLimit) break;
  }

  return links.slice(0, nodeCount);
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
