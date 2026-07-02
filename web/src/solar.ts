// solar.ts — offline solar-position math (the standard NOAA algorithm,
// ~45 lines, zero deps). Golden Hour reads only the device's own clock plus a
// once-configured lat/lon — no cloud, no GPS, no weather API. Pure functions
// so the math can be sanity-checked with plain node against the NOAA tables.
const RAD = Math.PI / 180;

/** Sun elevation above the horizon (degrees; refraction ignored, fine for a
 *  lighting ramp) at `date` for latitude/longitude in degrees (+N / +E). */
export function solarElevationDeg(date: Date, lat: number, lon: number): number {
  const t = (date.getTime() / 86400000 + 2440587.5 - 2451545) / 36525; // Julian centuries since J2000
  const L = norm(280.46646 + t * (36000.76983 + 0.0003032 * t), 360); // geometric mean longitude (deg)
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t); // mean anomaly (deg)
  const ecc = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const C =
    Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * M * RAD) * 0.000289; // equation of centre (deg)
  const omega = 125.04 - 1934.136 * t;
  const appLon = L + C - 0.00569 - 0.00478 * Math.sin(omega * RAD); // apparent longitude (deg)
  const e0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = e0 + 0.00256 * Math.cos(omega * RAD); // corrected obliquity (deg)
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(appLon * RAD)); // declination (rad)
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTimeMin =
    (4 / RAD) *
    (y * Math.sin(2 * L * RAD) -
      2 * ecc * Math.sin(M * RAD) +
      4 * ecc * y * Math.sin(M * RAD) * Math.cos(2 * L * RAD) -
      0.5 * y * y * Math.sin(4 * L * RAD) -
      1.25 * ecc * ecc * Math.sin(2 * M * RAD)); // equation of time (min)
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarMin = norm(utcMin + eqTimeMin + 4 * lon, 1440);
  const haDeg = trueSolarMin / 4 - 180; // hour angle (0 = solar noon)
  return (
    Math.asin(
      Math.sin(lat * RAD) * Math.sin(decl) +
        Math.cos(lat * RAD) * Math.cos(decl) * Math.cos(haDeg * RAD),
    ) / RAD
  );
}

function norm(v: number, m: number): number {
  return ((v % m) + m) % m;
}
