/**
 * Maps the candidate profile to form-field values, and — critically — decides when
 * NOT to guess. Any required field we can't fill confidently returns a
 * `needsHuman` signal so the pipeline pauses instead of submitting junk.
 */
export interface ApplicantFields {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  /** Street-level mailing address, for ATSes that require one (Workable, JazzHR). */
  address?: { street: string; city: string; region: string; postal: string };
  /** Country of work authorization, e.g. "Canada". */
  country: string;
  requiresSponsorship: boolean;
  linkedin?: string;
  portfolio?: string;
  github?: string;
  // Common free-text questions we have canned answers for:
  answers: Record<string, string>;
  // Per-job, human-approved answers (e.g. essay questions): first label
  // substring match wins, checked before every generic rule.
  custom?: { match: string; value: string }[];
  // EEO self-identification values the user chose to store (profile.eeo);
  // absent keys stay in `unknown` so the bot asks instead of guessing.
  eeo: Record<string, string>;
  // Fields we deliberately leave for the human (null in profile → ask):
  unknown: string[];
}

interface Profile {
  identity: {
    fullName: string;
    email: string;
    phone: string;
    location: string;
    address?: { street: string; city: string; region: string; postal: string } | null;
    links: { linkedin?: string | null; portfolio?: string | null; github?: string | null };
  };
  workAuthorization?: { authorizedIn?: string[]; requiresSponsorship?: boolean };
  commonAnswers: Record<string, unknown>;
  eeo: Record<string, unknown>;
}

export function buildFields(profile: Profile): ApplicantFields {
  const [firstName, ...rest] = profile.identity.fullName.split(" ");
  const unknown: string[] = [];
  // EEO questions left null in the profile → the bot must ask, never guess.
  for (const [k, v] of Object.entries(profile.eeo)) {
    if (k !== "note" && (v === null || v === undefined)) unknown.push(`eeo.${k}`);
  }
  return {
    fullName: profile.identity.fullName,
    firstName: firstName ?? "",
    lastName: rest.join(" "),
    email: profile.identity.email,
    phone: profile.identity.phone,
    location: profile.identity.location,
    address: profile.identity.address ?? undefined,
    country: profile.workAuthorization?.authorizedIn?.[0] ?? "",
    requiresSponsorship: profile.workAuthorization?.requiresSponsorship ?? true,
    linkedin: profile.identity.links.linkedin ?? undefined,
    portfolio: profile.identity.links.portfolio ?? undefined,
    github: profile.identity.links.github ?? undefined,
    answers: Object.fromEntries(
      Object.entries(profile.commonAnswers).map(([k, v]) => [k, String(v)]),
    ),
    eeo: Object.fromEntries(
      Object.entries(profile.eeo).filter(([k, v]) => k !== "note" && v != null).map(([k, v]) => [k, String(v)]),
    ),
    unknown,
  };
}

/**
 * Given a required-field label we don't recognise, decide if we can answer it.
 * Returns the answer string, or null meaning "pause for human".
 */
/** Province/state dropdowns list full names; a two-letter code like "ON" would
 *  otherwise substring-match the wrong option ("ON" → "ArizONa"). */
const REGION_NAMES: Record<string, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories",
  NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec",
  SK: "Saskatchewan", YT: "Yukon",
};
function expandRegionCode(region: string | undefined): string | undefined {
  if (!region) return region;
  return REGION_NAMES[region.trim().toUpperCase()] ?? region;
}

export function answerFor(label: string, fields: ApplicantFields): string | null {
  const l = label.toLowerCase();
  const country = fields.country.toLowerCase();

  // Human-approved per-job answers take precedence over every generic rule.
  for (const c of fields.custom ?? []) {
    if (l.includes(c.match.toLowerCase())) return c.value;
  }
  if (/first name/.test(l)) return fields.firstName;
  if (/last name/.test(l)) return fields.lastName;
  if (/full name|^name$/.test(l)) return fields.fullName;
  if (/email/.test(l)) return fields.email;
  if (/phone/.test(l)) return fields.phone;
  if (/linkedin/.test(l)) return fields.linkedin ?? null;
  if (/github/.test(l)) return fields.github ?? null;
  if (/portfolio|website/.test(l)) return fields.portfolio ?? null;

  // Work authorization / sponsorship. Only answer when we can do so truthfully:
  // sponsorship questions get a direct answer; "authorized/located in X" only
  // when X is the candidate's own country — anything else stays with the human.
  // Positive phrasing ("do you have the legal right / are you authorized to
  // work ... without sponsorship?") must be checked before the bare /sponsor/
  // rule: the word "sponsorship" inside it would otherwise invert the answer.
  if (/(legal(ly)?\s*right|right to work|authori[sz]ed to work|eligible to work)/.test(l)) {
    return fields.requiresSponsorship ? "No" : "Yes";
  }
  if (/sponsor/.test(l)) return fields.requiresSponsorship ? "Yes" : "No";
  if (country && new RegExp(`(authori[sz](ed|ation)|legal(ly)? .*work|located|resid|living|relocat).*${country}`).test(l)) {
    return "Yes";
  }
  if (/\bcountry\b/.test(l)) return fields.country || null;

  // Prior-relationship / restrictions boilerplate — driven by profile answers.
  if (/(previously|ever) (worked|been employed)|consulted for/.test(l)) {
    return fields.answers.previouslyWorkedHere ?? null;
  }
  if (/employment agreement|post-employment restriction|non-?compete/.test(l)) {
    return fields.answers.employmentRestrictions ?? null;
  }

  // Mailing-address fields (Workable/JazzHR require the full block). Only
  // answered when the profile carries a street address — never derived.
  if (/address (line )?1|street address|^address\b/.test(l)) return fields.address?.street ?? null;
  if (/postal|zip/.test(l)) return fields.address?.postal ?? null;
  if (/province|\bstate\b/.test(l)) return expandRegionCode(fields.address?.region) ?? null;

  // Word-bounded: a bare /city/ also matches "ethni-city" and leaks the
  // candidate's location into EEO demographic selects.
  if (/\bcity\b/.test(l)) return fields.address?.city ?? fields.location;
  if (/\blocation\b/.test(l)) return fields.location;
  // EEO self-identification: answered only from values the user explicitly
  // stored in profile.eeo. Values are phrased for word-boundary option
  // matching, so an ATS whose option list phrases things differently falls
  // back to unresolved (ask the human) rather than picking a wrong option.
  if (/gender identit|which gender/.test(l)) return fields.eeo.gender ?? null;
  // Word-bounded: a bare /race/ also matches "embrace" ("we embrace
  // automation…") and leaks the EEO race value into consent questions.
  if (/\brace\b|ethnicit/.test(l)) return fields.eeo.race ?? null;
  // Self-identification phrasing only: text inputs get answerFor values typed
  // in verbatim, so a broad /disability/ would paste the self-ID sentence into
  // accommodation-request textareas ("describe any disability-related needs").
  if (/protected veteran|veteran status/.test(l)) return fields.eeo.veteranStatus ?? null;
  if (/disability status|have a disability/.test(l)) return fields.eeo.disabilityStatus ?? null;
  if (/notice period/.test(l)) return fields.answers.noticePeriod ?? null;
  if (/how did you hear/.test(l)) return fields.answers.howDidYouHear ?? null;
  if (/salary|compensation expectation/.test(l)) return fields.answers.desiredSalary ?? null;
  // Anything genuinely open-ended ("why do you want to work here") → human/cover letter.
  return null;
}
