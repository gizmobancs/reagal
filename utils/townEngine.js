function startOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function slugifyTown(town) {
  return String(town || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function buildTownIndex(groupedEvents, opts = {}) {
  const today = opts.today ?? startOfTodayLocal();
  const comingSoonDays = opts.comingSoonDays ?? 28;

  const comingSoonLimit = new Date(today);
  comingSoonLimit.setDate(comingSoonLimit.getDate() + comingSoonDays);

  const towns = [];

  for (const [town, townEvents] of Object.entries(groupedEvents)) {
    const perfDates = [];

    for (const ev of townEvents) {
      for (const d of ev.dates || []) {
        if (!d.startISO) continue;
        const dt = new Date(d.startISO);
        if (dt >= today) perfDates.push(dt);
      }
    }

    // ❌ no upcoming dates at all → skip completely
    if (perfDates.length === 0) continue;

    perfDates.sort((a, b) => a - b);
    const startDate = perfDates[0];
    const endDate = perfDates[perfDates.length - 1];

    let status;

    if (today > endDate) {
      continue; // PAST → remove entirely
    } else if (isSameLocalDay(today, endDate)) {
      status = "FINAL_DAY";
    } else if (today >= startDate && today < endDate) {
      status = "IN_TOWN_NOW";
    } else if (startDate <= comingSoonLimit) {
      status = "COMING_SOON";
    } else {
      status = "LATER"; // ✅ KEEP THESE
    }

    towns.push({
      town,
      townSlug: slugifyTown(town),
      startDateISO: startDate.toISOString(),
      endDateISO: endDate.toISOString(),
      status,
      events: townEvents,
    });
  }

  const rank = {
    FINAL_DAY: 0,
    IN_TOWN_NOW: 1,
    COMING_SOON: 2,
    LATER: 3,
  };

  towns.sort((a, b) => {
    const ra = rank[a.status] ?? 9;
    const rb = rank[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    return new Date(a.startDateISO) - new Date(b.startDateISO);
  });

  return towns;
}

module.exports = { buildTownIndex, slugifyTown };
