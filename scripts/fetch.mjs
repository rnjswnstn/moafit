#!/usr/bin/env node
// MOAFIT 카탈로그 수집기 — Node 18+ / 외부 의존성 없음
//
// 하는 일
//  1) config/stores.json 의 스토어마다 robots.txt 를 확인하고(막혀 있으면 건너뜀)
//  2) 스토어가 공개하는 /products.json 을 하루 1~2번, 천천히 읽어서
//  3) 앱이 쓰기 좋은 작은 JSON(data/s/<id>.json, data/meta.json)으로 정리한다.
//  이미지는 복사하지 않고 스토어 CDN 주소만 저장한다.
//
// 환경변수
//  OUT_DIR  결과 사이트 폴더(기본 _site)   PREV_DIR 이전 배포본(기본 _prev)
//  REUSE=1  수집을 건너뛰고 이전 데이터를 그대로 재사용(앱 코드만 바뀐 push 용)

import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.env.OUT_DIR || path.join(ROOT, '_site'));
const PREV = path.resolve(process.env.PREV_DIR || path.join(ROOT, '_prev'));
const REPO = process.env.GITHUB_REPOSITORY || '';
const UA = `Mozilla/5.0 (compatible; moafit-personal-catalog/1.0${REPO ? `; +https://github.com/${REPO}` : ''})`;
const SITE_FILES = ['index.html', 'sw.js', 'manifest.webmanifest', 'icons'];
const TODAY = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 네트워크
async function get(url, { json = false, tries = 2, timeout = 25000 } = {}) {
  let lastErr;
  for (let n = 0; n < tries; n++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/plain,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        lastErr.status = res.status;
        await sleep(4000 * (n + 1));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      await sleep(2000 * (n + 1));
    }
  }
  throw lastErr;
}

// ───────────────────────── robots.txt
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function robotsAllows(txt, target, uaToken = 'moafit') {
  const groups = [];
  let cur = null;
  let lastUA = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === 'user-agent') {
      if (!cur || !lastUA) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastUA = true;
    } else if ((k === 'allow' || k === 'disallow') && cur) {
      cur.rules.push({ allow: k === 'allow', path: v });
      lastUA = false;
    } else lastUA = false;
  }
  let mine = groups.filter((g) => g.agents.some((a) => a !== '*' && a && uaToken.includes(a)));
  if (!mine.length) mine = groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const r of mine.flatMap((g) => g.rules)) {
    if (!r.path) continue;
    const anchored = r.path.endsWith('$');
    const body = anchored ? r.path.slice(0, -1) : r.path;
    const re = new RegExp('^' + body.split('*').map(reEsc).join('.*') + (anchored ? '$' : ''));
    if (!re.test(target)) continue;
    if (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)) {
      best = { len: r.path.length, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

// ───────────────────────── 분류 규칙
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const has = (s, re) => re.test(s);
const CAT_RULES = [
  ['shoes', /\b(sneakers?|shoes?|boots?|loafers?|sandals?|slides?|slippers?|derby|derbies|trainers?|runners?|mules?|clogs?|footwear|oxfords?)\b|스니커|신발|부츠|로퍼|샌들|슬리퍼|운동화|구두|슬라이드/],
  ['bag', /\b(bags?|backpacks?|totes?|duffles?|duffels?|rucksacks?|daypacks?|messenger|sacoche)\b|가방|백팩|토트|크로스백|숄더백|메신저|더플|에코백/],
  ['head', /\b(caps?|hats?|beanies?|bucket|headwear|balaclavas?|visors?|trucker)\b|모자|볼캡|비니|버킷햇|캡\b|바라클라바/],
  ['acc', /\b(socks?|belts?|scar(f|ves)|gloves?|mittens?|wallets?|card ?holders?|key ?(chain|ring|holder)s?|stickers?|necklaces?|rings?|bracelets?|earrings?|sunglasses|eyewear|glasses|watch(es)?|mufflers?|bandanas?|lanyards?|pins?|pouch(es)?|umbrellas?|towels?|mugs?|lighters?|incense|candles?|posters?|magazines?|books?|decks?|wheels?|air ?fresheners?|phone cases?|cases?|ties?|handkerchiefs?|underwear|boxers?|briefs?)\b|양말|벨트|머플러|스카프|장갑|지갑|키링|스티커|목걸이|반지|팔찌|귀걸이|선글라스|안경|시계|파우치|우산|타월|수건|속옷/],
  ['bottom', /\b(pants?|trousers?|jeans?|shorts?(?![\s-]?sleeve)|skirts?|joggers?|sweatpants?|sweatshorts?|chinos?|slacks|leggings?|cargos?|trunks|bermudas?|overalls?|dungarees)\b|팬츠|바지|청바지|쇼츠|반바지|스커트|치마|슬랙스|조거|레깅스|오버롤/],
  ['outer', /\b(jackets?|coats?|parkas?|puffers?|down|blousons?|bombers?|windbreakers?|anoraks?|vests?|gilets?|shell|varsity|blazers?|overshirts?|shackets?|fleece|outerwear|ponchos?|cagoules?|coach|harrington|ma-?1|cpo)\b|아우터|자켓|재킷|코트|패딩|점퍼|바람막이|베스트|조끼|블루종|플리스|후리스|블레이저|아노락|파카/],
  ['top', /\b(tees?|t-?shirts?|shirts?|hoodies?|hooded|hood|sweatshirts?|sweats?|crew(neck)?s?|knit(wear|s)?|sweaters?|cardigans?|polos?|jerseys?|tanks?|tops?|long ?sleeves?|l\/s|s\/s|pullovers?|henleys?|rugby|jumpers?|turtlenecks?|mock ?necks?|thermals?)\b|티셔츠|셔츠|후드|후디|맨투맨|스웨트|니트|가디건|카디건|폴로|저지|긴팔|반팔|스웨터|탱크|나시|럭비/],
];
const SUB_RULES = {
  shoes: [['sneakers', /sneaker|trainer|runner|running|스니커|운동화/], ['boots', /boot|부츠/], ['loafers', /loafer|derb|oxford|로퍼|구두/], ['sandals', /sandal|slide|slipper|mule|clog|샌들|슬리퍼|슬라이드/]],
  bag: [['backpack', /backpack|rucksack|daypack|백팩/], ['tote', /tote|토트|에코백/], ['crossbody', /cross|shoulder|messenger|sling|waist|sacoche|크로스|숄더|메신저/]],
  head: [['beanie', /beanie|balaclava|비니|바라클라바/], ['bucket', /bucket|버킷/], ['cap', /cap|trucker|visor|캡|모자/]],
  acc: [['socks', /sock|양말/], ['belt', /belt|벨트/], ['wallet', /wallet|card ?holder|지갑/], ['scarf', /scarf|scarves|muffler|머플러|스카프/], ['gloves', /glove|mitten|장갑/], ['eyewear', /sunglass|eyewear|glasses|선글라스|안경/], ['jewelry', /necklace|\brings?\b|bracelet|earring|목걸이|반지|팔찌|귀걸이/]],
  bottom: [['jeans', /jean|denim|청바지|데님/], ['shorts', /short|trunk|bermuda|쇼츠|반바지/], ['skirt', /skirt|스커트|치마/], ['sweatpants', /sweatpant|jogger|track ?pant|조거|트레이닝/], ['cargo', /cargo|카고/], ['slacks', /trouser|slack|chino|슬랙스/]],
  outer: [['puffer', /puffer|\bdown\b|padded|quilt|패딩|다운/], ['coat', /coat|코트/], ['fleece', /fleece|sherpa|플리스|후리스/], ['windbreaker', /windbreaker|anorak|shell|cagoule|바람막이|아노락/], ['vest', /vest|gilet|베스트|조끼/], ['blazer', /blazer|블레이저/]],
  top: [['hoodie', /hood|후드|후디/], ['sweat', /sweatshirt|crew|sweat\b|맨투맨|스웨트/], ['cardigan', /cardigan|가디건|카디건/], ['knit', /knit|sweater|jumper|니트|스웨터/], ['polo', /polo|rugby|폴로|럭비/], ['jersey', /jersey|저지/], ['longsleeve', /(long ?sleeve|l\/s|긴팔).*(tee|t-?shirt|티셔츠)|(tee|t-?shirt|티셔츠).*(long ?sleeve|l\/s|긴팔)/], ['tee', /\btees?\b|t-?shirt|티셔츠|반팔/], ['shirt', /shirt|셔츠/], ['tank', /tank|탱크|나시/]],
};
const DEFAULT_SUB = { shoes: 'shoes', bag: 'bag', head: 'hat', acc: 'acc', bottom: 'pants', outer: 'jacket', top: 'top', etc: 'etc' };

// 유형·제목에 '신발'이라는 말이 없어도 모델명으로 알아보는 보조 규칙
const SHOE_MODELS = /\b(air (jordan|force|max)|jordan \d+|dunk|blazer|cortez|vomero|pegasus|p-?6000|shox|foamposite|kobe|air huarache|samba|gazelle|campus|superstar|stan smith|handball spezial|sl ?72|ozweego|adizero|ultraboost|99[0-3]v?\d?|2002r|1906[a-z]?|9060|530|550|574|327|gel-[a-z0-9]+|kayano|nimbus|gt-2160|mexico 66|xt-[46]|speedcross|acs pro|old skool|sk8-hi|slip-on|chuck (taylor|70)|one star|wallabee|club c|instapump|clifton|bondi|cloud ?(monster|nova|tilt)|arizona|boston)\b/i;

export function classify(title, type, tags) {
  // 상품 유형 → 제목 → 태그 순으로 믿는다
  for (const src of [type, title, tags]) {
    const s = ` ${String(src || '').toLowerCase()} `;
    if (!s.trim()) continue;
    for (const [cat, re] of CAT_RULES) {
      if (has(s, re)) {
        const hay = `${title} ${type}`.toLowerCase();
        const sub = (SUB_RULES[cat] || []).find(([, r]) => r.test(hay));
        return [cat, sub ? sub[0] : DEFAULT_SUB[cat]];
      }
    }
  }
  if (SHOE_MODELS.test(title)) return ['shoes', 'sneakers'];
  return ['etc', 'etc'];
}

// 스토어마다 다르게 적는 브랜드 표기를 하나로 맞춘다
const BRAND_CANON = { stussy: 'Stüssy', 'stüssy': 'Stüssy', nike: 'Nike', 'nike sb': 'Nike SB', jordan: 'Jordan', 'air jordan': 'Jordan', adidas: 'adidas', 'adidas originals': 'adidas', asics: 'ASICS', 'new balance': 'New Balance', 'by parra': 'by Parra', parra: 'by Parra', salomon: 'Salomon', converse: 'Converse', vans: 'Vans', puma: 'PUMA', reebok: 'Reebok', clarks: 'Clarks', 'clarks originals': 'Clarks Originals', 'carhartt wip': 'Carhartt WIP', 'the north face': 'The North Face', patagonia: 'Patagonia', "arc'teryx": "Arc'teryx", arcteryx: "Arc'teryx", oakley: 'Oakley', crocs: 'Crocs', birkenstock: 'Birkenstock', 'dr. martens': 'Dr. Martens', 'dr martens': 'Dr. Martens', hoka: 'HOKA', 'hoka one one': 'HOKA', on: 'On', 'on running': 'On', timberland: 'Timberland', ugg: 'UGG', 'new era': 'New Era', dickies: 'Dickies', champion: 'Champion', levis: "Levi's", "levi's": "Levi's", mizuno: 'Mizuno', saucony: 'Saucony', kith: 'Kith', patta: 'Patta', gramicci: 'Gramicci' };
const VENDOR_IS_CATEGORY = /^(sale|mens?|womens?|unisex|kids|accessories|hats?|bags?|tops?|tees?|pants?|shorts?|outerwear|footwear|apparel|default|new|archive)(\s|$)|\b(pants|tees|tops|outerwear|shorts|hats|bags|accessories)$/i;
export function brandOf(vendor, store) {
  if (store.brand) return store.brand;
  const v = clean(vendor);
  if (!v || VENDOR_IS_CATEGORY.test(v)) return store.name;
  return BRAND_CANON[v.toLowerCase()] || v;
}

export function gender(title, type, tags) {
  const s = ` ${title} ${type} ${tags} `.toLowerCase();
  if (/\b(kids?|youth|toddlers?|infants?|baby|boys?|girls?|junior)\b|키즈|아동|주니어/.test(s)) return 'k';
  const w = /\b(women'?s?|womens|woman|wmns|ladies|female)\b|여성|우먼/.test(s);
  const m = /\b(men'?s?|mens|man|male)\b|남성|맨즈/.test(s);
  if (w && !m) return 'w';
  if (m && !w) return 'm';
  return 'u';
}

const COLORS = [
  ['black', /\b(black|noir|onyx|jet|charcoal black)\b|블랙|검정/],
  ['white', /\b(white|blanc|optic|snow)\b|화이트|흰색/],
  ['cream', /\b(cream|ivory|ecru|off[- ]?white|bone|natural|oatmeal|sail|egret|parchment)\b|크림|아이보리|에크루|오트밀/],
  ['grey', /\b(gr[ae]y|heather|ash|charcoal|silver|slate|graphite|cement|concrete|melange|smoke)\b|그레이|회색|차콜|멜란지/],
  ['navy', /\b(navy|midnight|indigo|ink)\b|네이비|남색|인디고/],
  ['blue', /\b(blue|cobalt|royal|sky|azure|teal|aqua|turquoise|denim|cyan)\b|블루|파랑|스카이|데님/],
  ['green', /\b(green|forest|emerald|mint|lime|pine|moss|sage|jade|kelly)\b|그린|초록|민트/],
  ['khaki', /\b(khaki|olive|army|military|fatigue|drab|loden)\b|카키|올리브/],
  ['beige', /\b(beige|sand|tan|camel|stone|taupe|khaki beige|wheat|putty|mushroom|greige)\b|베이지|샌드|카멜|탄색/],
  ['brown', /\b(brown|chocolate|mocha|coffee|espresso|walnut|chestnut|tobacco|cocoa|bison|rust|copper|bronze)\b|브라운|갈색|초콜릿|모카/],
  ['red', /\b(red|burgundy|maroon|wine|crimson|scarlet|cherry|cardinal|brick|oxblood)\b|레드|빨강|버건디|와인/],
  ['pink', /\b(pink|rose|blush|fuchsia|magenta|salmon|coral)\b|핑크|분홍|로즈|코랄/],
  ['purple', /\b(purple|violet|lavender|lilac|plum|mauve|grape)\b|퍼플|보라|라벤더/],
  ['yellow', /\b(yellow|mustard|lemon|gold|butter|canary|citron)\b|옐로|노랑|머스타드/],
  ['orange', /\b(orange|tangerine|apricot|peach|amber|pumpkin)\b|오렌지|주황/],
  ['multi', /\b(multi|multicolou?r|tie[- ]?dye|camo|camouflage|plaid|check|stripe[ds]?|floral|print(ed)?)\b|멀티|카모|체크|스트라이프/],
];
export function colors(text) {
  const s = ` ${String(text || '').toLowerCase()} `;
  const out = [];
  for (const [name, re] of COLORS) if (re.test(s)) out.push(name);
  return out.slice(0, 3);
}

// ───────────────────────── 상품 정리
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const SKIP_TYPE = /placeholder|gift ?card|e-?gift|insurance|shipping|protection|route|donation|membership|ticket|raffle|sample|test|bundle fee|warranty/i;
const SIZE_OPT = /size|사이즈|taille|サイズ|尺码|talla|größe/i;
const COLOR_OPT = /colou?r|색상|컬러|カラー/i;
const SIZE_VAL = /^(x{0,3}[sl]|m|[2-5]xl|os|o\/s|one ?size|free|f|\d{1,3}(\.5)?|\d{2,3}\s?(mm|cm)?|(us|uk|eu|kr|w)\s?\d{1,3}(\.5)?|\d{2}\s?[x×\/]\s?\d{2}|\d{2,3}\s?\(.{1,6}\))$/i;

function sizesOf(p) {
  const opts = p.options || [];
  let idx = opts.findIndex((o) => SIZE_OPT.test(o?.name || ''));
  if (idx < 0) {
    idx = opts.findIndex((o) => !COLOR_OPT.test(o?.name || '') && (o?.values || []).length > 0 && (o.values || []).every((v) => SIZE_VAL.test(String(v).trim())));
  }
  if (idx < 0) return [];
  const key = `option${idx + 1}`;
  const seen = new Map();
  for (const v of p.variants || []) {
    const label = clean(v[key]);
    if (!label || label.length > 10 || /default/i.test(label)) continue;
    const a = v.available === false ? 0 : 1;
    seen.set(label, Math.max(seen.get(label) || 0, a));
  }
  if (seen.size > 24) return [];
  return [...seen.entries()];
}

function colorOf(p, title) {
  const opts = p.options || [];
  const idx = opts.findIndex((o) => COLOR_OPT.test(o?.name || ''));
  let txt = '';
  if (idx >= 0) txt = (opts[idx].values || []).join(' ');
  const tail = title.split(/\s[-–—|/]\s/).slice(1).join(' ');
  return colors(`${txt} ${tail}`).length ? colors(`${txt} ${tail}`) : colors(title);
}

export function normalize(p, store, rate, prev) {
  const title = clean(p.title);
  const type = clean(p.product_type);
  if (!title || SKIP_TYPE.test(type) || /gift ?card|e-?gift|기프트 ?카드|상품권|\btest\b|테스트/i.test(title)) return null;
  if (store.vendorAllow && !new RegExp(store.vendorAllow, 'i').test(p.vendor || '')) return null;
  const variants = (p.variants || []).filter((v) => num(v.price) > 0);
  if (!variants.length) return null;
  const live = variants.filter((v) => v.available !== false);
  const pool = live.length ? live : variants;
  const price = Math.min(...pool.map((v) => num(v.price)));
  const was = Math.max(0, ...pool.map((v) => num(v.compare_at_price)));
  const imgs = (p.images || []).map((i) => i?.src).filter(Boolean).slice(0, 2);
  if (!imgs.length) return null;
  const tags = Array.isArray(p.tags) ? p.tags.join(' ') : String(p.tags || '');
  const [c, sc] = classify(title, type, tags);
  const id = `${store.id}:${p.id}`;
  const old = prev.get(id);
  const item = {
    id,
    t: title,
    b: brandOf(p.vendor, store),
    c, sc,
    g: gender(title, type, tags),
    p: price,
    k: Math.max(100, Math.round((price * rate) / 100) * 100),
    z: sizesOf(p),
    i: imgs[0],
    u: p.handle,
    d: String(p.published_at || p.created_at || '').slice(0, 10),
    f: old?.f || TODAY,
    a: live.length ? 1 : 0,
  };
  if (was > price) item.o = was;
  if (imgs[1]) item.i2 = imgs[1];
  const col = colorOf(p, title);
  if (col.length) item.col = col;
  // 가격 이력: 스토어 통화 기준으로 값이 바뀐 날만 기록
  let h = Array.isArray(old?.h) ? old.h.slice() : [[item.f, old?.p ?? price]];
  if (old && old.p !== price) h.push([TODAY, price]);
  if (h.length > 8) h = [h[0], ...h.slice(-7)];
  if (h.length > 1) item.h = h;
  return item;
}

function commonPrefix(list) {
  if (!list.length) return '';
  let pre = list[0];
  for (const s of list) {
    let n = 0;
    while (n < pre.length && n < s.length && pre[n] === s[n]) n++;
    pre = pre.slice(0, n);
    if (!pre) break;
  }
  const cut = pre.lastIndexOf('/');
  return cut > 8 ? pre.slice(0, cut + 1) : '';
}

// ───────────────────────── 환율
const FX_FALLBACK = { KRW: 1, USD: 1400, JPY: 9.3, EUR: 1560, GBP: 1820, CAD: 1010, AUD: 920, CNY: 195, HKD: 180, SGD: 1060, TWD: 44, DKK: 209, SEK: 135, NOK: 130, CHF: 1650 };
async function loadFx() {
  try {
    const res = await get('https://open.er-api.com/v6/latest/USD', { json: true, tries: 2, timeout: 15000 });
    const j = await res.json();
    if (j?.rates?.KRW) {
      const out = {};
      for (const [cur, v] of Object.entries(j.rates)) if (v > 0) out[cur] = j.rates.KRW / v;
      return { rates: out, live: true };
    }
  } catch { /* 아래 고정 환율 사용 */ }
  return { rates: FX_FALLBACK, live: false };
}

// ───────────────────────── 스토어 한 곳 수집
async function loadPrev(storeId) {
  try {
    const j = JSON.parse(await readFile(path.join(PREV, 'data', 's', `${storeId}.json`), 'utf8'));
    const ib = j.ib || '';
    const map = new Map();
    for (const it of j.items || []) map.set(it.id, it);
    return { json: j, map, ib };
  } catch {
    return { json: null, map: new Map(), ib: '' };
  }
}

async function fetchStore(store, cfg, fx) {
  const base = store.base || `https://${store.domain}`;
  const status = { id: store.id, name: store.name, domain: store.domain, region: store.region || 'GLOBAL', count: 0, state: 'ok' };
  const prev = await loadPrev(store.id);
  const keepPrev = (state, note) => {
    status.state = prev.json ? 'stale' : state;
    status.note = note;
    if (prev.json) {
      status.count = prev.json.items?.length || 0;
      status.currency = prev.json.store?.currency;
      return prev.json;
    }
    return null;
  };

  // 1) robots.txt
  try {
    const r = await get(`${base}/robots.txt`, { tries: 1, timeout: 15000 });
    if (r.status >= 500) return [status, keepPrev('error', `robots.txt ${r.status}`)];
    if (r.ok) {
      const txt = await r.text();
      if (!robotsAllows(txt, '/products.json?limit=250&page=1') || !robotsAllows(txt, '/products.json')) {
        status.state = 'robots';
        status.note = 'robots.txt 가 수집을 허용하지 않아 건너뜀';
        return [status, null];
      }
    }
  } catch (e) {
    return [status, keepPrev('error', `robots.txt 확인 실패: ${e.message}`)];
  }

  // 2) 스토어 기본 정보(통화) — 없으면 설정값 사용
  let currency = store.currency || '';
  try {
    const r = await get(`${base}/meta.json`, { json: true, tries: 1, timeout: 15000 });
    if (r.ok) {
      const m = await r.json();
      if (m?.currency) currency = m.currency;
    }
  } catch { /* 설정값 사용 */ }
  if (!currency) currency = 'USD';
  const rate = fx.rates[currency] || FX_FALLBACK[currency] || 0;
  if (!rate) return [status, keepPrev('error', `환율을 모르는 통화: ${currency}`)];
  status.currency = currency;

  // 3) 상품 목록
  const max = store.max || cfg.maxProductsPerStore || 1200;
  const raw = [];
  try {
    for (let page = 1; page <= Math.ceil(max / 250) + 1 && raw.length < max; page++) {
      const r = await get(`${base}/products.json?limit=250&page=${page}`, { json: true });
      if (!r.ok) {
        if (page === 1) return [status, keepPrev('blocked', `products.json HTTP ${r.status}`)];
        break;
      }
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) {
        if (page === 1) return [status, keepPrev('unsupported', '상품 JSON을 제공하지 않는 스토어')];
        break;
      }
      const j = await r.json();
      const list = j?.products || [];
      raw.push(...list);
      if (list.length < 250) break;
      await sleep(cfg.delayMs ?? 1200);
    }
  } catch (e) {
    return [status, keepPrev('error', `수집 실패: ${e.message}`)];
  }

  let items = raw.map((p) => normalize(p, store, rate, prev.map)).filter(Boolean);
  // 이전 파일의 이미지 접두사가 붙어 있던 값 복원은 필요 없음(항상 원본에서 다시 만듦)
  items.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : a.id < b.id ? -1 : 1));
  items = items.slice(0, max);
  const ib = commonPrefix(items.map((x) => x.i));
  if (ib) for (const it of items) {
    it.i = it.i.slice(ib.length);
    if (it.i2?.startsWith(ib)) it.i2 = it.i2.slice(ib.length);
    else if (it.i2) it.i2 = `!${it.i2}`; // 접두사가 다른 이미지는 전체 주소 유지
  }
  status.count = items.length;
  if (!items.length) { status.state = 'empty'; status.note = '상품이 없음'; }
  return [status, {
    store: { id: store.id, name: store.name, domain: store.domain, currency, region: store.region || 'GLOBAL', rate: Math.round(rate * 100) / 100 },
    ib,
    items,
  }];
}

// ───────────────────────── 실행
async function copySite() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'data', 's'), { recursive: true });
  for (const f of SITE_FILES) {
    const src = path.join(ROOT, f);
    if (existsSync(src)) await cp(src, path.join(OUT, f), { recursive: true });
  }
  await writeFile(path.join(OUT, '.nojekyll'), '');
}

async function main() {
  const cfg = JSON.parse(await readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
  const stores = (cfg.stores || []).filter((s) => s.enabled !== false && s.id && (s.domain || s.base));
  await copySite();

  const prevData = path.join(PREV, 'data');
  if (process.env.REUSE === '1' && existsSync(path.join(prevData, 'meta.json'))) {
    await cp(prevData, path.join(OUT, 'data'), { recursive: true });
    console.log('REUSE=1 → 이전 데이터를 그대로 사용');
    return;
  }

  const fx = await loadFx();
  const report = [];
  let total = 0;
  for (const store of stores) {
    const t0 = Date.now();
    let status, data;
    try {
      [status, data] = await fetchStore(store, cfg, fx);
    } catch (e) {
      status = { id: store.id, name: store.name, domain: store.domain, region: store.region || 'GLOBAL', count: 0, state: 'error', note: String(e.message || e) };
      data = null;
    }
    if (data) {
      await writeFile(path.join(OUT, 'data', 's', `${store.id}.json`), JSON.stringify(data));
      total += status.count;
    }
    report.push(status);
    console.log(`${status.state.padEnd(11)} ${String(status.count).padStart(5)}  ${store.id}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${status.note || ''}`);
    await sleep(cfg.delayMs ?? 1200);
  }
  const meta = { updated: new Date().toISOString(), total, fxLive: fx.live, stores: report };
  await writeFile(path.join(OUT, 'data', 'meta.json'), JSON.stringify(meta));
  console.log(`\n총 ${total}개 상품 / 스토어 ${report.filter((r) => r.count > 0).length}곳`);
  if (!total) {
    console.error('수집된 상품이 없습니다.');
    process.exitCode = existsSync(path.join(prevData, 'meta.json')) ? 0 : 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
