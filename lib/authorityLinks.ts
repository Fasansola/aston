/**
 * lib/authorityLinks.ts
 *
 * Curated list of real, verified external authority URLs for Aston VIP content.
 * GPT must use only these for external links — never invent URLs.
 *
 * Each entry: url, name, description (shown in prompt), and topics/jurisdictions
 * used for relevance scoring against the strategy.
 */

export interface AuthorityLink {
  url: string;
  name: string;
  description: string;
  topics: string[];         // keyword phrases matched against article topic + keywords
  jurisdictions: string[];  // matched against strategy.jurisdiction_map
}

export const AUTHORITY_LINKS: AuthorityLink[] = [
  // ── UAE ──────────────────────────────────────────────────────
  {
    url: "https://www.dfsa.ae",
    name: "Dubai Financial Services Authority (DFSA)",
    description: "financial services regulator for DIFC in Dubai",
    topics: ["DIFC", "financial services", "fund", "broker", "investment", "authorisation", "licence", "FSP", "DFSA"],
    jurisdictions: ["UAE", "DIFC", "Dubai"],
  },
  {
    url: "https://www.adgm.com",
    name: "Abu Dhabi Global Market (ADGM)",
    description: "international financial centre and regulator in Abu Dhabi",
    topics: ["ADGM", "Abu Dhabi", "financial centre", "fund", "investment", "company formation", "fintech"],
    jurisdictions: ["UAE", "ADGM", "Abu Dhabi"],
  },
  {
    url: "https://www.difc.ae",
    name: "Dubai International Financial Centre (DIFC)",
    description: "leading financial hub and free zone in Dubai",
    topics: ["DIFC", "Dubai", "financial centre", "free zone", "company setup", "fund", "fintech", "holding"],
    jurisdictions: ["UAE", "DIFC", "Dubai"],
  },
  {
    url: "https://www.centralbank.ae",
    name: "UAE Central Bank (CBUAE)",
    description: "central monetary authority of the United Arab Emirates",
    topics: ["banking", "UAE bank", "payment", "EMI", "money service", "AML", "exchange house", "PSP"],
    jurisdictions: ["UAE"],
  },
  {
    url: "https://www.vara.ae",
    name: "Virtual Assets Regulatory Authority (VARA)",
    description: "UAE regulator for virtual assets and cryptocurrency",
    topics: ["crypto", "virtual asset", "VASP", "VARA", "blockchain", "token", "exchange", "DeFi", "Web3"],
    jurisdictions: ["UAE", "Dubai"],
  },
  {
    url: "https://tax.gov.ae",
    name: "UAE Federal Tax Authority (FTA)",
    description: "UAE authority responsible for corporate tax and VAT",
    topics: ["UAE tax", "corporate tax", "VAT", "FTA", "tax registration", "tax residency", "CIT"],
    jurisdictions: ["UAE"],
  },
  {
    url: "https://www.moec.gov.ae",
    name: "UAE Ministry of Economy",
    description: "UAE federal ministry governing business licensing and economic policy",
    topics: ["UAE business", "trade licence", "mainland", "ministry", "company formation", "economic policy"],
    jurisdictions: ["UAE"],
  },
  {
    url: "https://www.dubaided.gov.ae",
    name: "Dubai Department of Economy and Tourism (DET)",
    description: "Dubai authority for mainland trade licences and business registration",
    topics: ["Dubai mainland", "trade licence", "DED", "business setup", "Dubai company", "Dubai licence"],
    jurisdictions: ["UAE", "Dubai"],
  },
  {
    url: "https://www.economy.sharjah.ae",
    name: "Sharjah Economic Development Department",
    description: "Sharjah authority for business licences and company formation",
    topics: ["Sharjah", "Sharjah business", "Sharjah licence", "UAE mainland"],
    jurisdictions: ["UAE", "Sharjah"],
  },
  // ── UK ───────────────────────────────────────────────────────
  {
    url: "https://www.fca.org.uk",
    name: "Financial Conduct Authority (FCA)",
    description: "UK financial services regulator",
    topics: ["FCA", "UK financial", "UK regulated", "UK broker", "UK fund", "EMI", "payment institution", "AML UK"],
    jurisdictions: ["UK", "United Kingdom", "Britain"],
  },
  {
    url: "https://www.bankofengland.co.uk",
    name: "Bank of England",
    description: "central bank and prudential regulator of the United Kingdom",
    topics: ["UK banking", "Bank of England", "PRA", "prudential", "systemic risk", "UK monetary"],
    jurisdictions: ["UK", "United Kingdom"],
  },
  {
    url: "https://www.gov.uk/government/organisations/companies-house",
    name: "Companies House (UK)",
    description: "UK government registry for company incorporation and filings",
    topics: ["UK company", "Companies House", "UK incorporation", "UK registration", "UK limited company", "UK LLP"],
    jurisdictions: ["UK", "United Kingdom", "England", "Wales", "Scotland"],
  },
  {
    url: "https://www.gov.uk/government/organisations/hm-revenue-customs",
    name: "HM Revenue & Customs (HMRC)",
    description: "UK tax authority responsible for corporate tax, VAT, and income tax",
    topics: ["UK tax", "HMRC", "UK corporate tax", "UK VAT", "UK income tax", "UK CGT", "UK reporting"],
    jurisdictions: ["UK", "United Kingdom"],
  },
  // ── EU ───────────────────────────────────────────────────────
  {
    url: "https://www.esma.europa.eu",
    name: "European Securities and Markets Authority (ESMA)",
    description: "EU authority for securities markets and investment services regulation",
    topics: ["ESMA", "EU fund", "AIFMD", "UCITS", "MiFID", "EU investment", "EU securities"],
    jurisdictions: ["EU", "Europe", "European Union"],
  },
  {
    url: "https://www.eba.europa.eu",
    name: "European Banking Authority (EBA)",
    description: "EU banking regulator and supervisory authority",
    topics: ["EBA", "EU banking", "EU payment", "EU EMI", "CRD", "AML Europe", "EU fintech"],
    jurisdictions: ["EU", "Europe", "European Union"],
  },
  {
    url: "https://ec.europa.eu",
    name: "European Commission",
    description: "executive body of the European Union responsible for legislation and policy",
    topics: ["EU law", "EU directive", "EU regulation", "GDPR", "AML directive", "EU policy", "MiCA"],
    jurisdictions: ["EU", "Europe", "European Union"],
  },
  {
    url: "https://www.ecb.europa.eu",
    name: "European Central Bank (ECB)",
    description: "central bank of the eurozone",
    topics: ["ECB", "eurozone", "EU monetary", "Euro banking", "EU interest rate"],
    jurisdictions: ["EU", "Europe", "Eurozone"],
  },
  // ── Cyprus ───────────────────────────────────────────────────
  {
    url: "https://www.cysec.gov.cy",
    name: "Cyprus Securities and Exchange Commission (CySEC)",
    description: "Cyprus financial services regulator within the EU framework",
    topics: ["CySEC", "Cyprus", "Cyprus fund", "Cyprus broker", "Cyprus investment", "Cyprus licence"],
    jurisdictions: ["Cyprus", "EU"],
  },
  {
    url: "https://www.investcyprus.org.cy",
    name: "Invest Cyprus",
    description: "official Cyprus investment promotion body",
    topics: ["Cyprus investment", "Cyprus business", "Cyprus company", "Cyprus holding", "Cyprus IP box"],
    jurisdictions: ["Cyprus"],
  },
  // ── Germany ──────────────────────────────────────────────────
  {
    url: "https://www.bafin.de",
    name: "BaFin (Germany)",
    description: "German Federal Financial Supervisory Authority",
    topics: ["BaFin", "Germany", "German bank", "German financial", "German licence", "German fund"],
    jurisdictions: ["Germany", "Deutschland"],
  },
  {
    url: "https://www.bundesbank.de",
    name: "Deutsche Bundesbank",
    description: "German central bank",
    topics: ["Bundesbank", "German banking", "Germany monetary", "German payment"],
    jurisdictions: ["Germany"],
  },
  // ── Switzerland ──────────────────────────────────────────────
  {
    url: "https://www.finma.ch",
    name: "FINMA (Switzerland)",
    description: "Swiss Financial Market Supervisory Authority",
    topics: ["FINMA", "Switzerland", "Swiss bank", "Swiss financial", "Swiss fund", "Swiss licence"],
    jurisdictions: ["Switzerland", "Swiss"],
  },
  // ── Singapore ────────────────────────────────────────────────
  {
    url: "https://www.mas.gov.sg",
    name: "Monetary Authority of Singapore (MAS)",
    description: "Singapore's central bank and integrated financial regulator",
    topics: ["MAS", "Singapore", "Singapore fund", "Singapore bank", "Singapore licence", "Singapore fintech"],
    jurisdictions: ["Singapore"],
  },
  // ── Hong Kong ────────────────────────────────────────────────
  {
    url: "https://www.sfc.hk",
    name: "Securities and Futures Commission (SFC) Hong Kong",
    description: "Hong Kong financial services and securities regulator",
    topics: ["SFC", "Hong Kong", "HK fund", "HK broker", "HK financial", "HK licence"],
    jurisdictions: ["Hong Kong", "HK"],
  },
  {
    url: "https://www.hkma.gov.hk",
    name: "Hong Kong Monetary Authority (HKMA)",
    description: "Hong Kong central banking institution",
    topics: ["HKMA", "Hong Kong banking", "HK bank", "Hong Kong monetary"],
    jurisdictions: ["Hong Kong"],
  },
  // ── Offshore ─────────────────────────────────────────────────
  {
    url: "https://www.cima.ky",
    name: "Cayman Islands Monetary Authority (CIMA)",
    description: "regulatory body for financial services in the Cayman Islands",
    topics: ["Cayman", "Cayman Islands", "Cayman fund", "offshore fund", "exempted company"],
    jurisdictions: ["Cayman Islands", "Cayman"],
  },
  {
    url: "https://www.bvifsc.vg",
    name: "BVI Financial Services Commission",
    description: "financial services regulator of the British Virgin Islands",
    topics: ["BVI", "British Virgin Islands", "BVI company", "BVI fund", "offshore BVI"],
    jurisdictions: ["BVI", "British Virgin Islands"],
  },
  {
    url: "https://www.fscmauritius.org",
    name: "Financial Services Commission Mauritius",
    description: "Mauritius financial services and global business regulator",
    topics: ["Mauritius", "Mauritius fund", "GBC", "Mauritius company", "Mauritius holding"],
    jurisdictions: ["Mauritius"],
  },
  {
    url: "https://www.iomfsa.im",
    name: "Isle of Man Financial Services Authority",
    description: "Isle of Man financial services regulator",
    topics: ["Isle of Man", "IOM", "IOM fund", "IOM company", "IOM licence"],
    jurisdictions: ["Isle of Man"],
  },
  // ── International ────────────────────────────────────────────
  {
    url: "https://www.oecd.org",
    name: "OECD",
    description: "Organisation for Economic Co-operation and Development — global economic policy and tax standards",
    topics: ["OECD", "BEPS", "transfer pricing", "global tax", "CRS", "FATCA", "tax treaty", "Pillar Two"],
    jurisdictions: [],
  },
  {
    url: "https://www.imf.org",
    name: "International Monetary Fund (IMF)",
    description: "international financial institution providing global economic data and policy",
    topics: ["IMF", "global economy", "international finance", "monetary", "balance of payments"],
    jurisdictions: [],
  },
  {
    url: "https://www.worldbank.org",
    name: "World Bank",
    description: "international development finance institution and global data source",
    topics: ["World Bank", "developing economy", "FDI", "global investment", "ease of doing business"],
    jurisdictions: [],
  },
  {
    url: "https://www.bis.org",
    name: "Bank for International Settlements (BIS)",
    description: "international organisation fostering central bank cooperation and global financial stability",
    topics: ["BIS", "Basel", "Basel III", "capital adequacy", "global banking regulation", "prudential"],
    jurisdictions: [],
  },
  {
    url: "https://www.fatf-gafi.org",
    name: "Financial Action Task Force (FATF)",
    description: "global AML/CFT standard-setting body",
    topics: ["FATF", "AML", "CFT", "anti-money laundering", "compliance", "grey list", "blacklist", "KYC"],
    jurisdictions: [],
  },
  {
    url: "https://www.fsb.org",
    name: "Financial Stability Board (FSB)",
    description: "international body monitoring and making recommendations on the global financial system",
    topics: ["FSB", "financial stability", "systemic risk", "global regulation", "crypto regulation"],
    jurisdictions: [],
  },
];

// ── Scoring & selection ───────────────────────────────────────

function score(link: AuthorityLink, topicText: string, jurisdictions: string[]): number {
  const haystack = topicText.toLowerCase();
  let s = 0;

  for (const kw of link.topics) {
    if (haystack.includes(kw.toLowerCase())) s += kw.split(" ").length;
  }
  for (const j of link.jurisdictions) {
    if (jurisdictions.some((x) => x.toLowerCase().includes(j.toLowerCase()))) s += 3;
  }

  return s;
}

/**
 * Return the most relevant authority links for a given topic and jurisdiction list.
 * Always returns at least `min` entries, padding with top global institutions if needed.
 */
export function selectAuthorityLinks(
  topicText: string,
  jurisdictions: string[],
  min = 10,
  max = 15
): AuthorityLink[] {
  const scored = AUTHORITY_LINKS.map((l) => ({ l, s: score(l, topicText, jurisdictions) }))
    .sort((a, b) => b.s - a.s);

  const relevant = scored.filter(({ s }) => s > 0).map(({ l }) => l);
  const fallback = scored.filter(({ s }) => s === 0).map(({ l }) => l);

  const result = relevant.slice(0, max);

  // Pad with top-scoring global institutions if below minimum
  for (const l of fallback) {
    if (result.length >= min) break;
    result.push(l);
  }

  return result.slice(0, max);
}

/** Format the authority link list for injection into the content generation prompt. */
export function formatAuthorityLinksForPrompt(links: AuthorityLink[]): string {
  const lines = links.map((l) => `- ${l.url} — ${l.name}: ${l.description}`).join("\n");
  return `APPROVED EXTERNAL AUTHORITY SOURCES
These are real, verified URLs. You MUST use only these for external links — do NOT invent external URLs or use any URL not listed here. Pick the most contextually relevant ones and embed them naturally inside sentences:

${lines}`;
}
