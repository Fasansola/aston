/**
 * lib/social/persona.ts
 * Single source of truth for the on-camera presenter and firm facts used by the
 * social studio's generators. Keeping these here means the reel scripts, captions
 * and any future generators all describe Aston VIP identically.
 *
 * (lib/heygen.ts still carries its own inline copy for the long-form YouTube
 * pipeline; worth centralising on this file when that pipeline is next touched.)
 */

export const PRESENTER = {
  name: "Jim",
  role: "Senior Investment Advisor at Aston VIP",
  bio: [
    "Jim has spent over 12 years in international corporate advisory, working with entrepreneurs,",
    "investors and business groups to structure their companies correctly across multiple jurisdictions.",
    "Based between London and Dubai, he has advised clients from over 60 countries. His speciality is",
    "making sure company formation, banking access and tax positioning are aligned before a single",
    "document is signed.",
  ].join(" "),
} as const;

export const FIRM = {
  name: "Aston VIP",
  site: "aston.ae",
  bio: [
    "Aston VIP is a full-service international corporate advisory firm helping entrepreneurs, investors",
    "and business groups with business setup, international company formation, cross-border group",
    "structuring, regulatory licensing, corporate banking, international tax advisory, nominee services",
    "and offshore vehicles. 19+ jurisdictions. Offices in London and Dubai.",
  ].join(" "),
} as const;

/** Persona preamble shared by every social-studio generator. */
export const PERSONA_BLOCK = `═══ WHO ${PRESENTER.name.toUpperCase()} IS ═══
${PRESENTER.bio}

═══ WHO ${FIRM.name.toUpperCase()} IS ═══
${FIRM.bio} Website: ${FIRM.site}.`;

/**
 * Compliance guardrails for a regulated advisory firm. Applied to every piece of
 * generated social content — the reputational cost of an invented tax figure is
 * far higher than the value of a punchier line.
 */
export const COMPLIANCE_BLOCK = `═══ COMPLIANCE (NON-NEGOTIABLE) ═══
- Educational framing only. Never give personalised financial, tax or legal advice.
- Never invent or state a specific tax rate, threshold, fee, deadline or statistic unless it is given to you in the brief. Speak in general terms instead ("in many cases", "depending on your structure").
- No guarantees or promises of outcomes ("you WILL get approved" is forbidden).
- Never name real clients or identifiable details.`;
