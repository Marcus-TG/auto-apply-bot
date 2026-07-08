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
  linkedin?: string;
  portfolio?: string;
  // Common free-text questions we have canned answers for:
  answers: Record<string, string>;
  // Fields we deliberately leave for the human (null in profile → ask):
  unknown: string[];
}

interface Profile {
  identity: {
    fullName: string;
    email: string;
    phone: string;
    location: string;
    links: { linkedin?: string | null; portfolio?: string | null };
  };
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
    linkedin: profile.identity.links.linkedin ?? undefined,
    portfolio: profile.identity.links.portfolio ?? undefined,
    answers: Object.fromEntries(
      Object.entries(profile.commonAnswers).map(([k, v]) => [k, String(v)]),
    ),
    unknown,
  };
}

/**
 * Given a required-field label we don't recognise, decide if we can answer it.
 * Returns the answer string, or null meaning "pause for human".
 */
export function answerFor(label: string, fields: ApplicantFields): string | null {
  const l = label.toLowerCase();
  if (/first name/.test(l)) return fields.firstName;
  if (/last name/.test(l)) return fields.lastName;
  if (/full name|^name$/.test(l)) return fields.fullName;
  if (/email/.test(l)) return fields.email;
  if (/phone/.test(l)) return fields.phone;
  if (/linkedin/.test(l)) return fields.linkedin ?? null;
  if (/portfolio|website/.test(l)) return fields.portfolio ?? null;
  if (/location|city/.test(l)) return fields.location;
  if (/notice period/.test(l)) return fields.answers.noticePeriod ?? null;
  if (/how did you hear/.test(l)) return fields.answers.howDidYouHear ?? null;
  if (/salary|compensation expectation/.test(l)) return fields.answers.desiredSalary ?? null;
  // Anything genuinely open-ended ("why do you want to work here") → human/cover letter.
  return null;
}
