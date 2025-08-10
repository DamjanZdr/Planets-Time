import {
  PLANETS,
  heliocentricDistanceAU,
  planetIrradianceScale,
} from "./planets.js";
import {
  formatTime,
  sunTimes,
  EARTH_NOON_LUX,
  findApparentAltitudeCrossings,
} from "./solar.js";

const q = (sel) => document.querySelector(sel);
// Fixed star count for the global starfield
const STAR_COUNT = 40;

// Visual sizes (px) for planets, aesthetic (bumped up for larger default view)
// Base sizes remain proportional, but with a compressed dynamic range
const PLANET_SIZES_BASE = {
  mercury: 28,
  venus: 38,
  earth: 38,
  mars: 33,
  jupiter: 76,
  saturn: 72,
  uranus: 49,
  neptune: 49,
  pluto: 21,
};
// Apply a gentle compression toward the mean to shrink differences
const PLANET_SIZE_MULTIPLIER = 1.5; // scale up default sizes by ~50%
const PLANET_SIZES = Object.fromEntries(
  Object.entries(PLANET_SIZES_BASE).map(([k, v]) => {
    const mean = 45; // visual midpoint target
    const factor = 0.6; // 0 = all equal to mean, 1 = original values
    const compressed = mean + (v - mean) * factor;
    const scaled = compressed * PLANET_SIZE_MULTIPLIER;
    return [k, Math.round(scaled)];
  })
);

const state = {
  lat: null,
  lon: null,
  place: null, // "City, Country"
  selectedEl: null,
  flickerTimers: new WeakMap(),
  countries: [],
  countryByName: new Map(),
  countryGuess: null,
  countryActiveIndex: -1,
  // Ensure initial country selection uses centroid like later manual picks
  countryAutoAppliedOnce: false,
  pendingCountryName: null,
};

// Compute target apparent solar altitude (degrees) for a planet on a given date.
// Pluto is fixed to -1.5°, matching NASA's PlutoTime definition. Others map
// inverse-square illuminance at planet noon to an equivalent Earth Sun altitude
// using a clear-sky illuminance model, then we solve for that altitude.
function targetApparentAltitudeForPlanetKey(planetKey, date = new Date()) {
  if (!planetKey) return null;
  const key = planetKey.toLowerCase();
  if (key === "earth") return null; // we don't show Earth times
  const H_PLUTO = -1.5; // NASA PlutoTime baseline
  const r = heliocentricDistanceAU(key, date) || 1;
  const rPluto = heliocentricDistanceAU("pluto", date) || 39.48;
  const Lx = EARTH_NOON_LUX * planetIrradianceScale(r);
  const Lp = EARTH_NOON_LUX * planetIrradianceScale(rPluto);
  // Slope from 0°=120000 lux to -6°=400 lux (log10 scale)
  const m = (-6 - 0) / (Math.log10(400) - Math.log10(120000));
  const delta = m * (Math.log10(Lx) - Math.log10(Lp));
  const hTarget = H_PLUTO + delta;
  return Math.max(-18, Math.min(85, hTarget));
}

// Prefer custom textures placed by the user under assets/custom_textures/{key}.{ext}
// Tries PNG, JPG, WEBP in that order. On success, sets the element's background image to only that texture (square, no rounding).
function tryCustomTexture(assetKey, el) {
  const exts = ["png", "jpg", "webp"];
  let idx = 0;
  const tryNext = () => {
    if (idx >= exts.length) return; // nothing found
    const ext = exts[idx++];
    const url = `./assets/custom_textures/${assetKey}.${ext}`;
    const probe = new Image();
    probe.onload = () => {
      el.style.backgroundImage = `url('${url}')`;
      // Fill the square element with the image
      el.style.backgroundSize = `cover`;
      el.style.backgroundPosition = `center`;
      el.style.backgroundRepeat = `no-repeat`;
      el.style.borderRadius = "0"; // square
      el.style.webkitMaskImage = "";
      el.style.maskImage = "";
      el.style.visibility = "visible";
    };
    probe.onerror = tryNext;
    // Start fetch
    probe.src = url;
  };
  tryNext();
}

function deviceKind() {
  const ua = navigator.userAgent || "";
  const isMobile =
    /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || window.innerWidth < 640;
  return isMobile ? "Phone" : "Desktop";
}

function setLocationDisplay(lat, lon) {
  const pretty = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const el = q("#locationText");
  if (el) el.textContent = state.place || pretty;
}

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lon)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("geocode failed");
    const data = await res.json();
    const a = data.address || {};
    const country = a.country || ""; // only country for display
    const place = country || null;
    state.place = place || null;
    // Record for auto-apply; if countries loaded and not yet applied, apply silently
    state.pendingCountryName = country || null;
    if (
      state.pendingCountryName &&
      !state.countryAutoAppliedOnce &&
      state.countryByName &&
      state.countryByName.has(state.pendingCountryName)
    ) {
      state.countryAutoAppliedOnce = true;
      applyCountrySelection(state.pendingCountryName, { visual: false });
    }
    setLocationDisplay(lat, lon);
  } catch (_) {
    // ignore network/geocode errors silently
  }
}

function buildSystem() {
  const system = q("#system");
  const plane = system.querySelector(".orbits");
  plane.innerHTML = ""; // reset

  // Use container size to compute radii
  const rect = system.getBoundingClientRect();
  const base = Math.min(rect.width, rect.height) * 0.72; // larger footprint
  // Vertical squeeze from CSS variable (fallback 0.55)
  const cs = getComputedStyle(system);
  const squeeze = parseFloat(cs.getPropertyValue("--squeeze")) || 0.55;
  // Write back the squeeze to the system element to ensure rings (CSS) and
  // planet placement (JS) are guaranteed to use the same value.
  system.style.setProperty("--squeeze", String(squeeze));
  // Sun radius in px (for overlap checks)
  const sun = system.querySelector(".sun");
  const sunRect = sun ? sun.getBoundingClientRect() : { width: 80 };
  const sunR = (sunRect.width || 80) / 2;
  // Layer spacing (small to minimize perspective distortion)
  const RING_SPACING_Z = 10; // px between successive rings in Z

  // Distribute radii across planets with a larger inner gap so Mercury doesn't touch the Sun
  const N = PLANETS.length;
  const firstSize = PLANET_SIZES[PLANETS[0].key] || 20;
  const innerMargin = 24; // extra clearance in px
  const rMin = sunR + firstSize / 2 + innerMargin;
  const rMax = base; // outermost radius footprint
  const radii = PLANETS.map(
    (_, i) => rMin + ((rMax - rMin) * i) / Math.max(1, N - 1)
  );
  // Seeded RNG for reproducible scatter
  let seed = 1337 >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed >>> 0) / 0xffffffff;
  };
  // No global separation needed since we alternate sides by ring
  const normalizeAngle = (a) => {
    let x = ((((a + 180) % 360) + 360) % 360) - 180;
    return x;
  };
  // Arrangement: alternate left/right from the Sun with mild jitter
  const JITTER = 10; // degrees of random jitter around side center
  const FORWARD_BIAS = 18; // push slightly toward camera (+90°)

  PLANETS.forEach((p, i) => {
    const r = radii[i];

    // Ring (elliptical via CSS scaleY)
    const ring = document.createElement("div");
    ring.className = "orbit-ring";
    ring.style.width = `${r * 2}px`;
    ring.style.height = `${r * 2}px`;
    ring.style.left = `50%`;
    ring.style.top = `50%`;
    // Put outer rings above inner planets: ring k has higher translateZ than planet j if k>j
    const ringZ = i * RING_SPACING_Z; // px layer step
    ring.style.setProperty("--ring-z", `${ringZ}px`);
    // Don't set transform here so CSS can apply translate + scaleY(var(--squeeze))
    plane.appendChild(ring);

    const el = document.createElement("div");
    el.className = "orbit-planet";
    el.setAttribute("data-key", p.key);
    el.setAttribute("title", p.name);
    // Persist index for proximity-based animations later
    el.dataset.index = String(i);

    const dot = document.createElement("div");
    dot.className = "dot";
    const sz = PLANET_SIZES[p.key] || 12;
    dot.style.width = `${sz}px`;
    dot.style.height = `${sz}px`;
    // Expose base size for CSS positioning of the label when selected
    el.style.setProperty("--dot", `${sz}px`);
    // Start hidden; show only when a custom texture loads
    dot.style.visibility = "hidden";
    dot.style.backgroundImage = "none";
    dot.style.backgroundColor = "transparent";
    dot.style.backgroundSize = `cover`;
    dot.style.backgroundPosition = `center`;
    dot.style.backgroundRepeat = `no-repeat`;
    // Square images (no rounding)
    dot.style.borderRadius = "0";
    // Use user-provided custom texture if present
    tryCustomTexture(p.key, dot);

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = p.name;

    // Depth mapping for layered look
    // After angle is chosen, compute depth based on near/far within the band
    el.dataset.r = String(r);
    // Pick a scattered angle in left/right halves, avoiding the Sun disk and keeping separation
    let angleDeg = null;
    for (let tries = 0; tries < 200; tries++) {
      // Alternate sides by ring index: even -> left (around 180°), odd -> right (around 0°)
      // Nudge both sides toward the camera (around +90°) by a small forward bias
      const sideCenter = i % 2 === 0 ? 180 - FORWARD_BIAS : 0 + FORWARD_BIAS;
      const jitter = (rand() * 2 - 1) * JITTER; // [-JITTER, +JITTER]
      const a = normalizeAngle(sideCenter + jitter);
      // avoid overlapping the sun disk
      const ar = (a * Math.PI) / 180;
      const testX = r * Math.cos(ar);
      const testY = r * Math.sin(ar) * squeeze;
      const d = Math.hypot(testX, testY);
      const dotR = sz / 2;
      if (d <= sunR + dotR + 6) continue; // too close to sun
      angleDeg = a;
      break;
    }
    if (angleDeg == null) {
      // Fallback evenly spaced placement with small jitter
      angleDeg = i * (360 / N) + (rand() * 40 - 20) - 180;
    }
    const angle = (angleDeg * Math.PI) / 180;
    const sinA = Math.sin(angle);
    const x = r * Math.cos(angle);
    const y = sinA * r * squeeze; // compress vertically to sit on ellipse
    el.dataset.x = String(x);
    el.dataset.y = String(y);
    el.style.left = `calc(50% + ${x}px)`;
    el.style.top = `calc(50% + ${y}px)`;
    // Depth: align exactly with the ring Z to ensure perfect visual alignment
    // with the dashed orbit line (avoid perspective mismatch).
    const depth = ringZ;
    el.style.setProperty("--z", `${depth}px`);
    // Keep default translate(-50%,-50%) and use CSS var for Z

    el.appendChild(dot);
    el.appendChild(label);
    // Toggle behavior: click selects; clicking the selected planet goes back
    el.addEventListener("click", () => {
      if (el.classList.contains("selected")) {
        clearSelection("animate");
      } else {
        selectPlanet(p, el);
      }
    });
    plane.appendChild(el);
  });
  // Match diffuse ellipse size to the outermost ring diameter
  const outer = radii[radii.length - 1] * 2;
  // add a touch of padding so it just envelops the outer ring shadow
  const planeD = `${outer + 0}px`;
  system.style.setProperty("--plane-d", planeD);

  // Apply custom texture to the Sun if provided (assets/custom_textures/sun.*)
  if (sun) {
    tryCustomTexture("sun", sun);
  }
}

function nextPlanetTime(date, lat, lon, au, key) {
  // Target apparent altitude in degrees using Pluto scaling method
  let targetAltDeg = null;
  if (key) {
    targetAltDeg = targetApparentAltitudeForPlanetKey(key, date);
  } else if (au) {
    const H_PLUTO = -1.5;
    const rPluto = heliocentricDistanceAU("pluto", date) || 39.48;
    const Lx = EARTH_NOON_LUX * planetIrradianceScale(au);
    const Lp = EARTH_NOON_LUX * planetIrradianceScale(rPluto);
    const m = (-6 - 0) / (Math.log10(400) - Math.log10(120000));
    const delta = m * (Math.log10(Lx) - Math.log10(Lp));
    targetAltDeg = H_PLUTO + delta;
  }
  const now = new Date();
  // Try to find a true crossing in the next 3 days
  for (let d = 0; d < 3; d++) {
    const day = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() + d
    );
    const times =
      findApparentAltitudeCrossings(day, lat, lon, targetAltDeg) || [];
    const candidates = times.filter(Boolean);
    if (!candidates.length) continue;
    // Prefer the next occurrence as PlutoTime does:
    // - If now < morning today -> morning today
    // - Else if now < evening today -> evening today
    // - Else -> morning tomorrow
    if (targetAltDeg != null && targetAltDeg <= 0) {
      const morning = candidates[0] || null;
      const evening = candidates[1] || null;
      if (d === 0) {
        if (morning && morning.getTime() > now.getTime()) return morning;
        if (evening && evening.getTime() > now.getTime()) return evening;
        // Otherwise, continue to next day (d=1) and return its morning
        continue;
      }
      // For future days (d>0) just return the morning for that day
      if (morning) return morning;
    }
    // Otherwise, return the next crossing after now
    let t = candidates[0];
    if (d === 0) {
      t = candidates.find((x) => x.getTime() > now.getTime()) || null;
    }
    if (t) return t;
  }
  // Fallback: no exact crossing exists (e.g., target >= max altitude).
  // Use the time of maximum solar elevation: local solar noon today/tomorrow.
  const noonToday = sunTimes(date, lat, lon).solarNoon;
  if (noonToday && noonToday.getTime() > now.getTime()) return noonToday;
  const tomorrow = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1
  );
  const noonTomorrow = sunTimes(tomorrow, lat, lon).solarNoon;
  return noonTomorrow || null;
}

// --- Panel helpers ---
function msUntil(date) {
  if (!date) return null;
  const now = new Date();
  return Math.max(0, date.getTime() - now.getTime());
}

function formatDuration(ms) {
  if (ms == null) return "—";
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m} mins`;
  if (m === 0) return `${h} hrs`;
  return `${h} hrs ${m} mins`;
}

// Long form for UI copy in panels
function formatDurationLong(ms) {
  if (ms == null) return "—";
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const hPart = h > 0 ? `${h} ${h === 1 ? "hour" : "hours"}` : "";
  const mPart = m > 0 ? `${m} ${m === 1 ? "minute" : "minutes"}` : "";
  if (!hPart && !mPart) return "0 minutes";
  if (!hPart) return mPart;
  if (!mPart) return hPart;
  return `${hPart} ${mPart}`;
}

function updatePanelsForSelection(p) {
  const nextTitle = q("#nextPanelTitle");
  const nextContent = q("#nextPanelContent");
  const tlTitle = q("#timelinePanelTitle");
  const tlList = q("#timelineList");
  const tlMorning = q("#tlMorning");
  const tlEvening = q("#tlEvening");
  const tlSunrise = q("#tlSunrise");
  const tlNoon = q("#tlNoon");
  const tlSunset = q("#tlSunset");
  const tlDaylight = q("#tlDaylight");
  const tlMorningLabel = q("#tlMorningLabel");
  const tlEveningLabel = q("#tlEveningLabel");

  if (!p) {
    if (nextTitle) nextTitle.textContent = "Planet time is in…";
    if (tlTitle) tlTitle.textContent = "Planet light timeline";
    if (tlMorningLabel) tlMorningLabel.textContent = "Morning Planet Time";
    if (tlEveningLabel) tlEveningLabel.textContent = "Evening Planet Time";
    if (nextContent) nextContent.textContent = "";
    if (tlList) tlList.style.display = "";
    [tlMorning, tlEvening, tlSunrise, tlNoon, tlSunset, tlDaylight].forEach(
      (el) => el && (el.textContent = "—")
    );
    return;
  }

  // Update titles with planet name
  if (nextTitle) nextTitle.textContent = `${p.name} time is in…`;
  if (tlTitle) tlTitle.textContent = `${p.name} light timeline`;
  if (tlMorningLabel) tlMorningLabel.textContent = `Morning ${p.name} Time`;
  if (tlEveningLabel) tlEveningLabel.textContent = `Evening ${p.name} Time`;

  // Use current date and location
  const dp = q("#datePicker");
  const date = dp && dp.valueAsDate ? dp.valueAsDate : new Date();
  const lat = state.lat;
  const lon = state.lon;

  // Next occurrence and time remaining (panel 2)
  const nextT = nextPlanetTime(date, lat, lon, p.au, p.key);
  if (nextContent) {
    if (p.key === "earth") {
      nextContent.textContent = "Your current time, duh";
    } else {
      const durLong = formatDurationLong(msUntil(nextT));
      const place = state.place || null;
      nextContent.textContent = place ? `${durLong} in ${place}` : durLong;
    }
  }

  // Timeline entries for this date
  const targetAltDeg =
    p.key === "earth" ? null : targetApparentAltitudeForPlanetKey(p.key, date);
  // Timeline: compute both morning/evening by apparent altitude equivalence
  let crossings =
    targetAltDeg == null
      ? []
      : findApparentAltitudeCrossings(date, lat, lon, targetAltDeg) || [];
  // If target is unreachable (e.g., Mercury/Venus often demand > max brightness),
  // progressively lower the target elevation until we get two crossings, or give up.
  // If no crossings (e.g., polar conditions), keep nulls; no elevation fallback here.
  const morning = crossings[0] || null;
  const evening = crossings[1] || null;
  const sun = sunTimes(date, lat, lon);

  if (tlMorning) tlMorning.textContent = morning ? formatTime(morning) : "—";
  if (tlEvening) tlEvening.textContent = evening ? formatTime(evening) : "—";
  if (tlSunrise)
    tlSunrise.textContent = sun.sunrise ? formatTime(sun.sunrise) : "—";
  if (tlNoon)
    tlNoon.textContent = sun.solarNoon ? formatTime(sun.solarNoon) : "—";
  if (tlSunset)
    tlSunset.textContent = sun.sunset ? formatTime(sun.sunset) : "—";
  if (tlDaylight) {
    tlDaylight.textContent =
      sun.alwaysUp || sun.alwaysDown
        ? sun.alwaysUp
          ? "All day"
          : "No daylight"
        : `${Math.floor(sun.daylight)}hrs ${Math.round(
            (sun.daylight % 1) * 60
          )}mins`;
  }

  // Earth special copy for timeline panel: keep the title; show message as content, hide list
  if (p.key === "earth") {
    if (tlTitle) tlTitle.textContent = `${p.name} light timeline`;
    if (tlList) tlList.style.display = "none";
    // Render message into nextPanelContent? No; it's for timeline panel.
    // We'll inject a simple paragraph below the title in the timeline panel body when list is hidden.
    const timelinePanel = q("#panel-timeline .panel-body");
    if (timelinePanel) {
      // Ensure message element exists and is unique.
      let msg = timelinePanel.querySelector(".earth-timeline-note");
      if (!msg) {
        msg = document.createElement("p");
        msg.className = "earth-timeline-note";
        timelinePanel.appendChild(msg);
      }
      msg.textContent =
        "Just look outside the window, and maybe touch some grass while you're at it";
      msg.style.margin = "10px 0 0";
      msg.style.textAlign = "center";
      msg.style.color =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--muted")
          .trim() || "#94a3b8";
    }
  } else {
    if (tlTitle) tlTitle.textContent = `${p.name} light timeline`;
    if (tlList) tlList.style.display = "";
    const timelinePanel = q("#panel-timeline .panel-body");
    if (timelinePanel) {
      const msg = timelinePanel.querySelector(".earth-timeline-note");
      if (msg) msg.remove();
    }
  }
}

// Clear current selection.
// mode: 'animate' (default) plays reverse fly-back; 'instant' cancels and snaps back immediately.
function clearSelection(mode = "animate") {
  const system = q("#system");
  // Always restore the selected element's left/top immediately
  if (state.selectedEl) {
    state.selectedEl.classList.remove("selected");
    state.selectedEl.style.removeProperty("transform");
    state.selectedEl.style.removeProperty("--sel-scale");
    const prevLeft = state.selectedEl.dataset.prevLeft || "";
    const prevTop = state.selectedEl.dataset.prevTop || "";
    if (prevLeft) state.selectedEl.style.left = prevLeft;
    if (prevTop) state.selectedEl.style.top = prevTop;
    delete state.selectedEl.dataset.prevLeft;
    delete state.selectedEl.dataset.prevTop;
  }

  const plane = system.querySelector(".orbits");
  // Handle other planets + sun depending on mode
  if (mode === "instant") {
    // Cancel any fly classes and bring everything back immediately
    if (plane) {
      plane.querySelectorAll(".orbit-planet").forEach((n) => {
        n.classList.remove(
          "fly-left",
          "fly-right",
          "fly-back-left",
          "fly-back-right"
        );
        n.style.opacity = "";
        delete n.dataset.flyDir;
      });
    }
    const s = system.querySelector(".sun");
    if (s) {
      s.classList.remove(
        "fly-left",
        "fly-right",
        "fly-back-left",
        "fly-back-right"
      );
      s.style.opacity = "";
      delete s.dataset.flyDir;
    }
  } else {
    // Animate back using recorded direction when possible, else infer from classes
    if (plane) {
      plane.querySelectorAll(".orbit-planet").forEach((n) => {
        const dir =
          n.dataset.flyDir ||
          (n.classList.contains("fly-left")
            ? "left"
            : n.classList.contains("fly-right")
            ? "right"
            : "");
        if (!dir) return;
        const backClass = dir === "left" ? "fly-back-left" : "fly-back-right";
        // Start reverse anim from end pose
        n.classList.add(backClass);
        void n.offsetWidth; // reflow
        n.classList.remove("fly-left", "fly-right");
        n.addEventListener(
          "animationend",
          () => {
            n.classList.remove(backClass);
            n.style.opacity = "";
            delete n.dataset.flyDir;
          },
          { once: true }
        );
      });
    }
    const s = system.querySelector(".sun");
    if (s) {
      const dir =
        s.dataset.flyDir ||
        (s.classList.contains("fly-left")
          ? "left"
          : s.classList.contains("fly-right")
          ? "right"
          : "");
      if (dir) {
        const backClass = dir === "left" ? "fly-back-left" : "fly-back-right";
        s.classList.add(backClass);
        void s.offsetWidth;
        s.classList.remove("fly-left", "fly-right");
        s.addEventListener(
          "animationend",
          () => {
            s.classList.remove(backClass);
            s.style.opacity = "";
            delete s.dataset.flyDir;
          },
          { once: true }
        );
      }
    }
  }
  system.classList.remove("zoomed");
  system.style.setProperty("--center-pan", "0px");
  system.removeAttribute("data-center-x");
  state.selectedEl = null;
  const dock = q("#detailDock");
  dock.classList.add("hidden");
  dock.innerHTML = "";
  const overlay = q("#infoOverlay");
  if (overlay) overlay.classList.add("hidden");
  // Starfield warp back when returning from selection
  if (mode === "animate") {
    warpStars("backward");
  }
  // Reset panel content when cleared
  updatePanelsForSelection(null);
}

function selectPlanet(p, el) {
  if (state.lat == null || state.lon == null) {
    alert("Please set your location first.");
    return;
  }
  const system = q("#system");
  const dp = q("#datePicker");
  const date = dp && dp.valueAsDate ? dp.valueAsDate : new Date();
  const t = nextPlanetTime(date, state.lat, state.lon, p.au);
  const when = t ? formatTime(t) : "—";
  const place =
    state.place || `${state.lat.toFixed(2)}, ${state.lon.toFixed(2)}`;

  // Instant-clear current state so a new selection never fights ongoing animations
  clearSelection("instant");

  // Compute original selected center X before we move it
  const plane = system.querySelector(".orbits");
  const allPlanets = [...plane.querySelectorAll(".orbit-planet")];
  const selRect0 = el.getBoundingClientRect();
  const selCenterX0 = selRect0.left + selRect0.width / 2;
  // Store original positions to restore on clear
  const prevLeft = el.style.left;
  const prevTop = el.style.top;
  el.dataset.prevLeft = prevLeft || "";
  el.dataset.prevTop = prevTop || "";
  // Target absolute center where the Sun sits (50%/50%)
  el.style.left = "50%";
  el.style.top = "50%";

  // Now apply selection/zoom
  el.classList.add("selected");
  system.classList.add("zoomed");

  // Ensure the selected planet's dot scales to a uniform target size across all planets
  const dotEl = el.querySelector(".dot");
  if (dotEl) {
    const basePx =
      dotEl.getBoundingClientRect().width || PLANET_SIZES[p.key] || 32;
    const targetPx = 240; // final on-screen size for any selected planet (50% larger)
    const selScale = Math.max(0.5, targetPx / Math.max(1, basePx));
    el.style.setProperty("--sel-scale", String(selScale));
  }

  // No second-pass needed since we target absolute coordinates

  // Fly out non-selected planets depending on side (relative to the selected's original X), and scale/fade via CSS
  allPlanets.forEach((pEl) => {
    if (pEl === el) return;
    // clean any stale classes from prior runs
    pEl.classList.remove(
      "fly-left",
      "fly-right",
      "fly-back-left",
      "fly-back-right"
    );
    // Compute proximity in the ring index space
    const selIdx = parseInt(el.dataset.index || "-1", 10);
    const idx = parseInt(pEl.dataset.index || "-1", 10);
    const dist = selIdx >= 0 && idx >= 0 ? Math.abs(idx - selIdx) : 1;
    const maxDist = Math.max(selIdx, PLANETS.length - 1 - selIdx) || 1;
    // Map distance -> fly-out dx: closer => larger dx, farther => smaller dx
    const MAX_DX = 420; // px for nearest neighbor (stronger motion)
    const MIN_DX = 90; // px for farthest
    const t = Math.min(1, Math.max(0, dist / maxDist));
    const dx = Math.round(MAX_DX - (MAX_DX - MIN_DX) * t);
    pEl.style.setProperty("--fly-dx", dx + "px");
    const rect = pEl.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    if (center < selCenterX0) {
      pEl.classList.add("fly-left");
      pEl.classList.remove("fly-right");
      pEl.dataset.flyDir = "left";
    } else {
      pEl.classList.add("fly-right");
      pEl.classList.remove("fly-left");
      pEl.dataset.flyDir = "right";
    }
  });

  // Also fly the Sun based on its position vs. selected
  const sunEl = system.querySelector(".sun");
  if (sunEl) {
    // clean stale classes
    sunEl.classList.remove(
      "fly-left",
      "fly-right",
      "fly-back-left",
      "fly-back-right"
    );
    // Apply distance-based mapping to the Sun as well: inner selections push Sun more
    const selIdx = parseInt(el.dataset.index || "-1", 10);
    const maxIdx = Math.max(1, PLANETS.length - 1);
    const tSun = selIdx >= 0 ? selIdx / maxIdx : 0.5; // 0 (Mercury) -> 0 move factor; 1 (outermost) -> far
    const SUN_MAX_DX = 420;
    const SUN_MIN_DX = 90;
    const sunDx = Math.round(SUN_MAX_DX - (SUN_MAX_DX - SUN_MIN_DX) * tSun);
    sunEl.style.setProperty("--fly-dx", sunDx + "px");
    const sRect = sunEl.getBoundingClientRect();
    const sCenterX = sRect.left + sRect.width / 2;
    if (sCenterX < selCenterX0) {
      sunEl.classList.add("fly-left");
      sunEl.classList.remove("fly-right");
      sunEl.dataset.flyDir = "left";
    } else {
      sunEl.classList.add("fly-right");
      sunEl.classList.remove("fly-left");
      sunEl.dataset.flyDir = "right";
    }
  }
  // Populate external detail dock
  const dock = q("#detailDock");
  dock.classList.add("hidden");
  dock.innerHTML = "";

  // Populate centered overlay
  const overlay = q("#infoOverlay");
  if (overlay) {
    const title = overlay.querySelector(".info-title");
    const sub = overlay.querySelector(".info-sub");
    const timeEl = overlay.querySelector(".info-time");
    const placeEl = overlay.querySelector(".info-place");
    const closeBtn = overlay.querySelector(".info-close");
    if (title) title.textContent = ""; // hide redundant planet name line
    if (p.key === "earth") {
      sub.textContent =
        "You’re already on Earth… unless you’re an alien checking in 👽";
      // For Earth, do not show time/place
      if (timeEl) {
        timeEl.textContent = "";
        timeEl.style.display = "none";
      }
      if (placeEl) {
        placeEl.textContent = "";
        placeEl.style.display = "none";
      }
    } else {
      sub.textContent = `Next ${p.name} time will occur at`;
      // For non-Earth, show time/place as usual
      if (timeEl) {
        timeEl.textContent = when || "—";
        timeEl.style.display = "";
      }
      if (placeEl) {
        placeEl.textContent = place ? `in ${place}` : "";
        placeEl.style.display = place ? "" : "none";
      }
    }
    overlay.classList.remove("hidden");
    if (closeBtn) closeBtn.onclick = () => clearSelection("animate");
  }

  state.selectedEl = el;
  // Trigger starfield warp forward on selection
  warpStars("forward");
  // Update panels to reflect selection
  updatePanelsForSelection(p);
}

function setupControls() {
  q("#detectLocationBtn").addEventListener("click", () => {
    if (!navigator.geolocation) return alert("Geolocation not supported.");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        state.lat = latitude;
        state.lon = longitude;
        q("#latInput").value = latitude.toFixed(6);
        q("#lonInput").value = longitude.toFixed(6);
        setLocationDisplay(latitude, longitude);
        reverseGeocode(latitude, longitude);
      },
      (err) => {
        alert("Failed to get location: " + err.message);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  q("#applyLocationBtn").addEventListener("click", () => {
    const lat = parseFloat(q("#latInput").value);
    const lon = parseFloat(q("#lonInput").value);
    if (isFinite(lat) && isFinite(lon)) {
      state.lat = lat;
      state.lon = lon;
      state.place = null;
      setLocationDisplay(lat, lon);
      reverseGeocode(lat, lon);
    }
  });

  const dp = q("#datePicker");
  if (dp) {
    const todayLocal = new Date();
    dp.valueAsDate = new Date(
      todayLocal.getFullYear(),
      todayLocal.getMonth(),
      todayLocal.getDate()
    );
  }
}

function init() {
  // Build subtle global starfield once
  const sky = q("#sky");
  if (sky && sky.children.length === 0) {
    // Always render a fixed number of stars
    const num = STAR_COUNT;
    const rng = () => Math.random();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < num; i++) {
      const s = document.createElement("div");
      s.className = "star";
      const x = (rng() * 100).toFixed(2) + "%";
      const y = (rng() * 100).toFixed(2) + "%";
      const sz = (0.8 + rng() * 2.2).toFixed(2) + "px"; // 0.8px - 3px
      const baseO = (0.35 + rng() * 0.35).toFixed(2); // 0.35 - 0.7
      s.style.setProperty("--x", x);
      s.style.setProperty("--y", y);
      s.style.setProperty("--sz", sz);
      s.style.setProperty("--o", baseO);
      // Randomize fade duration for opacity transitions (0.1s - 1s)
      const fadeMs = Math.floor(100 + rng() * 900);
      s.style.setProperty("--fade", `${fadeMs}ms`);
      frag.appendChild(s);
    }
    sky.appendChild(frag);
    // Start independent, randomized flicker on a subset of stars
    startStarFlicker(sky);
  }
  // Clip the global starfield so it never appears over header/footer
  const header = q(".app-header");
  const footer = q(".app-footer");
  const applySkyClip = () => {
    if (!sky) return;
    const top = header ? header.offsetHeight : 0;
    const bottom = footer ? footer.offsetHeight : 0;
    sky.style.top = top + "px";
    sky.style.bottom = bottom + "px";
  };
  applySkyClip();
  const devEl = q("#deviceText");
  if (devEl) devEl.textContent = deviceKind();
  buildSystem();
  // Controls may be removed; guard setup
  if (q("#detectLocationBtn") || q("#applyLocationBtn")) {
    setupControls();
  }
  // Rebuild on resize for better scaling
  window.addEventListener("resize", () => {
    clearSelection("instant");
    buildSystem();
    applySkyClip();
  });

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        state.lat = latitude;
        state.lon = longitude;
        const latEl = q("#latInput");
        const lonEl = q("#lonInput");
        if (latEl) latEl.value = latitude.toFixed(6);
        if (lonEl) lonEl.value = longitude.toFixed(6);
        setLocationDisplay(latitude, longitude);
        reverseGeocode(latitude, longitude);
      },
      () => {
        const lat = 52.2297,
          lon = 21.0122;
        state.lat = lat;
        state.lon = lon;
        const latEl = q("#latInput");
        const lonEl = q("#lonInput");
        if (latEl) latEl.value = lat.toFixed(6);
        if (lonEl) lonEl.value = lon.toFixed(6);
        setLocationDisplay(lat, lon);
        reverseGeocode(lat, lon);
      }
    );
  } else {
    const lat = 52.2297,
      lon = 21.0122;
    state.lat = lat;
    state.lon = lon;
    const latEl = q("#latInput");
    const lonEl = q("#lonInput");
    if (latEl) latEl.value = lat.toFixed(6);
    if (lonEl) lonEl.value = lon.toFixed(6);
    setLocationDisplay(lat, lon);
    reverseGeocode(lat, lon);
  }
  // Wire country selection controls
  wireCountryControls();

  // Wire header tabs (How, About, Contact)
  wireHeaderTabs();
}

async function fetchCountriesOnce() {
  if (state.countries && state.countries.length) return state.countries;
  try {
    // Static ISO country list with lat/lon (centroids); hosted free JSON
    // Fallback to a minimal built-in if fetch fails.
    const res = await fetch(
      "https://raw.githubusercontent.com/mledoze/countries/master/countries.json"
    );
    if (!res.ok) throw new Error("country list fetch failed");
    const data = await res.json();
    const list = [];
    for (const c of data) {
      const name = c.name && (c.name.common || c.name.official || c.name);
      // Some datasets include latlng [lat, lon]
      const latlng = Array.isArray(c.latlng) ? c.latlng : null;
      if (!name || !latlng || latlng.length < 2) continue;
      list.push({
        name: String(name),
        lat: Number(latlng[0]),
        lon: Number(latlng[1]),
      });
    }
    list.sort((a, b) => a.name.localeCompare(b.name));
    state.countries = list;
    state.countryByName = new Map(list.map((c) => [c.name, c]));
    // No native datalist used; we render our own dropdown.
    // Auto-apply pending reverse-geocoded country once (silent)
    if (state.pendingCountryName && !state.countryAutoAppliedOnce) {
      const name = state.pendingCountryName;
      if (state.countryByName.has(name)) {
        state.countryAutoAppliedOnce = true;
        applyCountrySelection(name, { visual: false });
      }
    }
    return list;
  } catch (e) {
    // Minimal fallback list
    const list = [
      { name: "United States", lat: 39.7837304, lon: -100.445882 },
      { name: "Poland", lat: 52.237, lon: 21.017 },
      { name: "United Kingdom", lat: 54.7023545, lon: -3.2765753 },
      { name: "India", lat: 22.3511148, lon: 78.6677428 },
      { name: "Australia", lat: -24.7761086, lon: 134.755 },
      { name: "Japan", lat: 36.5748441, lon: 139.2394179 },
    ];
    state.countries = list;
    state.countryByName = new Map(list.map((c) => [c.name, c]));
    // No native datalist used in fallback either.
    // Auto-apply pending reverse-geocoded country once (silent) using fallback list
    if (state.pendingCountryName && !state.countryAutoAppliedOnce) {
      const name = state.pendingCountryName;
      if (state.countryByName.has(name)) {
        state.countryAutoAppliedOnce = true;
        applyCountrySelection(name, { visual: false });
      }
    }
    return list;
  }
}

function guessCountryFromNavigator() {
  // Best-effort: use Intl API for region if available
  try {
    const region = new Intl.DateTimeFormat(undefined, {
      timeZoneName: "long",
    }).resolvedOptions().locale;
  } catch (_) {}
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || "";
    const parts = locale.split("-");
    const code = parts[1] || parts[0];
    return code || null;
  } catch (_) {
    return null;
  }
}

function applyCountrySelection(name, opts = { visual: true }) {
  if (!name) return;
  const entry = state.countryByName.get(name);
  if (!entry) return;
  const { lat, lon } = entry;
  state.lat = lat;
  state.lon = lon;
  state.place = name;
  const latEl = q("#latInput");
  const lonEl = q("#lonInput");
  if (latEl) latEl.value = lat.toFixed(6);
  if (lonEl) lonEl.value = lon.toFixed(6);
  setLocationDisplay(lat, lon);
  if (opts && opts.visual) {
    // Visual indicator: reset to system view (exit any selection) with animation
    clearSelection("animate");
    // Bring the system into view subtly
    const system = q("#system");
    if (system && typeof system.scrollIntoView === "function") {
      try {
        system.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (_) {
        // ignore scroll issues
      }
    }
  } else {
    // Silent refresh of panels if something is selected
    if (state.selectedEl) {
      const k = state.selectedEl.getAttribute("data-key");
      const planet = PLANETS.find((p) => p.key === k) || null;
      updatePanelsForSelection(planet);
    }
  }
}

function wireHeaderTabs() {
  // Smooth-scroll to in-page sections and briefly highlight the target
  const header = document.querySelector(".app-header");
  function scrollToTarget(hash) {
    if (!hash) return;
    const id = hash.replace(/^#/, "");
    const target = document.getElementById(id);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const headerH = header ? header.offsetHeight : 0;
    const y = window.scrollY + rect.top - (headerH + 12); // small breathing space
    window.scrollTo({ top: y, behavior: "smooth" });
    // Add highlight pulse after the scroll settles a bit
    setTimeout(() => {
      target.classList.add("section-highlight");
      setTimeout(() => target.classList.remove("section-highlight"), 750);
    }, 300);
  }

  document.querySelectorAll(".top-tabs .tab-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      const href = a.getAttribute("href") || "";
      if (href.startsWith("#") && href.length > 1) {
        e.preventDefault();
        scrollToTarget(href);
        // Update hash without jumping
        history.pushState(null, "", href);
      }
    });
  });

  // Also handle back/forward
  window.addEventListener("popstate", () => {
    const h = location.hash;
    if (h) scrollToTarget(h);
  });

  // Contact form submit (placeholder send)
  const form = document.getElementById("contactForm");
  const status = document.getElementById("contactStatus");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (status) status.textContent = "Sending…";
      const fd = new FormData(form);
      const payload = {
        title: String(fd.get("title") || ""),
        email: String(fd.get("email") || ""),
        message: String(fd.get("message") || ""),
      };
      try {
        // Placeholder: POST to a no-op endpoint or your serverless function.
        // For now, simulate success locally.
        await new Promise((r) => setTimeout(r, 600));
        if (status) status.textContent = "Thanks! Message sent.";
        form.reset();
      } catch (err) {
        if (status) status.textContent = "Failed to send. Try again later.";
      }
    });
  }
}

async function wireCountryControls() {
  await fetchCountriesOnce();
  const input = q("#countrySearch");
  const dropdown = q("#countryDropdown");
  const picker = input ? input.closest(".country-picker") : null;
  // If empty, prefill with detected region's country name if present in list
  if (input && !input.value) {
    // No robust offline mapping from region code to name; leave blank by default.
  }

  if (!input || !dropdown) return;

  // Helpers for dropdown rendering and behavior
  function hideDropdown() {
    dropdown.classList.add("hidden");
    dropdown.innerHTML = "";
    state.countryActiveIndex = -1;
  }
  function showDropdown() {
    dropdown.classList.remove("hidden");
  }
  function setActiveIndex(idx) {
    const items = dropdown.querySelectorAll(".country-item");
    const n = items.length;
    if (!n) {
      state.countryActiveIndex = -1;
      return;
    }
    // wrap around
    if (idx < 0) idx = n - 1;
    if (idx >= n) idx = 0;
    state.countryActiveIndex = idx;
    items.forEach((el, i) => {
      el.setAttribute("aria-selected", i === idx ? "true" : "false");
      if (i === idx) {
        // ensure in view
        el.scrollIntoView({ block: "nearest" });
      }
    });
  }
  function renderMatches(matches) {
    dropdown.innerHTML = "";
    const frag = document.createDocumentFragment();
    matches.forEach((c, i) => {
      const d = document.createElement("div");
      d.className = "country-item";
      d.setAttribute("role", "option");
      d.textContent = c.name;
      d.dataset.name = c.name;
      // Mouse selection should not blur input before we handle selection
      d.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
      });
      d.addEventListener("click", () => {
        input.value = c.name;
        applyCountrySelection(c.name, { visual: true });
        hideDropdown();
        input.blur();
      });
      frag.appendChild(d);
    });
    dropdown.appendChild(frag);
    // Reset active index
    state.countryActiveIndex = matches.length ? 0 : -1;
    if (matches.length) setActiveIndex(0);
  }
  function filterAndRender() {
    const v = (input.value || "").trim();
    if (v.length < 2) {
      hideDropdown();
      return;
    }
    const ql = v.toLowerCase();
    const matches = state.countries
      .filter((c) => c.name.toLowerCase().includes(ql))
      .slice(0, 10);
    if (!matches.length) {
      // Show an empty state briefly, then hide
      dropdown.innerHTML = "";
      dropdown.classList.remove("hidden");
      const empty = document.createElement("div");
      empty.className = "country-item";
      empty.textContent = "No matches";
      empty.setAttribute("aria-disabled", "true");
      dropdown.appendChild(empty);
      state.countryActiveIndex = -1;
      return;
    }
    renderMatches(matches);
    showDropdown();
  }

  input.addEventListener("input", filterAndRender);
  input.addEventListener("focus", () => {
    // only show if content already qualifies
    filterAndRender();
  });
  input.addEventListener("keydown", (e) => {
    const isOpen = !dropdown.classList.contains("hidden");
    if ((e.key === "ArrowDown" || e.key === "Down") && isOpen) {
      e.preventDefault();
      setActiveIndex(state.countryActiveIndex + 1);
    } else if ((e.key === "ArrowUp" || e.key === "Up") && isOpen) {
      e.preventDefault();
      setActiveIndex(state.countryActiveIndex - 1);
    } else if (e.key === "Enter") {
      const items = dropdown.querySelectorAll(".country-item");
      if (isOpen && items.length && state.countryActiveIndex >= 0) {
        const el = items[state.countryActiveIndex];
        const name = el && el.dataset && el.dataset.name;
        if (name && state.countryByName.has(name)) {
          input.value = name;
          applyCountrySelection(name, { visual: true });
          hideDropdown();
          return;
        }
      }
      // Else apply typed value if exact
      const name = (input.value || "").trim();
      if (name && state.countryByName.has(name)) {
        applyCountrySelection(name, { visual: true });
        hideDropdown();
      }
    } else if (e.key === "Escape") {
      hideDropdown();
    }
  });
  // Hide when focus leaves the picker
  if (picker) {
    picker.addEventListener("focusout", (ev) => {
      // If focus is moving inside the picker, ignore
      const next = ev.relatedTarget;
      if (next && picker.contains(next)) return;
      // small delay to allow click mousedown handler to run
      setTimeout(() => hideDropdown(), 100);
    });
  }
}

window.addEventListener("DOMContentLoaded", init);

// --- Starfield utilities ---
function startStarFlicker(sky) {
  const rng = Math.random;
  const stars = sky ? sky.querySelectorAll(".star") : [];
  stars.forEach((s, idx) => {
    // Only some stars flicker to avoid too much twinkling
    if (rng() < 0.6) return; // ~40% flicker-capable
    // Stagger start
    const initialDelay = Math.floor(rng() * 3000);
    const schedule = () => {
      // Random interval between flickers per star (2s - 8s)
      const interval = Math.floor(2000 + rng() * 6000);
      const t = setTimeout(() => {
        // Randomize fade duration (0.1s - 1s) each time
        const fadeMs = Math.floor(100 + rng() * 900);
        s.style.setProperty("--fade", fadeMs + "ms");
        // Flicker: drop opacity to 0, then restore to base
        const base =
          parseFloat(getComputedStyle(s).getPropertyValue("--o")) || 0.6;
        s.style.opacity = "0";
        // stay invisible briefly (30ms - 150ms)
        const dwell = Math.floor(30 + rng() * 120);
        setTimeout(() => {
          s.style.opacity = String(base);
          schedule();
        }, dwell + fadeMs * 0.15);
      }, interval);
      state.flickerTimers.set(s, t);
    };
    setTimeout(schedule, initialDelay);
  });
}

function clearStarFlicker(sky) {
  const stars = sky ? sky.querySelectorAll(".star") : [];
  stars.forEach((s) => {
    const t = state.flickerTimers.get(s);
    if (t) clearTimeout(t);
    state.flickerTimers.delete(s);
  });
}

function computeDirectionFromCenter(sky, el) {
  const skyRect = sky.getBoundingClientRect();
  const cx = skyRect.left + skyRect.width / 2;
  const cy = skyRect.top + skyRect.height / 2;
  const r = el.getBoundingClientRect();
  const ex = r.left + r.width / 2;
  const ey = r.top + r.height / 2;
  let dx = ex - cx;
  let dy = ey - cy;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  return { vx: dx, vy: dy };
}

function spawnStars(sky, count, variant = "behind") {
  const rng = Math.random;
  const frag = document.createDocumentFragment();
  const n = typeof count === "number" ? count : STAR_COUNT;
  for (let i = 0; i < n; i++) {
    const s = document.createElement("div");
    // Forward spawn: from 0 -> 1 scale; Backward spawn: from big -> 1 scale and move inward from edges
    s.className =
      variant === "front"
        ? "star warp-in-big-start warp-in-moving"
        : "star warp-in-start";
    // Target positions (percent strings). For backward, we'll compute a small
    // inward step from an edge toward the center for subtle motion.
    let x, y;
    const sz = (0.8 + rng() * 2.2).toFixed(2) + "px";
    // Backward spawn should fade fully in; forward can remain varied
    const baseO = variant === "front" ? 1 : (0.35 + rng() * 0.35).toFixed(2);
    const fadeMs = variant === "front" ? 700 : Math.floor(120 + rng() * 720);
    // We'll set --x/--y after computing targets (esp. for backward)
    s.style.setProperty("--sz", sz);
    s.style.setProperty("--o", baseO);
    s.style.setProperty("--fade", `${fadeMs}ms`);
    // For backward spawns, place at a random edge first, then animate to target
    if (variant === "front") {
      // Decide which edge: 0=top,1=right,2=bottom,3=left
      const edge = Math.floor(rng() * 4);
      // Random position along the chosen edge
      const u = rng() * 100;
      let startLeft, startTop;
      if (edge === 0) {
        // top
        startLeft = u;
        startTop = 0;
      } else if (edge === 1) {
        // right
        startLeft = 100;
        startTop = u;
      } else if (edge === 2) {
        // bottom
        startLeft = u;
        startTop = 100;
      } else {
        // left
        startLeft = 0;
        startTop = u;
      }
      // Compute a small inward step toward the center (50,50)
      let dx = 50 - startLeft;
      let dy = 50 - startTop;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const step = 6 + rng() * 8; // move inward ~6%-14%
      const targetLeft = Math.max(0, Math.min(100, startLeft + dx * step));
      const targetTop = Math.max(0, Math.min(100, startTop + dy * step));
      // Apply start positions now; final positions will be set in RAF
      s.style.left = startLeft.toFixed(2) + "%";
      s.style.top = startTop.toFixed(2) + "%";
      x = targetLeft.toFixed(2) + "%";
      y = targetTop.toFixed(2) + "%";
    } else {
      // Forward spawns start in-place at their target
      x = (rng() * 100).toFixed(2) + "%";
      y = (rng() * 100).toFixed(2) + "%";
      s.style.left = x;
      s.style.top = y;
    }
    // Assign final target positions as CSS vars (used in RAF transition)
    s.style.setProperty("--x", x);
    s.style.setProperty("--y", y);
    frag.appendChild(s);
  }
  sky.appendChild(frag);
  // Let layout apply, then trigger transition to normal
  requestAnimationFrame(() => {
    sky
      .querySelectorAll(".star.warp-in-start, .star.warp-in-big-start")
      .forEach((s) => {
        // Only transition the newly added ones (they still have warp-in-start)
        if (s.classList.contains("warp-in-big-start")) {
          // Move from edge to target position while fading/scaling
          const x = s.style.getPropertyValue("--x") || s.style.left;
          const y = s.style.getPropertyValue("--y") || s.style.top;
          // Set final left/top, CSS will animate due to warp-in-moving class
          s.style.left = x;
          s.style.top = y;
        }
        s.classList.add("warp-in");
        s.addEventListener(
          "transitionend",
          () => {
            s.classList.remove(
              "warp-in-start",
              "warp-in-big-start",
              "warp-in",
              "warp-in-moving"
            );
          },
          { once: true }
        );
      });
  });
  // Setup flicker on the newly spawned stars as well; delay for 'front' so
  // the initial fade-in isn't interrupted by flicker opacity changes
  if (variant === "front") {
    setTimeout(() => startStarFlicker(sky), 900);
  } else {
    startStarFlicker(sky);
  }
}

function warpStars(mode = "forward") {
  const sky = q("#sky");
  if (!sky) return;
  const stars = Array.from(sky.querySelectorAll(".star"));
  if (!stars.length) return;
  // Stop current flicker to avoid fighting opacity transitions
  clearStarFlicker(sky);
  const rng = Math.random;
  stars.forEach((s) => {
    const { vx, vy } = computeDirectionFromCenter(sky, s);
    if (mode === "backward") {
      // Shrink in-place to 0 and fade out
      s.style.setProperty("--vx", String(vx));
      s.style.setProperty("--vy", String(vy));
      s.style.setProperty("--dr", "0px");
      s.style.setProperty("--scl", "0");
      s.classList.add("warp-back");
    } else {
      // Fly outward and scale up
      const dr = 160 + rng() * 240;
      const scl = 2.0 + rng() * 1.6;
      s.style.setProperty("--vx", String(vx));
      s.style.setProperty("--vy", String(vy));
      s.style.setProperty("--dr", dr + "px");
      s.style.setProperty("--scl", String(scl));
    }
    s.classList.add("warp-out");
    s.addEventListener(
      "transitionend",
      () => {
        s.classList.remove("warp-back");
        s.remove();
      },
      { once: true }
    );
  });
  // Spawn replacements from the opposite depth
  const spawnVariant = mode === "backward" ? "front" : "behind";
  // Always spawn the fixed number to keep the count stable
  spawnStars(sky, STAR_COUNT, spawnVariant);
}
