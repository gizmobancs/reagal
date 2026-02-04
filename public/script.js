// public/script.js
// Shared utilities + event rendering (NO API keys)
// Uses your server routes: /api/events and /api/events?reference=...

(function () {
  "use strict";

  // ----------------------------
  // Autoscroll: menu to top
  // - waits for: (1) minimum delay (banner time) AND (2) events rendered
  // - does NOT depend on window 'load' (so it still works if called after load)
  // - cancels if user interacts
  // ----------------------------
  function autoScrollToMenuWhenReady({
    menuId = "menu",
    minDelayMs = 2500,
    readyPromise = Promise.resolve(),
  } = {}) {
    let cancelled = false;

    const cancel = () => {
      cancelled = true;
      cleanup();
    };

    function cleanup() {
      window.removeEventListener("wheel", cancel, { passive: true });
      window.removeEventListener("touchstart", cancel, { passive: true });
      window.removeEventListener("keydown", cancel);
    }

    window.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("keydown", cancel);

    const start = Date.now();
    const minDelay = new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Number(minDelayMs) || 0))
    );

    Promise.allSettled([minDelay, readyPromise]).then(() => {
      if (cancelled) return;

      // Give layout a moment to settle (especially after DOM writes)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled) return;

          const menu = document.getElementById(menuId);
          if (!menu) return;

          const reduce =
            window.matchMedia &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;

          const y = menu.getBoundingClientRect().top + window.pageYOffset;
          window.scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });

          cleanup();
        });
      });
    });
  }

  function waitForEventsRendered({
    container,
    timeoutMs = 12000,
  } = {}) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        // If there is no container, treat as "ready".
        if (!container) return resolve();

        // Any event cards OR an explicit no-events message means we're done.
        const hasEventCards =
          container.querySelector?.(".event") ||
          container.querySelector?.(".event-card") ||
          container.querySelector?.(".event-item");
        const hasNoEvents =
          container.querySelector?.(".no-events-message") ||
          document.querySelector?.(".no-events-message");

        // Or: container has children and isn't showing a spinner-only state.
        const hasChildren = container.children && container.children.length > 0;
        const spinner = container.querySelector?.(".loading-spinner");
        const spinnerVisible =
          spinner &&
          window.getComputedStyle(spinner).display !== "none" &&
          window.getComputedStyle(spinner).visibility !== "hidden";

        if (hasEventCards || hasNoEvents || (hasChildren && !spinnerVisible)) {
          return resolve();
        }

        if (Date.now() - start > timeoutMs) return resolve();
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  // ----------------------------
  // Helpers
  // ----------------------------
  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function unique(list) {
    return [...new Set(list)];
  }



  // ----------------------------
  // Date sorting helpers (UK dd/mm/yyyy)
  // ----------------------------
  function parseUkDate(dateStr) {
    const m = String(dateStr || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const y = parseInt(m[3], 10);
    const dt = new Date(y, mo, d);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function sortUkDates(dateStrings) {
    return [...dateStrings].sort((a, b) => {
      const da = parseUkDate(a);
      const db = parseUkDate(b);
      const ta = da ? da.getTime() : Number.POSITIVE_INFINITY;
      const tb = db ? db.getTime() : Number.POSITIVE_INFINITY;
      return ta - tb;
    });
  }
  // ----------------------------
  // Shared event renderer (same UX as before)
  // - groups by town (server returns this shape)
  // - date dropdown -> time dropdown -> Book Now
  // ----------------------------
  async function renderEventsPage({
    containerId,
    reference = null,
    mode = "tour", // "tour" or "all"
    loadingId = null,
    noEventsSelector = null,
    spinnerSelector = null,
  }) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const loadingEl = loadingId ? document.getElementById(loadingId) : null;
    const noEventsEl = noEventsSelector
      ? document.querySelector(noEventsSelector)
      : null;
    const spinnerEl = spinnerSelector ? document.querySelector(spinnerSelector) : null;

    function showLoading() {
      if (loadingEl) loadingEl.style.display = "block";
      if (spinnerEl) spinnerEl.style.display = "block";
      if (noEventsEl) noEventsEl.style.display = "none";
    }

    function hideLoading() {
      if (loadingEl) loadingEl.style.display = "none";
      if (spinnerEl) spinnerEl.style.display = "none";
    }

    showLoading();

    try {
      const url = reference
        ? `/api/events?reference=${encodeURIComponent(reference)}`
        : `/api/events`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const eventsByTown = await res.json();

      container.innerHTML = "";

      const townEntries = Object.entries(eventsByTown || {}).filter(
        ([, events]) => Array.isArray(events) && events.length
      );

      
      // Sort towns by earliest show date (UK dd/mm/yyyy)
      townEntries.sort((a, b) => {
        const aDates = (a[1] || []).flatMap(ev => (ev.dates || []).map(d => d.date));
        const bDates = (b[1] || []).flatMap(ev => (ev.dates || []).map(d => d.date));
        const aMin = sortUkDates(unique(aDates))[0];
        const bMin = sortUkDates(unique(bDates))[0];
        const da = parseUkDate(aMin);
        const db = parseUkDate(bMin);
        const ta = da ? da.getTime() : Number.POSITIVE_INFINITY;
        const tb = db ? db.getTime() : Number.POSITIVE_INFINITY;
        return ta - tb;
      });

if (!townEntries.length) {
        if (noEventsEl) {
          noEventsEl.style.display = "block";
        } else {
          container.innerHTML = `<p class="no-events-message">No events found.</p>`;
        }
        return;
      }

      townEntries.forEach(([town, events]) => {
        // Combine all dates for dropdowns
        const allDates = events.flatMap((ev) => ev.dates || []);
        const uniqueDates = sortUkDates(unique(allDates.map((d) => d.date)));

        if (!uniqueDates.length) return;

        // For display: use the first event (your existing behaviour)
        const ev = events[0];

        // For All Shows page: include from/to range for the town
        const fromDate = uniqueDates[0];
        const toDate = uniqueDates[uniqueDates.length - 1];

        const eventDiv = document.createElement("div");
        eventDiv.className = "event";

        // Thumbnail
        if (ev.thumbnail) {
          const img = document.createElement("img");
          img.src = ev.thumbnail;
          img.alt = ev.eventName || "Event";
          img.className = "event-thumbnail";
          eventDiv.appendChild(img);
        }

        // Details
        const detailsDiv = document.createElement("div");
        detailsDiv.className = "event-details";

        const title = document.createElement("h2");
        title.className = "event-title";

        if (mode === "all") {
          title.textContent = `${ev.eventName} (${town} - ${fromDate} to ${toDate})`;
        } else {
          title.textContent = ev.eventName || "Event";
        }

        detailsDiv.appendChild(title);

        // Town + range line for tour pages (matches what you had)
        if (mode === "tour") {
          const townDates = document.createElement("p");
          townDates.className = "event-town-dates";
          townDates.textContent = `${town}: ${fromDate} - ${toDate}`;
          detailsDiv.appendChild(townDates);
        }

        const desc = document.createElement("p");
        desc.textContent = ev.description || "";
        detailsDiv.appendChild(desc);

        // Date dropdown
        const dateDropdown = document.createElement("select");
        dateDropdown.className = "dropdown";
        dateDropdown.innerHTML = `<option value="">Select a date</option>`;
        uniqueDates.forEach((date) => {
          const opt = document.createElement("option");
          opt.value = date;
          opt.textContent = date;
          dateDropdown.appendChild(opt);
        });
        detailsDiv.appendChild(dateDropdown);

        // Time dropdown
        const timeDropdown = document.createElement("select");
        timeDropdown.className = "dropdown";
        timeDropdown.innerHTML = `<option value="">Select a time</option>`;
        detailsDiv.appendChild(timeDropdown);

        // Book Now button
        const bookBtn = document.createElement("a");
        bookBtn.href = "#";
        bookBtn.target = "_blank";
        bookBtn.rel = "noopener";
        bookBtn.textContent = "Book Now";
        bookBtn.className = "book-button";
        detailsDiv.appendChild(bookBtn);

        // Date -> populate times
        dateDropdown.addEventListener("change", () => {
          const selectedDate = dateDropdown.value;
          timeDropdown.innerHTML = `<option value="">Select a time</option>`;

          const filtered = allDates.filter((d) => d.date === selectedDate);
          filtered.forEach((d) => {
            const opt = document.createElement("option");
            opt.value = d.bookNowLink;
            opt.textContent = d.time;
            timeDropdown.appendChild(opt);
          });

          // reset link
          bookBtn.href = "#";
        });

        // Time -> set book link
        timeDropdown.addEventListener("change", () => {
          bookBtn.href = timeDropdown.value || "#";
        });

        eventDiv.appendChild(detailsDiv);
        container.appendChild(eventDiv);
      });
    } catch (err) {
      console.error("Failed to render events:", err);
      container.innerHTML = `<p class="no-events-message">Failed to load events.</p>`;
    } finally {
      hideLoading();
    }
  }

  // ----------------------------
  // Init (page-aware)
  // ----------------------------
  document.addEventListener("DOMContentLoaded", () => {
    const renderTasks = [];
    const scrollTargets = [];

    // All Shows
    if (document.getElementById("events-container")) {
      scrollTargets.push(document.getElementById("events-container"));
      renderTasks.push(
        renderEventsPage({
          containerId: "events-container",
          reference: null,
          mode: "all",
        })
      );
    }

    // General Tour
    if (document.getElementById("general-events")) {
      scrollTargets.push(document.getElementById("general-events"));
      renderTasks.push(
        renderEventsPage({
          containerId: "general-events",
          reference: "General",
          mode: "tour",
          loadingId: "loading",
        })
      );
    }

    // Summer Season
    if (document.getElementById("summer-events")) {
      scrollTargets.push(document.getElementById("summer-events"));
      renderTasks.push(
        renderEventsPage({
          containerId: "summer-events",
          reference: "Summer",
          mode: "tour",
          spinnerSelector: ".loading-spinner",
          noEventsSelector: ".no-events-message",
        })
      );
    }

    // Halloween Circus
    if (document.getElementById("halloween-events")) {
      scrollTargets.push(document.getElementById("halloween-events"));
      renderTasks.push(
        renderEventsPage({
          containerId: "halloween-events",
          reference: "Halloween",
          mode: "tour",
          spinnerSelector: ".loading-spinner",
          noEventsSelector: ".no-events-message",
        })
      );
    }

    const eventsReady = (async () => {
      // Wait for the render promises (if any)
      await Promise.allSettled(renderTasks);
      // Then also wait for the DOM to actually contain event/no-event content
      const containers = scrollTargets.length
        ? scrollTargets
        : [
            document.getElementById("events-container"),
            document.getElementById("general-events"),
            document.getElementById("summer-events"),
            document.getElementById("halloween-events"),
          ].filter(Boolean);
      await Promise.allSettled(
        containers.map((c) => waitForEventsRendered({ container: c }))
      );
    })();

    // Always wait at least 2.5s so banners are visible; then scroll once ready.
    autoScrollToMenuWhenReady({
      minDelayMs: 2500,
      readyPromise: eventsReady,
      menuId: "menu",
    });
  });
})();
