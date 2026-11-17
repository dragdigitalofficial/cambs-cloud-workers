'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const columns = [
  'business_name', 'category', 'additional_categories', 'email', 'email_source',
  'phone', 'website', 'address', 'town', 'county', 'postcode', 'rating',
  'review_count', 'latitude', 'longitude', 'place_id', 'cid', 'google_maps_url',
  'opening_hours', 'business_status', 'date_collected', 'source',
  'caller_pitch_summary', 'caller_pain_points', 'ghl_caller_battlecard_note'
];

const file = p => path.join(root, p);
const read = (p, d) => fs.existsSync(file(p)) ? JSON.parse(fs.readFileSync(file(p), 'utf8')) : d;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function atomic(p, v) {
  fs.mkdirSync(path.dirname(file(p)), { recursive: true });
  fs.writeFileSync(file(p + '.tmp'), JSON.stringify(v, null, 2));
  fs.renameSync(file(p + '.tmp'), file(p));
}

function csv(p, rows) {
  const q = v => {
    let s = String(v ?? '');
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  fs.mkdirSync(path.dirname(file(p)), { recursive: true });
  fs.writeFileSync(file(p), '\ufeff' + [columns.join(','), ...rows.map(r => columns.map(k => q(r[k])).join(','))].join('\r\n') + '\r\n');
}

function ring(x, y, a) {
  let c = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    let [xi, yi] = a[i], [xj, yj] = a[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}

function inside(x, y, b) {
  return b.features.some(f => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).some(p => ring(x, y, p[0]) && !p.slice(1).some(r => ring(x, y, r))));
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function phone(s) {
  let p = String(s || '').replace(/[^\d+]/g, '').replace(/^00/, '+');
  return /^0\d{9,10}$/.test(p) ? '+44' + p.slice(1) : p;
}

function domain(s) {
  try {
    return new URL(s).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function identity(r) {
  if (r.place_id) return 'place:' + r.place_id;
  if (r.cid) return 'cid:' + r.cid;
  return fallback(r);
}

function fallback(r) {
  let loc = norm(r.address) || ((r.latitude && r.longitude) ? Number(r.latitude).toFixed(5) + ',' + Number(r.longitude).toFixed(5) : '');
  if (!loc) return '';
  return 'loc:' + crypto.createHash('sha256').update(norm(r.business_name) + '|' + loc + '|' + norm(r.postcode)).digest('hex');
}

function normalise(a, date) {
  let ca = a.complete_address || {}, lat = Number(a.latitude), lon = Number(a.longitude ?? a.longtitude);
  return {
    business_name: a.title || a.business_name || '',
    category: a.category || '',
    additional_categories: (a.categories || []).join('; '),
    email: Array.isArray(a.emails) ? a.emails.join('; ') : (a.email || ''),
    email_source: a.email_source || '',
    phone: phone(a.phone),
    website: a.web_site || a.website || '',
    address: a.address || '',
    town: ca.city || a.town || '',
    county: 'Cambridgeshire',
    postcode: ca.postal_code || a.postcode || ((a.address || '').match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i) || [''])[0].toUpperCase(),
    rating: a.review_rating ?? a.rating ?? '',
    review_count: a.review_count ?? '',
    latitude: Number.isFinite(lat) ? lat : '',
    longitude: Number.isFinite(lon) ? lon : '',
    place_id: a.place_id || '',
    cid: a.cid || '',
    google_maps_url: a.link || a.google_maps_url || '',
    opening_hours: typeof a.open_hours === 'string' ? a.open_hours : JSON.stringify(a.open_hours || {}),
    business_status: a.status || a.business_status || '',
    date_collected: date,
    source: 'google_maps'
  };
}

module.exports = {
  root, file, read, atomic, csv, stamp, columns, inside, normalise, identity, fallback, domain, phone
};
