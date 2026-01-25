// server.js
"use strict";

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");

// Optional: load .env locally (safe in production; Render injects env vars anyway)
try {
  // eslint-disable-next-line global-require
  require("dotenv").config();
} catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;

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


// Cache-busting version for static assets (set in Render env vars, e.g. 20260125-2)
const APP_VERSION = (process.env.APP_VERSION || "").trim();
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
        res.setHeader("Cache-Control", "public, max-age=0, must-revalidate"); // always revalidate
        return;
      }
    },
  })
);

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

/**
 * Base URL logic:
 * - If PUBLIC_BASE_URL is set -> always use it (best for production canonical URLs)
 * - Otherwise -> derive from request (fine for local dev)
 */
function getBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, "");

  const proto =
    (req.headers["x-forwarded-proto"] && String(req.headers["x-forwarded-proto"]).split(",")[0]) ||
    req.protocol ||
    "http";
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
  const SITE_OG_IMAGE = `${baseUrl}/og-share.png`;

  const siteSchema =
    SEO_FLAGS.enableJsonLd
      ? {
          "@context": "https://schema.org",
          "@type": ["Organization", "LocalBusiness"],
          name: "Reagal Events",
          url: baseUrl,
          logo: `${baseUrl}/banner1.jpg`,
          image: `${baseUrl}/banner1.jpg`,
          telephone: "07719877422",
          address: {
            "@type": "PostalAddress",
            addressCountry: "GB",
          },
          sameAs: [
            "https://www.facebook.com/story.php?story_fbid=610427098343014&id=100081271867855",
            "https://www.tiktok.com/@the.wonder.circus",
            "https://www.instagram.com/wondercircus_circus_of_wonders/",
          ],
        }
      : null;

  const mergedJsonLd = [siteSchema, ...(jsonLdObjects || [])].filter(Boolean);

  const jsonLdScripts =
    SEO_FLAGS.enableJsonLd && mergedJsonLd && mergedJsonLd.length
      ? mergedJsonLd
          .map((obj) => {
            const safe = JSON.stringify(obj).replace(/</g, "\\u003c");
            return `<script type="application/ld+json">${safe}</script>`;
          })
          .join("\n")
      : "";


  // Cache-buster for CSS/JS so browsers fetch the latest assets after deploy
  const assetV = APP_VERSION || (process.env.NODE_ENV === "production" ? "prod" : String(Date.now()));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>

  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-HF03R5RLBZ"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-HF03R5RLBZ');
  </script>

  <link rel="preconnect" href="https://www.googletagmanager.com" crossorigin>
  <link rel="preconnect" href="https://www.google-analytics.com" crossorigin>

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
  <meta property="og:image" content="${escapeHtml(SITE_OG_IMAGE)}"/>
  <meta property="og:image:width" content="1080"/>
  <meta property="og:image:height" content="333"/>

  <link rel="stylesheet" href="/styles.css?v=${escapeHtml(assetV)}"/>

  <link rel="preconnect" href="https://cdnjs.cloudflare.com" crossorigin>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.2/css/all.min.css">

  <script defer src="https://unpkg.com/web-vitals@4/dist/web-vitals.iife.js"></script>
  <script>
    window.addEventListener('load', function () {
      if (!window.webVitals || typeof window.gtag !== 'function') return;

      function sendToGA(metric) {
        gtag('event', metric.name, {
          event_category: 'Web Vitals',
          value: Math.round(metric.name === 'CLS' ? metric.value * 1000 : metric.value),
          event_label: metric.id,
          non_interaction: true
        });
      }

      webVitals.getCLS(sendToGA);
      webVitals.getINP(sendToGA);
      webVitals.getLCP(sendToGA);
      webVitals.getFCP(sendToGA);
      webVitals.getTTFB(sendToGA);
    });
  </script>

  ${headExtras || ""}
  ${jsonLdScripts}
</head>
<body>
  <header>
    <img src="/banner1.jpg" alt="Reagal Events Banner" class="banner" decoding="async" fetchpriority="high">
    <h2 class="circus-font">Proudly Presents</h2>
    <div class="banner2-container"></div>
    <nav id="menu">
      <ul>
        <li><a href="/index.html">Welcome</a></li>
        <li><a href="/all-shows.html">View All Shows</a></li>
        <li><a href="/gallery.html">Gallery</a></li>
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
      <div class="social-links">
        <a href="https://www.facebook.com/story.php?story_fbid=610427098343014&id=100081271867855" target="_blank" class="social-icon" rel="noopener">
          <i class="fa-brands fa-facebook-f"></i>
        </a>
        <a href="https://www.tiktok.com/@the.wonder.circus" target="_blank" class="social-icon" rel="noopener">
          <i class="fa-brands fa-tiktok"></i>
        </a>
        <a href="https://www.instagram.com/wondercircus_circus_of_wonders/" target="_blank" class="social-icon" rel="noopener">
          <i class="fa-brands fa-instagram"></i>
        </a>
      </div>
      <p class="footer-text">&copy; ${year} Reagal Events. All rights reserved.</p>
      <div class="ticketsource-button">
        <a href="https://www.ticketsource.co.uk/reagalevents">
          <img border="0" width="130" height="56" alt="Book now"
          src="https://www.ticketsource.co.uk/images/bookNow/bookNow-black-small.png">
        </a>
      </div>
    </div>
  </footer>

  <!-- Autoscroll: bring menu into view, without breaking mobile -->
<script>
(function () {
  // Only run autoscroll ONCE per page load
  let ran = false;

  function runAutoScroll() {
    if (ran) return;
    ran = true;

    const reduce =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const menu = document.getElementById('menu');
    if (!menu) return;

    // Scroll to menu position, but only if user hasn't already scrolled down
    const alreadyScrolled = window.pageYOffset > 30;
    if (alreadyScrolled) return;

    const y = menu.getBoundingClientRect().top + window.pageYOffset;

    try {
      window.scrollTo({ top: y, behavior: reduce ? 'auto' : 'smooth' });
    } catch (e) {
      window.scrollTo(0, y);
    }
  }

  window.addEventListener('load', function () {
    // Faster than 2500ms; also avoids iOS oddities
    setTimeout(runAutoScroll, 700);
  });
})();
</script>

</body>
</html>`;
}

// -------------------------
// TicketSource fetch
// -------------------------
async function fetchAllEvents(apiUrl, reference = null) {
  const allEvents = [];
  let nextUrl = apiUrl;

  while (nextUrl) {
    const params = reference ? { reference } : {};
    const response = await axios.get(nextUrl, {
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
  let events = await fetchAllEvents("https://api.ticketsource.io/events", ref);

  if (ref) {
    events = events.filter((event) => {
      const eventReference = event.attributes?.reference?.toLowerCase();
      return eventReference === ref;
    });
  }

  const venueRequests = events.map((event) =>
    axios.get(event.links.venues, { headers: { Authorization: `Bearer ${API_KEY}` } })
  );
  const dateRequests = events.map((event) =>
    axios.get(event.links.dates, { headers: { Authorization: `Bearer ${API_KEY}` } })
  );

  const venuesResponses = await Promise.all(venueRequests);
  const datesResponses = await Promise.all(dateRequests);

  const groupedEvents = {};
  const today = startOfTodayLocal();

  events.forEach((event, index) => {
    const venues = venuesResponses[index].data.data;
    const dates = datesResponses[index].data.data;

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
// robots.txt + sitemap.xml (dynamic, correct for production via PUBLIC_BASE_URL)
// -------------------------
if (SEO_FLAGS.enableRobotsTxt) {
  app.get("/robots.txt", (req, res) => {
    const baseUrl = getBaseUrl(req);
    res
      .type("text/plain")
      .send(`User-agent: *\nAllow: /\nSitemap: ${baseUrl}/sitemap.xml\n`);
  });
}

if (SEO_FLAGS.enableSitemap) {
  app.get("/sitemap.xml", async (req, res) => {
    try {
      const baseUrl = getBaseUrl(req);

      const staticPaths = [
        "/",
        "/index.html",
        "/all-shows.html",
        "/gallery.html",
        "/contact.html",
        "/general-tour.html",
        "/summer-season.html",
        "/halloween-circus.html",
        "/tour-locations",
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

      res.type("application/xml").send(xml);
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
        <p style="margin:0; color:#fff;">Want all shows in one place?</p>
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
// Town page route (unchanged logic below - kept to avoid breaking)
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

    const title = `Family Friendly Circus in ${townName} | Reagal Events`;
    const desc = `Family-friendly circus and entertainment in ${townName}. ${badgeText.replace(
      /^[^\w]+/,
      ""
    )} — view dates and book tickets.`;

    const eventsHtml = (townObj.events || [])
      .map((ev, evIndex) => {
        const byDay = {};
        for (const d of ev.dates || []) {
          const dayKey = toDateLabel(d.startISO);
          byDay[dayKey] = byDay[dayKey] || [];
          byDay[dayKey].push({
            time: toTimeLabel(d.startISO),
            bookNowLink: d.bookNowLink,
            startISO: d.startISO,
          });
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

        const dateSelectId = `dateSel_${evIndex}`;
        const timeSelectId = `timeSel_${evIndex}`;
        const linkId = `bookLink_${evIndex}`;

        const thumbAlt = ev.thumbnail ? `Family-friendly circus in ${townName} by Reagal Events` : "";

        return `
          <div class="town-page-box town-events town-wide" style="color:#fff;">
            <div class="event-flex">
              <div class="event-left">
                ${
                  ev.thumbnail
                    ? `<img src="${escapeHtml(ev.thumbnail)}" alt="${escapeHtml(
                        thumbAlt
                      )}" class="event-thumb">`
                    : ""
                }
              </div>

              <div class="event-right">
                <h3 style="color:#fff; margin:0 0 6px 0;">${escapeHtml(ev.eventName)}</h3>
                <div class="town-range" style="color:#fff; margin:0 0 10px 0;">${escapeHtml(
                  rangeLine
                )}</div>

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
                timeSel.innerHTML = times.map(t => '<option value="' + t.time + '">' + t.time + '</option>').join('');
                updateLink();
              }

              function updateLink() {
                const day = dateSel.value;
                const times = byDay[day] || [];
                const chosen = timeSel.value;
                const match = times.find(t => t.time === chosen) || times[0];
                link.href = match ? match.bookNowLink : "#";
              }

              dateSel.addEventListener("change", repopulateTimes);
              timeSel.addEventListener("change", updateLink);

              repopulateTimes();
            })();
          </script>
        `;
      })
      .join("");

    const { html: faqHtml, schema: faqSchema } = buildFaqBlock(townName, primaryVenueInfo);

    const jsonLdObjects = [
      ...buildEventJsonLdForTown(req, townObj),
      ...(faqSchema ? [faqSchema] : []),
    ];

    const headExtras = `
      <style>
        .town-page-box.town-wide { max-width: 1200px !important; }
        .town-page-box { max-width: 1200px !important; }

        .town-hero { max-width: 1100px; margin: 0 auto; text-align: center; color:#fff; }
        .town-hero * { color:#fff !important; }
        .town-hero h1 {
          margin: 0 0 6px 0;
          font-size: clamp(28px, 3.4vw, 52px);
          line-height: 1.05;
          white-space: nowrap;
        }
        .town-hero .status { margin: 0 0 8px 0; font-weight: 800; }
        .town-hero .desc { margin: 0; width: 100%; max-width: none; line-height: 1.2; }
        .town-hero .extra { margin: 8px 0 0 0; width: 100%; max-width: none; line-height: 1.2; }
        .town-hero .btnrow { margin-top: 10px; display: flex; justify-content: center; }

        .event-flex { display:flex; gap:18px; align-items:center; justify-content:center; }
        .event-left { flex: 0 0 260px; display:flex; justify-content:center; }
        .event-right { flex: 1 1 auto; min-width: 320px; }
        .event-thumb { width: 260px; max-width: 100%; height:auto; border-radius:12px; display:block; }

        .town-events .town-row{
          display: grid !important;
          grid-template-columns: 280px auto;
          column-gap: 18px;
          align-items: center;
          justify-content: start;
        }

        .town-events .town-row .town-field:nth-child(1){
          grid-column: 1;
          grid-row: 1;
          width: 280px;
        }

        .town-events .town-row .town-field:nth-child(2){
          grid-column: 1;
          grid-row: 2;
          width: 280px;
          margin-top: 12px;
        }

        .town-events .town-row .town-booknow{
          grid-column: 2;
          grid-row: 1 / span 2;
          align-self: center;
          justify-self: start;
          white-space: nowrap;
        }

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
          .town-hero h1 { white-space: normal; }
        }
      </style>
    `;

    const bodyHtml = `
      <div class="town-page-box" style="padding:10px 14px;">
        <div class="town-hero">
          <h1>Family Friendly Circus in ${escapeHtml(townName)}</h1>
          <div class="status">${escapeHtml(badgeText)}</div>

          <p class="desc">${escapeHtml(autoDesc)}</p>

          ${familyLine ? `<p class="extra" style="opacity:0.95;">${escapeHtml(familyLine)}</p>` : ""}

          ${weekendLine ? `<p class="extra" style="font-weight:800;">${escapeHtml(weekendLine)}</p>` : ""}

          ${
            nextTown
              ? `<p class="extra"><strong>Next stop:</strong> <a href="/circus-in/${escapeHtml(
                  nextTown.townSlug
                )}">${escapeHtml(nextTown.town)}</a></p>`
              : ""
          }

          <div class="btnrow">
            <a class="town-booknow" href="/tour-locations">See all tour locations</a>
          </div>
        </div>
      </div>

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
