#!/usr/bin/env node
// 스토어 후보 점검: config/candidates.txt 의 도메인이 수집 가능한지(robots 허용 + 상품 JSON 공개) 확인만 한다.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { robotsAllows } from './fetch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (compatible; moafit-personal-catalog/1.0)';
const get = (url, cookie) => fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,text/html,text/plain,*/*', ...(cookie ? { Cookie: cookie } : {}) }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
// 스토어가 지금 어떤 나라·통화 기준으로 가격을 보여주는지 첫 화면에서 읽는다
async function context(base, cookie) {
  try {
    const r = await get(`${base}/`, cookie);
    const html = await r.text();
    const cur = html.match(/Shopify\.currency\s*=\s*\{\s*"active"\s*:\s*"([A-Z]{3})"/)?.[1] || '?';
    const country = html.match(/Shopify\.country\s*=\s*"([A-Z]{2})"/)?.[1] || '?';
    const pj = await (await get(`${base}/products.json?limit=1`, cookie)).json();
    return `${country}/${cur}/${pj.products?.[0]?.variants?.[0]?.price}`;
  } catch (e) { return `실패(${e.cause?.code || e.name})`; }
}

async function probe(domain) {
  const base = `https://${domain}`;
  try {
    const rb = await get(`${base}/robots.txt`).catch(() => null);
    if (rb && rb.ok && !robotsAllows(await rb.text(), '/products.json?limit=250&page=1')) return `NO   ${domain}  robots.txt 불허`;
    const r = await get(`${base}/products.json?limit=3`);
    if (!r.ok) return `NO   ${domain}  HTTP ${r.status}`;
    if (!(r.headers.get('content-type') || '').includes('json')) return `NO   ${domain}  JSON 아님`;
    const j = await r.json();
    const n = (j.products || []).length;
    if (!n) return `NO   ${domain}  상품 0개`;
    let meta = {};
    try { const m = await get(`${base}/meta.json`); if (m.ok) meta = await m.json(); } catch { /* 없음 */ }
    const p = j.products[0];
    const kr = await context(base, 'localization=KR');
    const none = await context(base, '');
    return `OK   ${domain}  기본통화 ${meta.currency || '?'}  ${meta.published_products_count ?? '?'}개  ${meta.country || '?'}  | 한국 기준: ${kr} | 기본: ${none} | 예: ${p.vendor} / ${String(p.title).slice(0, 30)}`;
  } catch (e) {
    return `NO   ${domain}  ${e.cause?.code || e.name || e.message}`;
  }
}

const list = [...new Set((await readFile(path.join(ROOT, 'config', 'candidates.txt'), 'utf8')).split(/\r?\n/).map((s) => s.replace(/#.*/, '').trim()).filter(Boolean))];
const out = [];
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => { while (i < list.length) { const d = list[i++]; out.push(await probe(d)); } }));
out.sort();
console.log(out.join('\n'));
console.log(`\n후보 ${list.length}곳 중 수집 가능 ${out.filter((x) => x.startsWith('OK')).length}곳`);
