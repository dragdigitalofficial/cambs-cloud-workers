'use strict';
/**
 * 24/7 Cloud Worker for Cambridgeshire & Peterborough Business Scraper + Battlecard Generator
 * Runs in GitHub Actions (Linux) or any server/PC without needing your local PC open.
 * Coordinates with https://cambs-collector.wasmer.app:
 * 1. Claims queued category/grid jobs from Wasmer PostgreSQL hub
 * 2. Runs gosom/google-maps-scraper with headless Chromium
 * 3. Enriches discovered websites (public email + DNS MX + CMS/Chat/WhatsApp/Price signals)
 * 4. Generates Bamplify x Cambslist Caller Pitch Summary, Caller Pain Points & 7-Block GHL Battlecard Note
 * 5. Uploads results + battlecards to Wasmer Hub AND saves CSV exports for artifact download
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const u = require('./process-results.cjs');
const lib = require('./email-library.cjs');
const bc = require('./battlecard.cjs');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'data');
const outDir = path.join(root, 'results');
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

// Load worker config from environment variables (GitHub Actions Secrets) or worker-config.json
function loadConfig() {
  if (process.env.WASMER_WORKER_ID && process.env.WASMER_WORKER_TOKEN) {
    return {
      site: (process.env.WASMER_SITE || 'https://cambs-collector.wasmer.app').replace(/\/+$/, ''),
      workerId: process.env.WASMER_WORKER_ID.trim(),
      workerToken: process.env.WASMER_WORKER_TOKEN.trim(),
      name: process.env.WASMER_WORKER_NAME || 'GitHub-Actions-Cloud-Worker'
    };
  }
  const configPath = path.join(root, 'worker-config.json');
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  throw new Error('Missing worker credentials. Set WASMER_WORKER_ID and WASMER_WORKER_TOKEN environment secrets or provide worker-config.json.');
}

const cfg = loadConfig();
if (new URL(cfg.site).protocol !== 'https:') {
  throw new Error('The dashboard URL must use HTTPS.');
}

const maxRuntimeMinutes = Number(process.env.MAX_RUNTIME_MINUTES || 330); // Default 5.5 hours for GitHub Actions 6h limit
const maxJobsPerRun = Number(process.env.MAX_JOBS_PER_RUN || 50);
const startTime = Date.now();
const deadline = startTime + maxRuntimeMinutes * 60 * 1000;

const pause = ms => new Promise(r => setTimeout(r, ms));
let stopping = false, child = null, current = null, heartbeatBusy = false, controllerPaused = false, hbFailCount = 0;
const isWindows = process.platform === 'win32';

const atomic = (p, v) => {
  fs.writeFileSync(p + '.tmp', JSON.stringify(v));
  fs.renameSync(p + '.tmp', p);
};

const statePath = path.join(dir, 'worker-state.json');
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { cursor: 0, seeds: {}, exclusions: [] };

const sessionLeads = [];

async function api(action, body, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(cfg.site + '/api/hub/' + action, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'x-worker-id': cfg.workerId,
          'x-worker-token': cfg.workerToken,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(action === 'heartbeat' ? 15000 : 30000)
      });
      if (!r.ok) {
        const errText = (await r.text()).slice(0, 250);
        const err = new Error('Dashboard ' + r.status + ': ' + errText);
        err.status = r.status;
        if ((r.status === 429 || r.status >= 500) && attempt < retries - 1) {
          await pause(1200 * (attempt + 1));
          continue;
        }
        throw err;
      }
      return await r.json();
    } catch (e) {
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
      if (attempt === retries - 1) throw e;
      await pause(1200 * (attempt + 1));
    }
  }
}

function stopChild() {
  if (!child?.pid) return;
  if (isWindows) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      spawnSync('pkill', ['-9', '-P', String(child.pid)], { stdio: 'ignore' });
      process.kill(child.pid, 'SIGKILL');
    } catch {
      try { process.kill(child.pid, 'SIGTERM'); } catch {}
    }
  }
}

function stop() {
  stopping = true;
  stopChild();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function getAvailableMemMB() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch {}
  return Math.round(os.freemem() / (1024 * 1024));
}

function cleanupZombiesAndTemp() {
  try {
    spawnSync('sh', ['-c', 'rm -rf /tmp/playwright_chromiumdev_profile-* 2>/dev/null'], { stdio: 'ignore' });
  } catch {}
  try {
    if (!child?.pid) {
      spawnSync('pkill', ['-9', '-f', 'chrome-headless-shell'], { stdio: 'ignore' });
    }
  } catch {}
}

async function ensureMemoryThreshold() {
  cleanupZombiesAndTemp();
  const minRequiredMB = 75; // 75MB free RAM threshold
  let avail = getAvailableMemMB();
  if (avail < minRequiredMB) {
    console.warn(`[Memory Guard] Available RAM low (${avail}MB < ${minRequiredMB}MB threshold). Performing memory cleanup & cooling down...`);
    if (global.gc) {
      try { global.gc(); } catch {}
    }
    try {
      spawnSync('sudo', ['sysctl', '-w', 'vm.drop_caches=1'], { stdio: 'ignore' });
    } catch {}
    await pause(5000);
    avail = getAvailableMemMB();
    console.log(`[Memory Guard] Post-cleanup available RAM: ${avail}MB.`);
  }
}

async function sync() {
  let cursor = state.cursor;
  do {
    const p = await api('exclusions?cursor=' + cursor);
    for (const r of p.rows) {
      if (!state.exclusions.includes(r.key)) state.exclusions.push(r.key);
      const s = JSON.parse(r.seed || '{}');
      const id = s.place_id || s.cid || s.data_id || s.link;
      if (id) state.seeds[id] = { ...s, _seed: true };
      cursor = Number(r.sequence);
    }
    state.cursor = cursor;
    atomic(statePath, state);
    if (!p.next) break;
  } while (!stopping);
}

async function beat() {
  if (heartbeatBusy) return;
  heartbeatBusy = true;
  try {
    const b = await api('heartbeat', current ? { jobId: current.id, leaseToken: current.lease_token } : {}, 2);
    controllerPaused = !!b.paused;
    hbFailCount = 0;
    if (b.paused) stopChild();
  } catch (e) {
    if (e.status === 409) {
      controllerPaused = true;
      stopChild();
      console.warn('[Heartbeat] Lease lost (409); stopping child job.');
      return;
    }
    hbFailCount++;
    console.warn(`[Heartbeat] Warning (${hbFailCount}/12): ${e.message}`);
    if (hbFailCount >= 12) {
      controllerPaused = true;
      stopChild();
      console.error('Connection lost (12 consecutive failed heartbeats); pausing child work.');
    }
  } finally {
    heartbeatBusy = false;
  }
}

function resolveScraperBinary() {
  if (process.env.SCRAPER_BINARY && fs.existsSync(process.env.SCRAPER_BINARY)) {
    return process.env.SCRAPER_BINARY;
  }
  const candidates = isWindows
    ? [
        path.join(root, 'bin/scraper.exe'),
        path.join(root, 'bin/google-maps-scraper-source.exe'),
        'C:/Users/N4Bx/Desktop/cambridgeshire/bin/google-maps-scraper-source.exe'
      ]
    : [
        path.join(root, 'bin/google-maps-scraper'),
        '/usr/local/bin/google-maps-scraper'
      ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Could not find google-maps-scraper binary. Set SCRAPER_BINARY or build into bin/.');
}

function scrape(job, file) {
  return new Promise((resolve, reject) => {
    const query = String(job.query);
    if (query.length > 200 || !Number.isFinite(Number(job.lat)) || !Number.isFinite(Number(job.lon))) {
      return reject(new Error('Invalid job'));
    }
    const input = path.join(dir, job.id + '.txt');
    fs.writeFileSync(input, query + '\n');
    if (!fs.existsSync(file)) {
      const seedLines = Object.values(state.seeds).map(x => JSON.stringify(x)).join('\n');
      fs.writeFileSync(file, seedLines ? seedLines + '\n' : '');
    }

    const env = { ...process.env, DISABLE_TELEMETRY: '1' };
    if (fs.existsSync(path.join(root, 'runtime/driver'))) {
      env.PLAYWRIGHT_DRIVER_PATH = path.join(root, 'runtime/driver');
    }
    if (fs.existsSync(path.join(root, 'runtime/browsers'))) {
      env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, 'runtime/browsers');
    }
    delete env.PLAYWRIGHT_INSTALL_ONLY;

    const scrapeConc = String(process.env.SCRAPE_CONCURRENCY || '2');
    const poolSize = String(process.env.SCRAPE_BROWSER_POOL || '1');
    const pagesPerBrowser = String(process.env.SCRAPE_PAGES_PER_BROWSER || scrapeConc);
    const scrapeDepth = String(process.env.SCRAPE_DEPTH || '3');

    const args = [
      '-c', scrapeConc,
      '-browser-pool-size', poolSize,
      '-pages-per-browser', pagesPerBrowser,
      '-lang', 'en',
      '-json',
      '-resume',
      '-input', input,
      '-results', file,
      '-geo', job.lat + ',' + job.lon,
      '-zoom', '14',
      '-depth', scrapeDepth,
      '-exit-on-inactivity', '90s'
    ];

    let buffer = '', blocked = false, timedOut = false;
    const log = fs.createWriteStream(path.join(dir, job.id + '.log'), { flags: 'a' });
    const binPath = resolveScraperBinary();
    child = spawn(binPath, args, { cwd: root, env, windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; stopChild(); }, 9 * 60 * 1000);

    const consume = b => {
      log.write(b);
      buffer = (buffer + b.toString()).slice(-10000);
      if (/captcha|unusual traffic|too many requests|rate.?limit|status(?:code)?[ :=]+(?:403|429)\b/i.test(buffer)) {
        blocked = true;
        stopChild();
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      child = null;
      log.end();
      resolve({ code, blocked, timedOut });
    });
  });
}

function isUnderFourStars(r) {
  const raw = r.review_rating ?? r.rating ?? r['Google Rating'];
  if (raw === '' || raw === null || raw === undefined) return true;
  const n = Number(raw);
  return !Number.isFinite(n) || n < 4;
}

async function upload(job, file, allowEmail) {
  if (!fs.existsSync(file)) return;
  const rows = [];
  for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r.title && !r._seed) {
        rows.push(r);
      }
    } catch {}
  }

  const mxCache = {};
  for (let i = 0; i < rows.length && !stopping; i += 20) {
    const batch = rows.slice(i, i + 20).map(raw => {
      // Pre-compute baseline battlecard before website scan
      const normRec = u.normalise(raw, new Date().toISOString());
      const card = bc.generateBattlecard(normRec, {});
      return {
        ...raw,
        town: card.town,
        caller_pitch_summary: card.callerPitchSummary,
        caller_pain_points: card.callerPainPoints,
        ghl_caller_battlecard_note: card.ghlBattlecardNote
      };
    });

    const saved = await api('results', { jobId: job.id, leaseToken: job.lease_token, rows: batch });

    if (allowEmail && Array.isArray(saved.accepted) && saved.accepted.length > 0) {
      const enrichConcurrency = 8;
      for (let j = 0; j < saved.accepted.length; j += enrichConcurrency) {
        if (stopping || controllerPaused) break;
        const chunk = saved.accepted.slice(j, j + enrichConcurrency);
        await Promise.all(chunk.map(async item => {
          if (stopping || controllerPaused) return;
          let email = '', source = '', siteSignals = {};
          const normRec = u.normalise(item.record, new Date().toISOString());
          if (item.record.web_site) {
            try {
              // Fast 7-second budget per website: if no email or slow, immediately skip to next lead
              const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Enrich timeout (7s)')), 7000));
              const check = await Promise.race([lib.enrich(normRec, mxCache), timeoutPromise]);
              siteSignals = check.siteSignals || {};
              if (check.status === 'found') {
                email = check.email;
                source = check.source;
              }
            } catch (e) {
              console.log(`[Fast-Skip] ${normRec.business_name}: ${e.message}`);
            }
          }
          const card = bc.generateBattlecard(normRec, siteSignals);
          await api('enrich', {
            jobId: job.id,
            leaseToken: job.lease_token,
            id: item.id,
            email,
            source,
            town: card.town,
            cms: card.siteSignals.cms,
            caller_pitch_summary: card.callerPitchSummary,
            caller_pain_points: card.callerPainPoints,
            ghl_caller_battlecard_note: card.ghlBattlecardNote
          });

          sessionLeads.push({
            'Business Name': normRec.business_name,
            Category: normRec.category,
            Email: email,
            'Phone Number': lib.phone(normRec.phone),
            Website: normRec.website,
            'Google Maps URL': normRec.google_maps_url,
            Address: normRec.address,
            Town: card.town,
            Postcode: normRec.postcode,
            District: card.town,
            'Google Rating': normRec.rating,
            'Review Count': normRec.review_count,
            'Email Source URL': source,
            'Email Check': email ? 'MX configured; mailbox activity unverified' : 'No public email found',
            'Collected At': new Date().toISOString(),
            'Place ID': normRec.place_id,
            'Caller Pitch Summary': card.callerPitchSummary,
            'Caller Pain Points': card.callerPainPoints,
            'GHL Caller Battlecard Note': card.ghlBattlecardNote
          });
        }));
      }
    }
  }

  if (sessionLeads.length > 0) {
    fs.writeFileSync(path.join(outDir, 'cloud-session-leads-with-battlecards.csv'), lib.csv(sessionLeads));
  }
  console.log(`Saved ${rows.length} raw records from job (${sessionLeads.length} enriched leads in session).`);
  return rows.length;
}

function cleanupJobFiles(jobId) {
  for (const ext of ['.jsonl', '.log', '.txt']) {
    try { fs.unlinkSync(path.join(dir, jobId + ext)); } catch {}
  }
}

(async () => {
  console.log(`Connected 24/7 Cloud Worker: ${cfg.name} -> ${cfg.site}`);
  await beat();
  const timer = setInterval(beat, 20000);
  let jobsCompleted = 0;

  try {
    while (!stopping && Date.now() < deadline && jobsCompleted < maxJobsPerRun) {
      if (controllerPaused) {
        console.log('Hub or worker is paused. Waiting 15s to recheck...');
        await pause(15000);
        await beat();
        if (controllerPaused) {
          await pause(15000);
          continue;
        }
      }
      await ensureMemoryThreshold();
      const next = await api('claim', {});
      if (next.paused || !next.job) {
        console.log(next.paused ? 'Hub is paused.' : 'No more queued jobs available.');
        break;
      }
      current = next.job;
      console.log(`[Job ${jobsCompleted + 1}/${maxJobsPerRun}] Assigned: ${current.query} @ ${current.lat},${current.lon} (Available RAM: ${getAvailableMemMB()}MB)`);
      if (process.env.SYNC_EXCLUSIONS === 'true') {
        await sync();
      }

      if (stopping || controllerPaused) {
        await api('finish', { jobId: current.id, leaseToken: current.lease_token, status: 'paused' }).catch(() => {});
        current = null;
        break;
      }

      const file = path.join(dir, current.id + '.jsonl');
      const result = await scrape(current, file);
      if (result.blocked) {
        await api('report-block', {}).catch(() => {});
        controllerPaused = true;
      }
      const uploadedCount = (await upload(current, file, !result.blocked).catch(e => {
        console.warn('[Upload Warning]', e.message);
        return 0;
      })) || 0;
      cleanupZombiesAndTemp();
      const jobDone = !result.blocked && (result.code === 0 || (result.timedOut && uploadedCount > 0));
      const finalStatus = (controllerPaused && !jobDone) || stopping ? 'paused' : jobDone ? 'done' : 'failed';
      await api('finish', {
        jobId: current.id,
        leaseToken: current.lease_token,
        status: finalStatus,
        blocked: result.blocked,
        error: result.blocked ? 'Access restriction detected' : finalStatus === 'failed' ? 'Scraper exit ' + result.code : ''
      }).catch(e => console.warn('[Finish Warning]', e.message));
      cleanupJobFiles(current.id);
      jobsCompleted++;
      if (result.blocked) controllerPaused = true;
      current = null;
      await pause(1000);
    }
    console.log(`Cloud worker run finished cleanly. Jobs processed this session: ${jobsCompleted}`);
  } finally {
    clearInterval(timer);
    stopChild();
  }
})().catch(e => {
  stopChild();
  console.error('Worker error:', e.message);
  process.exitCode = 1;
});
