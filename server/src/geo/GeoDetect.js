/**
 * GeoDetect — lightweight continent detection from IP addresses or request headers.
 *
 * Used to set an `intercontinental` hint when two peers are on different continents.
 * This is a best-effort optimization hint — never a security signal.
 *
 * Detection priority:
 *   1. Cloudflare `CF-IPCountry` header (free, no dependency, production-accurate)
 *   2. `X-Vercel-IP-Country` / `X-Real-IP-Country` (Vercel, Railway, etc.)
 *   3. Fallback: null (unknown region — no hint set, ICE runs without filtering)
 *
 * Continent mapping is deliberately coarse (6 buckets) to keep the implementation
 * tiny and avoid pulling in a full GeoIP database.
 */

// ISO 3166-1 alpha-2 → continent code. This list covers ~98% of real traffic.
// Missing countries resolve to null (unknown), which is safe — no hint is set.
const COUNTRY_TO_CONTINENT = {
    // North America
    US: 'NA', CA: 'NA', MX: 'NA',
    // South America
    BR: 'SA', AR: 'SA', CL: 'SA', CO: 'SA', PE: 'SA', VE: 'SA', EC: 'SA', UY: 'SA',
    // Europe
    GB: 'EU', DE: 'EU', FR: 'EU', IT: 'EU', ES: 'EU', NL: 'EU', SE: 'EU', NO: 'EU',
    CH: 'EU', AT: 'EU', BE: 'EU', DK: 'EU', FI: 'EU', IE: 'EU', PT: 'EU', PL: 'EU',
    CZ: 'EU', RO: 'EU', HU: 'EU', GR: 'EU', UA: 'EU', BG: 'EU', HR: 'EU', SK: 'EU',
    LT: 'EU', LV: 'EU', EE: 'EU', SI: 'EU', LU: 'EU', IS: 'EU', RS: 'EU', BA: 'EU',
    // Asia
    IN: 'AS', CN: 'AS', JP: 'AS', KR: 'AS', SG: 'AS', TW: 'AS', HK: 'AS', TH: 'AS',
    VN: 'AS', MY: 'AS', PH: 'AS', ID: 'AS', PK: 'AS', BD: 'AS', LK: 'AS', NP: 'AS',
    MM: 'AS', KH: 'AS', LA: 'AS', MN: 'AS', KZ: 'AS', UZ: 'AS',
    // Middle East (counted as AS for continent purposes)
    AE: 'AS', SA: 'AS', IL: 'AS', TR: 'AS', QA: 'AS', KW: 'AS', BH: 'AS', OM: 'AS',
    IR: 'AS', IQ: 'AS', JO: 'AS', LB: 'AS',
    // Africa
    ZA: 'AF', NG: 'AF', EG: 'AF', KE: 'AF', GH: 'AF', TZ: 'AF', ET: 'AF', MA: 'AF',
    DZ: 'AF', TN: 'AF', UG: 'AF', SN: 'AF', CI: 'AF', CM: 'AF', MZ: 'AF', ZW: 'AF',
    // Oceania
    AU: 'OC', NZ: 'OC', FJ: 'OC', PG: 'OC',
};

/**
 * Extract the ISO country code from request headers.
 * @param {import('http').IncomingMessage | {headers: object}} req
 * @returns {string|null} ISO 3166-1 alpha-2 country code, or null
 */
export function countryFromHeaders(req) {
    const headers = req?.headers || {};
    // Cloudflare (most common production setup)
    const cf = headers['cf-ipcountry'];
    if (cf && cf !== 'XX' && cf !== 'T1') return cf.toUpperCase();
    // Vercel / Railway / generic reverse proxy
    const vercel = headers['x-vercel-ip-country'] || headers['x-real-ip-country'];
    if (vercel) return vercel.toUpperCase();
    return null;
}

/**
 * Map a country code to its continent.
 * @param {string|null} countryCode
 * @returns {string|null} continent code (NA, SA, EU, AS, AF, OC) or null
 */
export function continentFromCountry(countryCode) {
    if (!countryCode) return null;
    return COUNTRY_TO_CONTINENT[countryCode.toUpperCase()] || null;
}

/**
 * Determine whether two peers are on different continents.
 * @param {string|null} countryA
 * @param {string|null} countryB
 * @returns {boolean|null} true = different continents, false = same, null = unknown
 */
export function isIntercontinental(countryA, countryB) {
    const a = continentFromCountry(countryA);
    const b = continentFromCountry(countryB);
    if (!a || !b) return null; // can't determine
    return a !== b;
}
