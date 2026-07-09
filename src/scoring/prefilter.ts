/**
 * Stage 1 of scoring: deterministic, free hard filters. Kills obvious non-fits
 * before we spend any tokens. Returns a reason when a job is filtered out, or
 * null when it passes to the LLM stage.
 */
import type { JobPosting } from "../types/index.js";

export interface CandidateProfile {
  preferences: {
    remote: string[];
    locations: string[];
    minSalary: number;
    salaryCurrency: string;
    seniority: string[];
    mustHaveKeywords: string[];
    excludeKeywords: string[];
    excludeCompanies: string[];
  };
  workAuthorization: { authorizedIn: string[]; requiresSponsorship: boolean };
  [k: string]: unknown;
}

export function prefilter(job: JobPosting, profile: CandidateProfile): string | null {
  const p = profile.preferences;
  const hay = `${job.title} ${job.description} ${job.location ?? ""}`.toLowerCase();

  if (p.excludeCompanies.some((c) => job.company.toLowerCase() === c.toLowerCase())) {
    return `excluded company: ${job.company}`;
  }
  for (const kw of p.excludeKeywords) {
    if (hay.includes(kw.toLowerCase())) return `contains excluded keyword: ${kw}`;
  }
  for (const kw of p.mustHaveKeywords) {
    if (!hay.includes(kw.toLowerCase())) return `missing must-have keyword: ${kw}`;
  }

  // Location eligibility: reject postings whose stated location clearly names
  // somewhere the candidate can't work and nowhere they can. Conservative on
  // purpose — vague locations ("Hybrid", "Remote") pass through to the LLM.
  const locReason = locationExcluded(job.location, profile);
  if (locReason) return locReason;

  // Remote preference: only filter when the posting is clearly a mismatch.
  if (job.remote === "onsite" && !p.remote.includes("onsite")) {
    const locationOk = p.locations.some((loc) =>
      (job.location ?? "").toLowerCase().includes(loc.toLowerCase()),
    );
    if (!locationOk) return `onsite role outside preferred locations`;
  }

  // Salary floor: only filter if the posting states a max BELOW the floor and
  // currencies match. Missing comp is NOT a reason to reject (most don't list it).
  if (
    job.compensation?.max != null &&
    job.compensation.currency === p.salaryCurrency &&
    job.compensation.max < p.minSalary
  ) {
    return `max comp ${job.compensation.max} below floor ${p.minSalary}`;
  }

  return null;
}

// Signals that a location string names a specific market. US state codes are
// matched case-sensitively after a comma ("Foster City, CA", "Remote, TX");
// none collide with Canadian province codes (ON, QC, BC, AB, MB, SK, NS, NB,
// PE, NL, YT, NT, NU are all absent from the US list except CA-the-state,
// which Canadian addresses never use — they write the country name).
const US_STATE_AFTER_COMMA =
  /,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;

const FOREIGN_MARKET_TOKENS = [
  "united states", "u.s.", "usa",
  "india", "bangalore", "bengaluru", "pune", "hyderabad", "chennai", "mumbai", "delhi",
  "united kingdom", "england", "scotland", "ireland",
  "germany", "france", "netherlands", "spain", "portugal", "italy", "poland",
  "romania", "hungary", "czech", "austria", "belgium", "switzerland",
  "denmark", "sweden", "norway", "finland", "estonia", "greece", "turkey",
  "japan", "china", "korea", "taiwan", "hong kong", "singapore", "malaysia",
  "indonesia", "vietnam", "thailand", "philippines",
  "australia", "new zealand",
  "brazil", "mexico", "colombia", "argentina", "chile", "peru",
  "uae", "dubai", "saudi", "israel", "egypt", "nigeria", "kenya", "south africa",
  "pakistan", "bangladesh", "sri lanka",
  "emea", "apac", "latam", "europe",
  // Unambiguous US city/metro names that often appear without a state code.
  // (Deliberately omits names shared with Canadian cities, e.g. London.)
  "new york", "nyc", "san francisco", "bay area", "palo alto", "mountain view",
  "foster city", "seattle", "boston", "chicago", "austin", "denver", "atlanta",
  "los angeles", "washington dc", "d.c.",
];

/** Words that always count as "somewhere the candidate can work". */
const UNIVERSAL_PASS_TOKENS = ["global", "worldwide", "anywhere", "americas"];

/**
 * Returns a filter reason when `location` names at least one specific market,
 * none of which the candidate is authorized in / prefers. Null/vague locations
 * pass. Pass tokens are derived from the profile, so this works for any user.
 */
export function locationExcluded(
  location: string | null,
  profile: CandidateProfile,
): string | null {
  if (!location) return null;
  const loc = location.toLowerCase();

  // Meaningful words from preferred locations + authorized countries
  // ("Remote - Canada" contributes "canada", "Toronto" contributes "toronto").
  const passTokens = new Set(UNIVERSAL_PASS_TOKENS);
  for (const src of [...profile.preferences.locations, ...profile.workAuthorization.authorizedIn]) {
    for (const word of src.toLowerCase().split(/[^a-z]+/)) {
      if (word.length >= 4 && !["remote", "hybrid", "onsite"].includes(word)) passTokens.add(word);
    }
  }
  for (const token of passTokens) {
    if (loc.includes(token)) return null;
  }

  const named =
    US_STATE_AFTER_COMMA.test(location) ||
    /\bus\b/.test(loc) ||
    FOREIGN_MARKET_TOKENS.some((t) => loc.includes(t));
  if (named) {
    return `location "${location}" excludes candidate markets (${profile.workAuthorization.authorizedIn.join(", ")})`;
  }
  return null;
}
