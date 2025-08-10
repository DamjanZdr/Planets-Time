// Minimal solar position + sunrise/sunset calculations (NOAA approximation)
// References:
// - NOAA Solar Calculator equations (simplified)
// - All times in UTC internally; format for local time via Intl.DateTimeFormat

export function toJulian(date) {
  // date is JS Date in UTC
  return date / 86400000 - 0.5 + 2440587.5;
}

function toDays(date) {
  return toJulian(date) - 2451545.0;
}

const rad = Math.PI / 180;
const deg = 180 / Math.PI;

function sin(x) {
  return Math.sin(x);
}
function cos(x) {
  return Math.cos(x);
}
function tan(x) {
  return Math.tan(x);
}
function asin(x) {
  return Math.asin(x);
}
function atan2(y, x) {
  return Math.atan2(y, x);
}

function frac(x) {
  return x - Math.floor(x);
}

function solarMeanAnomaly(d) {
  return rad * (357.5291 + 0.98560028 * d);
}
function eclipticLongitude(M) {
  const C =
    rad *
    (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = rad * 102.9372; // perihelion of Earth
  return M + C + P + Math.PI;
}
function declination(L) {
  const e = rad * 23.4397; // obliquity
  return Math.asin(Math.sin(e) * Math.sin(L));
}
function rightAscension(L) {
  const e = rad * 23.4397;
  return Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
}

function siderealTime(d, lw) {
  return rad * (280.16 + 360.9856235 * d) - lw;
}

function azAlt(d, lat, lon) {
  const lw = -lon * rad;
  const phi = lat * rad;
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const ra = rightAscension(L);
  const st = siderealTime(d, lw);
  const H = st - ra;
  const altitude = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  );
  const azimuth = Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)
  );
  return { azimuth, altitude, dec, ra };
}

export function solarPosition(date, lat, lon) {
  const d = toDays(date);
  const { azimuth, altitude } = azAlt(d, lat, lon);
  return { azimuth, altitude }; // radians
}

// Hour angle for given altitude
function hourAngle(h, phi, dec) {
  return Math.acos(
    (Math.sin(h) - Math.sin(phi) * Math.sin(dec)) /
      (Math.cos(phi) * Math.cos(dec))
  );
}

// Compute sunrise/sunset and solar noon using simplified equations
export function sunTimes(date, lat, lon) {
  // date local; compute for that civil day: we'll take 12:00 local estimate then back to UTC
  // Use midnight local guess; but JS Date lacks tz of lat/lon; so we use user's local TZ.
  const y = date.getFullYear();
  const m = date.getMonth();
  const d0 = date.getDate();
  const noonLocal = new Date(y, m, d0, 12, 0, 0, 0);
  const d = toDays(noonLocal);

  const lw = -lon * rad;
  const phi = lat * rad;
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  const dec = declination(L);

  const h0 = -0.833 * rad; // standard refraction + solar radius
  let H = hourAngle(h0, phi, dec);
  if (isNaN(H)) {
    // Polar day/night: no rise or no set
    // Determine if Sun is above horizon all day (midnight sun) or below all day.
    const pos = azAlt(d, lat, lon);
    const alwaysUp = pos.altitude > h0;
    return {
      sunrise: null,
      sunset: null,
      solarNoon: null,
      daylight: 0,
      alwaysUp,
      alwaysDown: !alwaysUp,
    };
  }

  const Jtransit = 2451545.0 + d + (lw + rightAscension(L)) / (2 * Math.PI);
  const Jrise = Jtransit - H / (2 * Math.PI);
  const Jset = Jtransit + H / (2 * Math.PI);

  function fromJulian(J) {
    return new Date((J + 0.5 - 2440587.5) * 86400000);
  }
  const sunrise = fromJulian(Jrise);
  const sunset = fromJulian(Jset);
  const solarNoon = fromJulian(Jtransit);
  const daylight = (sunset - sunrise) / 3600000; // hours

  return {
    sunrise,
    sunset,
    solarNoon,
    daylight,
    alwaysUp: false,
    alwaysDown: false,
  };
}

export function formatTime(d) {
  if (!d) return "—";
  // Use user's locale/timezone
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

// --- Illuminance model (clear sky approximation) ---
// Reference midday horizontal illuminance on Earth (clear sky)
export const EARTH_NOON_LUX = 120000; // per spec
// Twilight reference at horizon: empirical value to bridge to twilight (~hundreds of lux)
const TWILIGHT_H0_LUX = 400; // lux at Sun altitude 0° (approx)
// Twilight decay e-fold (degrees): tuned so ~3.4 lux near -6° (civil twilight end)
const TWILIGHT_DECAY_DEG = 1.257; // deg

// Compute approximate global horizontal illuminance (lux) as a function of solar altitude (radians)
export function earthIlluminanceLuxFromAltRad(altRad) {
  const altDeg = altRad * deg;
  if (altDeg >= 0) {
    // Above-horizon: scale with sin(h) and a mild exponent to mimic atmosphere and diffuse light
    const s = Math.max(0, Math.sin(altRad));
    const k = 1.25;
    return EARTH_NOON_LUX * Math.pow(s, k);
  }
  // Twilight: exponential decay with solar depression angle
  return TWILIGHT_H0_LUX * Math.exp(altDeg / TWILIGHT_DECAY_DEG);
}

// Find times during the day when Earth illuminance equals a target lux.
export function findIlluminanceCrossings(date, lat, lon, targetLux) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d0 = date.getDate();
  const start = new Date(y, m, d0, 0, 0, 0, 0);
  const result = [];
  let prevDiff = null;
  let prevT = null;
  for (let minutes = 0; minutes <= 24 * 60; minutes++) {
    const t = new Date(start.getTime() + minutes * 60000);
    const { altitude } = solarPosition(t, lat, lon);
    const E = earthIlluminanceLuxFromAltRad(altitude);
    const diff = E - targetLux;
    if (prevDiff != null && diff === 0) {
      result.push(t);
    } else if (prevDiff != null && diff > 0 !== prevDiff > 0) {
      // crossing; refine by binary search +/- 60s
      let lo = new Date(prevT.getTime());
      let hi = new Date(t.getTime());
      for (let iter = 0; iter < 14; iter++) {
        const mid = new Date((lo.getTime() + hi.getTime()) / 2);
        const a =
          earthIlluminanceLuxFromAltRad(solarPosition(mid, lat, lon).altitude) -
          targetLux;
        const aLo =
          earthIlluminanceLuxFromAltRad(solarPosition(lo, lat, lon).altitude) -
          targetLux;
        if (a > 0 === aLo > 0) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      result.push(new Date((lo.getTime() + hi.getTime()) / 2));
    }
    prevDiff = diff;
    prevT = t;
  }
  return result.slice(0, 2);
}

// Find times during the day when solar altitude crosses a target elevation.
// Returns up to two times (morning/evening). May be none.
export function findElevationCrossings(date, lat, lon, targetDeg) {
  const target = targetDeg * rad;
  // Sample at 1-minute granularity and find zero-crossings of altitude - target.
  const y = date.getFullYear();
  const m = date.getMonth();
  const d0 = date.getDate();
  const start = new Date(y, m, d0, 0, 0, 0, 0);
  const result = [];
  let prevAlt = null;
  let prevT = null;
  for (let minutes = 0; minutes <= 24 * 60; minutes++) {
    const t = new Date(start.getTime() + minutes * 60000);
    const { altitude } = solarPosition(t, lat, lon);
    const diff = altitude - target;
    if (prevAlt !== null && diff === 0) {
      result.push(t);
    } else if (prevAlt !== null && diff > 0 !== prevAlt > 0) {
      // crossing; refine by binary search +/- 60s
      let lo = new Date(prevT.getTime());
      let hi = new Date(t.getTime());
      for (let iter = 0; iter < 14; iter++) {
        // ~1/2^14 ~ 0.06s resolution
        const mid = new Date((lo.getTime() + hi.getTime()) / 2);
        const a = solarPosition(mid, lat, lon).altitude - target;
        if (a > 0 === solarPosition(lo, lat, lon).altitude - target > 0) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      result.push(new Date((lo.getTime() + hi.getTime()) / 2));
    }
    prevAlt = diff;
    prevT = t;
  }
  return result.slice(0, 2);
}

// --- Meeus/NOAA apparent altitude with refraction (degrees) ---
// Fractional year gamma (rad) using UTC time
function fractionalYearGammaUTC(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
  const doy = Math.floor((date - start) / 86400000) + 1; // 1..365/366
  const utcMinutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const H = utcMinutes / 60; // hours
  return ((2 * Math.PI) / 365) * (doy - 1 + (H - 12) / 24);
}

// Equation of time Et (minutes) and solar declination delta (radians)
function equationOfTimeAndDeclination(date) {
  const gamma = fractionalYearGammaUTC(date);
  const sinG = Math.sin(gamma);
  const cosG = Math.cos(gamma);
  const sin2G = Math.sin(2 * gamma);
  const cos2G = Math.cos(2 * gamma);
  const sin3G = Math.sin(3 * gamma);
  const cos3G = Math.cos(3 * gamma);
  const Et =
    229.18 *
    (0.000075 +
      0.001868 * cosG -
      0.032077 * sinG -
      0.014615 * cos2G -
      0.040849 * sin2G);
  const delta =
    0.006918 -
    0.399912 * cosG +
    0.070257 * sinG -
    0.006758 * cos2G +
    0.000907 * sin2G -
    0.002697 * cos3G +
    0.00148 * sin3G;
  return { Et, delta };
}

// NOAA refraction correction R(h) in degrees; input/output degrees
function refractionDeg(hDeg) {
  if (hDeg > 85) return 0;
  if (hDeg > 5) {
    const t = Math.tan(hDeg * rad);
    const invt = 1 / t;
    const invt3 = invt * invt * invt;
    const invt5 = invt3 * invt * invt;
    return (1 / 3600) * (58.1 * invt - 0.07 * invt3 + 0.000086 * invt5);
  }
  if (hDeg > -0.575) {
    const h = hDeg;
    return (
      (1 / 3600) *
      (1735 -
        518.2 * h +
        103.4 * h * h -
        12.79 * h * h * h +
        0.711 * h * h * h * h)
    );
  }
  // Below -0.575°
  return (1 / 3600) * (-20.774 / Math.tan(hDeg * rad));
}

// Apparent solar altitude (degrees) using Meeus/NOAA TST + refraction
export function solarApparentAltitudeDeg(date, latDeg, lonDegEast) {
  // True solar time minutes
  const utcMinutes =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const { Et, delta } = equationOfTimeAndDeclination(date);
  const TST = utcMinutes + Et + 4 * lonDegEast; // lon east positive
  const omegaDeg = TST / 4 - 180; // hour angle in degrees
  const phi = latDeg * rad;
  const omega = omegaDeg * rad;
  // True (geometric) altitude
  const cosz =
    Math.sin(phi) * Math.sin(delta) +
    Math.cos(phi) * Math.cos(delta) * Math.cos(omega);
  const z = Math.acos(Math.max(-1, Math.min(1, cosz)));
  const hTrueDeg = 90 - z * deg;
  // Apparent altitude
  return hTrueDeg + refractionDeg(hTrueDeg);
}

// Invert our illuminance model to an equivalent Earth Sun altitude (degrees)
export function illuminanceToAltitudeDeg(targetLux) {
  if (targetLux == null || !isFinite(targetLux)) return null;
  if (targetLux <= 0) return -90; // dark limit
  if (targetLux < TWILIGHT_H0_LUX) {
    // Twilight branch: E = TWILIGHT_H0_LUX * exp(hDeg / TWILIGHT_DECAY_DEG)
    return TWILIGHT_DECAY_DEG * Math.log(targetLux / TWILIGHT_H0_LUX);
  }
  // Daytime branch: E = EARTH_NOON_LUX * sin(h)^k
  const k = 1.25;
  const ratio = Math.min(1, targetLux / EARTH_NOON_LUX);
  const s = Math.pow(ratio, 1 / k);
  const h = Math.asin(Math.max(0, Math.min(1, s)));
  return h * deg;
}

// Find times during the day when apparent altitude equals a target (deg)
export function findApparentAltitudeCrossings(
  date,
  latDeg,
  lonDegEast,
  targetDeg
) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d0 = date.getDate();
  const start = new Date(y, m, d0, 0, 0, 0, 0);
  const result = [];
  let prev = null;
  let prevT = null;
  for (let minutes = 0; minutes <= 24 * 60; minutes++) {
    const t = new Date(start.getTime() + minutes * 60000);
    const h = solarApparentAltitudeDeg(t, latDeg, lonDegEast) - targetDeg;
    if (prev != null) {
      if (h === 0) result.push(t);
      else if (h > 0 !== prev > 0) {
        // crossing between prevT and t; bisection to ~0.1s
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 20; i++) {
          const mid = new Date((lo.getTime() + hi.getTime()) / 2);
          const hm =
            solarApparentAltitudeDeg(mid, latDeg, lonDegEast) - targetDeg;
          const hlo =
            solarApparentAltitudeDeg(lo, latDeg, lonDegEast) - targetDeg;
          if (hm > 0 === hlo > 0) lo = mid;
          else hi = mid;
        }
        result.push(new Date((lo.getTime() + hi.getTime()) / 2));
        if (result.length >= 2) break;
      }
    }
    prev = h;
    prevT = t;
  }
  return result;
}
