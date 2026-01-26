// public/script.js
// Shared utilities + event rendering (NO API keys)
// Uses your server routes: /api/events and /api/events?reference=...

(function () {
  "use strict";

  // ----------------------------
  // Autoscroll: menu to top
  // ----------------------------
  function autoScrollToMenu(options = {}) {
    const delay = Number(options.delay ?? 2500);
    const menuId = options.menuId ?? "menu";

    let cancelled = false;

    function cancel() {
      cancelled = true;
      cleanup();
    }

    function cleanup() {
      window.removeEventListener("wheel", cancel, { passive: true });
      window.removeEventListener("touchstart", cancel, { passive: true });
      window.removeEventListener("keydown", cancel);
    }

    window.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("touchstart", cancel, { passive: true });
    window.addEventListener("keydown", cancel);

    window.addEventListener("load", () => {
      setTimeout(() => {
        if (cancelled) return;

        const menu = document.getElementById(menuId);
        if (!menu) return;

        const reduce =
          window.matchMedia &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        const y = menu.getBoundingClientRect().top + window.pageYOffset;
        window.scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });

        cleanup();
      }, delay);
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
        const uniqueDates = unique(allDates.map((d) => d.date));

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
    autoScrollToMenu({ delay: 2500 });

    // All Shows
    if (document.getElementById("events-container")) {
      renderEventsPage({
        containerId: "events-container",
        reference: null,
        mode: "all",
      });
    }

    // General Tour
    if (document.getElementById("general-events")) {
      renderEventsPage({
        containerId: "general-events",
        reference: "General",
        mode: "tour",
        loadingId: "loading",
      });
    }

    // Summer Season
    if (document.getElementById("summer-events")) {
      renderEventsPage({
        containerId: "summer-events",
        reference: "Summer",
        mode: "tour",
        spinnerSelector: ".loading-spinner",
        noEventsSelector: ".no-events-message",
      });
    }

    // Halloween Circus
    if (document.getElementById("halloween-events")) {
      renderEventsPage({
        containerId: "halloween-events",
        reference: "Halloween",
        mode: "tour",
        spinnerSelector: ".loading-spinner",
        noEventsSelector: ".no-events-message",
      });
    }
  });
})();
