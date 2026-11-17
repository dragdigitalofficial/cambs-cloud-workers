'use strict';
const dns = require('node:dns').promises;
const net = require('node:net');
const bc = require('./battlecard.cjs');

// All 6 Cambridgeshire & Peterborough Local Authority Districts
const DISTRICTS = new Set([
  'Cambridge',
  'South Cambridgeshire',
  'East Cambridgeshire',
  'Huntingdonshire',
  'Fenland',
  'Peterborough'
]);

const FIELDS = [
  'Business Name',
  'Category',
  'Email',
  'Phone Number',
  'Website',
  'Google Maps URL',
  'Address',
  'Town',
  'Postcode',
  'District',
  'Google Rating',
  'Review Count',
  'Email Source URL',
  'Email Check',
  'Collected At',
  'Place ID',
  'Caller Pitch Summary',
  'Caller Pain Points',
  'GHL Caller Battlecard Note'
];

const FREE = new Set('gmail.com googlemail.com hotmail.com hotmail.co.uk outlook.com outlook.co.uk yahoo.com yahoo.co.uk btinternet.com aol.com icloud.com live.co.uk'.split(' '));
const DIRECTORY = new Set('facebook.com instagram.com yell.com yelp.com tripadvisor.co.uk tripadvisor.com camra.org.uk whatpub.com google.com business.site'.split(' '));
const BAD = /^(?:no[.-]?reply|do[.-]?not[.-]?reply|privacy|dpo|gdpr|data[.-]?protection|legal|complaints?|press|media|jobs?|careers?|recruitment|hr|vacancies|unsubscribe|abuse|postmaster|webmaster|security|accounts|billing|invoices?|payroll|donations)(?:[.@_-]|$)/i;
const EMAIL = /^[a-z0-9][a-z0-9._%+\-]*@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const host = url => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function base(h) {
  const p = h.split('.');
  return p.slice(/^(co|org|ac|gov)\.uk$/.test(p.slice(-2).join('.')) ? -3 : -2).join('.');
}

function phone(s) {
  return String(s || '').replace(/^'/, '').replace(/\(0\)/g, '').replace(/\D/g, '').replace(/^0044/, '0').replace(/^44/, '0');
}

function htmlDecode(s) {
  return s.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, n) => {
    const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/&commat;/gi, '@').replace(/&period;/gi, '.').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'");
}

function candidates(html, url, r) {
  const visible = htmlDecode(html.replace(/<!--[^]*?-->/g, ' ').replace(/<(script|style)\b[^>]*>[^]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' '));
  const mails = [...html.matchAll(/mailto:([^"'<>\s?]+)/gi)].flatMap(m => {
    try {
      return decodeURIComponent(htmlDecode(m[1])).split(/[,;]/);
    } catch {
      return [];
    }
  });
  let result = [];
  for (const email of new Set([...mails, ...(visible.match(/[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [])].map(e => e.toLowerCase()))) {
    if (!EMAIL.test(email) || email.includes('..') || BAD.test(email) || /\.(png|jpg|jpeg|webp|svg|gif)$/.test(email)) continue;
    const [local, d] = email.split('@');
    if (['example.com', 'example.org', 'domain.com', 'yourdomain.com'].includes(d)) continue;
    if (!FREE.has(d) && base(d) !== base(host(url))) continue;
    if (/(?:^|[._-])(london|oxford|norwich|ipswich|newmarket|royston|manchester|bristol|leeds|york|singapore)(?:[._-]|$)/.test(local)) continue;
    const brand = ((r.business_name || r.title || '') + ' ' + host(url)).toLowerCase().match(/[a-z0-9]{4,}/g) || [];
    if (FREE.has(d) && !brand.some(w => !['limited', 'cambridge', 'cambridgeshire', 'peterborough', 'services', 'gmail', 'hotmail'].includes(w) && norm(local).includes(w))) continue;
    const priority = /^(info|hello|contact|enquiries|enquiry|sales|office|reception|admin|bookings|booking|team|general)@/.test(email) ? 50 : 0;
    result.push({
      email,
      source: url,
      priority: priority + (/cambridge|cambs|peterborough|huntingdon|wisbech|chatteris|^ely[.@]/.test(local) ? 70 : 0)
    });
  }
  return result.sort((a, b) => b.priority - a.priority || a.email.localeCompare(b.email));
}

function robotsRules(txt) {
  let groups = [], g = { agents: [], rules: [] };
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(), i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).toLowerCase().trim(), v = line.slice(i + 1).trim();
    if (k === 'user-agent') {
      if (g.rules.length) {
        groups.push(g);
        g = { agents: [], rules: [] };
      }
      g.agents.push(v.toLowerCase());
    } else if (['allow', 'disallow'].includes(k) && g.agents.length && v) {
      g.rules.push({ allow: k === 'allow', path: v });
    }
  }
  groups.push(g);
  const specific = groups.filter(g => g.agents.some(a => a !== '*' && 'cambridgeshirebusinesscontactcollector'.includes(a)));
  return (specific.length ? specific : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
}

function permitted(url, rules) {
  const u = new URL(url), p = u.pathname + u.search;
  let best = null;
  for (const r of rules) {
    const re = r.path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    if (new RegExp('^' + re).test(p) && (!best || r.path.length > best.path.length || r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

function publicIP(ip) {
  if (net.isIP(ip) === 6) return /^[23]/.test(ip);
  const p = ip.split('.').map(Number);
  return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || p[0] === 169 && p[1] === 254 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && p[1] === 168 || p[0] === 100 && p[1] >= 64 && p[1] <= 127 || p[0] === 198 && [18, 19].includes(p[1]));
}

function matchesBusiness(html, url, r) {
  const p = phone(r.phone);
  if (p.length >= 10 && norm(html).includes(p.replace(/^0/, ''))) return true;
  const generic = new Set('services limited ltd plumbing heating electrical roofing cambridge cambridgeshire peterborough company group and the garage restaurant cafe'.split(' '));
  const words = ((r.business_name || r.title || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(w => !generic.has(w));
  const heading = [...html.matchAll(/<(title|h1)\b[^>]*>([^]*?)<\/\1>/gi)].map(m => m[2]).join(' ');
  const evidence = norm(url + ' ' + htmlDecode(heading));
  return words.some(w => evidence.includes(w));
}

async function bounded(p, ms) {
  let timer;
  try {
    return await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Request timeout')), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function requestOnce(url, allowedHost) {
  let x = new URL(url);
  for (let n = 0; n < 3; n++) {
    if (!['http:', 'https:'].includes(x.protocol) || x.username || x.password || host(x.href) !== allowedHost) {
      throw Error('Different website redirect requires review');
    }
    const ips = await bounded(dns.lookup(x.hostname, { all: true }), 3000);
    if (!ips.length || ips.some(a => !publicIP(a.address))) throw Error('Non-public host excluded');
    const response = await fetch(x, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(3500)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get('location');
      await response.body?.cancel();
      if (!loc) throw Error('Redirect without location');
      x = new URL(loc, x);
      continue;
    }
    if ([401, 403, 429].includes(response.status)) {
      await response.body?.cancel();
      throw Error('Access restricted; skipped');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status, text: '', url: x.href };
    }
    let size = 0, chunks = [];
    for await (const b of response.body) {
      size += b.length;
      if (size > 1.5e6) throw Error('Page exceeds size limit');
      chunks.push(b);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (/<title[^>]*>[^<]*(captcha|access denied|just a moment)|unusual traffic from your computer network|verify you are human/i.test(text)) {
      throw Error('Access challenge; skipped');
    }
    return { status: 200, text, url: x.href };
  }
  throw Error('Redirect limit');
}

async function request(url, allowedHost) {
  // Fast single-attempt request. No retry sleep loop on failed/dead sites.
  return await requestOnce(url, allowedHost);
}

async function mx(domain, cache) {
  if (cache[domain]) return cache[domain];
  try {
    const records = await bounded(dns.resolveMx(domain), 2500);
    return cache[domain] = records.some(r => r.exchange && r.exchange !== '.') ? 'MX configured; mailbox activity unverified' : 'No usable MX';
  } catch (e) {
    return cache[domain] = 'MX unavailable: ' + (e.code || e.message);
  }
}

async function enrich(r, mxCache = {}) {
  let start;
  try {
    start = new URL(r.website || r.web_site);
  } catch {
    return { status: 'not_found', reason: 'Invalid website URL', candidates: [], siteSignals: null };
  }

  const h = host(start.href);
  if (!h || DIRECTORY.has(h)) return { status: 'review', reason: 'Directory or social website', candidates: [], siteSignals: null };

  const origin = start.origin;
  const primaryUrl = start.href;
  let visited = new Set(), found = [], siteSignals = null;

  // 1. Fast check on primary URL / homepage
  try {
    visited.add(primaryUrl);
    const page = await request(primaryUrl, h);
    if (page && page.status === 200) {
      siteSignals = bc.analyzeWebsiteHtml(page.text, page.url);
      found.push(...candidates(page.text, page.url, r));
    }
  } catch (e) {
    if (origin + '/' !== primaryUrl && !visited.has(origin + '/')) {
      try {
        visited.add(origin + '/');
        const page = await request(origin + '/', h);
        if (page && page.status === 200) {
          siteSignals = bc.analyzeWebsiteHtml(page.text, page.url);
          found.push(...candidates(page.text, page.url, r));
        }
      } catch {}
    }
  }

  // If email found on homepage, verify MX and return immediately!
  if (found.length > 0) {
    found.sort((a, b) => b.priority - a.priority || a.email.localeCompare(b.email));
    for (const f of found) {
      f.mailCheck = await mx(f.email.split('@')[1], mxCache);
      if (f.mailCheck.startsWith('MX configured')) {
        return { status: 'found', ...f, candidates: found, checkedPages: [...visited], siteSignals };
      }
    }
  }

  // 2. If NO email found on homepage, check ONLY 1 contact page!
  const contactCandidates = [origin + '/contact', origin + '/contact-us', origin + '/get-in-touch'];
  let contactUrl = contactCandidates[0];
  for (const c of contactCandidates) {
    if (!visited.has(c)) {
      contactUrl = c;
      break;
    }
  }

  try {
    visited.add(contactUrl);
    const page = await request(contactUrl, h);
    if (page && page.status === 200) {
      const pageSignals = bc.analyzeWebsiteHtml(page.text, page.url);
      if (!siteSignals) siteSignals = pageSignals;
      found.push(...candidates(page.text, page.url, r));
    }
  } catch {}

  // Final check for candidates found on contact page
  if (found.length > 0) {
    found.sort((a, b) => b.priority - a.priority || a.email.localeCompare(b.email));
    for (const f of found) {
      f.mailCheck = await mx(f.email.split('@')[1], mxCache);
      if (f.mailCheck.startsWith('MX configured')) {
        return { status: 'found', ...f, candidates: found, checkedPages: [...visited], siteSignals };
      }
    }
  }

  // If still no email found: DO NOT wander around. Skip immediately!
  return {
    status: 'not_found',
    reason: 'No public email found on homepage or contact page',
    candidates: found,
    checkedPages: [...visited],
    siteSignals
  };
}

function csv(rows) {
  const q = x => '"' + String(x ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"';
  return '\ufeff' + [FIELDS.join(','), ...rows.map(r => FIELDS.map(k => q(r[k])).join(','))].join('\r\n') + '\r\n';
}

module.exports = {
  DISTRICTS,
  FIELDS,
  enrich,
  csv,
  phone,
  host,
  base
};
