const express = require("express");
const axios = require("axios");
const cors = require("cors");
const compression = require("compression");
const path = require("path");

const app = express();
app.disable("x-powered-by");
const PORT = process.env.PORT || 3000;

// Simple in-memory cache for SEO endpoints (prevents crawler bursts hammering TicketSource)
const SITEMAP_TTL_MS = parseInt(process.env.SITEMAP_TTL_MS || "", 10) || 6 * 60 * 60 * 1000; // default 6 hours
let sitemapCache = { xml: null, ts: 0, etag: null };

/**
 * IMPORTANT:
 * - DO NOT hardcode your TicketSource API key in the repo.
 * - Set TICKETSOURCE_API_KEY in Render Environment.
 */
const API_KEY = process.env.TICKETSOURCE_API_KEY;

// Fail fast in production if key is missing (prevents silent breakage)
if (!API_KEY) {
  const msg =
    "Missing TICKETSOURCE_API_KEY env var. Set it in Render (and in .env locally if needed).";
  if (process.env.NODE_ENV === "production") {
    throw new Error(msg);
  } else {
    console.warn(`[WARN] ${msg}`);
  }
}

// Force canonical base URL for robots/sitemap/canonicals in production
// Example: https://www.reagalevents.com
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();

const SEO_FLAGS = {
  enableJsonLd: true,
  enableFaq: true,
  enableWeekendLine: true,
  enableFamilyIntentLine: true,
  enableSitemap: true,
  enableRobotsTxt: true,
};

// Render/proxies: needed so req.protocol becomes https behind proxy
app.set("trust proxy", 1);

app.use(cors());
app.use(compression());

app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "30d",
    immutable: false,
    setHeaders(res, filePath) {
      const ext = path.extname(filePath).toLowerCase();

      if (ext === ".html") {
        res.setHeader("Cache-Control", "no-cache");
        return;
      }

      if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"].includes(ext)) {
        res.setHeader("Cache-Control", "public, max-age=2592000"); // 30 days
        return;
      }

      if ([".css", ".js"].includes(ext)) {
        res.setHeader("Cache-Control", "public, max-age=604800"); // 7 days
        return;
      }
    },
  })
);


// Redirect /index.html to / to avoid duplicate indexing
app.get("/index.html", (req, res) => res.redirect(301, "/"));

// -------------------------
// Helpers
// -------------------------
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function slugifyTown(town) {
  return String(town || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function startOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function toDateLabel(iso) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function toDateLabelFull(iso) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function toTimeLabel(iso) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function getBaseUrl(req) {
  // Prefer an explicit public base URL so canonicals/sitemap/schema remain correct behind proxies/CDNs.
  // Example: https://www.reagalevents.com
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL.replace(/\/+$/, "");
  }
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
}

function stripQuery(originalUrlOrPath) {
  return String(originalUrlOrPath || "").split("?")[0];
}

function isWeekend(dateObj) {
  const d = dateObj.getDay();
  return d === 5 || d === 6 || d === 0;
}

function withinDays(dateObj, days) {
  const today = startOfTodayLocal();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + days);
  return dateObj >= today && dateObj <= cutoff;
}

function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function buildTourNowNextHtml(townIndex) {
  const today = startOfTodayLocal();

  const sorted = [...(townIndex || [])].sort(
    (a, b) => new Date(a.startDateISO) - new Date(b.startDateISO)
  );

  // "Current" = any town whose date range includes today (prefer FINAL_DAY/IN_TOWN_NOW)
  const currentTown =
    sorted.find((t) => t.status === "FINAL_DAY") ||
    sorted.find((t) => t.status === "IN_TOWN_NOW") ||
    sorted.find((t) => {
      const s = new Date(t.startDateISO);
      const e = new Date(t.endDateISO);
      const startDay = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      const endDay = new Date(e.getFullYear(), e.getMonth(), e.getDate());
      return today >= startDay && today <= endDay;
    }) ||
    null;

  if (!currentTown) {
    // Fallback: show next stop only
    const nextOnly = sorted.find((t) => t.status === "NEXT_STOP") || sorted[0];
    if (!nextOnly) return "";
    return `<p class="tour-now-next"><strong>Next stop</strong> <a href="/circus-in/${escapeHtml(
      nextOnly.townSlug
    )}">${escapeHtml(nextOnly.town)}</a></p>`;
  }

  const end = new Date(currentTown.endDateISO);
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const isFinalDay = isSameLocalDay(today, endDay) || currentTown.status === "FINAL_DAY";
  const isFinalWeekend =
    !isFinalDay && isWeekend(today) && withinDays(endDay, 2) && isWeekend(endDay);

  let leftLabel = "Currently in";
  if (isFinalDay) leftLabel = "Last day in";
  else if (isFinalWeekend) leftLabel = "Final weekend in";

  // Next town after current end
  const nextTown =
    sorted.find((t) => t.status === "NEXT_STOP") ||
    sorted.find((t) => new Date(t.startDateISO) > endDay) ||
    null;

  const left = `<strong>${escapeHtml(leftLabel)}</strong> <a href="/circus-in/${escapeHtml(
    currentTown.townSlug
  )}">${escapeHtml(currentTown.town)}</a>`;

  const right = nextTown
    ? `<span class="dot">•</span> <strong>Next stop</strong> <a href="/circus-in/${escapeHtml(
        nextTown.townSlug
      )}">${escapeHtml(nextTown.town)}</a>`
    : "";

  return `<p class="tour-now-next">${left}${right}</p>`;
}

// -------------------------
// Venue extraction + adaptive description
// -------------------------
function pickVenueInfo(venue) {
  const a = venue?.attributes || {};
  const addr = a.address || {};

  return {
    venueName: a.name || a.title || "",
    address1: addr.line_1 || "",
    address2: addr.line_2 || "",
    address3: addr.line_3 || "",
    address4: addr.line_4 || "",
    postcode: addr.postcode || addr.post_code || "",
    county: addr.county || "",
    country: addr.country || "",
  };
}

function buildAdaptiveTownDescription({
  townName,
  venueInfo,
  status,
  startDateISO,
  endDateISO,
  nextTownName = "",
}) {
  const venueName = venueInfo?.venueName ? venueInfo.venueName : "our venue";
  const addressBits = [venueInfo?.address1, venueInfo?.address2, venueInfo?.postcode]
    .filter(Boolean)
    .join(", ");
  const locationBit = addressBits ? `, ${addressBits}` : "";

  const dateRange =
    startDateISO && endDateISO ? `${toDateLabel(startDateISO)} – ${toDateLabel(endDateISO)}` : "";

  let opener = `Reagal Events is coming to ${townName}!`;
  let helperLine = dateRange ? `Dates: ${dateRange}.` : "";

  if (status === "FINAL_DAY") {
    opener = `Final day in ${townName} today!`;
    helperLine = dateRange ? `Last chance — ${dateRange}.` : "Last chance to catch the show.";
  } else if (status === "IN_TOWN_NOW") {
    opener = `We’re in ${townName} right now!`;
    helperLine = dateRange ? `Running ${dateRange}.` : "Book today and pick your best time.";
  } else if (status === "COMING_SOON") {
    opener = `Coming soon to ${townName}!`;
    helperLine = dateRange ? `Running ${dateRange}.` : "Dates are listed below.";
  } else if (status === "NEXT_STOP") {
    opener = `${townName} is our next stop!`;
    helperLine = dateRange ? `Dates: ${dateRange}.` : "Dates are listed below.";
  } else if (status === "LATER") {
    opener = `Tour dates for ${townName} are listed below.`;
    helperLine = dateRange ? `Planned dates: ${dateRange}.` : "";
  }

  const nextBit =
    nextTownName && status !== "FINAL_DAY"
      ? ` Next stop after ${townName}: ${nextTownName}.`
      : "";

  return (
    `${opener} ` +
    `Join us at ${venueName}${locationBit} for a fun family show packed with laughs, thrills and classic big top magic. ` +
    `${helperLine}${nextBit} ` +
    `Select a date and time below to book your tickets.`
  )
    .replace(/\s+/g, " ")
    .trim();
}

// -------------------------
// SEO helpers
// -------------------------
function buildFamilyIntentLine(townName) {
  return `Looking for things to do with kids in ${townName}? This family-friendly event is a great day out for weekends and school holidays.`;
}

function buildWeekendLine(townObj) {
  if (!SEO_FLAGS.enableWeekendLine) return "";
  const allDates = [];
  for (const ev of townObj.events || []) {
    for (const d of ev.dates || []) allDates.push(new Date(d.startISO));
  }
  const hasWeekendSoon = allDates.some((dt) => withinDays(dt, 10) && isWeekend(dt));
  if (!hasWeekendSoon) return "";
  return `Running this weekend in ${townObj.town} — advance booking recommended.`;
}

function buildFaqBlock(townName, venueInfo) {
  if (!SEO_FLAGS.enableFaq) return { html: "", schema: null };

  const venueName = venueInfo?.venueName ? venueInfo.venueName : `the venue in ${townName}`;
  const qas = [
    {
      q: `Is this event suitable for children?`,
      a: `Yes — it’s designed as a family-friendly experience. Please check the event description and any age guidance on the ticket page before booking.`,
    },
    {
      q: `Where is the venue in ${townName}?`,
      a: `${venueName} is listed on this page. Select a date/time to open the official booking page for the full venue details and any access information.`,
    },
    {
      q: `Do I need to book tickets in advance?`,
      a: `We recommend booking online in advance to secure your preferred date and time.`,
    },
  ];

  const html = `
    <details class="town-page-box" style="margin:14px auto; cursor:pointer; color:#fff;">
      <summary style="font-weight:800; font-size:18px; color:#fff;">FAQs</summary>
      <div style="margin-top:10px; text-align:left; max-width:760px; margin-left:auto; margin-right:auto; color:#fff;">
        ${qas
          .map(
            (x) => `
          <div style="margin:10px 0; color:#fff;">
            <div style="font-weight:800; color:#fff;">${escapeHtml(x.q)}</div>
            <div style="opacity:0.95; color:#fff;">${escapeHtml(x.a)}</div>
          </div>
        `
          )
          .join("")}
      </div>
    </details>
  `;

  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: qas.map((x) => ({
      "@type": "Question",
      name: x.q,
      acceptedAnswer: { "@type": "Answer", text: x.a },
    })),
  };

  return { html, schema };
}

function buildEventJsonLdForTown(req, townObj) {
  if (!SEO_FLAGS.enableJsonLd) return [];

  const baseUrl = getBaseUrl(req);
  const townUrl = `${baseUrl}/circus-in/${townObj.townSlug}`;

  const organizer = {
    "@type": "Organization",
    name: "Reagal Events",
    url: baseUrl,
  };

  const schemas = [];

  for (const ev of townObj.events || []) {
    const dates = (ev.dates || []).map((d) => new Date(d.startISO)).sort((a, b) => a - b);
    if (!dates.length) continue;

    const startDate = dates[0].toISOString();
    const endDate = dates[dates.length - 1].toISOString();

    const v = ev.venueInfo || {};
    const location = {
      "@type": "Place",
      name: v.venueName || `${townObj.town} venue`,
      address: {
        "@type": "PostalAddress",
        streetAddress: [v.address1, v.address2, v.address4].filter(Boolean).join(", "),
        addressLocality: townObj.town,
        addressRegion: v.county || "",
        postalCode: v.postcode || "",
        addressCountry: v.country || "GB",
      },
    };

    const firstBooking = (ev.dates || [])[0]?.bookNowLink || townUrl;

    schemas.push({
      "@context": "https://schema.org",
      "@type": "Event",
      name: ev.eventName || `Family friendly circus in ${townObj.town}`,
      startDate,
      endDate,
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      eventStatus: "https://schema.org/EventScheduled",
      location,
      image: ev.thumbnail ? [ev.thumbnail] : undefined,
      description: (ev.description || "").replace(/\s+/g, " ").trim().slice(0, 400) || undefined,
      organizer,
      url: townUrl,
      offers: {
        "@type": "Offer",
        url: firstBooking,
        availability: "https://schema.org/InStock",
        validFrom: startDate,
      },
    });
  }

  return schemas;
}

// -------------------------
// -------------------------
// Rendering shell
// -------------------------
function renderShell({
  req,
  title,
  description,
  bodyHtml,
  robots = "index, follow",
  headExtras = "",
  jsonLdObjects = [],
}) {
  const baseUrl = getBaseUrl(req);
  const canonicalPath = stripQuery(req.originalUrl);
  const canonical = `${baseUrl}${canonicalPath}`;

  const year = new Date().getFullYear();

  // Use a real share image you host. banner1.jpg works as a starter.
  const SITE_OG_IMAGE = `${baseUrl}/banner1.jpg`;

  const jsonLdScripts =
    SEO_FLAGS.enableJsonLd && jsonLdObjects && jsonLdObjects.length
      ? jsonLdObjects
          .filter(Boolean)
          .map((obj) => {
            const safe = JSON.stringify(obj).replace(/</g, "\\u003c");
            return `<script type="application/ld+json">${safe}</script>`;
          })
          .join("\n")
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>

  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}"/>
  <meta name="robots" content="${escapeHtml(robots)}"/>
  <link rel="canonical" href="${escapeHtml(canonical)}"/>

  <!-- Open Graph -->
  <meta property="og:site_name" content="Reagal Events"/>
  <meta property="og:locale" content="en_GB"/>
  <meta property="og:title" content="${escapeHtml(title)}"/>
  <meta property="og:description" content="${escapeHtml(description)}"/>
  <meta property="og:url" content="${escapeHtml(canonical)}"/>
  <meta property="og:type" content="website"/>
  <meta property="og:image" content="${escapeHtml(SITE_OG_IMAGE)}"/>

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:title" content="${escapeHtml(title)}"/>
  <meta name="twitter:description" content="${escapeHtml(description)}"/>
  <meta name="twitter:image" content="${escapeHtml(SITE_OG_IMAGE)}"/>

  <!-- Favicons -->
  <link rel="icon" href="/favicon.ico" sizes="any"/>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"/>
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png"/>
  <link rel="apple-touch-icon" href="/favicon-512.png"/>

  <link rel="stylesheet" href="/styles.css"/>

  <!-- Speed up third-party CSS -->
  <link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css">

  ${headExtras || ""}
  ${jsonLdScripts}
</head>
<body>
  <header>
    <img src="/banner1.jpg" alt="Reagal Events Banner" class="banner">
    <div class="banner2-container">
      <h2 class="circus-font">Proudly Presents</h2>
    </div>
    <nav id="menu">
      <ul>
        <li><a href="/index.html">Welcome</a></li>
        <li><a href="/all-shows.html">All Shows</a></li>
        <li><a href="/tour-locations">Tour Locations</a></li>
        <li><a href="/gallery.html">Gallery</a></li>
        <li><a href="/about-us.html">About Us</a></li>
        <li><a href="/contact.html">Contact Us</a></li>
        <li><a href="/general-tour.html">General Tour</a></li>
        <li><a href="/summer-season.html">Summer Season</a></li>
        <li><a href="/halloween-circus.html">Halloween Circus</a></li>
      </ul>
    </nav>
  </header>

  <main>
    ${bodyHtml}
  </main>

  <footer>
<div class="footer-container">
  <div class="footer-left">
    <div class="social-links">
      <a class="social-icon" href="https://www.facebook.com/Reagalevents" rel="noopener" target="_blank" aria-label="Reagal Events on Facebook">
        <i class="fa-brands fa-facebook-f"></i>
      </a>
      <a class="social-icon" href="https://www.tiktok.com/@the.wonder.circus" rel="noopener" target="_blank" aria-label="The Wonder Circus on TikTok">
        <i class="fa-brands fa-tiktok"></i>
      </a>
    </div>
  </div>

  <div class="footer-center footer-authority">
    <p class="footer-authority-title"><strong>Reagal Events</strong></p>
    <p class="footer-authority-text">
      A traditional touring circus bringing family-friendly live entertainment to towns across the UK.
      Explore our tour locations, learn about life on the road, and find official media assets.
    </p>
    <div class="footer-authority-links">
      <a href="/press-media.html">Press &amp; Media</a>
      <span class="footer-link-sep">•</span>
      <a href="/how-a-traditional-touring-circus-works.html">How it works</a>
      <span class="footer-link-sep">•</span>
      <a href="/life-on-the-road-with-reagal-events.html">Life on the road</a>
      <span class="footer-link-sep">•</span>
      <a href="/circus-animal-welfare-standards.html">Animal welfare</a>
    </div>
  </div>

  <div class="footer-right">
    <div class="ticketsource-button">
      <a href="https://www.ticketsource.co.uk/Reagalevents" rel="noopener" target="_blank">
        <img src="https://www.ticketsource.co.uk/images/bookNow/bookNow-black-small.png" alt="Book now" width="130" height="56" loading="lazy"/>
      </a>
    </div>
    <div class="footer-nap">
      <p><strong>Reagal Events</strong></p>
      <p><a href="tel:07719877422">07719 877422</a></p>
      <p>United Kingdom</p>
      <p>Animal licence number: 19/00613/AWEA</p>
    </div>
  </div>

  <p class="footer-text">© 2026 Reagal Events. All rights reserved.</p>
</div>
</footer>

  <!-- Autoscroll: bring menu to top, but only after:
       - minimum banner time (2.5s), and
       - events have appeared (or "no events" message), if this page has events -->
  <script>
    (function () {
      var cancelled = false;

      function cancel() { cancelled = true; cleanup(); }
      function cleanup() {
        window.removeEventListener('wheel', cancel, { passive: true });
        window.removeEventListener('touchstart', cancel, { passive: true });
        window.removeEventListener('keydown', cancel);
      }

      function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

      function pageLooksLikeEventsPage() {
        return !!document.querySelector('[id$="-events"], #events-container, .events-container');
      }

      async function waitForEvents(maxWaitMs) {
        if (!pageLooksLikeEventsPage()) return;

        var start = Date.now();
        while (Date.now() - start < maxWaitMs) {
          if (document.querySelector('.event')) return;
          if (document.querySelector('.no-events-message')) return;

          // Fallback: any events container has children
          var containers = document.querySelectorAll('[id$="-events"], #events-container, .events-container');
          for (var i = 0; i < containers.length; i++) {
            if (containers[i] && containers[i].children && containers[i].children.length > 0) return;
          }

          await sleep(80);
        }
      }

      window.addEventListener('wheel', cancel, { passive: true });
      window.addEventListener('touchstart', cancel, { passive: true });
      window.addEventListener('keydown', cancel);

      window.addEventListener('load', function() {
        Promise.all([
          sleep(2500),      // minimum banner time
          waitForEvents(12000) // wait for events if applicable
        ]).then(function() {
          if (cancelled) return;

          var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          var menu = document.getElementById('menu');
          if (!menu) return;

          var y = menu.getBoundingClientRect().top + window.pageYOffset;
          window.scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' });

          cleanup();
        }).catch(function() { cleanup(); });
      });
    })();
  </script>
  <script src="/script.js" defer></script>
</body>
</html>`;
}


// TicketSource resilience knobs (safe defaults)
const TS_TIMEOUT_MS = Number(process.env.TS_TIMEOUT_MS || 12000);
const TS_CONCURRENCY = Number(process.env.TS_CONCURRENCY || 6);
const TS_MAX_RETRIES = Number(process.env.TS_MAX_RETRIES || 2);
const TS_CACHE_TTL_MS = Number(process.env.TS_CACHE_TTL_MS || 300000); // 5 min

// Simple in-memory cache: { key -> { ts, data } }
const __eventsCache = new Map();

function pLimit(concurrency) {
  let activeCount = 0;
  const queue = [];
  const next = () => {
    activeCount--;
    if (queue.length > 0) queue.shift()();
  };
  const run = (fn, resolve, reject) => {
    activeCount++;
    Promise.resolve()
      .then(fn)
      .then((val) => {
        resolve(val);
        next();
      })
      .catch((err) => {
        reject(err);
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      if (activeCount < concurrency) run(fn, resolve, reject);
      else queue.push(run.bind(null, fn, resolve, reject));
    });
}

const __limit = pLimit(Math.max(1, TS_CONCURRENCY));

function isRetryableAxiosError(err) {
  const status = err?.response?.status;
  if (!status) return true; // network/DNS/timeout
  return status === 429 || (status >= 500 && status <= 599);
}

async function axiosGetWithRetry(url, config = {}, attempt = 0) {
  try {
    return await axios.get(url, { timeout: TS_TIMEOUT_MS, ...config });
  } catch (err) {
    if (attempt >= TS_MAX_RETRIES || !isRetryableAxiosError(err)) throw err;

    const status = err?.response?.status;
    const retryAfter = Number(err?.response?.headers?.["retry-after"] || 0);
    const backoff = retryAfter
      ? retryAfter * 1000
      : [600, 1400, 2600][attempt] || 2600;

    await new Promise((r) => setTimeout(r, backoff));
    return axiosGetWithRetry(url, config, attempt + 1);
  }
}

// -------------------------
// TicketSource fetch
// -------------------------
async function fetchAllEvents(apiUrl, reference = null) {
  const allEvents = [];
  let nextUrl = apiUrl;

  while (nextUrl) {
    const params = reference ? { reference } : {};
    const response = await axiosGetWithRetry(nextUrl, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      params,
    });
    allEvents.push(...response.data.data);
    nextUrl = response.data.links?.next || null;
  }

  return allEvents;
}

async function buildGroupedEvents(reference = null) {
  const ref = reference ? String(reference).toLowerCase() : null;
  const cacheKey = ref || "__all__";
  const cached = __eventsCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.ts < TS_CACHE_TTL_MS) {
    return cached.data;
  }

  let events;
  try {
    events = await fetchAllEvents("https://api.ticketsource.io/events", ref);
  } catch (err) {
    if (cached) {
      console.warn("TicketSource fetch failed; serving stale cache for", cacheKey, err?.message || err);
      return cached.data;
    }
    throw err;
  }

  if (ref) {
    events = events.filter((event) => {
      const eventReference = event.attributes?.reference?.toLowerCase();
      return eventReference === ref;
    });
  }

  const venueRequests = events.map((event) =>
    __limit(() =>
      axiosGetWithRetry(event.links.venues, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      })
    )
  );

  const dateRequests = events.map((event) =>
    __limit(() =>
      axiosGetWithRetry(event.links.dates, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      })
    )
  );

  const venuesResponses = await Promise.allSettled(venueRequests);
  const datesResponses = await Promise.allSettled(dateRequests);

  const groupedEvents = {};
  const today = startOfTodayLocal();

  events.forEach((event, index) => {
    const venues = venuesResponses[index].status === "fulfilled"
      ? venuesResponses[index].value.data.data
      : [];
    const dates = datesResponses[index].status === "fulfilled"
      ? datesResponses[index].value.data.data
      : [];

    if (venuesResponses[index].status !== "fulfilled") {
      console.warn("Venue fetch failed for event:", event?.attributes?.name || event?.id, venuesResponses[index].reason?.message || venuesResponses[index].reason);
    }
    if (datesResponses[index].status !== "fulfilled") {
      console.warn("Dates fetch failed for event:", event?.attributes?.name || event?.id, datesResponses[index].reason?.message || datesResponses[index].reason);
    }

    const town = venues[0]?.attributes?.address?.line_3 || "Unknown Town";
    const venueInfo = pickVenueInfo(venues[0]);

    const eventDetails = {
      eventName: event.attributes.name,
      description: event.attributes.description,
      thumbnail: event.attributes.images?.find((img) => img.type === "thumbnail")?.src || "",
      town,
      fromDate: null,
      toDate: null,
      dates: [],
      reference: event.attributes.reference,
      venueInfo,
    };

    let minStart = null;
    let maxStart = null;

    dates.forEach((date) => {
      const startDate = new Date(date.attributes.start);
      if (startDate < today) return;

      eventDetails.dates.push({
        startISO: date.attributes.start,
        date: toDateLabelFull(date.attributes.start),
        time: toTimeLabel(date.attributes.start),
        bookNowLink: date.links.book_now,
      });

      if (!minStart || startDate < minStart) minStart = startDate;
      if (!maxStart || startDate > maxStart) maxStart = startDate;
    });

    if (eventDetails.dates.length === 0) return;

    eventDetails.fromDate = minStart.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    eventDetails.toDate = maxStart.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    groupedEvents[town] = groupedEvents[town] || [];
    groupedEvents[town].push(eventDetails);
  });

  __eventsCache.set(cacheKey, { ts: Date.now(), data: groupedEvents });
  return groupedEvents;
}

function buildTownIndex(groupedEvents, { comingSoonDays = 28 } = {}) {
  const today = startOfTodayLocal();
  const soonCutoff = new Date(today);
  soonCutoff.setDate(soonCutoff.getDate() + comingSoonDays);

  const towns = Object.keys(groupedEvents)
    .map((town) => {
      const events = groupedEvents[town] || [];
      let minStart = null;
      let maxEnd = null;

      for (const ev of events) {
        for (const d of ev.dates || []) {
          const dt = new Date(d.startISO);
          if (!minStart || dt < minStart) minStart = dt;
          if (!maxEnd || dt > maxEnd) maxEnd = dt;
        }
      }

      if (!minStart || !maxEnd) return null;

      return {
        town,
        townSlug: slugifyTown(town),
        startDateISO: minStart.toISOString(),
        endDateISO: maxEnd.toISOString(),
        status: "LATER",
        events,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.startDateISO) - new Date(b.startDateISO));

  const isSameLocalDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  for (const t of towns) {
    const start = new Date(t.startDateISO);
    const end = new Date(t.endDateISO);

    if (start <= today && end >= today) {
      t.status = isSameLocalDay(end, today) ? "FINAL_DAY" : "IN_TOWN_NOW";
    } else if (start > today && start <= soonCutoff) {
      t.status = "COMING_SOON";
    } else if (end < today) {
      t.status = "PAST";
    } else {
      t.status = "LATER";
    }
  }

  const inTownNow = towns.filter((t) => t.status === "IN_TOWN_NOW" || t.status === "FINAL_DAY");
  if (inTownNow.length > 0) {
    const currentMaxEnd = new Date(
      Math.max(...inTownNow.map((t) => new Date(t.endDateISO).getTime()))
    );
    const next = towns.find((t) => new Date(t.startDateISO) > currentMaxEnd);
    if (next) next.status = "NEXT_STOP";
  } else {
    const next = towns.find((t) => new Date(t.startDateISO) > today);
    if (next) next.status = "NEXT_STOP";
  }

  return towns.filter((t) => t.status !== "PAST");
}

// -------------------------
// robots.txt + sitemap.xml
// -------------------------
if (SEO_FLAGS.enableRobotsTxt) {
  app.get("/robots.txt", (req, res) => {
    const baseUrl = getBaseUrl(req);
    res.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`);
  });
}

if (SEO_FLAGS.enableSitemap) {
  app.get("/sitemap.xml", async (req, res) => {
    try {
      const baseUrl = getBaseUrl(req);

      // If cache is fresh, serve it immediately
      const now = Date.now();
      if (sitemapCache.xml && now - sitemapCache.ts < SITEMAP_TTL_MS) {
        if (sitemapCache.etag && req.headers["if-none-match"] === sitemapCache.etag) {
          return res.status(304).end();
        }
        res.setHeader("Content-Type", "application/xml; charset=utf-8");
        if (sitemapCache.etag) res.setHeader("ETag", sitemapCache.etag);
        res.setHeader("Cache-Control", "public, max-age=3600"); // allow short CDN/browser caching too
        return res.status(200).send(sitemapCache.xml);
      }

      const staticPaths = [
  "/",
  "/all-shows.html",
  "/gallery.html",
  "/contact.html",
  "/general-tour.html",
  "/summer-season.html",
  "/halloween-circus.html",
  "/tour-locations",

  // About hub + subpages
  "/about-us.html",
  "/about-who-we-are.html",
  "/about-our-heritage.html",
  "/about-our-beautiful-animals.html",
  "/about-life-on-the-road.html",
  "/about-our-trucks-and-transport.html",

  // Authority pages
  "/press-media.html",
  "/how-a-traditional-touring-circus-works.html",
  "/life-on-the-road-with-reagal-events.html",
  "/circus-animal-welfare-standards.html",
];


      const groupedEvents = await buildGroupedEvents(null);
      const townIndex = buildTownIndex(groupedEvents, { comingSoonDays: 365 });
      const townPaths = townIndex.map((t) => `/circus-in/${t.townSlug}`);

      const urls = [...new Set([...staticPaths, ...townPaths])]
        .map((p) => `${baseUrl}${p}`)
        .sort();

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${escapeHtml(u)}</loc>
  </url>`
  )
  .join("\n")}
</urlset>`;

      const etag = "W/\"" + Buffer.from(xml).length + "-" + Date.now().toString(16) + "\"" ;
      sitemapCache = { xml, ts: Date.now(), etag };
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.type("application/xml; charset=utf-8").send(xml);
    } catch (e) {
      console.error("Error /sitemap.xml:", e);
      res.status(500).type("text/plain").send("Error building sitemap");
    }
  });
}

// -------------------------
// API ROUTES
// -------------------------
app.get("/api/events", async (req, res) => {
  try {
    const reference = req.query.reference ? req.query.reference.toLowerCase() : null;
    const groupedEvents = await buildGroupedEvents(reference);
    res.json(groupedEvents);
  } catch (error) {
    console.error("Error /api/events:", error.message);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

app.get("/api/town-index", async (req, res) => {
  try {
    const groupedEvents = await buildGroupedEvents(null);
    const townIndex = buildTownIndex(groupedEvents, { comingSoonDays: 28 });
    res.json(townIndex);
  } catch (error) {
    console.error("Error /api/town-index:", error.message);
    res.status(500).json({ error: "Failed to build town index" });
  }
});

// -------------------------
// Tour Locations hub page
// -------------------------
app.get("/tour-locations", async (req, res) => {
  try {
    const groupedEvents = await buildGroupedEvents(null);
    const townIndex = buildTownIndex(groupedEvents, { comingSoonDays: 28 });

    const badge = (status) => {
      if (status === "FINAL_DAY") return "🔴 Final day";
      if (status === "IN_TOWN_NOW") return "🟢 In town now";
      if (status === "NEXT_STOP") return "🟡 Next stop";
      if (status === "COMING_SOON") return "🟡 Coming soon";
      return "🟣 Later";
    };

    const fmtRange = (t) => `${toDateLabel(t.startDateISO)} – ${toDateLabel(t.endDateISO)}`;

    const inTown = townIndex.filter((t) => t.status === "IN_TOWN_NOW" || t.status === "FINAL_DAY");
    const nextStop = townIndex.filter((t) => t.status === "NEXT_STOP");
    const comingSoon = townIndex.filter((t) => t.status === "COMING_SOON");
    const later = townIndex.filter((t) => t.status === "LATER");

    const renderTownCard = (t) => `
      <div class="town-page-box" style="margin:14px auto;">
        <h3 style="margin:0 0 6px 0; color:#fff;">Family Friendly Circus in ${escapeHtml(t.town)}</h3>
        <div style="font-weight:800; margin-bottom:6px; color:#fff;">${badge(t.status)}</div>
        <div style="opacity:0.95; margin-bottom:10px; color:#fff;"><strong>${escapeHtml(fmtRange(t))}</strong></div>
        <a class="town-booknow" href="/circus-in/${escapeHtml(t.townSlug)}">View dates</a>
      </div>
    `;

    const bodyHtml = `
      <section class="town-page-box">
        <h1 style="margin-top:0;">Tour Locations</h1>
        <p style="margin:10px auto; max-width:760px;">
          Find where we’re <strong>in town now</strong>, the <strong>next stop</strong>, and upcoming locations.
          Each location page shows dates, times and quick ticket booking.
        </p>
      </section>

      ${inTown.length ? `<section><h2 style="text-align:center; margin:12px 0;">🟢 In town now</h2>${inTown.map(renderTownCard).join("")}</section>` : ""}

      ${nextStop.length ? `<section><h2 style="text-align:center; margin:12px 0;">🟡 Next stop</h2>${nextStop.map(renderTownCard).join("")}</section>` : ""}

      ${comingSoon.length ? `<section><h2 style="text-align:center; margin:12px 0;">🟡 Coming soon</h2>${comingSoon.map(renderTownCard).join("")}</section>` : ""}

      ${
        later.length
          ? `<section>
              <details class="town-page-box" style="cursor:pointer;">
                <summary style="font-weight:800; font-size:18px;">🟣 Later tour locations</summary>
                <div style="margin-top:10px;">
                  ${later.map(renderTownCard).join("")}
                </div>
              </details>
            </section>`
          : ""
      }

      <section class="town-page-box" style="margin-bottom:20px;">
        <p style="margin:0; color:#fff;">
          Want all shows in one place?
        </p>
        <div style="margin-top:10px;">
          <a class="town-booknow" href="/all-shows.html">View All Shows</a>
        </div>
      </section>
    `;

    const html = renderShell({
      req,
      title: "Tour Locations | Reagal Events",
      description:
        "Find tour locations: in town now, next stop, and upcoming towns. Click a location to view dates and book tickets.",
      bodyHtml,
      robots: "index, follow",
      jsonLdObjects: SEO_FLAGS.enableJsonLd
        ? [
            {
              "@context": "https://schema.org",
              "@type": "CollectionPage",
              name: "Tour Locations",
              url: `${getBaseUrl(req)}${stripQuery(req.originalUrl)}`,
            },
          ]
        : [],
    });

    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send("Error building tour locations page");
  }
});

// -------------------------
// Town page (SEO) + schema + improved layout
// -------------------------
// -------------------------
// Town page (SEO) + schema + improved layout
// -------------------------
app.get("/circus-in/:townSlug", async (req, res) => {
  try {
    const groupedEvents = await buildGroupedEvents(null);
    const townIndex = buildTownIndex(groupedEvents, { comingSoonDays: 28 });

    const slug = String(req.params.townSlug || "").toLowerCase();
    const townObj = townIndex.find((t) => t.townSlug === slug);

    if (!townObj) {
      const html = renderShell({
        req,
        title: `Family Friendly Circus | Reagal Events`,
        description: "No upcoming dates currently listed. Please check View All Shows.",
        bodyHtml: `
          <div class="town-page-box">
            <h1 style="color:#fff;">Reagal Events</h1>
            <p style="color:#fff;">No upcoming dates are currently listed for this location. Please check <a href="/all-shows.html">View All Shows</a>.</p>
          </div>`,
        robots: "noindex, follow",
      });
      res.set("X-Robots-Tag", "noindex, follow");
      return res.status(404).send(html);
    }

    const townName = townObj.town;

    const badgeText =
      townObj.status === "FINAL_DAY"
        ? "🔴 Final day"
        : townObj.status === "IN_TOWN_NOW"
        ? "🟢 In town now"
        : townObj.status === "COMING_SOON"
        ? "🟡 Coming soon"
        : townObj.status === "NEXT_STOP"
        ? "🟡 Next stop"
        : "🟣 Later";

    const sorted = [...townIndex].sort(
      (a, b) => new Date(a.startDateISO) - new Date(b.startDateISO)
    );
    const thisEnd = new Date(townObj.endDateISO);
    const nextTown = sorted.find((t) => new Date(t.startDateISO) > thisEnd) || null;

    // Internal linking: nearby tour locations (helps SEO crawl depth)
    const currentIndex = sorted.findIndex((t) => t.townSlug === townObj.townSlug);
    const neighborSlice = sorted
      .filter((t) => t.townSlug !== townObj.townSlug)
      .slice(Math.max(0, currentIndex - 3), Math.min(sorted.length, currentIndex + 4))
      .slice(0, 6);

    const neighborsHtml = neighborSlice.length
      ? `
        <div class="town-page-box town-wide" style="margin-top:14px;">
          <h2 style="color:#fff; text-align:center; margin:0 0 10px 0;">Other tour locations</h2>
          <div style="display:flex; flex-wrap:wrap; gap:10px; justify-content:center;">
            ${neighborSlice
              .map(
                (t) =>
                  `<a class="town-booknow" style="padding:10px 14px;" href="/circus-in/${escapeHtml(t.townSlug)}">${escapeHtml(
                    t.town
                  )}</a>`
              )
              .join("")}
          </div>
        </div>
      `
      : "";

    const primaryVenueInfo = townObj.events?.[0]?.venueInfo || {};
    const autoDesc = buildAdaptiveTownDescription({
      townName: townObj.town,
      venueInfo: primaryVenueInfo,
      status: townObj.status,
      startDateISO: townObj.startDateISO,
      endDateISO: townObj.endDateISO,
      nextTownName: nextTown?.town || "",
    });

    const familyLine = SEO_FLAGS.enableFamilyIntentLine ? buildFamilyIntentLine(townName) : "";
    const weekendLine = buildWeekendLine(townObj);
    const tourNowNextHtml = buildTourNowNextHtml(townIndex);

    const showYear = new Date(townObj.startDateISO).getFullYear();
    const title = `🎪 Circus in ${townName} ${showYear} – Family Touring Show | Reagal Events`;
    const desc = `Family-friendly circus and entertainment in ${townName}. ${badgeText.replace(
      /^[^\w]+/,
      ""
    )} — view dates and book tickets.`;

    const eventsHtml = (() => {
      const allEvents = townObj.events || [];
      if (!allEvents.length) return "";

      // Merge ALL TicketSource events for this town into ONE card (same UX as Oundle/General Tour)
      const byDay = {};
      for (const ev of allEvents) {
        for (const d of ev.dates || []) {
          const dayKey = toDateLabel(d.startISO);
          byDay[dayKey] = byDay[dayKey] || [];
          byDay[dayKey].push({
            time: toTimeLabel(d.startISO),
            bookNowLink: d.bookNowLink,
            startISO: d.startISO,
          });
        }
      }

      const dayKeys = Object.keys(byDay).sort(
        (a, b) =>
          new Date(byDay[a][0].startISO).getTime() - new Date(byDay[b][0].startISO).getTime()
      );
      for (const k of dayKeys) {
        byDay[k].sort((x, y) => new Date(x.startISO) - new Date(y.startISO));
      }

      const rangeLine = `${toDateLabel(townObj.startDateISO)} – ${toDateLabel(townObj.endDateISO)}`;
      const dataJson = JSON.stringify(byDay).replace(/</g, "\\u003c");

      const dateSelectId = `dateSel_0`;
      const timeSelectId = `timeSel_0`;
      const linkId = `bookLink_0`;

      const primary = allEvents[0] || {};
      const displayName = primary.eventName || "Circus Show";
      const thumb = primary.thumbnail || "";
      const thumbAlt = thumb ? `Family-friendly circus in ${townName} by Reagal Events` : "";

      return `
          <div class="town-page-box town-events town-wide" style="color:#fff;">
            <div class="event-flex">
              <div class="event-left">
                ${thumb ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(thumbAlt)}" class="event-thumb">` : ""}
              </div>

              <div class="event-right">
                <h3 style="color:#fff; margin:0 0 6px 0;">${escapeHtml(displayName)}</h3>
                <div class="town-range" style="color:#fff; margin:0 0 10px 0;">${escapeHtml(rangeLine)}</div>

                <div class="town-row" style="color:#fff;">
                  <div class="town-field" style="color:#fff;">
                    <span style="color:#fff;">Date</span>
                    <select id="${dateSelectId}">
                      ${dayKeys
                        .map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`)
                        .join("")}
                    </select>
                  </div>

                  <div class="town-field" style="color:#fff;">
                    <span style="color:#fff;">Time</span>
                    <select id="${timeSelectId}"></select>
                  </div>

                  <a id="${linkId}" class="town-booknow" href="#" target="_blank" rel="noopener">Book now</a>
                </div>
              </div>
            </div>
          </div>

          <script>
            (function(){
              const byDay = ${dataJson};
              const dateSel = document.getElementById("${dateSelectId}");
              const timeSel = document.getElementById("${timeSelectId}");
              const link = document.getElementById("${linkId}");

              function repopulateTimes() {
                const day = dateSel.value;
                const times = byDay[day] || [];
                // Times already sorted earliest-first above.
                timeSel.innerHTML = times.map(t => '<option value="' + (t.bookNowLink || '#') + '">' + t.time + '</option>').join('');
                updateLink();
              }

              function updateLink() {
                link.href = timeSel.value || "#";
              }

              dateSel.addEventListener("change", repopulateTimes);
              timeSel.addEventListener("change", updateLink);

              // init
              repopulateTimes();
            })();
          </script>
      `;
    })();;

    const { html: faqHtml, schema: faqSchema } = buildFaqBlock(townName, primaryVenueInfo);

    const jsonLdObjects = [
      ...buildEventJsonLdForTown(req, townObj),
      ...(faqSchema ? [faqSchema] : []),
    ];

    // CSS is injected ONLY on this page to widen boxes + force white status + event layout
    const headExtras = `
      <style>
        /* widen the semi-transparent boxes on this page only */
        .town-page-box.town-wide { max-width: 1200px !important; }
        .town-page-box { max-width: 1200px !important; }

        /* make the glass box adapt to content + long town names */
        .town-page-box { padding: clamp(16px, 2.6vw, 28px) !important; }

        /* hero block */
        .town-hero { max-width: 1100px; margin: 0 auto; text-align: center; color:#fff; }
        .town-hero * { color:#fff !important; }
        .town-hero h1 {
          margin: 0 0 6px 0;
          font-size: clamp(26px, 3.0vw, 48px);
          line-height: 1.08;
          white-space: normal;
          overflow-wrap: anywhere;
          text-wrap: balance;
        }
        .town-hero .status { margin: 0 0 8px 0; font-weight: 800; }
        .town-hero .tour-now-next { margin: 6px 0 10px 0; font-weight: 800; }
        .town-hero .tour-now-next .dot { padding: 0 10px; opacity: 0.95; }
        .town-hero .desc { margin: 0; width: 100%; max-width: none; line-height: 1.2; }
        .town-hero .extra { margin: 8px 0 0 0; width: 100%; max-width: none; line-height: 1.2; }
        .town-hero .btnrow { margin-top: 10px; display: flex; justify-content: center; }

        /* event box layout */
        .event-flex { display:flex; gap:18px; align-items:center; justify-content:center; }
        .event-left { flex: 0 0 260px; display:flex; justify-content:center; }
        .event-right { flex: 1 1 auto; min-width: 320px; }
        .event-thumb { width: 260px; max-width: 100%; height:auto; border-radius:12px; display:block; }

        /* ✅ EXACT LAYOUT YOU WANT:
           Middle stack (Date above Time) + Book button on right */
        .town-events .town-row{
          display: grid !important;
          grid-template-columns: 280px auto; /* left = stacked selects, right = button */
          column-gap: 18px;
          align-items: center;
          justify-content: start;
        }

        /* Date (first field) goes top-left */
        .town-events .town-row .town-field:nth-child(1){
          grid-column: 1;
          grid-row: 1;
          width: 280px;
        }

        /* Time (second field) goes under Date */
        .town-events .town-row .town-field:nth-child(2){
          grid-column: 1;
          grid-row: 2;
          width: 280px;
          margin-top: 12px;
        }

        /* Book button sits on the right, centered vertically */
        .town-events .town-row .town-booknow{
          grid-column: 2;
          grid-row: 1 / span 2;
          align-self: center;
          justify-self: start;
          white-space: nowrap;
        }

        /* consistent label + control sizing */
        .town-events .town-row .town-field span{
          display:block;
          margin: 0 0 6px 0;
          line-height: 1;
          color:#fff !important;
        }
        .town-events .town-row .town-field select{
          width: 100%;
          box-sizing: border-box;
          height: 42px;
        }

        @media (max-width: 900px) {
          .event-flex { flex-direction: column; }
          .event-left { flex: 0 0 auto; }
          .event-right { min-width: auto; width: 100%; }

          /* mobile stack */
          .town-events .town-row{
            grid-template-columns: 1fr;
            row-gap: 12px;
          }
          .town-events .town-row .town-field:nth-child(1),
          .town-events .town-row .town-field:nth-child(2){
            width: 100%;
            margin-top: 0;
          }
          .town-events .town-row .town-booknow{
            grid-column: 1;
            grid-row: 3;
            width: 100%;
            text-align: center;
            justify-self: stretch;
          }
        }

        @media (max-width: 600px) {
          .town-hero .tour-now-next { font-size: 15px; line-height: 1.2; }
        }
      </style>
    `;

    const bodyHtml = `
      <div class="town-page-box">
        <div class="town-hero">
          <h1>Family Friendly Circus in ${escapeHtml(townName)}</h1>
          <div class="status">${escapeHtml(badgeText)}</div>

          ${tourNowNextHtml}

          <p class="desc">${escapeHtml(autoDesc)}</p>

          <p class="extra" style="margin-top:12px;">Planning your visit? Read our <a href="/plan-your-visit.html">Plan Your Visit</a> guide, see our <a href="/circus-animal-welfare-standards.html">animal welfare standards</a>, or explore <a href="/life-on-the-road-with-reagal-events.html">life on the road</a> with Reagal Events.</p>

          ${familyLine ? `<p class="extra" style="opacity:0.95;">${escapeHtml(familyLine)}</p>` : ""}

          ${weekendLine ? `<p class="extra" style="font-weight:800;">${escapeHtml(weekendLine)}</p>` : ""}

          ${nextTown ? `<p class="extra"><strong>Next stop:</strong> <a href="/circus-in/${escapeHtml(nextTown.townSlug)}">${escapeHtml(nextTown.town)}</a></p>` : ""}

          <div class="btnrow">
            <a class="town-booknow" href="/tour-locations">See all tour locations</a>
          </div>
        </div>
      </div>

      ${neighborsHtml}

      ${eventsHtml}

      ${faqHtml}
    `;

    const html = renderShell({
      req,
      title,
      description: desc,
      bodyHtml,
      robots: "index, follow",
      headExtras,
      jsonLdObjects,
    });

    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send("Error building town page");
  }
});


// Fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});