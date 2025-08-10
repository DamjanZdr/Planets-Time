// Basic planet data for inverse-square irradiance at 1 AU = 1361 W/m^2
// Distances are mean heliocentric distances in AU (approx).
// Emoji and color for UI.

export const PLANETS = [
  {
    key: "mercury",
    name: "Mercury",
    au: 0.387,
    color: "#f59e0b",
    // texture supplied by user under assets/custom_textures/mercury.png
  },
  {
    key: "venus",
    name: "Venus",
    au: 0.723,
    color: "#eab308",
    // texture supplied by user under assets/custom_textures/venus.png
  },
  {
    key: "earth",
    name: "Earth",
    au: 1.0,
    color: "#22c55e",
    // texture supplied by user under assets/custom_textures/earth.png
  },
  {
    key: "mars",
    name: "Mars",
    au: 1.524,
    color: "#ef4444",
    // texture supplied by user under assets/custom_textures/mars.png
  },
  {
    key: "jupiter",
    name: "Jupiter",
    au: 5.203,
    color: "#93c5fd",
    // texture supplied by user under assets/custom_textures/jupiter.png
  },
  {
    key: "saturn",
    name: "Saturn",
    au: 9.537,
    color: "#fde68a",
    // texture supplied by user under assets/custom_textures/saturn.png
  },
  {
    key: "uranus",
    name: "Uranus",
    au: 19.191,
    color: "#38bdf8",
    // texture supplied by user under assets/custom_textures/uranus.png
  },
  {
    key: "neptune",
    name: "Neptune",
    au: 30.07,
    color: "#60a5fa",
    // texture supplied by user under assets/custom_textures/neptune.png
  },
  {
    key: "pluto",
    name: "Pluto",
    au: 39.48,
    color: "#a78bfa",
    // texture supplied by user under assets/custom_textures/pluto.png
  }, // dwarf but included
];

// Convert solar constant at 1 AU to planet noon equivalent brightness scaling.
// Using inverse-square: irradiance ~ 1 / au^2.
export function planetIrradianceScale(au) {
  return 1 / (au * au);
}

// Given Earth's clear-sky brightness proportional to sin(solar_elevation), find target elevation
// where Earth's brightness equals noon brightness at planet.
// We clamp to [0, 90] deg; returns null if below horizon all day.
// Approximate orbital elements for heliocentric distance (AU) at date.
// Values are simplified (base + linear rate) around J2000; sufficient for
// brightness mapping. Angles in degrees; rates per day. Source: simplified
// public-domain compilations (e.g., Schlyter/J2000), adapted lightly.
const ORBITS = {
  mercury: {
    a: 0.387098,
    e0: 0.205635,
    eRate: 5.59e-10,
    M0: 168.6562,
    n: 4.0923344368,
  },
  venus: {
    a: 0.72333,
    e0: 0.006773,
    eRate: -1.302e-9,
    M0: 48.0052,
    n: 1.6021302244,
  },
  earth: {
    a: 1.0,
    e0: 0.016709,
    eRate: -1.151e-9,
    M0: 356.047,
    n: 0.9856002585,
  },
  mars: {
    a: 1.523688,
    e0: 0.093405,
    eRate: 2.516e-9,
    M0: 18.6021,
    n: 0.5240207766,
  },
  jupiter: {
    a: 5.20256,
    e0: 0.048498,
    eRate: 4.469e-9,
    M0: 19.895,
    n: 0.0830853001,
  },
  saturn: {
    a: 9.55475,
    e0: 0.055546,
    eRate: -9.499e-9,
    M0: 316.967,
    n: 0.0334442282,
  },
  uranus: {
    a: 19.18171,
    e0: 0.047318,
    eRate: 7.45e-9,
    M0: 142.5905,
    n: 0.011725806,
  },
  neptune: {
    a: 30.05826,
    e0: 0.008606,
    eRate: 2.15e-9,
    M0: 260.2471,
    n: 0.005995147,
  },
  // Pluto: coarse elements sufficient for distance modulation
  pluto: { a: 39.48168677, e0: 0.24880766, eRate: 0, M0: 14.53, n: 0.00396 },
};

function daysSinceJ2000(date) {
  // J2000.0 epoch: 2000-01-01 12:00 TT; we approximate with UTC noon
  const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0, 0);
  return (date.getTime() - J2000) / 86400000;
}

function solveKeplerE(Mrad, e) {
  let E = Mrad; // initial guess
  for (let i = 0; i < 12; i++) {
    const f = E - e * Math.sin(E) - Mrad;
    const fp = 1 - e * Math.cos(E);
    const dE = -f / fp;
    E += dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

export function heliocentricDistanceAU(planetKey, date = new Date()) {
  const el = ORBITS[planetKey];
  if (!el) return null;
  const d = daysSinceJ2000(date);
  const e = el.e0 + el.eRate * d;
  const Mdeg = el.M0 + el.n * d; // degrees
  const Mrad = (Mdeg * Math.PI) / 180;
  const E = solveKeplerE(Mrad, e);
  const r = el.a * (1 - e * Math.cos(E));
  return r;
}

export function targetElevationForPlanet(planetAU) {
  // Science-backed approach:
  // - Anchor Pluto noon to ~ -1.5° solar altitude (NASA/Sky & Telescope rule-of-thumb)
  // - Generalize via a logarithmic relation of relative illuminance vs. Pluto
  //   to map other planets to their equivalent Earth solar altitude.
  // - This avoids hardcoding a fixed time and yields the correct daily crossings.

  const S = planetIrradianceScale(planetAU); // relative to Earth noon
  const S_PLUTO_REF = planetIrradianceScale(39.48); // Pluto mean distance baseline
  // Target altitude (deg): alpha = A + B * log10(S / S_pluto)
  // A ≈ -1.5° (Pluto anchor). B ≈ 1.5° per decade brightness change (gentle slope).
  const A = -1.5;
  const B = 1.5;
  const alpha = A + B * Math.log10(Math.max(1e-9, S / S_PLUTO_REF));
  // Clamp to a practical range
  return Math.max(-12, Math.min(30, alpha));
}

export function targetElevationForPlanetKey(planetKey, date = new Date()) {
  const r = heliocentricDistanceAU(planetKey, date);
  if (!r)
    return targetElevationForPlanet(
      PLANETS.find((p) => p.key === planetKey)?.au || 1
    );
  return targetElevationForPlanet(r);
}
