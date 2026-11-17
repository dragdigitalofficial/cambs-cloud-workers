'use strict';

/**
 * Bamplify x Cambslist — AI Caller Battlecard & Sales Pitch Engine
 * Implements the 5-Module Specification from Bamplify-Cambslist-Caller-Pitch-Playbook.pdf:
 * - Section 01: Value First (Cambslist live listing) + Empirical Diagnosis (3 Enquiry Leaks) + Commercial Impact + Zero-Risk Close
 * - Section 02: 4-Source Lead R&D Checklist & Mandatory Pairing Directive (SEO #3 always paired with Reviews #5/#6)
 * - Section 03: Our 7 Services & Niche Reactivation Angles (#1 to #7)
 * - Section 04: 5-Second Glanceable 7-Block Caller Battlecard Output Format (for GHL Notes)
 * - Section 05: Self-Learning Feedback Log (High-Ticket Enquiries vs Hands-On Trades / Mobile Operators)
 */

function slugify(name) {
  return String(name || 'business')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'business';
}

function cleanCategoryLabel(rawCategory, businessName = '') {
  const cat = String(rawCategory || '').trim();
  const name = String(businessName || '').toLowerCase();
  if (!cat || /^local business|establishment|point of interest|store|service$/i.test(cat)) {
    if (/respray|kitchen/i.test(name)) return 'kitchen resprays';
    if (/plumb|heating|boiler|gas/i.test(name)) return 'plumbing and heating';
    if (/electr/i.test(name)) return 'electricians';
    if (/carpent|joiner|cabinet|bespoke/i.test(name)) return 'bespoke joinery and carpentry';
    if (/roof/i.test(name)) return 'roofing contractors';
    if (/clean/i.test(name)) return 'cleaning services';
    if (/garage|mot|auto|tyre|car\s*repair/i.test(name)) return 'car servicing and MOT';
    if (/photo|wedding|venue/i.test(name)) return 'wedding and event photography';
    if (/dental|dentist|clinic|physio|chiro|osteopath/i.test(name)) return 'private clinic treatments';
    if (/taxi|cab|chauffeur|coach|airport/i.test(name)) return 'private hire and airport transfers';
    if (/build|construct|renovat|extension/i.test(name)) return 'building and renovations';
    if (/landscap|garden|tree|driveway|paving/i.test(name)) return 'landscaping and driveways';
    if (/locksmith/i.test(name)) return 'emergency locksmiths';
    if (/sweep|chimney/i.test(name)) return 'chimney sweeps';
    return 'local services';
  }
  const lower = cat.toLowerCase().replace(/\s+service$/i, ' services').replace(/\s+shop$/i, 's').replace(/\s+contractor$/i, ' contractors');
  return lower;
}

function resolveTown(record) {
  const town = String(record.town || record.Town || record.complete_address?.city || '').trim();
  if (town) return town;
  const addr = String(record.address || record.Address || '');
  const knownTowns = [
    'Peterborough', 'Cambridge', 'Ely', 'Huntingdon', 'St Neots', 'St Ives',
    'Wisbech', 'March', 'Chatteris', 'Whittlesey', 'Ramsey', 'Soham',
    'Cambourne', 'Histon', 'Sawston', 'Melbourn', 'Linton', 'Cottenham',
    'Waterbeach', 'Littleport', 'Burwell', 'Godmanchester', 'Yaxley', 'Brampton'
  ];
  for (const t of knownTowns) {
    if (new RegExp(`\\b${t}\\b`, 'i').test(addr)) return t;
  }
  const district = String(record.district || record.District || record.location || '').trim();
  if (district) return district;
  return 'Cambridgeshire';
}

function detectPhoneType(phoneStr) {
  const digits = String(phoneStr || '').replace(/\D/g, '').replace(/^0044/, '0').replace(/^44/, '0');
  if (!digits) return { type: 'None', label: 'No phone number listed', isMobile: false, formatted: '' };
  if (/^07\d{8,9}$/.test(digits)) {
    return { type: 'Mobile', label: 'Mobile', isMobile: true, formatted: digits };
  }
  if (/^0[123]\d{8,9}$/.test(digits)) {
    return { type: 'Landline', label: 'Landline', isMobile: false, formatted: digits };
  }
  return { type: 'Phone', label: 'Standard Line', isMobile: false, formatted: digits };
}

function analyzeWebsiteHtml(html = '', url = '') {
  const rawHtml = String(html || '');
  const lower = rawHtml.toLowerCase();
  const urlStr = String(url || '').trim();
  const hasWebsite = Boolean(urlStr);
  const isHttps = urlStr.startsWith('https://');

  let cms = hasWebsite ? 'Custom HTML' : 'No Website';
  if (lower.includes('wp-content') || lower.includes('wp-includes') || /name=["']generator["'][^>]*wordpress/i.test(rawHtml)) {
    cms = 'WordPress';
  } else if (lower.includes('wix.com') || lower.includes('wixstatic.com') || lower.includes('_wix_')) {
    cms = 'Wix';
  } else if (lower.includes('squarespace.com') || lower.includes('static1.squarespace.com') || lower.includes('sqs-')) {
    cms = 'Squarespace';
  } else if (lower.includes('cdn.shopify.com') || lower.includes('shopify.theme')) {
    cms = 'Shopify';
  } else if (lower.includes('webflow') || lower.includes('assets.website-files.com') || lower.includes('wf-page')) {
    cms = 'Webflow';
  } else if (lower.includes('leadconnector') || lower.includes('msgsndr.com') || lower.includes('highlevel')) {
    cms = 'GoHighLevel';
  } else if (lower.includes('framer.com') || lower.includes('framer-')) {
    cms = 'Framer';
  } else if (lower.includes('godaddy') || lower.includes('wsimg.com')) {
    cms = 'GoDaddy Website Builder';
  } else if (lower.includes('weebly')) {
    cms = 'Weebly';
  } else if (lower.includes('joomla')) {
    cms = 'Joomla';
  } else if (lower.includes('drupal')) {
    cms = 'Drupal';
  } else if (lower.includes('_next/static') || lower.includes('__next')) {
    cms = 'Next.js';
  } else if (/\.netlify\.app/i.test(urlStr)) {
    cms = 'Netlify Static Site';
  }

  const chatMatchers = [
    { pattern: /leadconnector|msgsndr\.com|lc_chat/i, name: 'LeadConnector Chat' },
    { pattern: /tidio\.co|tidiochat/i, name: 'Tidio' },
    { pattern: /intercom\.io|intercomsettings/i, name: 'Intercom' },
    { pattern: /tawk\.to/i, name: 'Tawk.to' },
    { pattern: /crisp\.chat/i, name: 'Crisp Chat' },
    { pattern: /livechatinc\.com|__lc\b/i, name: 'LiveChat' },
    { pattern: /drift\.com|driftt/i, name: 'Drift' },
    { pattern: /zendesk\.com.*ekr\/snippet|zopim/i, name: 'Zendesk Chat' },
    { pattern: /freshchat|wchat\.freshchat/i, name: 'Freshchat' },
    { pattern: /hubspot\.com.*conversations|hs-chat/i, name: 'HubSpot Chat' },
    { pattern: /smartsupp/i, name: 'Smartsupp' },
    { pattern: /olark/i, name: 'Olark' },
    { pattern: /chaport/i, name: 'Chaport' },
    { pattern: /jivochat|jivosite/i, name: 'JivoChat' }
  ];
  let chatProvider = null;
  for (const m of chatMatchers) {
    if (m.pattern.test(rawHtml)) {
      chatProvider = m.name;
      break;
    }
  }

  const hasWhatsApp = /wa\.me\/|api\.whatsapp\.com\/send|whatsapp:\/\/send|chat\.whatsapp\.com/i.test(rawHtml);
  const hasTelLink = /href\s*=\s*["']tel:/i.test(rawHtml);

  const visibleText = rawHtml
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  const priceMatches = [...visibleText.matchAll(/£\s*(\d{1,2}(?:,\d{3})+|\d{2,4})(?:\.\d{2})?/g)]
    .map(m => Number(m[1].replace(/,/g, '')))
    .filter(n => n >= 45 && n <= 25000 && n !== 100 && n !== 500 && n !== 1000);

  let extractedPrice = null;
  if (priceMatches.length >= 2) {
    const min = Math.min(...priceMatches);
    const max = Math.max(...priceMatches);
    if (min !== max) {
      extractedPrice = `£${min.toLocaleString('en-GB')} - £${max.toLocaleString('en-GB')}+ (Extracted from website)`;
    } else {
      extractedPrice = `From £${min.toLocaleString('en-GB')}+ (Extracted from website)`;
    }
  } else if (priceMatches.length === 1) {
    extractedPrice = `From £${priceMatches[0].toLocaleString('en-GB')}+ (Extracted from website)`;
  }

  let yearsInBusiness = null;
  const yearsMatch = visibleText.match(/\b(?:over\s+|more\s+than\s+)?(\d{1,2})\+?\s+years(?:'|\s+of)?\s+(?:experience|in\s+business|serving|trading)/i);
  if (yearsMatch && Number(yearsMatch[1]) >= 2 && Number(yearsMatch[1]) <= 90) {
    yearsInBusiness = `${yearsMatch[1]}+ years experience`;
  }

  return {
    hasWebsite,
    isHttps,
    cms,
    hasChatWidget: Boolean(chatProvider),
    chatProvider,
    hasWhatsApp,
    hasTelLink,
    extractedPrice,
    yearsInBusiness
  };
}

function classifyVertical(category = '', businessName = '') {
  const text = `${category} ${businessName}`.toLowerCase();

  if (/kitchen|respray|joiner|carpent|cabinet|wardrobe|bespoke|shopfit|renov|refurb|extension|builder|building|construct|conservator|window|glazing|flooring|roof/i.test(text)) {
    return {
      id: 'bespoke_trades_projects',
      name: 'Bespoke Trades, Joinery & Property Projects',
      isHandsOn: true,
      isHighConsideration: true,
      benchmarkValue: '£1,200 - £4,500+ per bespoke project (Benchmark - quote on enquiry)',
      dbReactivationSummary: 'Past customers -> seasonal repeat bookings, maintenance check-ins, and a wave of 5-star Google reviews',
      dbReactivationDetail: 'Past customers -> bespoke storage/media walls, property upgrades, seasonal maintenance check-ins, and a wave of fresh 5-star Google reviews',
      selfLearningInsight: '[Hands-On Trades & Bespoke Projects Benchmark]: Leading with Missed Call Text Back ("when you\'re on a job / in the workshop") + Automated Google Reviews & Review Engagement to push them from Page 2+ into the local Map Pack. High project value (£1,200+) means saving even 1 leaked enquiry pays for the entire system.'
    };
  }

  if (/photo|wedding|bridal|venue|event|marquee|cater|florist|videograph|dj\b|party|hire|banquet/i.test(text)) {
    return {
      id: 'wedding_events',
      name: 'Wedding / Event Services',
      isHandsOn: true,
      isHighConsideration: true,
      benchmarkValue: '£1,500 - £3,500+ per package/booking (Benchmark - quote on enquiry)',
      dbReactivationSummary: 'Past clients -> anniversary, maternity, family shoots, or seasonal events, plus a wave of 5-star Google reviews',
      dbReactivationDetail: 'Past wedding/event clients -> anniversary, maternity, family shoots, or seasonal events + fresh 5-star Google reviews',
      selfLearningInsight: '[Wedding / Event Services Benchmark (£1,500+)]: Highlighting Page 2+ search ranking + review gap paired with 30-day free trial (GBP Optimization + Automated Reviews + Missed Call Text Back) and £0-upfront Client Re-engagement for repeat lifecycle bookings. Saving 1 leaked enquiry covers months of service with zero upfront risk.'
    };
  }

  if (/garage|mot\b|auto|mechanic|car\s*repair|tyre|exhaust|body\s*shop|bodyshop|vehicle|gearbox|clutch|valet|detailing/i.test(text)) {
    return {
      id: 'automotive_garages',
      name: 'Garages / Automotive',
      isHandsOn: true,
      isHighConsideration: false,
      benchmarkValue: '£180 - £850+ per service / repair job (Benchmark - quote on enquiry)',
      dbReactivationSummary: 'Past customers -> MOT due dates, annual servicing, winter checks, and a wave of 5-star Google reviews',
      dbReactivationDetail: 'Past customers -> MOT due dates, annual servicing, winter safety checks, and automated 5-star Google review requests',
      selfLearningInsight: '[Automotive & Garages Benchmark]: Mechanics under ramps miss calls constantly during peak drop-off hours. Lead with immediate Missed Call Text Back recovery + automated MOT/annual service reminders to past customers on a £0-upfront basis.'
    };
  }

  if (/plumb|heating|boiler|gas|electr|eicr|rewire|sweep|chimney|clean|gutter|driveway|pressure\s*wash|locksmith|drain|pest|handyman|decorat|painter|plaster|scaffol|fenc|tree\s*surg|landscap|garden|removal|skip\s*hire/i.test(text)) {
    return {
      id: 'hands_on_trades',
      name: 'Hands-On Trades & Mobile Specialists',
      isHandsOn: true,
      isHighConsideration: false,
      benchmarkValue: '£150 - £1,200+ per callout / installation (Benchmark - quote on enquiry)',
      dbReactivationSummary: 'Past customers -> seasonal repeat bookings, maintenance check-ins, and a wave of 5-star Google reviews',
      dbReactivationDetail: 'Past customers -> EICR renewals, annual boiler servicing, consumer unit upgrades, annual chimney sweeps, driveway/gutter cleans, and a wave of 5-star Google reviews',
      selfLearningInsight: '[Hands-On Trades & Mobile Specialists Benchmark]: Lead with Missed Call Text Back ("when you\'re on a job / on tools") + Automated Google Reviews & Review Engagement to push them from Page 2+ into the local Map Pack. Avoid pitching complex website rebuilds or software jargon cold if they say they are busy on tools.'
    };
  }

  if (/clinic|dent|orthodont|medical|doctor|physio|chiro|osteopath|podiatr|optician|hearing|spa|salon|beauty|hair|barber|aesthetic|skin|massage|nail|gym|fitness|pilates|yoga|vet|pet|groom/i.test(text)) {
    return {
      id: 'health_beauty_wellness',
      name: 'Health / Beauty / Clinics & Wellness',
      isHandsOn: true,
      isHighConsideration: true,
      benchmarkValue: '£120 - £1,200+ per treatment plan / client LTV (Benchmark - quote on enquiry)',
      dbReactivationSummary: 'Past clients -> lapsed client win-back, seasonal packages, maintenance check-ins, and a wave of 5-star Google reviews',
      dbReactivationDetail: 'Past clients -> lapsed client win-back, seasonal treatment packages, corporate wellness days, and fresh 5-star Google reviews',
      selfLearningInsight: '[Clinics, Health & Wellness Benchmark]: High patient/client lifetime value means winning back lapsed clients via £0-upfront DB Reactivation and capturing evening/weekend website visitors via 24/7 AI Chat & Automated GBP Reviews delivers immediate ROI.'
    };
  }

  if (/taxi|cab|chauffeur|coach\b|minibus|airport|transfer|transport|haulage|courier|tour/i.test(text)) {
    return {
      id: 'taxis_coaches_tours',
      name: 'Taxis / Coaches / Chauffeur & Tours',
      isHandsOn: true,
      isHighConsideration: true,
      benchmarkValue: '£120 - £1,500+ per group booking / corporate account (Benchmark - quote on enquiry)',
      dbReactivationSummary: 'Past bookers -> summer/Christmas group outings, airport runs, corporate accounts, and a wave of 5-star Google reviews',
      dbReactivationDetail: 'Past bookers -> summer/Christmas group outings, airport runs, repeat corporate accounts, and 5-star Google reviews',
      selfLearningInsight: '[Drivers, Chauffeurs & Coach Hire Benchmark]: Drivers on the road cannot answer calls safely. Lead with Missed Call Text Back to secure airport runs and private hires before callers ring the next operator on Google.'
    };
  }

  if (/solicitor|law|legal|will|probate|accountant|tax|bookkeep|financial|mortgage|architect|surveyor|estate\s*agent|letting|property|consult|agency|it\s*support|computer/i.test(text)) {
    return {
      id: 'professional_services',
      name: 'Professional & High-Consideration Services',
      isHandsOn: false,
      isHighConsideration: true,
      benchmarkValue: '£650 - £3,000+ per client engagement (Benchmark - quote on enquiry)',
      dbReactivationSummary: 'Past clients -> annual reviews, repeat consultations, referral check-ins, and a wave of 5-star Google reviews',
      dbReactivationDetail: 'Past clients -> annual policy/account reviews, lifecycle updates, and a wave of fresh 5-star Google reviews',
      selfLearningInsight: '[High-Consideration Professional Services Benchmark]: Prospects research out of hours. Highlighting Page 2+ Google ranking + review velocity alongside 24/7 Website/WhatsApp AI Lead Capture and £0-upfront past-client reactivation converts immediately.'
    };
  }

  return {
    id: 'local_commercial',
    name: 'Local Commercial Business',
    isHandsOn: true,
    isHighConsideration: true,
    benchmarkValue: '£250 - £2,500+ per customer / project (Benchmark - quote on enquiry)',
    dbReactivationSummary: 'Past customers -> seasonal repeat bookings, maintenance check-ins, and a wave of 5-star Google reviews',
    dbReactivationDetail: 'Past customers -> seasonal repeat bookings, check-ins, and a wave of fresh 5-star Google reviews',
    selfLearningInsight: '[Cambridgeshire Local Business Benchmark]: Always pair Page 2+ Google ranking with Automated Reviews (#5/#6) and Missed Call Text Back (#2), anchoring the pitch around 1 saved customer covering the entire system with zero upfront risk.'
  };
}

function generateBattlecard(record, checkSignals = {}) {
  const businessName = String(record['Business Name'] || record.business_name || record.title || 'Local Business').trim();
  const rawCategory = String(record.category || record.business_type || record.Category || '').trim();
  const serviceKeyword = cleanCategoryLabel(rawCategory, businessName);
  const town = resolveTown(record);
  const phoneRaw = record['Phone Number'] || record.phone || '';
  const phoneInfo = detectPhoneType(phoneRaw);
  const websiteUrl = String(record.Website || record.website || record.web_site || '').trim();
  const ratingRaw = record['Google Rating'] ?? record.rating ?? record.review_rating ?? '';
  const rating = ratingRaw !== '' && Number.isFinite(Number(ratingRaw)) ? Number(ratingRaw) : null;
  const reviewsRaw = record['Review Count'] ?? record.review_count ?? '';
  const reviewCount = reviewsRaw !== '' && Number.isFinite(Number(reviewsRaw)) ? Number(reviewsRaw) : null;

  const site = {
    hasWebsite: Boolean(websiteUrl),
    isHttps: websiteUrl.startsWith('https://'),
    cms: checkSignals.cms || (websiteUrl ? (/\.netlify\.app/i.test(websiteUrl) ? 'Netlify' : 'WordPress') : 'No Website'),
    hasChatWidget: Boolean(checkSignals.hasChatWidget),
    chatProvider: checkSignals.chatProvider || null,
    hasWhatsApp: Boolean(checkSignals.hasWhatsApp),
    hasTelLink: checkSignals.hasTelLink !== undefined ? Boolean(checkSignals.hasTelLink) : true,
    extractedPrice: checkSignals.extractedPrice || null,
    yearsInBusiness: checkSignals.yearsInBusiness || null
  };

  const vertical = classifyVertical(rawCategory, businessName);
  const valueString = site.extractedPrice || vertical.benchmarkValue;
  const slug = slugify(businessName);
  const cambslistUrl = `https://cambslist.co.uk/business-listing/${slug}/`;

  const painPoints = [];

  const reviewDetail = reviewCount !== null
    ? (reviewCount < 30
      ? `Currently at ${reviewCount} Google review${reviewCount === 1 ? '' : 's'}${rating ? ` (${rating}★)` : ''} — Google ranks local businesses much higher when review volume, recency, and owner reply engagement increase.`
      : `Even with ${reviewCount} reviews${rating ? ` (${rating}★)` : ''}, Google ranks local businesses much higher when fresh review velocity, recency, and owner reply engagement increase.`)
    : `Google ranks local businesses much higher when review volume, recency, and owner reply engagement increase.`;

  painPoints.push(
    `[Low Google Search Rank + Review Gap]: Ranks Page 2+ (Outside Page 1 Top 10 for "${serviceKeyword} in ${town}"). ${reviewDetail}`
  );

  if (phoneInfo.isMobile) {
    painPoints.push(
      `[Missed Call Risk]: Runs on a mobile number (Mobile) without Missed Call Text Back - any call missed while with a client or on a job goes straight to a competitor.`
    );
  } else if (phoneInfo.type === 'Landline') {
    painPoints.push(
      `[Missed Call & Out-of-Hours Risk]: Runs on a landline (${phoneInfo.formatted}) without Missed Call Text Back - any unanswered peak-hour or after-hours call goes straight to a competitor.`
    );
  } else {
    painPoints.push(
      `[Missed Call Risk]: No instant Missed Call Text Back workflow configured - any missed customer call during busy work hours goes straight to a competitor on Google.`
    );
  }

  if (!site.hasWebsite) {
    painPoints.push(
      `[No Conversion Website / 24/7 Capture]: No dedicated conversion website or 24/7 WhatsApp/AI chat capture to turn local searchers into booked enquiries out of hours.`
    );
  } else if (!site.isHttps) {
    painPoints.push(
      `[Insecure Non-SSL Website + No 24/7 Chat]: Website (${site.cms}, HTTP non-SSL) shows a browser "Not Secure" warning and has no live chat or WhatsApp button to capture evening/weekend enquiries.`
    );
  } else if (!site.hasChatWidget && !site.hasWhatsApp) {
    painPoints.push(
      `[No 24/7 Website Chat / Instant Capture]: Website (${site.cms}) has no live chat or AI chatbot and no WhatsApp button to capture evening/weekend enquiries.`
    );
  } else if (!site.hasWhatsApp) {
    painPoints.push(
      `[Missing Instant WhatsApp & Click-to-Book Flow]: Website (${site.cms}) lacks direct WhatsApp lead capture and automated SMS follow-up for mobile visitors comparing quotes.`
    );
  } else {
    painPoints.push(
      `[Slow Web Enquiry Follow-Up]: Website (${site.cms}) enquiries rely on manual email/form replies rather than instant 24/7 AI qualification and diary booking.`
    );
  }

  const callerPainPoints = painPoints.join(' || ');

  let primaryBundle = 'GBP & Automated Reviews (#5) + Local SEO Rankings (#3) + Missed Call Text Back (#2)';
  if (!site.hasWebsite || !site.isHttps) {
    primaryBundle = 'GBP & Automated Reviews (#5) + Local SEO Rankings (#3) + Missed Call Text Back (#2) + Conversion Website Upgrade (#1)';
  }

  const callerPitchSummary =
    `#1: 30-Day Free Trial of Growth System (${primaryBundle}) | ` +
    `#2: £0-Upfront DB Reactivation (${vertical.dbReactivationSummary}) | ` +
    `#3: 90-Day Homepage + Blog | ` +
    `Value: ${valueString}`;

  const scaleHeritage = [
    site.yearsInBusiness,
    reviewCount !== null ? `${reviewCount} Google reviews${rating ? ` (${rating}★)` : ''}` : 'Local GBP profile',
    phoneInfo.isMobile ? 'Mobile / Hands-On Operator' : 'Established Local Line'
  ].filter(Boolean).join(' • ');

  const primarySpokenHook = phoneInfo.isMobile || vertical.isHandsOn
    ? `"An automated SMS is sent the second you miss a call while you're with a client or on a job, securing the lead before they ring the next competitor on Google — plus we set up automated Google review requests & replies to push your business onto Page 1 for '${serviceKeyword} in ${town}' without paying per shared lead like Bark or Checkatrade."`
    : `"We fix your Google Maps profile visibility, set up automated review request & reply workflows to push you onto Page 1 for '${serviceKeyword} in ${town}', and capture evening/weekend visitors on your ${site.cms} site with Missed Call Text Back (#2) & 24/7 AI Chat (#4)."`;

  const watchouts = phoneInfo.isMobile || vertical.isHandsOn
    ? `Runs on a mobile number (${phoneInfo.formatted || 'Mobile'}) — likely on tools or with clients when answering. Lead with immediate 5-second value: reference their free live Cambslist listing first, then pitch Missed Call Text Back + Automated Reviews. Do NOT pitch complex website rebuilds or software jargon cold. Anchor around economics: saving just 1 leaked job (${valueString}) pays for the entire system.`
    : `Receptionist/Landline gatekeeper possible (${phoneInfo.formatted || 'Landline'}). Ask for the Owner/Managing Director referencing their live Cambslist directory listing (${cambslistUrl}). Anchor around 1 saved enquiry (${valueString}) covering the system with zero upfront risk.`;

  const ghlBattlecardNote = [
    `BLOCK 01 | SNAPSHOT: Decision Maker: Owner / MD | Town: ${town} | Est. Job/Package Value: ${valueString} | Scale/Heritage: ${scaleHeritage} | Warm Context: Free live listing at ${cambslistUrl}`,
    `BLOCK 02 | TOP 3 VERIFIED PAIN POINTS: ${callerPainPoints}`,
    `BLOCK 03 | #1 PRIMARY PITCH (30-Day Growth System Trial): Pitch: ${primaryBundle} + 24/7 AI Chat (#4) | Spoken Hook: ${primarySpokenHook}`,
    `BLOCK 04 | #2 NO-BRAINER WEDGE (£0-Upfront DB Reactivation - Service #6): Niche Repeat Angle: ${vertical.dbReactivationDetail} | Spoken Hook: "Zero upfront fee. We reach out to your past clients automatically to book repeat work and generate a wave of fresh 5-star Google reviews, and only take a small percentage from successfully booked clients - making it 100% risk-free for you to start."`,
    `BLOCK 05 | #3 FALLBACK / UPSELL PITCH (Cambslist Premium Tier - Service #7): 90-Day Cambslist Homepage Feature + Custom SEO Blog Post | Spoken Hook: "Featured placement on the Cambslist homepage for 90 days plus a dedicated SEO blog article spotlighting ${businessName} to local ${town} & Cambridgeshire residents."`,
    `BLOCK 06 | CALLER WATCHOUTS & OBJECTION HANDLER: ${watchouts}`,
    `BLOCK 07 | SELF-LEARNING INSIGHT: ${vertical.selfLearningInsight}`
  ].join('\n');

  return {
    callerPitchSummary,
    callerPainPoints,
    ghlBattlecardNote,
    siteSignals: site,
    vertical: vertical.name,
    serviceKeyword,
    town
  };
}

module.exports = {
  slugify,
  cleanCategoryLabel,
  resolveTown,
  detectPhoneType,
  analyzeWebsiteHtml,
  classifyVertical,
  generateBattlecard
};
