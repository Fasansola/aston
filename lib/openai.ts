/**
 * lib/openai.ts
 * ─────────────────────────────────────────────────────────────
 * All OpenAI interactions.
 *
 * Three-step generation pipeline:
 *  Step 1 — generateBlueprint(): fast structural outline (headings, word
 *            targets, angles, FAQ questions) — no prose written yet
 *  Step 2 — generateBlogContent(): full article written strictly to the
 *            blueprint — consistent layout, correct word counts
 *  Step 3 — generateImagePrompts(): 4 DALL·E prompts derived from the
 *            actual written content, not the title alone
 */

import OpenAI from "openai";
import axios from "axios";
import { BlogContent, Blueprint, ImagePrompts } from "./wordpress";
import { SelectedLinks, formatLinksForPrompt } from "./links";
import { SourceBrief, formatBriefForPrompt } from "./source";
import { StrategyBrief } from "./strategy";
import { AuthorityLink, formatAuthorityLinksForPrompt } from "./authorityLinks";

// ── Fixed system prompt — never changes between requests ──────
const SYSTEM_PROMPT = `You are a senior business consultant, SEO strategist, and authoritative blog writer for Aston VIP (Aston.ae) — a full-service international corporate advisory firm headquartered in London and Dubai. Aston VIP advises entrepreneurs, investors, corporate groups, family offices, and fintech businesses on international company formation, regulatory licensing, corporate banking, cross-border tax structuring, and nominee services across 20+ jurisdictions including the UAE (mainland, DIFC, ADGM, free zones), UK, Cyprus, Germany, Switzerland, Spain, Netherlands, Sweden, Denmark, Hong Kong, Panama, Seychelles, and others.

Aston VIP is not a registration agent. They are a proper advisory firm — clients include regulated financial businesses, crypto companies, trading firms, holding groups, and HNWIs who need compliant, bank-ready structures built correctly from the start.

Your writing is authoritative, specific, and human. You write like a practitioner who has guided hundreds of real clients — not like a content farm. Every section must contain concrete details: real jurisdiction names, actual fee ranges, named regulators, realistic timelines, and practical distinctions a reader cannot find in a generic article.

SEO KEYWORD RULES (Yoast green target — every rule below is mandatory):
- Place the exact focus keyword in: the first sentence of the introduction (main_content), the SEO title, the meta description, at least 2 H3 or H4 headings, and at least one key_takeaways item
- Keyphrase density: use the focus keyword naturally approximately once every 100–150 words across the full article (roughly 1–2% density). Spread it evenly — intro, body sections, FAQ — never front-load it
- The slug must contain the exact focus keyword in hyphenated form (e.g. focus keyword "UAE trade license" → slug begins "uae-trade-license-...")
- Distribute secondary keywords across more_content_1 through more_content_6 without forcing them
- Never stuff a keyword — if a sentence reads awkwardly, rephrase it or use a natural variation

READABILITY RULES (Yoast readability green target — every rule below is mandatory):
- Transition words: at least one in every three sentences must open with or include a transition (however, therefore, because, this means, as a result, for example, in addition, which means, in practice, by contrast, that said, more importantly, in most cases, as a rule)
- Sentence length: HARD MAXIMUM 20 words per sentence — no exceptions. Yoast flags any post where more than 25% of sentences exceed 20 words, which blocks a green readability score. Count words as you write. Target 12–16 words per sentence. If a sentence is approaching 18 words, end it and start a new one. The most common causes of long sentences are: (1) chaining clauses with "which", "that", "and", "because", or "since" — break these into two sentences; (2) listing three or more items in a sentence — convert to a bullet list or split; (3) adding a parenthetical or qualification mid-sentence — move it to its own sentence
- Passive voice: use active voice in at least 9 of every 10 sentences. Write "Aston VIP handles the filing" not "the filing is handled by Aston VIP"
- Paragraph length: maximum 4 sentences per paragraph. Never exceed 100 words in a single paragraph
- Consecutive sentences: never start 3 or more sentences in a row with the same word
- Subheading distribution: place an H3 or H4 at least every 300 words so readers and Yoast never see a wall of text

TONE AND STYLE RULES:
- UK English only: organisation, optimisation, authorised, centre, travelling, adviser
- Always write "license" (never "licence") — this is the site's mandatory house style, no exceptions
- Sentence case for all headings — do NOT use American title case
- All headings (H3, H4, H5) must be no longer than 8 words or 60 characters. If a heading exceeds this, rephrase it
- Maximum 3-4 lines per paragraph. Each paragraph must start with a clear idea, then explain it properly
- Never use em dashes or en dashes. Use commas or restructure the sentence instead
- Do NOT use colons in any heading, subheading, or section label
- Titles must not contain dashes of any kind — write as one clean natural sentence
- Bold text is allowed only in headings and subheadings — do NOT bold random words inside paragraphs
- Do NOT use arrows, decorative symbols, or unusual punctuation for style
- Write for a reader who is informed but not yet expert. Avoid jargon without context
- Every claim about costs, timelines, or regulations must reflect real, accurate information. Do not invent figures
- The article must read as a continuous professional blog — not a menu, checklist, or collection of bullet points

LINK FORMAT RULES (mandatory):
- Internal links MUST be written as HTML: <a href="/relevant-page-url">anchor text</a>
- External links MUST be written as HTML: <a href="https://official-site.com" target="_blank" rel="nofollow noopener">anchor text</a>
- Only link to real official external sources: regulators, governments, official institutions, authoritative frameworks
- Do NOT invent external URLs. Do NOT cite random blogs or weak sources
- Insert links inside sentences naturally — do NOT group links at the end of sections
- Anchor text must be natural, descriptive, and fit the sentence — never use "click here" or raw URLs
- TARGET 7 to 9 external links across the full article — spread across different body sections (main_content, more_content_1, more_content_2, more_content_3, more_content_6)
- Use ONLY the APPROVED EXTERNAL AUTHORITY SOURCES listed above — do NOT invent external URLs or use any URL not in that list

ARTICLE STRUCTURE (mandatory):
1. Title (H1)
2. Key takeaways — directly after the title, before the introduction. This section is NOT optional
3. Introduction
4. Main content sections
5. Conclusion or final advisory section

KEY TAKEAWAYS RULES:
- The key_takeaways field must appear directly after the title in the final article
- It must be clearly formatted as a bullet list
- It must summarise the most important insights of the article
- Each takeaway must contain real decision-useful content — not marketing or vague summaries
- It must contain meaningful, specific, advisory-level points about structure, banking, tax, licensing, regulation, or jurisdiction logic

BANNED PHRASES — never use any of these under any circumstances:
seamless, hassle-free, empower, unlock the power of, cutting-edge, innovative solution, game-changing, leverage, next-gen, disrupt, frictionless, one-stop-shop, solution-oriented, obtain, delve, navigate the complexities, it's worth noting, in today's landscape, in conclusion, unlock, streamline, robust, comprehensive suite, tailored solutions, ever-evolving, look no further`;

// ── Domain context library ────────────────────────────────────
/**
 * Each entry defines a domain that Aston VIP writes about.
 * signals: keywords that trigger this domain (checked against title + customPrompt)
 * context: the specialist knowledge block injected into the user prompt
 *
 * To add a new domain: add an entry to DOMAIN_CONTEXTS.
 * The system prompt never needs to change — domain knowledge lives here only.
 */
interface DomainEntry {
  signals: string[];
  context: string;
}

const DOMAIN_CONTEXTS: DomainEntry[] = [
  {
    signals: [
      "bank account", "banking", "bank application", "corporate account",
      "account opening", "high-risk", "aml", "kyc", "money laundering",
      "fintech banking", "payment company", "otc desk", "gold trading",
      "precious metals", "bullion", "remittance", "emi", "e-money",
      "wire transfer", "correspondent bank", "due diligence",
    ],
    context: `DOMAIN EXPERTISE — CORPORATE BANKING AND COMPLIANCE:
Use this knowledge throughout the article wherever relevant. Name specific entities, frameworks, and requirements — do not speak in generalities.

UAE banking landscape:
- Local UAE banks and their known risk postures: ADCB, Emirates NBD, Mashreq, RAK Bank, Abu Dhabi Islamic Bank (ADIB), Commercial Bank of Dubai (CBD), First Abu Dhabi Bank (FAB), HSBC UAE, Standard Chartered UAE, Citibank UAE
- International banks with UAE presence: HSBC, Standard Chartered, Barclays (wholesale), Deutsche Bank (corporate)
- Electronic Money Institutions and payment alternatives operating in the UAE ecosystem: Wise Business (automated, no relationship banking), Payoneer, Airwallex, Wio Bank, Liv Business, YAP Business

Regulatory frameworks to name correctly:
- CBUAE: Central Bank of the UAE — the primary banking regulator. Issues banking licenses and sets AML/CFT rules
- UAE AML Federal Decree-Law No. 20 of 2018 — the primary AML legislation
- UAE Cabinet Decision No. 10 of 2019 — implementing regulations for AML law
- UAE Cabinet Resolution No. 58 of 2020 — UBO (Ultimate Beneficial Owner) disclosure requirements
- FATF: Financial Action Task Force — the UAE completed its 2022 mutual evaluation; FATF grey-listing concerns have driven stricter bank compliance
- DFSA: Dubai Financial Services Authority — regulates entities inside DIFC
- FSRA: Financial Services Regulatory Authority — regulates entities inside ADGM

AML/KYC compliance infrastructure banks assess:
- TMS: Transaction Monitoring System — automated software that flags unusual patterns
- CIP: Customer Identification Programme — formal policy for onboarding and verifying clients
- MLRO: Money Laundering Reporting Officer — a named, qualified individual responsible for internal AML oversight
- SAR: Suspicious Activity Report — filed with the UAE Financial Intelligence Unit (FIU) via goAML platform
- PEP screening: Politically Exposed Person checks — mandatory for all new clients
- Sanctions screening: checked against UN, OFAC, EU, and UAE local sanctions lists
- Source of funds vs source of wealth: source of funds explains where the money for a specific transaction came from; source of wealth explains how the UBO built their overall net worth. Banks require both; confusing them is a common application error

Gold and precious metals specific:
- DMCC: Dubai Multi Commodities Centre — the primary free zone for gold, diamond, and commodities businesses
- DMCC Gold Standard: the voluntary responsible sourcing framework for DMCC gold members
- LBMA: London Bullion Market Association — international responsible sourcing standard; LBMA approval is a positive signal for banks
- Dubai Good Delivery (DGD): the DMCC standard for gold bars accepted in Dubai markets
- Trade finance instruments relevant to gold traders: Letters of Credit (LC), Documentary Collections, Trade Finance facilities, Commodity Murabaha
- Enhanced Due Diligence (EDD): mandatory for precious metals due to FATF Recommendation 22 (DNFBPs — Designated Non-Financial Businesses and Professions)

Fintech and payment company specific:
- CBUAE Payment Service Provider (PSP) framework: Retail Payment Services and Card Schemes Regulation 2021
- PSP license categories: Retail Payment Service Provider, Large Payment Service Provider
- Minimum capital requirements for PSPs: AED 2 million to AED 50 million depending on category
- Banking partners that fintech/PSPs commonly use vs avoid
- Transaction monitoring obligations under CBUAE Guidance on AML/CFT for Licensed Payment Service Providers

Compliance posture that banks want to see (name these in the article):
- Written AML/CFT policy and procedures manual
- Named MLRO with CV and qualifications
- Customer onboarding procedures and KYC forms
- Transaction monitoring system (even basic software is acceptable for smaller businesses)
- Sanctions and PEP screening process
- Business plan with detailed transaction flow diagrams
- 12-month projected transaction volumes, currencies, corridors, and counterparties
- Source of wealth declarations from all UBOs with supporting documentation
- Corporate structure chart showing full ownership to natural persons

Important compliance positions to hold in the article:
- Never guarantee bank account opening; outcomes depend on the bank's internal risk appetite
- Never suggest bypassing, circumventing, or accelerating AML/KYC — frame compliance preparation as the competitive advantage
- Never claim accounts cannot be reviewed, frozen, or closed — banks retain this right under UAE law
- Write with the measured authority of a compliance adviser, not a sales pitch`,
  },
  {
    signals: [
      "company formation", "company setup", "incorporate", "incorporation",
      "trade license", "trading license", "free zone", "freezone",
      "mainland", "business setup", "register a company", "company registration",
      "difc", "adgm", "jafza", "dmcc", "ifza", "meydan",
    ],
    context: `DOMAIN EXPERTISE — UAE COMPANY FORMATION AND BUSINESS SETUP:
Use this knowledge wherever relevant. Name specific free zones, costs, timelines, and regulators.

UAE jurisdictional options:
- UAE Mainland (DED-licensed): full access to UAE market, can trade directly with UAE clients and government, no foreign ownership restrictions since 2021 amendment to UAE Commercial Companies Law
- DIFC (Dubai International Financial Centre): onshore but separate legal and regulatory framework under English common law, regulated by DFSA, suited to financial services, funds, family offices
- ADGM (Abu Dhabi Global Market): similar to DIFC but in Abu Dhabi, regulated by FSRA, popular for family offices, holding companies, fintechs
- UAE Free Zones (50+): 100% foreign ownership, 0% personal income tax, import/export benefits, but restricted to trading with UAE market via a local distributor or mainland entity. Key free zones: DMCC, JAFZA, IFZA, Meydan, RAKEZ, SHAMS, Ajman Free Zone, DIEZ

Key cost benchmarks (approximate — advise readers to get a current quote):
- IFZA license: from AED 11,900/year (most affordable)
- DMCC license: from AED 18,000–25,000/year
- Mainland DED license: from AED 10,000–20,000 depending on activity
- DIFC: from USD 8,000–15,000 for a standard operating company
- ADGM: from USD 10,000–15,000 for a standard entity

Timelines:
- Free zone: 3–7 working days for license issuance once documents submitted
- Mainland DED: 1–3 weeks depending on activity and approvals
- DIFC/ADGM: 4–8 weeks including DFSA/FSRA application and fit-and-proper review

Ownership and structure:
- UAE Federal Decree-Law No. 26 of 2020 removed the 51% local sponsor requirement for most mainland activities (exceptions include strategic sectors)
- Local Service Agent (LSA) still required for certain professional licenses — LSA has no equity, only a nominal annual fee arrangement
- Foreign companies can establish a UAE Branch Office — subject to annual renewal and parent company guarantees

Visa eligibility (tied to company setup):
- Free zone: investor visa and employment visas based on office space/flexi-desk
- Mainland: visa allocation depends on office space (sq footage) and activity
- Golden Visa: 10-year residency — available to investors with AED 2M+ real property or qualifying business investment`,
  },
  {
    signals: [
      "crypto", "cryptocurrency", "virtual asset", "digital asset", "bitcoin",
      "blockchain", "defi", "nft", "vara", "dfsa crypto", "virtual asset service",
      "vasp", "exchange", "crypto license", "web3", "token",
    ],
    context: `DOMAIN EXPERTISE — UAE CRYPTO AND VIRTUAL ASSETS:
Use this knowledge wherever relevant. Name specific regulators, license categories, and requirements.

UAE crypto regulatory landscape:
- VARA: Virtual Assets Regulatory Authority — Dubai's crypto regulator (established 2022, Dubai Law No. 4 of 2022). Regulates all virtual asset activities in Dubai (excluding DIFC)
- VARA license categories: Exchange Services, Broker-Dealer Services, Lending and Borrowing Services, Virtual Asset Management and Investment Services, Transfer and Settlement Services, Advisory Services
- DFSA: Dubai Financial Services Authority — regulates crypto inside DIFC (separate from VARA). DFSA issued its crypto token regime in 2022
- FSRA (ADGM): Abu Dhabi's crypto framework — Digital Asset Framework. ADGM was the first UAE free zone to regulate crypto (2018)
- SCA: Securities and Commodities Authority — UAE mainland crypto oversight for certain token types

VARA licensing requirements:
- Minimum capital: varies by activity — from AED 600,000 (advisory) to AED 70M+ (exchange)
- Fit-and-proper requirements for directors and shareholders
- MLRO appointment mandatory
- AML/CFT policy aligned with VARA AML Rulebook
- Technology governance and cybersecurity framework
- Custody arrangements for client assets

Banking for crypto businesses:
- Most UAE banks do not bank unregulated crypto firms
- VARA-licensed firms have more banking options but still face enhanced due diligence
- Common approach: combination of VARA license + EMI/neo-bank relationship + traditional bank for operational account
- Banks will ask for: VARA license copy, AML policy, transaction monitoring system details, client onboarding procedures, source of funds for crypto transactions`,
  },
  {
    signals: [
      "tax", "corporate tax", "vat", "transfer pricing", "tax residency",
      "double taxation", "dta", "tax treaty", "holding company", "tax planning",
      "tax structure", "tax efficient", "offshore tax", "tax advisory",
      "economic substance", "pillar two", "global minimum tax",
    ],
    context: `DOMAIN EXPERTISE — UAE AND INTERNATIONAL TAX:
Use this knowledge wherever relevant. Name specific rates, rules, thresholds, and frameworks.

UAE corporate tax (in force from June 2023):
- Federal Decree-Law No. 47 of 2022 on the Taxation of Corporations and Businesses
- Standard rate: 9% on net taxable income above AED 375,000
- 0% on taxable income up to AED 375,000 (small business relief)
- Free zone entities: 0% on qualifying income from qualifying activities if they meet the substance requirements — non-qualifying income taxed at 9%
- Qualifying Free Zone Person (QFZP) status requires: adequate substance in the free zone, qualifying income only, no election to be subject to standard CT, audited financial statements
- Exempt persons: UAE government entities, qualifying extractive businesses, qualifying public benefit entities

UAE VAT:
- Standard rate: 5% (introduced January 2018, Federal Decree-Law No. 8 of 2017)
- Zero-rated: exports of goods/services, international transport, certain financial services, residential property (first supply)
- Exempt: bare land, local passenger transport, certain financial services
- Registration threshold: AED 375,000 mandatory; AED 187,500 voluntary

International tax structures using the UAE:
- Double Taxation Agreements (DTAs): UAE has 130+ active DTAs — covers dividends, royalties, capital gains withholding tax reductions
- Economic Substance Regulations (ESR): Cabinet Resolution No. 57 of 2020 — UAE entities in certain activities (banking, insurance, holding companies, IP holding, HQ, shipping, distribution/service centres, fund management, financing/leasing) must demonstrate economic substance
- Pillar Two / Global Minimum Tax (15%): UAE has enacted a Domestic Minimum Top-up Tax (DMTT) effective January 2025 for MNEs with global revenue above EUR 750M
- Transfer pricing: UAE CT law adopts the arm's length principle — transactions between related parties must be at market value; documentation required for transactions above AED 3M annually`,
  },
  {
    signals: [
      "nominee", "nominee director", "nominee shareholder", "nominee service",
      "beneficial owner", "ubo", "ownership structure", "holding structure",
      "offshore", "bvi", "seychelles", "cayman", "panama", "mauritius",
      "offshore company", "offshore vehicle", "shelf company",
    ],
    context: `DOMAIN EXPERTISE — NOMINEE SERVICES, HOLDING STRUCTURES AND OFFSHORE VEHICLES:
Use this knowledge wherever relevant. Name specific offshore jurisdictions, structures, and compliance obligations.

UAE nominee context:
- UAE Cabinet Resolution No. 58 of 2020 requires all UAE companies to maintain an accurate UBO register disclosing all natural persons who ultimately own or control the entity (directly or through a chain)
- Nominee directors are legal in the UAE but the UBO register must still reflect the true beneficial owner
- UAE companies must file UBO registers with the relevant authority — non-compliance results in penalties
- Nominee arrangements do not provide secrecy under UAE law — they are administrative and operational tools, not concealment mechanisms

Offshore jurisdictions Aston works with:
- British Virgin Islands (BVI): most commonly used — flexible, well-recognised, no public register of beneficial owners (though BOSS system exists for regulatory access), 0% corporate tax, quick formation (3–5 days)
- Seychelles IBC: very cost-effective (from $800–1,200/year), 0% tax, simple structure, popular for holding and trading companies
- Cayman Islands: preferred for fund structures, hedge funds, private equity — more expensive and complex
- Panama: SA and Foundation structures, historically used for asset holding and estate planning
- Mauritius: strong DTA network with India and Africa, GBC (Global Business Company) license
- RAK ICC (UAE): offshore company registered in Ras Al Khaimah, regulated by RAKICC — popular because it is UAE-based with a local offshore framework

Legitimate uses of holding structures:
- Asset protection between jurisdictions
- IP holding and royalty flows
- Consolidating international shareholdings under one parent
- Estate planning for HNW families
- Separating operational risk from asset ownership

Important compliance positions:
- Offshore structures are not tax evasion tools — they work within the legal frameworks of each jurisdiction
- Substance requirements (ESR in UAE, economic nexus tests in Mauritius, Cayman CIMA substance) must be respected
- Banks and counterparties conduct enhanced due diligence on offshore entities — the UBO must be disclosed and verifiable`,
  },
  {
    signals: [
      "golden visa", "uae visa", "residency visa", "residence visa",
      "investor visa", "employment visa", "retirement visa", "freelancer visa",
      "long-term residency", "permanent residency uae", "visa application",
    ],
    context: `DOMAIN EXPERTISE — UAE RESIDENCY AND VISA:
Use this knowledge wherever relevant. Name specific visa categories, thresholds, and processing steps.

UAE Golden Visa (10-year residency):
- Introduced under UAE Cabinet Resolution No. 56 of 2018, expanded in 2022
- Qualifying categories: real property investors (AED 2M minimum, unemcumbered), entrepreneurs (approved by accredited incubator or with AED 500,000+ startup capital), specialised talents (scientists, doctors, engineers, artists — evaluated by relevant authorities), outstanding students
- No UAE sponsor required — self-sponsored residency
- Can sponsor family members and unlimited domestic workers
- Processing: approximately 4–8 weeks via ICA (Federal Authority for Identity, Citizenship, Customs and Port Security)

UAE Investor Visa (2-year, renewable):
- Available to company shareholders — minimum share capital or investment value requirements vary by emirate
- Dubai: AED 72,000 minimum investment value or share capital for mainland; free zones set their own thresholds
- Can be combined with residence for family

Freelancer and remote worker visas:
- Dubai Freelancer Permit: issued via TECOM, Dubai Media City, or other free zones
- Green Visa (5-year self-sponsored): for skilled professionals, freelancers, and entrepreneurs earning above AED 360,000/year

Processing requirements:
- Emirates ID application via ICA
- Health insurance (mandatory for Dubai residency)
- Medical fitness test
- Entry permit, then status change to residency inside the UAE`,
  },
  {
    signals: [
      "regulatory license", "financial license", "regulated", "regulation",
      "fund management", "asset management", "family office", "wealth management",
      "investment advisor", "investment manager", "broker", "broker-dealer",
      "insurance", "reinsurance", "factoring", "leasing",
    ],
    context: `DOMAIN EXPERTISE — UAE REGULATORY LICENSING:
Use this knowledge wherever relevant. Name the specific regulator, license category, and requirements.

DIFC (regulated by DFSA):
- Authorised Firm categories: Category 1 (deposit-taking), Category 2 (dealing in investments as principal), Category 3A (dealing in investments as agent), Category 3B (managing collective investment funds), Category 3C (managing assets), Category 4 (advising on financial products), Category 5 (Islamic finance)
- Minimum capital: ranges from USD 10,000 (Cat 4 advisory) to USD 10M+ (Cat 1 deposit-taking)
- Key requirement: Approved Individuals (AI) — senior management and controlled functions must be individually approved by DFSA
- Family office: DIFC Family Office framework — members of the same family, minimum AED 50M assets under management in the DIFC

ADGM (regulated by FSRA):
- Financial Services Permission (FSP) — equivalent to DIFC's authorised firm
- Popular for: fund managers, family offices, SPVs, holding companies
- ADGM Registered Agent requirement for non-regulated entities

UAE Mainland (regulated by SCA — Securities and Commodities Authority):
- Investment fund management license
- Financial analysis and investment advisory license
- Portfolio management license

CBUAE-regulated activities:
- Banking license
- Exchange house license (money transfer and currency exchange)
- Insurance license
- Finance company license (for lending)
- Payment service provider license`,
  },
];

/**
 * Detect which domains are relevant to this article and return a combined
 * specialist knowledge block to inject into the user prompt.
 * Returns an empty string if no domain matches — the system prompt handles the generic case.
 */
function buildDomainContext(title: string, customPrompt?: string): string {
  const haystack = `${title} ${customPrompt ?? ""}`.toLowerCase();

  const matched = DOMAIN_CONTEXTS.filter((domain) =>
    domain.signals.some((signal) => haystack.includes(signal))
  );

  if (matched.length === 0) return "";

  const blocks = matched.map((d) => d.context).join("\n\n");
  return `\nSPECIALIST DOMAIN KNOWLEDGE (treat this as your source of truth for specific facts, names, and figures in this article — do not contradict it, do not invent alternatives):\n${blocks}\n`;
}

// ── Step 1: Generate structure blueprint ──────────────────────

/**
 * Fast first call — produces a structured outline before any prose is written.
 * The blueprint enforces consistent layout, correct word targets per section,
 * and specific headings/angles that the content generator must follow exactly.
 */
const ENGLISH_LANG_CODES = new Set(["en", "en-gb", "en-us"]);

function isNonEnglish(language?: string): boolean {
  return !!language && !ENGLISH_LANG_CODES.has(language.toLowerCase());
}

export async function generateBlueprint(
  title: string,
  selectedLinks: SelectedLinks,
  sourceBrief?: SourceBrief,
  strategy?: StrategyBrief | null,
  customPrompt?: string,
  language?: string
): Promise<Blueprint> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const linkCategories = [
    ...selectedLinks.internal.map((l) => l.title),
    ...selectedLinks.external.map((l) => l.title),
  ].join(", ");

  const sourceBriefBlock = sourceBrief ? formatBriefForPrompt(sourceBrief) : "";

  const strategyBlock = strategy ? `
STRATEGY BRIEF (use as source of truth for this blueprint):
- Primary keyword: ${strategy.keyword_model.primary_keyword}
- Primary keyword rationale: ${strategy.keyword_model.primary_keyword_why}
- Secondary keywords: ${strategy.keyword_model.secondary_keywords.slice(0, 10).join(", ")}
- Article angle: ${strategy.article_angle}
- Search intent: ${strategy.search_intent_type} — ${strategy.search_intent.slice(0, 200)}
- Commercial service layers: ${strategy.commercial_intent_layers.slice(0, 4).join("; ")}
- High-value strategy: ${strategy.high_value_strategy.slice(0, 300)}
- Content risks to avoid: ${strategy.content_risks.slice(0, 5).join("; ")}
` : "";

  // Detect if the custom prompt is a detailed article brief with explicit sections
  const isDetailedBrief = customPrompt && customPrompt.length > 600 &&
    (/section|heading|explain|discuss|include|cover/i.test(customPrompt));

  // Extract word count target from custom prompt if specified
  const wordCountMatch = customPrompt?.match(/(\d[\d,]+)\s*[-–]\s*(\d[\d,]+)\s*words?/i);
  const targetWordCount = wordCountMatch
    ? Math.round((parseInt(wordCountMatch[1].replace(/,/g, ""), 10) + parseInt(wordCountMatch[2].replace(/,/g, ""), 10)) / 2)
    : 2200;
  const sectionWordTarget = targetWordCount > 2800 ? 560 : 380;

  const customPromptBlock = customPrompt?.trim()
    ? `\nCUSTOM INSTRUCTIONS (highest priority — follow throughout the blueprint):\n${customPrompt.trim()}\n${isDetailedBrief ? `
SECTION MAPPING INSTRUCTIONS (mandatory when custom instructions provide a detailed article structure):
The custom instructions above specify multiple sections, headings, or angles. You MUST:
1. Extract the total word count target from the custom instructions — use it as estimated_word_count (if 3000–4000 words are requested, set estimated_word_count to 3500 and each section's target_words to ${sectionWordTarget})
2. Map the requested sections to the 5 available content fields (more_content_1 through more_content_6, excluding more_content_5 which is always FAQ):
   - more_content_1 → first 1–2 major requested sections (combine with clear H4 subsections for each)
   - more_content_2 → next 1–2 major requested sections
   - more_content_3 → next requested section(s)
   - more_content_4 → ALWAYS the Aston VIP advisory/role section (adapt the heading to the topic)
   - more_content_6 → remaining section(s) — banking options comparison, common mistakes, checklist, or jurisdiction comparison
3. Use the requested section headings (adapted to sentence case, max 8 words, no colons) as the H3 headings
4. Distribute the requested sub-points as H4 subsections within the appropriate field
5. Carry all the requested keywords, industry names, regulatory bodies, and topic angles into the section angles
6. The FAQ questions must come from the article topic — use questions a real high-risk business operator would ask
` : ""}\n`
    : "";

  const languageBlock = isNonEnglish(language)
    ? `\nTARGET LANGUAGE: ${language!.toUpperCase()} — MANDATORY OVERRIDE\nEvery field in this blueprint — seo_title, meta_description, focus_keyword, secondary_keywords, intro_angle, all h3_heading and h4_heading values, all angle descriptions, all faq_questions — MUST be written entirely in ${language}. No English words or phrases anywhere. The "UK English only" rule in the system prompt does NOT apply here. Write everything in ${language}.\n`
    : "";

  const domainContext = buildDomainContext(title, customPrompt);

  const userPrompt = `Blog title: "${title}"
Available link topics for context: ${linkCategories}
${languageBlock}${domainContext}${strategyBlock}${customPromptBlock}${sourceBriefBlock ? `\n${sourceBriefBlock}\n` : ""}

Plan the structure of this blog post and return it as a single valid JSON object. No markdown, no code fences:

{
  "focus_keyword": "string",
  "secondary_keywords": ["string", "string", "string", "string"],
  "seo_title": "string",
  "meta_description": "string",
  "slug": "string",
  "estimated_word_count": ${targetWordCount},
  "intro_angle": "string",
  "sections": [
    {
      "field": "more_content_1",
      "h3_heading": "string",
      "angle": "string",
      "target_words": ${sectionWordTarget},
      "subsections": [
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" }
      ]
    },
    {
      "field": "more_content_2",
      "h3_heading": "string",
      "angle": "string",
      "target_words": ${sectionWordTarget},
      "subsections": [
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" }
      ]
    },
    {
      "field": "more_content_3",
      "h3_heading": "string",
      "angle": "string",
      "target_words": ${sectionWordTarget},
      "subsections": [
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" }
      ]
    },
    {
      "field": "more_content_4",
      "h3_heading": "Aston VIP's role in your [adapt to topic]",
      "angle": "string",
      "target_words": ${sectionWordTarget},
      "subsections": [
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" }
      ]
    },
    {
      "field": "more_content_6",
      "h3_heading": "string",
      "angle": "string",
      "target_words": ${Math.round(sectionWordTarget * 0.85)},
      "subsections": [
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" },
        { "h4_heading": "string", "angle": "string" }
      ]
    }
  ],
  "faq_questions": ["string", "string", "string", "string"]
}

BLUEPRINT RULES:
- focus_keyword: ${strategy ? `use exactly "${strategy.keyword_model.primary_keyword}" — this has been determined by the strategy engine` : "the single phrase this article should rank for in Google — 2 to 4 words, as a reader would actually type it into Google"}

- seo_title: Write a title that makes a senior institutional adviser stop scrolling. STRICT RULES — all must be met simultaneously:
  1. Contains the exact focus keyword — it does NOT need to be the first words; place it wherever it reads most naturally
  2. Exactly 50–60 characters including spaces — count precisely before returning
  3. Sentence case only — capitalise only the first word and proper nouns
  4. No site name, no pipes, no dashes, no question marks, no colons
  5. One complete, natural phrase — no lists, no two clauses joined by punctuation
  6. BANNED suffixes — never use: "complete guide", "explained", "step-by-step guide", "what you need to know", "how it works", "a guide", "overview", "everything you need to know", "all you need to know"
  7. Write with practitioner authority — use constructions like:
     - "Why [jurisdiction] is becoming the go-to for [topic]"
     - "Inside [entity]'s [approach/framework] for [topic]"
     - "What [topic] means for [institutional audience]"
     - "[Topic] and what serious [founders/investors/operators] get wrong"
     - "The institutional case for [topic] in [jurisdiction]"
     - "How [jurisdiction/regulator] is redefining [topic]"
     - "[Topic] eligibility, timelines and costs in [jurisdiction]"
     - "Before you [action]: what [topic] actually requires"
  8. Each title must feel written by a practitioner, not generated — specific, confident, commercially intelligent

- meta_description: This appears verbatim on Google — it must be complete, punchy, and entice the reader to click. STRICT RULES — all must be met simultaneously:
  1. HARD MAXIMUM: 141 characters including spaces. This is an absolute ceiling — never exceed it under any circumstance. Count the characters in your final string before returning it. If your draft is 142 or more characters, rewrite the sentence with shorter words or remove a clause — do NOT truncate mid-word or mid-thought.
  2. TARGET: aim for 130–141 characters. If you genuinely cannot reach 130 without padding or filler, 110–129 is acceptable — but never go below 110.
  3. The description must be a COMPLETE, grammatically correct sentence or two that ends on a full stop or clear CTA. It must never trail off or end mid-thought.
  4. Place the exact focus keyword within the first 60 characters
  5. Lead with the specific outcome or insight the reader gets — name a real number, jurisdiction, timeline, or comparison; no vague claims
  6. End with a punchy, direct CTA that creates urgency or curiosity: "Aston VIP walks you through every step.", "Find out exactly what applies to your situation.", "Speak to our advisers before you commit." — vary it; do not repeat the same CTA across articles
  7. Active voice, present tense — write as if talking to the reader directly
  8. Must not repeat the seo_title verbatim — complement it, do not duplicate it
  9. Never use: seamless, hassle-free, comprehensive, robust, tailored, one-stop, navigate, landscape, unlock, dive

- slug: lowercase hyphenated only — STRICT RULES:
  1. Start with the exact focus keyword hyphenated (e.g. "UAE trade license" → starts with "uae-trade-license")
  2. Strip ALL stop words after the keyword (the, a, an, of, for, with, to, in, on, at, by, and, or, your, our)
  3. Total length: 3–5 words maximum — shorter is better for Google
  4. Only add 1 extra word after the focus keyword if it meaningfully disambiguates (e.g. "-guide", "-requirements", "-2025") — otherwise stop at the keyword itself
  5. No numbers, no years, unless they are part of the focus keyword itself
- intro_angle: one sentence describing what the intro should establish — the business problem or opportunity
- sections[].h3_heading: the exact H3 heading for that section, sentence case, max 8 words
- sections[].angle: one sentence describing what that section covers and what the reader should understand after reading it
- sections[].subsections[].h4_heading: the exact H4 heading, sentence case, max 8 words
- sections[].subsections[].angle: one sentence describing the subsection focus
- more_content_4 must always open with an Aston VIP CTA heading adapted to the topic
- more_content_6 must be a distinct fifth body section covering a practical angle not addressed in sections 1–4 (e.g. common mistakes, jurisdiction comparison, a specific use case, or a compliance checklist). Do not duplicate more_content_4 themes.
- faq_questions: 4 specific questions a real reader would ask about this topic. Questions only, no answers yet`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
    max_completion_tokens: 3000,
  }, { signal: AbortSignal.timeout(60_000) });

  const choice = response.choices[0];
  if (choice.finish_reason === "length") {
    throw new Error("Blueprint response was cut off by the token limit. Increase max_tokens or shorten the prompt.");
  }

  const raw = choice.message.content?.trim() ?? "";

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `No JSON found in blueprint response. Raw: ${raw.slice(0, 200)}`
    );
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Blueprint;
    if (parsed.meta_description && parsed.meta_description.length > 141) {
      const cut = parsed.meta_description.slice(0, 141);
      const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
      parsed.meta_description = lastStop > 80 ? parsed.meta_description.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, "");
    }
    return parsed;
  } catch {
    throw new Error(
      `Blueprint returned invalid JSON. Raw: ${raw.slice(0, 200)}`
    );
  }
}

// ── Step 2: Generate blog content from blueprint ──────────────

/**
 * Write the full article using the blueprint as the source of truth.
 * Every section heading, angle, and word target comes from the blueprint —
 * the AI fills in the prose, not the structure.
 */
export async function generateBlogContent(
  title: string,
  blueprint: Blueprint,
  selectedLinks: SelectedLinks,
  sourceBrief?: SourceBrief,
  strategy?: StrategyBrief | null,
  customPrompt?: string,
  language?: string,
  authorityLinks?: AuthorityLink[]
): Promise<BlogContent> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const linksBlock = formatLinksForPrompt(selectedLinks, language);
  const authorityLinksBlock = authorityLinks && authorityLinks.length > 0
    ? `\n${formatAuthorityLinksForPrompt(authorityLinks, language)}\n`
    : "";
  const sourceBriefBlock = sourceBrief ? formatBriefForPrompt(sourceBrief) : "";

  const strategyContentBlock = strategy ? `
STRATEGY CONTEXT (use throughout the article):
Article angle: ${strategy.article_angle}
Banking angle: ${strategy.banking_tax_structuring_compliance.banking.slice(0, 200)}
Tax angle: ${strategy.banking_tax_structuring_compliance.tax.slice(0, 200)}
Structuring angle: ${strategy.banking_tax_structuring_compliance.structuring.slice(0, 200)}
High-value strategy: ${strategy.high_value_strategy.slice(0, 300)}
Internal link plan: ${strategy.internal_link_plan.slice(0, 300)}
External link plan: ${strategy.external_link_plan.slice(0, 300)}
Content risks to avoid: ${strategy.content_risks.join("; ")}

PRE-PLANNED KEY TAKEAWAYS (use these as the basis for the key_takeaways field — refine and format as HTML list):
${strategy.key_takeaways.map((t, i) => `${i + 1}. ${t}`).join("\n")}
` : "";

  // Serialise blueprint sections into clear per-field instructions
  const sectionInstructions = blueprint.sections
    .map((s) => {
      const subs = s.subsections
        .map((sub) => `    H4: "${sub.h4_heading}" — ${sub.angle}`)
        .join("\n");
      return `${s.field} (target: ~${s.target_words} words)
  H3: "${s.h3_heading}"
  Angle: ${s.angle}
${subs}`;
    })
    .join("\n\n");

  const faqInstructions = blueprint.faq_questions
    .map((q, i) => `  Q${i + 1}: ${q}`)
    .join("\n");

  // Detect visual SEO block markers in the custom prompt
  const hasVisualBlocks = customPrompt && /\[INFOGRAPHIC|FLOWCHART|CHART|VISUAL SEO BLOCK|CHECKLIST\]/i.test(customPrompt);

  const customPromptContentBlock = customPrompt?.trim()
    ? `\nCUSTOM INSTRUCTIONS (highest priority — follow throughout the entire article):\n${customPrompt.trim()}\n${hasVisualBlocks ? `
VISUAL SEO BLOCK RENDERING RULES (mandatory):
The custom instructions above reference visual SEO blocks such as [INFOGRAPHIC IDEA], [FLOWCHART], [CHART], [VISUAL SEO BLOCK], or [CHECKLIST].
You MUST render each one as a styled HTML block in the appropriate content section using EXACTLY this format:

<div class="visual-seo-block">
<p class="vsb-label">[Type of visual — e.g. "Infographic idea" or "Approval flowchart" or "Risk comparison chart"]</p>
<p class="vsb-title">[Descriptive title for the visual, e.g. "Why bank applications get rejected"]</p>
<ul>
<li>[First item or step]</li>
<li>[Second item or step]</li>
<li>[Third item or step — continue until all key points are covered]</li>
</ul>
</div>

Rules:
- Render the block in the section that is most relevant to the visual's content
- Replace the [INFOGRAPHIC IDEA], [FLOWCHART], [CHART], [VISUAL SEO BLOCK], or [CHECKLIST] placeholder with the actual rendered block — do not leave the raw placeholder text
- Each block must contain a <p class="vsb-title"> title and a <ul><li> list of 4–8 specific, factual items
- The items must be concrete and advisory-level — real information a compliance team would use
- Do NOT add the vsb-label or vsb-title inside the <ul>
` : ""}\n`
    : "";

  const languageContentBlock = isNonEnglish(language)
    ? `\nTARGET LANGUAGE: ${language!.toUpperCase()} — MANDATORY OVERRIDE\nThe ENTIRE article — every paragraph, every heading, every key takeaway, the excerpt, all quotes, and all SEO fields (seo_title, meta_description, focus_keyword) — MUST be written entirely in ${language}. No English words or phrases anywhere. The "UK English only" rule in the system prompt does NOT apply. Write everything in ${language}.\n`
    : "";

  const domainContext = buildDomainContext(title, customPrompt);

  const userPrompt = `Blog title: "${title}"
${languageContentBlock}${domainContext}${strategyContentBlock}${customPromptContentBlock}${sourceBriefBlock ? `\n${sourceBriefBlock}\n` : ""}${authorityLinksBlock}
You have already planned the structure. Now write the full article following the blueprint exactly.
The headings, section angles, and word targets below are fixed — do not change them.

BLUEPRINT:
Focus keyword: ${blueprint.focus_keyword}
Secondary keywords: ${blueprint.secondary_keywords.join(", ")}
Intro angle: ${blueprint.intro_angle}

SECTION STRUCTURE (follow exactly):
${sectionInstructions}

FAQ QUESTIONS (write a concise, factual answer for each):
${faqInstructions}

Return as a single valid JSON object with exactly these fields. No markdown, no code fences:

{
  "focus_keyword": "${blueprint.focus_keyword}",
  "secondary_keywords": ${JSON.stringify(blueprint.secondary_keywords)},
  "seo_title": "${blueprint.seo_title}",
  "meta_description": "${blueprint.meta_description}",
  "slug": "${blueprint.slug}",
  "excerpt": "string",
  "main_content": "string",
  "keypoint_one": "string",
  "more_content_1": "string",
  "more_content_2": "string",
  "quote_1": "string",
  "more_content_3": "string",
  "keypoint_two": "string",
  "more_content_4": "string",
  "quote_2": "string",
  "key_takeaways": "string",
  "more_content_5": "string",
  "more_content_6": "string",
  "final_points": "string",
  "read_mins": "string",
  "internal_links_used": [{"anchor": "string", "url": "string"}],
  "external_links_used": [{"anchor": "string", "url": "string"}]
}

FIELD INSTRUCTIONS:

excerpt:
2-3 sentence plain-text excerpt for WordPress archive pages. No HTML. 40-60 words.

main_content (300-340 words — MINIMUM 300, count before submitting):
- Open with the business problem or opportunity described in the intro angle: "${blueprint.intro_angle}"
- The focus keyword must appear in the first sentence of the first paragraph — not the second, not the third
- Use the focus keyword 2–3 times naturally across the full intro (spread across different paragraphs)
- Do NOT open with an H3. Start with a <p> tag
- After the opening paragraph, you MUST include at least 2 H3 subheadings to break the text into scannable sections — do not write 300 words of unbroken paragraphs
- Heading hierarchy: every H4 must sit under an H3. Never skip levels
- End with a sentence that pulls the reader into what follows
- LINKS (mandatory): embed exactly 1 internal link and at least 1 external link naturally within the text — both must sit inside a sentence and support the point being made
- SENTENCE LENGTH (mandatory): no sentence may exceed 20 words. If a sentence is running long, split it into two. This applies to every paragraph in this section
- Allowed HTML: <h3>, <h4>, <p>, <strong>, <em>, <a>

keypoint_one:
A single compelling sentence (max 25 words) from the key insight of main_content. Plain text only — no markdown, no asterisks, no bold tags. No em dashes. No question marks.

more_content_1:
- Use EXACTLY this H3: "${blueprint.sections[0]?.h3_heading ?? ""}"
- Follow the angle: ${blueprint.sections[0]?.angle ?? ""}
- Write EACH H4 subsection fully as specified in the blueprint — each H4 must be followed by at least 2 substantial paragraphs
- Target ~${blueprint.sections[0]?.target_words ?? 380} words — HIT THIS TARGET, do not write less
- Must include at least one: specific cost/fee in AED or USD, named regulatory body, realistic timeline, or jurisdiction comparison
- If a visual SEO block was requested for this section's topic, render it here using the visual block format above
- Use 1-2 secondary keywords naturally
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>, <a>, <div class="visual-seo-block">, <p class="vsb-label">, <p class="vsb-title">

more_content_2:
- Use EXACTLY this H3: "${blueprint.sections[1]?.h3_heading ?? ""}"
- Follow the angle: ${blueprint.sections[1]?.angle ?? ""}
- Write EACH H4 subsection fully as specified in the blueprint — each H4 must be followed by at least 2 substantial paragraphs
- Target ~${blueprint.sections[1]?.target_words ?? 380} words — HIT THIS TARGET, do not write less
- Must include a bulleted or numbered list of at least 5 concrete items with facts, figures, or named details
- If a visual SEO block was requested for this section's topic, render it here using the visual block format above
- Use 1-2 secondary keywords naturally
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>, <a>, <div class="visual-seo-block">, <p class="vsb-label">, <p class="vsb-title">

quote_1:
Short, punchy, practical advice from more_content_1 or more_content_2. Max 2 sentences. No em dashes. Actionable. Must sound like it came from a senior compliance adviser, not a marketing page.

more_content_3:
- Use EXACTLY this H3: "${blueprint.sections[2]?.h3_heading ?? ""}"
- Follow the angle: ${blueprint.sections[2]?.angle ?? ""}
- Write EACH H4 subsection fully as specified in the blueprint — each H4 must be followed by at least 2 substantial paragraphs
- Target ~${blueprint.sections[2]?.target_words ?? 380} words — HIT THIS TARGET, do not write less
- Include at least one real-world scenario as a short narrative (e.g. "A gold trading company registered in DMCC approached three banks over six months...")
- If a visual SEO block was requested for this section's topic, render it here using the visual block format above
- Use 1-2 secondary keywords naturally
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>, <a>, <div class="visual-seo-block">, <p class="vsb-label">, <p class="vsb-title">

keypoint_two:
A single compelling sentence (max 25 words) from the key insight of more_content_3. Plain text only — no markdown, no asterisks, no bold tags. No em dashes. No question marks. Different from keypoint_one.

more_content_4:
- Use EXACTLY this H3: "${blueprint.sections[3]?.h3_heading ?? "Aston VIP's role in your process"}"
- Follow the angle: ${blueprint.sections[3]?.angle ?? ""}
- Write EACH H4 subsection fully as specified in the blueprint — each H4 must be followed by at least 2 substantial paragraphs
- Target ~${blueprint.sections[3]?.target_words ?? 380} words — HIT THIS TARGET, do not write less
- Describe Aston's end-to-end involvement specific to this topic — name the actual steps: pre-banking review, KYC file preparation, UBO documentation, compliance policy drafting, bank matching, introduction to relationship managers
- DO NOT describe Aston generically. Every H4 must describe a specific, distinct phase of Aston's involvement
- Include the mandatory disclaimer: "We do not guarantee bank account approvals. Our role is to ensure clients are properly prepared and introduced to institutions that align with their business profile."
- Close with: <p>To discuss your situation, <a href="https://aston.ae/contact-us/">speak with our team</a>.</p>
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <strong>, <a>

quote_2:
Short, punchy advice from more_content_4. Max 2 sentences. No em dashes. Different from quote_1.

key_takeaways:
HTML <ul><li> list of 4 to 6 items. This section appears directly after the title — before the introduction. ${strategy ? "Use and refine the PRE-PLANNED KEY TAKEAWAYS provided above — adapt them to match the final article content. Each must be a standalone advisory point with real decision-useful insight about structure, banking, tax, licensing, regulation, or jurisdiction logic. Not marketing. Not vague summaries." : "Each must contain at least one named figure, regulator, jurisdiction, timeline, or cost. Include the focus keyword in at least one item."}
LENGTH RULE: each list item must be 8–14 words maximum — short enough to scan in under 3 seconds. Cut any item that runs longer. Lead with the specific fact or number, not a preamble. Example format: "DIFC company formation costs from AED 15,000 in fees." or "UAE corporate tax is 9% on profits above AED 375,000."
Allowed HTML: <ul>, <li> only. Do NOT use <strong> or any other tags inside list items — plain text only.

more_content_5:
Write answers for each of these FAQ questions using the format below.
Questions: ${blueprint.faq_questions.map((q, i) => `Q${i + 1}: ${q}`).join(" | ")}
Format each as: <h3>Question text</h3><p>Answer (2-4 sentences, factual, specific)</p>
Do NOT wrap in any container — just the h3/p pairs.
Allowed HTML: <h3>, <p>, <strong>

more_content_6:
- Use EXACTLY this H3: "${blueprint.sections[4]?.h3_heading ?? ""}"
- Follow the angle: ${blueprint.sections[4]?.angle ?? ""}
- Write EACH H4 subsection fully as specified in the blueprint — each H4 must be followed by at least 2 substantial paragraphs
- Target ~${blueprint.sections[4]?.target_words ?? 320} words — HIT THIS TARGET, do not write less
- This is a distinct fifth body section — do not repeat themes from more_content_4
- If a visual SEO block was requested for this section's topic, render it here using the visual block format above
- Use 1-2 secondary keywords naturally
- Allowed HTML: <h3>, <h4>, <h5>, <p>, <ul>, <li>, <strong>, <em>, <a>, <div class="visual-seo-block">, <p class="vsb-label">, <p class="vsb-title">

final_points:
HTML <ul><li> list of exactly 4 practical next steps. Start each with a verb. Specific, advisory-level, and actionable — tailored to this article's topic.
Allowed HTML: <ul>, <li>, <strong>

read_mins:
Number string only. Estimate at 200 words per minute. Example: "9"

internal_links_used:
Array of objects recording every internal link placed in the article body.

external_links_used:
Array of objects recording every external link placed. Empty array if none used.

${linksBlock}`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.6,
    max_completion_tokens: 32000,
  }, { signal: AbortSignal.timeout(180_000) });

  const choice = response.choices[0];
  if (choice.finish_reason === "length") {
    throw new Error("Content response was cut off by the token limit — the JSON is incomplete. Reduce content scope or increase max_tokens.");
  }

  const raw = choice.message.content?.trim() ?? "";

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in GPT response. Raw: ${raw.slice(0, 200)}`);
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as BlogContent;
    if (parsed.meta_description && parsed.meta_description.length > 141) {
      const cut = parsed.meta_description.slice(0, 141);
      const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
      parsed.meta_description = lastStop > 80 ? parsed.meta_description.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, "");
    }
    return parsed;
  } catch {
    throw new Error(`GPT returned invalid JSON. Raw: ${raw.slice(0, 200)}`);
  }
}

// ── Step 3: Generate content-aware image prompts ──────────────

/**
 * Write 4 DALL·E prompts from the actual written content.
 * Called after generateBlogContent() so each prompt references the real
 * section topic, not just the article title.
 */
export async function generateImagePrompts(
  title: string,
  content: BlogContent
): Promise<ImagePrompts> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const strip = (html: string, len = 400) =>
    html.slice(0, len).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  const keywords = [content.focus_keyword, ...(content.secondary_keywords ?? [])].join(", ");

  const userPrompt = `You are creating 4 distinct, topic-specific image prompts for a blog post.

ARTICLE TITLE: "${title}"
FOCUS KEYWORD: "${content.focus_keyword}"
KEY TOPICS: ${keywords}

SECTION CONTENT (use these to determine what each image should show):

IMAGE 1 — keypoint_one (illustrates the article introduction):
"${strip(content.main_content)}"

IMAGE 2 — keypoint_two (illustrates the mid-article insight):
"${strip(content.more_content_3)}"

IMAGE 3 — post_split (illustrates the Aston VIP advisory/process section):
"${strip(content.more_content_4)}"

IMAGE 4 — featured hero (represents the full article topic — this must be the most specific and striking image, directly visualising "${content.focus_keyword}")

TOPIC-TO-SCENE GUIDE — use this to pick the right setting for each image:
- DIFC / DFSA → DIFC Gate building exterior, glass towers, financial district walkway
- ADGM / Abu Dhabi → Al Maryah Island skyline, ADGM square glass towers, waterfront
- VARA / crypto / virtual assets → clean minimalist tech office, abstract digital network nodes, server room with cool blue lighting — NO coins or currency symbols
- UAE mainland / trade license → modern Dubai business district, government service centre, document signing
- Tax / corporate tax / VAT → financial documents spread on a desk, calculator, structured corporate paperwork
- Banking / EMI / payment license → modern private bank interior, vault corridor, payment terminal close-up
- Company formation / incorporation → corporate seal, certificate of incorporation on a desk, handshake in a modern lobby
- Offshore / Seychelles / BVI → tropical island aerial with clean blue water, corporate office contrast with island backdrop
- Cyprus / EU jurisdiction → Limassol or Nicosia modern skyline, Mediterranean light, EU-style corporate building
- Germany / Frankfurt / EU → Frankfurt banking district skyline, Commerzbank Tower area, glass and steel architecture
- Holding company / structuring → layered corporate org chart visualised as glass building floors, abstract structure
- Startups / founders → bright co-working space, whiteboard, young professionals collaborating
- Golden Visa / residency → luxury Dubai apartment view, residence document, passport on a desk
- General / mixed → neutral modern international office, floor-to-ceiling windows, city view below

RULES FOR EVERY PROMPT:
- Each image must visualise a DIFFERENT aspect of the topic — no two prompts should describe the same scene
- Featured image must show the most striking, instantly recognisable visual for "${content.focus_keyword}"
- Apply Aston VIP visual style: high-end corporate editorial photography, bright and airy interiors, natural daylight through floor-to-ceiling windows or soft warm studio lighting, neutral whites/warm greys/muted golds, never oversaturated — think Architectural Digest meets Bloomberg editorial
- Let the architectural setting or object carry the topic — do not add people unless the scene requires a human interaction (e.g. document signing, consultation). When people are included they must be dressed in formal business attire and shown from behind or side-on — no faces
- Never include: text of any kind, logos, watermarks, flags, digital screens with readable content, clocks, coins, currency symbols, phone or laptop screens
- End every prompt with: "shot on Canon EOS R5, 85mm f/1.4 lens, shallow depth of field, soft natural light or warm studio lighting, ultra-sharp focus on subject, professional corporate editorial photography, cinematic warm-neutral colour grade, no text overlay, no logos, no watermarks"
- 2–3 sentences per prompt. Structure each prompt as: (1) the specific scene and subject in detail, (2) lighting quality, atmosphere, and mood, (3) the camera and style suffix above

Return as a single valid JSON object. No markdown, no code fences:

{
  "keypoint_one_img_prompt": "string",
  "keypoint_one_img_alt": "string",
  "keypoint_two_img_prompt": "string",
  "keypoint_two_img_alt": "string",
  "post_split_img_prompt": "string",
  "post_split_img_alt": "string",
  "featured_img_prompt": "string",
  "featured_img_alt": "string"
}

Alt text rules (SEO-optimised — all must be met):
1. Alt text is NOT a description of the image — it is a short SEO phrase about the article topic and focus keyword. Write it as a search-engine-friendly label, not a visual caption.
2. Every alt text MUST include the focus keyword "${content.focus_keyword}" or a close natural variation of it — this is the primary SEO signal
3. Each alt text should also weave in a secondary or related keyword from the article topic (jurisdiction, service type, regulator name, etc.) to build topical relevance
4. 8–12 words per alt text — concise, keyword-rich, reads like a natural phrase a user might search
5. All 4 alt texts must be distinct — vary the keyword combinations and phrasing across the four images so they cover different aspects of the topic
6. No full stops, no quotes, no HTML
7. Never start with "image of", "photo of", or "picture of" — start directly with the keyword phrase
8. Examples of good alt text: "UAE trade license setup for mainland company formation", "DIFC financial services license requirements for fund managers", "Dubai crypto license VARA regulatory framework guide"
9. Examples of bad alt text: "glass office tower at sunset", "businesspeople shaking hands in lobby", "documents on a desk with calculator"`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.5,
    max_completion_tokens: 2000,
  }, { signal: AbortSignal.timeout(60_000) });

  const choice = response.choices[0];
  if (choice.finish_reason === "length") {
    throw new Error("Image prompts response was cut off by the token limit.");
  }

  const raw = choice.message.content?.trim() ?? "";

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(
      `No JSON found in image prompts response. Raw: ${raw.slice(0, 200)}`
    );
  }

  try {
    return JSON.parse(jsonMatch[0]) as ImagePrompts;
  } catch {
    throw new Error(
      `GPT returned invalid JSON for image prompts. Raw: ${raw.slice(0, 200)}`
    );
  }
}

// ── Step 2b: Fix only the fields that failed QA ───────────────

// QA checks that relate to images — if only these fail, content doesn't need fixing
export const IMAGE_QA_CHECKS = ["featured_image_exists", "section_images_exist", "image_alt_text_exists"];

// Maps each QA check key → the BlogContent field(s) responsible
const CHECK_TO_FIELDS: Record<string, string[]> = {
  // Blocking — structural metadata
  focus_keyword_exists:             ["focus_keyword"],
  seo_title_exists:                 ["seo_title"],
  meta_description_exists:          ["meta_description"],
  slug_exists:                      ["slug"],
  excerpt_exists:                   ["excerpt"],
  // Blocking — content body
  main_content_exists:              ["main_content"],
  main_content_has_internal_link:   ["main_content"],
  main_content_has_external_link:   ["main_content"],
  key_takeaways_exists:             ["key_takeaways"],
  more_content_5_exists:            ["more_content_5"],
  final_points_exists:              ["final_points"],
  cta_exists:                       ["more_content_4"],
  internal_links_sufficient:        ["main_content", "more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_6"],
  focus_keyword_in_title:           ["seo_title"],
  // Non-blocking — keyword/SEO
  focus_keyword_in_intro:           ["main_content"],
  focus_keyword_in_heading:         ["main_content", "more_content_1"],
  seo_title_length_ok:              ["seo_title"],
  meta_description_length_ok:       ["meta_description"],
  no_dashes_in_title:               ["seo_title"],
  // Non-blocking — structure
  word_count_in_range:              ["main_content", "more_content_1", "more_content_2", "more_content_3"],
  h3_count_sufficient:              ["main_content", "more_content_1", "more_content_2", "more_content_3"],
  h4_count_sufficient:              ["more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_5"],
  keypoints_exist:                  ["keypoint_one", "keypoint_two"],
  quotes_exist:                     ["quote_1", "quote_2"],
  external_links_present:           ["main_content", "more_content_1", "more_content_2", "more_content_3", "more_content_6"],
  no_banned_phrases:                ["main_content", "more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_5", "more_content_6"],
  no_colons_in_headings:            ["main_content", "more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_5", "more_content_6"],
  sentence_length_ok:               ["main_content", "more_content_1", "more_content_2", "more_content_3", "more_content_4", "more_content_5", "more_content_6"],
};

const CHECK_DESCRIPTIONS: Record<string, string> = {
  // Structural metadata
  focus_keyword_exists:             "focus_keyword is empty — write a short, specific keyword phrase (3–5 words) that this article targets",
  seo_title_exists:                 "seo_title is empty — write a creative, authority-signaling title (50–60 chars) that contains the focus keyword naturally (not necessarily first), uses sentence case, no dashes/colons, and avoids generic suffixes like 'explained', 'complete guide', 'step-by-step guide'",
  meta_description_exists:          "meta_description is empty — write it (110–141 chars, contain focus keyword, end with a call to action)",
  slug_exists:                      "slug is empty or invalid — write a lowercase hyphenated URL slug (only a-z, 0-9, hyphens; no spaces)",
  excerpt_exists:                   "excerpt is empty — write a 1–2 sentence plain-text summary of the article (no HTML)",
  // Content body
  main_content_exists:              "main_content is under 270 words — rewrite it to at least 300 words",
  main_content_has_internal_link:   "main_content has no internal link — embed exactly 1 internal link from the provided list",
  main_content_has_external_link:   "main_content has no external link — embed at least 1 external link from an official source (regulator, government, institution)",
  key_takeaways_exists:             "key_takeaways is empty — write 4–6 bullet points",
  more_content_5_exists:            "more_content_5 (FAQ) is empty — write answers to the FAQ questions from the blueprint",
  final_points_exists:              "final_points is empty — write exactly 4 practical next steps",
  cta_exists:                       `more_content_4 is missing the contact CTA — end it with: <p>To discuss your situation, <a href="https://aston.ae/contact-us/">speak with our team</a>.</p>`,
  internal_links_sufficient:        "fewer than 7 internal links across the article — add more internal links from the provided list, spread across the listed sections",
  focus_keyword_in_title:           "focus keyword not present in seo_title — rewrite the title so the focus keyword appears naturally anywhere in the phrase; keep it creative and authority-signaling, not a generic keyword + boilerplate suffix",
  // SEO/keyword
  focus_keyword_in_intro:           "focus keyword missing from the first paragraph of main_content — include it in the first sentence",
  focus_keyword_in_heading:         "focus keyword not found in any H2/H3 heading — naturally include it in at least one heading",
  seo_title_length_ok:              "seo_title is outside 45–65 characters — rewrite to fit within this range while keeping the focus keyword",
  meta_description_length_ok:       "meta_description is outside 110–141 characters — rewrite to land in this range",
  no_dashes_in_title:               "seo_title contains a dash — rewrite the title without using dashes",
  // Structure
  word_count_in_range:              "total article word count is outside 1800–3500 words — expand thin sections or trim bloated ones",
  h3_count_sufficient:              "fewer than 4 H3 subheadings in the article — add subheadings to break up long sections",
  h4_count_sufficient:              "fewer than 6 H4 subheadings in the article — add H4 sub-points under existing H3 sections",
  keypoints_exist:                  "one or both keypoint callout boxes are empty — write them",
  quotes_exist:                     "one or both pull-quote fields are empty — write a compelling 1–2 sentence quote for each",
  external_links_present:           "fewer than 5 verified external links in the article — add authoritative external links (regulators, governments, official institutions) spread across main_content, more_content_1, more_content_2, more_content_3, and more_content_6; target 7 to 9 total so broken links can be removed without dropping below 5",
  no_banned_phrases:                "banned phrase(s) found in the article — identify and remove or replace them",
  no_colons_in_headings:            "colon found in one or more headings — rewrite those headings without colons",
  sentence_length_ok:               "too many sentences exceed 20 words — Yoast requires fewer than 25% of sentences to be over 20 words. Rewrite any sentence over 20 words by splitting it at a natural junction (full stop). Target 12–16 words. Common fixes: split clauses joined by 'which', 'that', 'because', 'since'; convert inline lists to bullet points; move parenthetical qualifications to their own sentence",
};

/**
 * Fix only the content fields that failed QA, leaving everything else intact.
 * Called on QA retry attempts 2 and 3 instead of a full regeneration.
 */
export async function fixBlogContent(
  title: string,
  previousContent: BlogContent,
  blueprint: Blueprint,
  selectedLinks: SelectedLinks,
  failingChecks: Record<string, boolean>,
  language?: string,
  brokenUrls?: string[],
  authorityLinks?: AuthorityLink[]
): Promise<BlogContent> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const failedKeys = Object.entries(failingChecks)
    .filter(([, passed]) => !passed)
    .map(([key]) => key)
    .filter((key) => !IMAGE_QA_CHECKS.includes(key));

  const fieldsToFix = [...new Set(failedKeys.flatMap((k) => CHECK_TO_FIELDS[k] ?? []))];

  // If no mapping found (unknown check key), there's nothing targeted to fix — skip silently
  // rather than returning unchanged content, log and proceed with whatever fields we do have.
  if (fieldsToFix.length === 0) {
    console.warn(`[fixBlogContent] No field mappings found for failing checks: ${failedKeys.join(", ")} — skipping content fix`);
    return previousContent;
  }

  const linksBlock = formatLinksForPrompt(selectedLinks, language);
  const authorityLinksBlock = authorityLinks && authorityLinks.length > 0
    ? `\n${formatAuthorityLinksForPrompt(authorityLinks, language)}\n`
    : "";

  const issueList = failedKeys
    .map((k, i) => `${i + 1}. ${CHECK_DESCRIPTIONS[k] ?? `"${k}" check failed`}`)
    .join("\n");

  const currentFieldsBlock = fieldsToFix
    .map((f) => {
      const val = (previousContent as unknown as Record<string, unknown>)[f] as string ?? "";
      return `--- ${f} (current — needs fixing) ---\n${val || "(empty)"}`;
    })
    .join("\n\n");

  const alreadyUsed = (previousContent.internal_links_used ?? [])
    .map((l) => `- ${l.url} (anchor: "${l.anchor}")`)
    .join("\n") || "None";

  const prompt = `You are fixing specific QA failures in a blog article for Aston VIP. Fix ONLY the fields listed below and return them as JSON.

ARTICLE CONTEXT:
Title: "${title}"
Focus keyword: "${blueprint.focus_keyword}"
Secondary keywords: ${blueprint.secondary_keywords.join(", ")}

ISSUES TO FIX:
${issueList}

CURRENT CONTENT OF FIELDS THAT NEED FIXING:
${currentFieldsBlock}

INTERNAL LINKS ALREADY PLACED in sections you are NOT fixing (do not duplicate these):
${alreadyUsed}

${linksBlock}
${authorityLinksBlock}
RULES:
- Fix every issue listed above — do not skip any
- British English throughout (except: always write "license" never "licence"), no colons in headings, sentence case, no em dashes
- For main_content: minimum 300 words, at least 2 H3 subheadings, exactly 1 internal link + at least 1 external link
- Sentence length across ALL fields you are fixing: hard maximum 20 words per sentence. Split any sentence at 18+ words. Target 12–16 words
- Across all sections combined: target 7 to 9 external links (minimum 5) — use ONLY the APPROVED EXTERNAL AUTHORITY SOURCES listed above${brokenUrls && brokenUrls.length > 0 ? `\n- The following external URLs were found to be BROKEN — do NOT reuse any of them:\n${brokenUrls.map((u) => `  • ${u}`).join("\n")}` : ""}
- Preserve all existing HTML structure within the fields you are fixing
- Do NOT change fields that are not listed above
- Return ONLY raw JSON — no markdown, no code fences, no explanation

Return this exact JSON shape with ONLY the fields that need fixing plus updated link arrays:
{
  ${fieldsToFix.map((f) => `"${f}": "string"`).join(",\n  ")},
  "internal_links_used": [{"anchor": "string", "url": "string"}],
  "external_links_used": [{"anchor": "string", "url": "string"}]
}

The "internal_links_used" and "external_links_used" arrays must include ALL links in the full article — both the ones already placed in untouched sections and any new ones you add.`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0.5,
    max_completion_tokens: 12000,
  }, { signal: AbortSignal.timeout(90_000) });

  if (response.choices[0]?.finish_reason === "length") {
    throw new Error("fixBlogContent response was cut off — increase max_completion_tokens");
  }

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`fixBlogContent: no JSON in response. Raw: ${raw.slice(0, 200)}`);

  const fixes = JSON.parse(jsonMatch[0]) as Partial<BlogContent>;

  // Safe merge: only apply non-empty values from GPT so a truncated response
  // can't wipe fields that were already good.
  const safeUpdates: Partial<BlogContent> = {};
  for (const [k, v] of Object.entries(fixes)) {
    if (typeof v === "string" && v.trim()) {
      safeUpdates[k as keyof BlogContent] = v as never;
    } else if (Array.isArray(v) && v.length > 0) {
      safeUpdates[k as keyof BlogContent] = v as never;
    }
  }

  // Enforce meta description ceiling so a bad GPT rewrite can't re-fail the check.
  if (safeUpdates.meta_description) {
    const md = safeUpdates.meta_description as string;
    if (md.length > 141) {
      safeUpdates.meta_description = md.slice(0, 141) as never;
    }
  }

  // Validate slug: must be lowercase hyphenated — reject if GPT returned garbage.
  if (safeUpdates.slug && !/^[a-z0-9-]+$/.test(safeUpdates.slug as string)) {
    delete safeUpdates.slug;
    console.warn("[fixBlogContent] GPT returned an invalid slug — keeping previous value");
  }

  return { ...previousContent, ...safeUpdates };
}

// ── Image generation ──────────────────────────────────────────

export type ImageModel = "imagen-4" | "gpt-image-1";

/**
 * Generate an image and return it as a Buffer.
 * Supports Imagen 4 (Google AI Studio) and GPT-image-1 (OpenAI).
 */
export async function generateImage(prompt: string, model: ImageModel = "imagen-4"): Promise<Buffer> {
  if (model === "gpt-image-1") {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
    }, { signal: AbortSignal.timeout(90_000) });

    const b64 = response.data?.[0]?.b64_json;
    if (b64) return Buffer.from(b64, "base64");

    const url = response.data?.[0]?.url;
    if (url) {
      const res = await fetch(url);
      return Buffer.from(await res.arrayBuffer());
    }

    throw new Error("GPT-image-1 returned no image data");
  }

  // Default: Imagen 4
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const timeoutMs = 90_000;
  const imagenPromise = ai.models.generateImages({
    model: "imagen-4.0-generate-001",
    prompt,
    config: {
      numberOfImages: 1,
      aspectRatio: "16:9",
    },
  });
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Imagen 4 timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  );
  const response = await Promise.race([imagenPromise, timeoutPromise]);

  const imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
  if (!imageBytes) throw new Error("Imagen 4 returned no image data");

  return Buffer.from(imageBytes, "base64");
}
