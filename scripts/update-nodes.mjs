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

const links = await fetchLinks({
  apiUrl: API_URL,
  cookie: COOKIE,
  nodeCount: NODE_COUNT,
  apiLimit: API_LIMIT,
  maxPages: MAX_PAGES,
  minScore: MIN_SCORE,
  maxScore: MAX_SCORE,
  sort: SORT,
  region: REGION,
});

const content = links.join('\n') + (links.length ? '\n' : '');
await fs.writeFile(outPath, content, 'utf8');
process.stdout.write(`Wrote ${links.length} links to ${outPath}\n`);

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
}) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'user-agent': 'qilan-node-list/1.0',
    referer: 'https://www.qilan.de/',
  };
  if (cookie) headers.cookie = cookie;

  const seen = new Set();
  const links = [];

  for (let page = 1; page <= maxPages && links.length < nodeCount; page += 1) {
    const url = new URL(apiUrl);
    url.search = new URLSearchParams({
      page: String(page),
      limit: String(apiLimit),
      q: '',
      protocol: '',
      region,
      status: 'online',
      ip_type: '',
      features: '',
      min_score: String(minScore),
      max_score: String(maxScore),
      sort,
    }).toString();

    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      const body = await safeReadText(res);
      throw new Error(`Request failed: ${res.status} ${res.statusText}\n${body}`);
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

    if (data.length < apiLimit) break;
  }

  return links.slice(0, nodeCount);
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
