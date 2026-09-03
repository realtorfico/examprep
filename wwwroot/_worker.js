/**
 * examprep public-site Worker (Cloudflare Pages "Advanced Mode" -- this file must be
 * named _worker.js at the root of the deployed directory).
 *
 * /api/* is forwarded to the examprep-api Worker via a Service Binding (env.API) --
 * same-origin from the browser's perspective (so the bearer token in localStorage
 * never has to deal with cross-origin cookie/CORS rules), and no public hostname
 * needed for the backend at all. Everything else falls through to the static
 * assets (Pages provides env.ASSETS automatically alongside _worker.js).
 *
 * /mcp is forwarded the same way, unchanged (no prefix to strip) -- it's the public,
 * unauthenticated remote MCP server (see examprep-api's handleMcp) that AI assistants and
 * Cloudflare's WebMCP bridge script (Dashboard > Agent Readiness > Labs, data-mcp-url="/mcp")
 * call directly, kept at a clean top-level path since that's the conventional MCP endpoint
 * shape external clients/directories look for.
 *
 * Category-first URL scheme (2026-08-24 restructure): tracks now live at
 * /{category-slug}/{state} (e.g. /notary/ny), and bare /{category-slug} (e.g. /notary) is a
 * category landing page listing every state. TRACK_REDIRECTS below is a generated, exhaustive
 * old-route -> new-route map for every previously-indexed/bookmarked track URL (the old
 * /{state}_{category} convention, e.g. /ny_notary) -- 301 (permanent) since these are real
 * external links/search-engine-indexed URLs, not internal navigation. KIND_SLUGS mirrors
 * app.js's HUB_KIND_SLUGS (kept in sync by hand -- this Worker has no shared-module access to
 * app.js) so old /{state}/{kind-slug} filtered-hub URLs (e.g. /ny/real-estate) can redirect to
 * their new category page too, carrying the visitor's state forward via the pxq_state cookie
 * rather than losing it. A bare old /{state} URL (e.g. /ny) has nowhere state-specific to land
 * anymore (there's no more per-state hub under category-first routing) -- redirects to "/",
 * likewise carrying the state forward via the cookie.
 *
 * Exception: CA's 3 legacy unprefixed track routes (/notary, /cdl, /motorcycle) are NOT in
 * TRACK_REDIRECTS -- those bare paths are now claimed by the Notary/CDL/Motorcycle category
 * pages themselves, which is the correct behavior under the new scheme (a visitor with an old
 * CA bookmark lands on the category page and picks California from there, rather than being
 * force-redirected past it).
 *
 * pxq_state cookie: written by app.js whenever a visitor lands on/picks a state (see
 * setStateCookie in app.js), and by this Worker's redirects below when an old URL already names
 * a state explicitly. Read here only for the (now-removed) root geolocation redirect's
 * replacement below -- app.js itself doesn't read it back yet (that lands with the real
 * category-page template, phase 4 of the restructure) -- so today it's purely a "for next time"
 * signal, same spirit as a "remember my region" preference.
 */
const KNOWN_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY',
  'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY',
]);

const KIND_SLUGS = {
  'real-estate-salesperson': true,
  'real-estate-broker': true,
  'driver': true,
  'cdl': true,
  'motorcycle': true,
  'boating': true,
  'notary': true,
  'mlo': true,
};

// Old /{state}/{kind-slug} URLs used 'real-estate' as the kind slug (examKind was undifferentiated
// 'Real Estate' before the 2026-08-24 salesperson/broker split) -- redirect those to the new
// general category, since the old filtered-hub route had no way to express "broker" specifically.
const LEGACY_KIND_SLUG_ALIASES = { 'real-estate': 'real-estate-salesperson' };

// Old /{state}_{category} track URL -> new /{category-slug}/{state} track URL. Generated
// 2026-08-24 from HUB_EXAMS (see Websites/passexamhq's category-first restructure) -- if a new
// track is added under the OLD convention this list obviously can't include it (there is no old
// URL to redirect from), so this is a fixed, closed set from the migration, not something that
// needs updating for new tracks going forward.
const TRACK_REDIRECTS = {
  '/ak_cdl': '/cdl/ak',
  '/ak_driver': '/driver/ak',
  '/ak_notary': '/notary/ak',
  '/ak_real_estate': '/real-estate-salesperson/ak',
  '/al_cdl': '/cdl/al',
  '/al_driver': '/driver/al',
  '/al_notary': '/notary/al',
  '/al_real_estate': '/real-estate-salesperson/al',
  '/ar_cdl': '/cdl/ar',
  '/ar_driver': '/driver/ar',
  '/ar_notary': '/notary/ar',
  '/ar_real_estate': '/real-estate-salesperson/ar',
  '/az_cdl': '/cdl/az',
  '/az_driver': '/driver/az',
  '/az_notary': '/notary/az',
  '/az_real_estate': '/real-estate-salesperson/az',
  '/ca_driver': '/driver/ca',
  '/ca_real_estate': '/real-estate-salesperson/ca',
  '/co_cdl': '/cdl/co',
  '/co_driver': '/driver/co',
  '/co_notary': '/notary/co',
  '/co_real_estate': '/real-estate-salesperson/co',
  '/ct_cdl': '/cdl/ct',
  '/ct_driver': '/driver/ct',
  '/ct_notary': '/notary/ct',
  '/ct_real_estate': '/real-estate-salesperson/ct',
  '/de_cdl': '/cdl/de',
  '/de_driver': '/driver/de',
  '/de_notary': '/notary/de',
  '/de_real_estate': '/real-estate-salesperson/de',
  '/fl_cdl': '/cdl/fl',
  '/fl_driver': '/driver/fl',
  '/fl_notary': '/notary/fl',
  '/fl_real_estate': '/real-estate-salesperson/fl',
  '/ga_cdl': '/cdl/ga',
  '/ga_driver': '/driver/ga',
  '/ga_motorcycle': '/motorcycle/ga',
  '/ga_notary': '/notary/ga',
  '/ga_real_estate': '/real-estate-salesperson/ga',
  '/hi_cdl': '/cdl/hi',
  '/hi_driver': '/driver/hi',
  '/hi_notary': '/notary/hi',
  '/hi_real_estate': '/real-estate-salesperson/hi',
  '/ia_cdl': '/cdl/ia',
  '/ia_driver': '/driver/ia',
  '/ia_notary': '/notary/ia',
  '/ia_real_estate': '/real-estate-salesperson/ia',
  '/id_cdl': '/cdl/id',
  '/id_driver': '/driver/id',
  '/id_notary': '/notary/id',
  '/id_real_estate': '/real-estate-salesperson/id',
  '/il_cdl': '/cdl/il',
  '/il_driver': '/driver/il',
  '/il_managing_broker': '/real-estate-broker/il',
  '/il_notary': '/notary/il',
  '/il_real_estate': '/real-estate-salesperson/il',
  '/in_cdl': '/cdl/in',
  '/in_driver': '/driver/in',
  '/in_notary': '/notary/in',
  '/in_real_estate': '/real-estate-salesperson/in',
  '/ks_cdl': '/cdl/ks',
  '/ks_driver': '/driver/ks',
  '/ks_notary': '/notary/ks',
  '/ks_real_estate': '/real-estate-salesperson/ks',
  '/ky_cdl': '/cdl/ky',
  '/ky_driver': '/driver/ky',
  '/ky_notary': '/notary/ky',
  '/ky_real_estate': '/real-estate-salesperson/ky',
  '/la_cdl': '/cdl/la',
  '/la_driver': '/driver/la',
  '/la_notary': '/notary/la',
  '/la_real_estate': '/real-estate-salesperson/la',
  '/ma_cdl': '/cdl/ma',
  '/ma_driver': '/driver/ma',
  '/ma_notary': '/notary/ma',
  '/ma_real_estate': '/real-estate-salesperson/ma',
  '/md_cdl': '/cdl/md',
  '/md_driver': '/driver/md',
  '/md_notary': '/notary/md',
  '/md_real_estate': '/real-estate-salesperson/md',
  '/me_cdl': '/cdl/me',
  '/me_driver': '/driver/me',
  '/me_notary': '/notary/me',
  '/me_real_estate': '/real-estate-salesperson/me',
  '/mi_boating': '/boating/mi',
  '/mi_cdl': '/cdl/mi',
  '/mi_driver': '/driver/mi',
  '/mi_motorcycle': '/motorcycle/mi',
  '/mi_notary': '/notary/mi',
  '/mi_real_estate': '/real-estate-salesperson/mi',
  '/mn_cdl': '/cdl/mn',
  '/mn_driver': '/driver/mn',
  '/mn_notary': '/notary/mn',
  '/mn_real_estate': '/real-estate-salesperson/mn',
  '/mo_cdl': '/cdl/mo',
  '/mo_driver': '/driver/mo',
  '/mo_notary': '/notary/mo',
  '/mo_real_estate': '/real-estate-salesperson/mo',
  '/ms_cdl': '/cdl/ms',
  '/ms_driver': '/driver/ms',
  '/ms_notary': '/notary/ms',
  '/ms_real_estate': '/real-estate-salesperson/ms',
  '/mt_cdl': '/cdl/mt',
  '/mt_driver': '/driver/mt',
  '/mt_notary': '/notary/mt',
  '/mt_real_estate': '/real-estate-salesperson/mt',
  '/nc_boating': '/boating/nc',
  '/nc_cdl': '/cdl/nc',
  '/nc_driver': '/driver/nc',
  '/nc_notary': '/notary/nc',
  '/nc_real_estate': '/real-estate-salesperson/nc',
  '/nd_cdl': '/cdl/nd',
  '/nd_driver': '/driver/nd',
  '/nd_notary': '/notary/nd',
  '/nd_real_estate': '/real-estate-salesperson/nd',
  '/ne_cdl': '/cdl/ne',
  '/ne_driver': '/driver/ne',
  '/ne_notary': '/notary/ne',
  '/ne_real_estate': '/real-estate-salesperson/ne',
  '/nh_cdl': '/cdl/nh',
  '/nh_driver': '/driver/nh',
  '/nh_notary': '/notary/nh',
  '/nh_real_estate': '/real-estate-salesperson/nh',
  '/nj_cdl': '/cdl/nj',
  '/nj_driver': '/driver/nj',
  '/nj_notary': '/notary/nj',
  '/nj_real_estate': '/real-estate-salesperson/nj',
  '/nm_cdl': '/cdl/nm',
  '/nm_driver': '/driver/nm',
  '/nm_notary': '/notary/nm',
  '/nm_real_estate': '/real-estate-salesperson/nm',
  '/nv_cdl': '/cdl/nv',
  '/nv_driver': '/driver/nv',
  '/nv_notary': '/notary/nv',
  '/nv_real_estate': '/real-estate-salesperson/nv',
  '/ny_cdl': '/cdl/ny',
  '/ny_driver': '/driver/ny',
  '/ny_notary': '/notary/ny',
  '/ny_real_estate': '/real-estate-salesperson/ny',
  '/oh_boating': '/boating/oh',
  '/oh_cdl': '/cdl/oh',
  '/oh_driver': '/driver/oh',
  '/oh_motorcycle': '/motorcycle/oh',
  '/oh_notary': '/notary/oh',
  '/oh_real_estate': '/real-estate-salesperson/oh',
  '/ok_cdl': '/cdl/ok',
  '/ok_driver': '/driver/ok',
  '/ok_notary': '/notary/ok',
  '/ok_real_estate': '/real-estate-salesperson/ok',
  '/or_cdl': '/cdl/or',
  '/or_driver': '/driver/or',
  '/or_notary': '/notary/or',
  '/or_real_estate': '/real-estate-salesperson/or',
  '/pa_cdl': '/cdl/pa',
  '/pa_driver': '/driver/pa',
  '/pa_notary': '/notary/pa',
  '/pa_real_estate': '/real-estate-salesperson/pa',
  '/ri_cdl': '/cdl/ri',
  '/ri_driver': '/driver/ri',
  '/ri_notary': '/notary/ri',
  '/ri_real_estate': '/real-estate-salesperson/ri',
  '/sc_cdl': '/cdl/sc',
  '/sc_driver': '/driver/sc',
  '/sc_notary': '/notary/sc',
  '/sc_real_estate': '/real-estate-salesperson/sc',
  '/sd_cdl': '/cdl/sd',
  '/sd_driver': '/driver/sd',
  '/sd_notary': '/notary/sd',
  '/sd_real_estate': '/real-estate-salesperson/sd',
  '/tn_cdl': '/cdl/tn',
  '/tn_driver': '/driver/tn',
  '/tn_notary': '/notary/tn',
  '/tn_real_estate': '/real-estate-salesperson/tn',
  '/tx_cdl': '/cdl/tx',
  '/tx_driver': '/driver/tx',
  '/tx_notary': '/notary/tx',
  '/tx_real_estate': '/real-estate-salesperson/tx',
  '/ut_cdl': '/cdl/ut',
  '/ut_driver': '/driver/ut',
  '/ut_notary': '/notary/ut',
  '/ut_real_estate': '/real-estate-salesperson/ut',
  '/va_boating': '/boating/va',
  '/va_cdl': '/cdl/va',
  '/va_driver': '/driver/va',
  '/va_motorcycle': '/motorcycle/va',
  '/va_notary': '/notary/va',
  '/va_real_estate': '/real-estate-salesperson/va',
  '/vt_cdl': '/cdl/vt',
  '/vt_driver': '/driver/vt',
  '/vt_notary': '/notary/vt',
  '/vt_real_estate': '/real-estate-salesperson/vt',
  '/wa_cdl': '/cdl/wa',
  '/wa_driver': '/driver/wa',
  '/wa_managing_broker': '/real-estate-broker/wa',
  '/wa_motorcycle': '/motorcycle/wa',
  '/wa_notary': '/notary/wa',
  '/wa_real_estate': '/real-estate-salesperson/wa',
  '/wi_cdl': '/cdl/wi',
  '/wi_driver': '/driver/wi',
  '/wi_notary': '/notary/wi',
  '/wi_real_estate': '/real-estate-salesperson/wi',
  '/wv_cdl': '/cdl/wv',
  '/wv_driver': '/driver/wv',
  '/wv_notary': '/notary/wv',
  '/wv_real_estate': '/real-estate-salesperson/wv',
  '/wy_cdl': '/cdl/wy',
  '/wy_driver': '/driver/wy',
  '/wy_notary': '/notary/wy',
  '/wy_real_estate': '/real-estate-salesperson/wy',
};

// Per-route <title>/<meta name="description"> overrides for category and track pages, plus the
// sitemap.xml URL list -- both generated from HUB_EXAMS by scripts/generate-seo-meta.js (the
// SEO_META_START
const SEO_META = {
  '/notary': { title: 'Notary Public Exam Prep — Practice Tests for Every State | PassExamHQ', description: 'Practice questions for your state\'s notary public exam, built from official handbooks. Instant access, no subscription.' },
  '/driver': { title: 'Driver\'s License Knowledge Test Practice — All 50 States | PassExamHQ', description: 'Practice questions for your state DMV written permit test, based on the current official driver handbook. Instant access.' },
  '/cdl': { title: 'CDL Practice Test — Commercial Driver\'s License Exam Prep | PassExamHQ', description: 'Practice questions covering general knowledge, air brakes, combination vehicles, and endorsements for your state CDL exam.' },
  '/motorcycle': { title: 'Motorcycle Permit Practice Test — Knowledge Exam Prep | PassExamHQ', description: 'Practice questions for your state motorcycle knowledge test, covering safe riding, hazards, and licensing requirements.' },
  '/boating': { title: 'Boating Safety Exam Practice Test | PassExamHQ', description: 'Practice questions for your state boating safety certification exam, built from official course material.' },
  '/real-estate-salesperson': { title: 'Real Estate Salesperson Exam Prep — Practice Questions by State | PassExamHQ', description: 'Practice questions for your state real estate salesperson licensing exam, covering state law and licensing requirements.' },
  '/real-estate-broker': { title: 'Real Estate Managing Broker Exam Prep | PassExamHQ', description: 'Practice questions for your state managing broker upgrade exam, covering supervisory duties and brokerage law.' },
  '/mlo': { title: 'NMLS SAFE MLO Exam Prep | PassExamHQ', description: 'Practice questions for the NMLS SAFE national Mortgage Loan Originator exam.' },
  '/notary/ca': { title: 'California Notary Public Exam | PassExamHQ', description: 'Practice questions covering the California notary handbook: statutory fees, thumbprint rules, journal requirements, and civil/criminal misconduct exposure.' },
  '/driver/ca': { title: 'California Driver Knowledge Test (Class C) | PassExamHQ', description: 'Practice questions covering the 2025 California DMV Driver\'s Handbook, weighted by its own real section structure: licensing and introduction to driving,…' },
  '/cdl/ca': { title: 'California CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the California Commercial Driver Handbook (DMV), weighted by its own real section lengths: the General Knowledge test content…' },
  '/motorcycle/ca': { title: 'California Motorcycle Knowledge Test (M1/M2) | PassExamHQ', description: 'Practice questions covering the 2024 California DMV Motorcycle Handbook, weighted by its own real section structure: license requirements and preparing…' },
  '/driver/tx': { title: 'Texas Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the Texas Driver Handbook (DPS), weighted by its own real 14-chapter structure: licensing and testing, vehicle…' },
  '/cdl/tx': { title: 'Texas CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Texas Commercial Motor Vehicle Driver Handbook (DPS, AAMVA content, revised March 2026), weighted by its own real section…' },
  '/driver/fl': { title: 'Florida Class E Knowledge Exam | PassExamHQ', description: 'Practice questions covering the Florida Driver License Handbook (FLHSMV), weighted by its own real 10-chapter section structure: driver licenses/IDs and…' },
  '/cdl/fl': { title: 'Florida CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Florida Commercial Driver License Handbook (FLHSMV), weighted by its own real section lengths: the General Knowledge test…' },
  '/driver/ny': { title: 'New York Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the New York State Driver\'s Manual: licensing and learner permit rules, right-of-way and traffic control,…' },
  '/cdl/ny': { title: 'New York CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the New York State Commercial Driver\'s Manual (CDL-10), weighted by its own real section lengths: the General Knowledge test…' },
  '/notary/ny': { title: 'New York Notary Public Exam | PassExamHQ', description: 'Practice questions covering the New York Notary Public License Law: appointment and professional conduct, powers and duties, statutory fees, real…' },
  '/driver/il': { title: 'Illinois Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the Illinois Rules of the Road: licensing and exam procedures, roadway signs and signals, traffic laws, safe driving and…' },
  '/real-estate-salesperson/il': { title: 'Illinois Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the Illinois Real Estate License Act of 2000 (225 ILCS 454): licensing requirements, the License Act itself, additional…' },
  '/real-estate-broker/il': { title: 'Illinois Managing Broker Exam | PassExamHQ', description: 'Practice questions covering the Illinois Real Estate License Act of 2000 (225 ILCS 454) for the Managing Broker upgrade credential, scoped to PSI/IDFPR\'s…' },
  '/driver/pa': { title: 'Pennsylvania Driver\'s License Knowledge Test | PassExamHQ', description: 'Practice questions covering the Pennsylvania Driver\'s Manual (PennDOT, PUB 95), weighted by its own real 6-chapter page structure: introduction/learner\'s…' },
  '/cdl/pa': { title: 'Pennsylvania CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Pennsylvania Commercial Driver\'s Manual (PennDOT, PUB223), weighted by its own real section lengths: the General…' },
  '/real-estate-salesperson/pa': { title: 'Pennsylvania Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering 49 Pa. Code Chapter 35 (State Real Estate Commission regulations): the Real Estate Commission, licensure, agency and…' },
  '/real-estate-salesperson/ca': { title: 'California DRE Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the California Real Estate Law (Business and Professions Code, Division 4), scoped to DRE\'s own official RE 425 exam content…' },
  '/real-estate-broker/ca': { title: 'California Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the California Real Estate Law (Business and Professions Code, Division 4) at broker level, scoped to the DRE\'s own official…' },
  '/driver/oh': { title: 'Ohio Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the current Ohio Driver\'s Manual (BMV), weighted by its own real 13-section page structure: licensing process and…' },
  '/cdl/oh': { title: 'Ohio CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Ohio CDL Manual (BMV, 2025 AAMVA content), weighted by its own real 13-section lengths: the General Knowledge test…' },
  '/motorcycle/oh': { title: 'Ohio Motorcycle Written Knowledge Test | PassExamHQ', description: 'Practice questions covering the current Ohio Motorcycle Operator Manual (Motorcycle Ohio / ODPS), weighted by its own real section structure: basic…' },
  '/real-estate-salesperson/oh': { title: 'Ohio Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Ohio Revised Code Chapter 4735 (Real Estate Brokers) and Ohio Administrative Code Chapter 1301:5, scoped and weighted to…' },
  '/boating/oh': { title: 'Ohio Boater Education Certification Exam | PassExamHQ', description: 'Practice questions covering the Ohio Boat Operators Guide (ODNR Division of Parks & Watercraft), weighted by the real guide\'s own page structure:…' },
  '/driver/ga': { title: 'Georgia Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the 2023-2024 Georgia Driver\'s Manual (Department of Driver Services), weighted by its own real chapter page-space: general…' },
  '/cdl/ga': { title: 'Georgia CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Georgia CDL Manual/Study Guide (Department of Driver Services, AAMVA-based content): the General Knowledge test content…' },
  '/motorcycle/ga': { title: 'Georgia Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the Georgia Motorcycle Operator\'s Manual (Department of Driver Services), weighted by its own real chapter page-space: DDS…' },
  '/real-estate-salesperson/ga': { title: 'Georgia Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Georgia Salesperson Supplement Examination, scoped to GREC/PSI\'s own official Candidate Information Bulletin content…' },
  '/driver/nc': { title: 'North Carolina Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the North Carolina Driver\'s Handbook by its own real 7-chapter structure: licensing, permits and required documents, alcohol…' },
  '/cdl/nc': { title: 'North Carolina CDL (Commercial Driver\'s License) Exam | PassExamHQ', description: 'Practice questions covering the North Carolina CDL Manual (2005 CDL Testing System, AAMVA), weighted by its own real section lengths: the General…' },
  '/real-estate-salesperson/nc': { title: 'North Carolina Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the North Carolina Real Estate License Law and Commission Rules, scoped and weighted to the North Carolina Real Estate…' },
  '/notary/nc': { title: 'North Carolina Notary Public Exam | PassExamHQ', description: 'Practice questions covering the North Carolina Notary Public Act (General Statutes Chapter 10B), weighted by each Article/Part\'s real statutory text…' },
  '/boating/nc': { title: 'North Carolina Boater Education Certification Exam | PassExamHQ', description: 'Practice questions covering the North Carolina Vessel Operator\'s Guide: registration, safety education and required equipment, boating accidents, rules…' },
  '/driver/va': { title: 'Virginia Driver License Knowledge Exam | PassExamHQ', description: 'Practice questions covering the Virginia Driver\'s Manual: traffic signals, signs and pavement markings, space cushion, sharing the road and hazardous…' },
  '/cdl/va': { title: 'Virginia CDL (Commercial Driver\'s License) Exam | PassExamHQ', description: 'Practice questions covering the Virginia CDL Manual: vehicle control, air brakes and combination vehicles, CDL licensing and driving safety, hazardous…' },
  '/motorcycle/va': { title: 'Virginia Motorcycle Knowledge Exam | PassExamHQ', description: 'Practice questions covering the Virginia Motorcycle Rider\'s Manual: visibility, lane positioning and following distance, gear, pre-ride inspection and…' },
  '/real-estate-salesperson/va': { title: 'Virginia Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Virginia Code Chapter 21 (Real Estate Board) and 18VAC135-20: licensing, qualifications, continuing education and escrow…' },
  '/real-estate-broker/va': { title: 'Virginia Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering PSI Services LLC\'s official Virginia Real Estate Broker exam content outline (administered on behalf of the Virginia…' },
  '/boating/va': { title: 'Virginia Boating Safety Education Exam | PassExamHQ', description: 'Practice questions covering the Virginia DWR Boater\'s Guide: required safety equipment, operating laws and safety course requirements, safety, accidents…' },
  '/driver/mi': { title: 'Michigan Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the Michigan Driver\'s Manual (Secretary of State), weighted by its own real 7-chapter page structure: your driver\'s license…' },
  '/cdl/mi': { title: 'Michigan CDL (Commercial Driver\'s License) Exam | PassExamHQ', description: 'Practice questions covering the Michigan Commercial Driver License Manual, weighted by its own real section page lengths: the General Knowledge test…' },
  '/motorcycle/mi': { title: 'Michigan Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the Michigan Motorcycle Operator Manual: licensing, permits and endorsement requirements, Michigan motorcycle laws and…' },
  '/boating/mi': { title: 'Michigan Boater Safety Certification Exam | PassExamHQ', description: 'Practice questions covering Michigan Boating Laws and Responsibilities: required safety equipment, boating basics and navigation rules, operating laws,…' },
  '/boating/ca': { title: 'California Boater Card Knowledge Exam | PassExamHQ', description: 'Practice questions covering California\'s Boater Card education requirement (California State Parks Division of Boating and Waterways, DBW): boat types…' },
  '/boating/tx': { title: 'Texas Boater Education Knowledge Exam | PassExamHQ', description: 'Practice questions covering Texas\'s boater education requirement (Texas Parks & Wildlife Department, TPWD) and the Texas Boating Laws and…' },
  '/boating/fl': { title: 'Florida Boating Safety Education Knowledge Exam | PassExamHQ', description: 'Practice questions covering Florida\'s Boating Safety Education ID Card requirement (Florida Fish and Wildlife Conservation Commission, FWC) and the…' },
  '/boating/ny': { title: 'New York Boater Safety Certificate Exam (Brianna\'s Law) | PassExamHQ', description: 'Practice questions covering New York\'s Brianna\'s Law boater safety certificate requirement (New York State Office of Parks, Recreation and Historic…' },
  '/boating/pa': { title: 'Pennsylvania Boating Safety Education Certificate Exam | PassExamHQ', description: 'Practice questions covering the Pennsylvania Boating Safety Education Certificate requirement (Pennsylvania Fish and Boat Commission, PFBC) and the…' },
  '/boating/il': { title: 'Illinois Boating Safety Certificate Exam | PassExamHQ', description: 'Practice questions covering the Handbook of Illinois Boating Laws and Responsibilities (Illinois Department of Natural Resources): vessel basics,…' },
  '/boating/ga': { title: 'Georgia Boating Education Exam | PassExamHQ', description: 'Practice questions covering the Handbook of Georgia Boating Laws and Responsibilities (Kalkomey/Boat-Ed course material, approved by the Georgia…' },
  '/boating/nj': { title: 'New Jersey Boat Safety Certificate Exam | PassExamHQ', description: 'Practice questions covering the New Jersey Boat Safety Certificate program (NJ State Police Marine Services Bureau): vessel basics, required equipment…' },
  '/boating/wa': { title: 'Washington Boater Education Card Exam | PassExamHQ', description: 'Practice questions covering the Washington Boating Program handbook (Washington State Parks): vessel basics, required equipment and nighttime navigation,…' },
  '/boating/az': { title: 'Arizona Boating Safety Course Exam | PassExamHQ', description: 'Practice questions covering The Boater\'s Guide of Arizona (Arizona Game and Fish Department): vessel basics, required equipment and navigation lights,…' },
  '/boating/ma': { title: 'Massachusetts Boater Safety Certificate Course Exam | PassExamHQ', description: 'Practice questions covering the Massachusetts Environmental Police (MEP) boater education program: boat types and classification, PFDs and life jackets,…' },
  '/boating/tn': { title: 'Tennessee Boating Safety Education Exam | PassExamHQ', description: 'Practice questions covering the Tennessee Wildlife Resources Agency (TWRA) boating safety program: boat types and classification, PFDs and life jackets,…' },
  '/boating/mo': { title: 'Missouri Boating Safety Identification Card Exam | PassExamHQ', description: 'Practice questions covering the Missouri State Highway Patrol (MSHP) Water Patrol Division boating safety program and Missouri Revised Statutes Chapters…' },
  '/boating/md': { title: 'Maryland Boating Safety Certificate Exam | PassExamHQ', description: 'Practice questions covering the Maryland Department of Natural Resources (DNR) Natural Resources Police boating safety program: vessel types and…' },
  '/boating/sc': { title: 'South Carolina Boater Education Exam | PassExamHQ', description: 'Practice questions covering the South Carolina Department of Natural Resources (SCDNR) boating safety program and S.C. Code of Laws Title 50, Chapter 21:…' },
  '/boating/mn': { title: 'Minnesota Boater Education Certification Exam | PassExamHQ', description: 'Practice questions covering the Minnesota DNR-approved boater education curriculum grounded in Minn. Stat. 86B (registration, titling, PWC rules,…' },
  '/boating/wi': { title: 'Wisconsin Boater Safety Certification Exam | PassExamHQ', description: 'Practice questions covering the Wisconsin DNR boater-safety curriculum required under Wis. Stat. ch. 30 for operators born on or after January 1, 1989:…' },
  '/boating/al': { title: 'Alabama Boating Safety Certification Exam | PassExamHQ', description: 'Practice questions covering Alabama\'s vessel "V" license requirements administered by ALEA Marine Patrol: PFD Performance Level and Type I-V labeling,…' },
  '/boating/la': { title: 'Louisiana Boater Education Certification Exam | PassExamHQ', description: 'Practice questions covering LDWF\'s boater education requirements for anyone born after January 1, 1984 operating a motorboat over 10hp or a PWC: required…' },
  '/boating/nv': { title: 'Nevada Boater Safety Certification Exam | PassExamHQ', description: 'Practice questions covering NRS Chapter 488\'s safe-boating course requirement for persons born on or after January 1, 1983 operating a power-driven…' },
  '/boating/ct': { title: 'Connecticut Boater Safety Certification Exam | PassExamHQ', description: 'Practice questions covering Connecticut\'s Safe Boating Certificate requirements administered by DEEP: required equipment by federal length class, the…' },
  '/real-estate-salesperson/mi': { title: 'Michigan Real Estate Salesperson Exam Prep (Michigan-Specific Content) | PassExamHQ', description: 'Practice questions covering Michigan\'s Occupational Code Article 25 (Real Estate Brokers and Salespersons, MCL 339.2501-2518), weighted by PSI\'s own…' },
  '/driver/wa': { title: 'Washington Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the Washington Driver Guide (Department of Licensing): licensing, permits and endorsements, vehicles, safety technology and…' },
  '/cdl/wa': { title: 'Washington CDL (Commercial Driver\'s License) Exam | PassExamHQ', description: 'Practice questions covering the Washington Commercial Driver Guide: vehicle control, air brakes and combination vehicles, CDL licensing, driving safety…' },
  '/motorcycle/wa': { title: 'Washington Motorcycle Endorsement Knowledge Test | PassExamHQ', description: 'Practice questions covering the Washington Motorcycle Operator Manual: licensing, permits and endorsement process, gear, motorcycle inspection and…' },
  '/motorcycle/al': { title: 'Alabama Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the Alabama Motorcycle Operator Manual (18th Edition, ALEA): protective gear and Alabama motorcycle licensing/road rules,…' },
  '/motorcycle/ar': { title: 'Arkansas Motorcycle Endorsement Knowledge Test | PassExamHQ', description: 'Practice questions covering the Motorcycle Operator Manual (Motorcycle Safety Foundation, distributed by the Arkansas Department of Public Safety /…' },
  '/motorcycle/ct': { title: 'Connecticut Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the Connecticut DMV Motorcycle Operator Manual: preparing to ride and gear, knowing your motorcycle, the CT motorcycle…' },
  '/motorcycle/mn': { title: 'Minnesota Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the Minnesota DPS Motorcycle and Motorized Bicycle Manual (PS30001-21, 11/2021), published by the Minnesota Department of…' },
  '/motorcycle/ms': { title: 'Mississippi Motorcycle Endorsement Written Knowledge Test | PassExamHQ', description: 'Practice questions covering the Mississippi Motorcycle Operator Manual (Mississippi Department of Public Safety, Driver Service Bureau): protective gear,…' },
  '/motorcycle/nc': { title: 'North Carolina Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the NC DMV Motorcyclists\' Handbook, Thirteenth Edition (NCDMV), weighted by its own real page structure: gear and motorcycle…' },
  '/motorcycle/ny': { title: 'New York Motorcycle Written Knowledge Test | PassExamHQ', description: 'Practice questions covering the New York State DMV Motorcycle Manual, weighted by its own real section structure: licenses/registration and preparing to…' },
  '/motorcycle/pa': { title: 'Pennsylvania Motorcycle Written Knowledge Test | PassExamHQ', description: 'Practice questions covering the PennDOT Motorcycle Operator Manual, Pub 147 (11-24 ed.), weighted by its own real page structure: gear and basic vehicle…' },
  '/motorcycle/tx': { title: 'Texas Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the Texas Motorcycle Operator Training Manual 2020-2021 (Texas Department of Licensing & Regulation / Texas Department of…' },
  '/motorcycle/ut': { title: 'Utah Motorcycle Endorsement Knowledge Test | PassExamHQ', description: 'Practice questions covering the Utah Motorcycle Operator Manual (Utah Driver License Division, DLD): basic vehicle control, keeping distance, SEE…' },
  '/real-estate-salesperson/wa': { title: 'Washington Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering RCW 18.85 (broker licensing), RCW 18.86 (brokerage relationships/agency) and RCW 49.60.222-.227 (fair housing): licensing…' },
  '/real-estate-broker/wa': { title: 'Washington Managing Broker Exam | PassExamHQ', description: 'Practice questions covering RCW 18.85 (managing-broker sections), WAC 308-124C (Records and Responsibilities), WAC 308-124E (Trust Account Procedures)…' },
  '/real-estate-salesperson/ak': { title: 'Alaska Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Alaska Real Estate Law Content Outline (Alaska Statutes Title 08, Chapter 88 and the Real Estate Commission\'s regulations…' },
  '/real-estate-salesperson/al': { title: 'Alabama Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Alabama Real Estate License Law (Code of Alabama 1975, Title 34, Chapter 27) and the Alabama Real Estate Commission\'s…' },
  '/real-estate-broker/al': { title: 'Alabama Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering Pearson VUE\'s official Alabama Real Estate Broker exam content outline (administered on behalf of the Alabama Real Estate…' },
  '/real-estate-salesperson/ar': { title: 'Arkansas Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Arkansas Real Estate License Law (Arkansas Code Annotated Title 17, Chapter 42) and the Arkansas Real Estate Commission\'s…' },
  '/real-estate-salesperson/az': { title: 'Arizona Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Arizona Department of Real Estate\'s Arizona Real Estate Law Book (A.R.S. Title 32, Chapter 20 and A.A.C. Title 4, Chapter…' },
  '/real-estate-broker/az': { title: 'Arizona Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering Pearson VUE\'s official Arizona Real Estate Broker Examination Content Outline (administered on behalf of the Arizona…' },
  '/real-estate-salesperson/co': { title: 'Colorado Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the Colorado Real Estate Manual, Colorado Revised Statutes Title 12, Article 10, and 4 CCR 725-1 (Rules Regarding Real Estate…' },
  '/real-estate-salesperson/ct': { title: 'Connecticut Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Connecticut General Statutes Title 20, Chapter 392 (Real Estate Licensees) and its implementing Regulations of Connecticut…' },
  '/real-estate-broker/ct': { title: 'Connecticut Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering PSI\'s national real estate broker content outline (property ownership, land use controls, valuation, financing, agency,…' },
  '/real-estate-salesperson/de': { title: 'Delaware Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Delaware Code Title 24, Chapter 29 (Real Estate Services, Brokers, Associate Brokers and Salespersons) and the Delaware Real…' },
  '/real-estate-salesperson/hi': { title: 'Hawaii Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Hawaii Real Estate Brokers and Salespersons Law (Hawaii Revised Statutes Chapter 467) and the Real Estate Commission\'s…' },
  '/real-estate-salesperson/ia': { title: 'Iowa Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Iowa Code Chapter 543B (Real Estate Brokers and Salespersons) and Iowa Administrative Code 193E (Real Estate Commission):…' },
  '/real-estate-salesperson/id': { title: 'Idaho Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Idaho Real Estate Commission\'s License Law and Rules (Idaho Code Title 54, Chapter 20 and IDAPA 24.37.01) -- the…' },
  '/real-estate-salesperson/in': { title: 'Indiana Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering Indiana Code Title 25, Article 34.1 (the Real Estate Broker Licensing Act) and 876 IAC (Indiana Administrative Code, Indiana…' },
  '/real-estate-salesperson/ks': { title: 'Kansas Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Kansas Real Estate Brokers\' and Salespersons\' License Act (K.S.A. 58-3034 et seq.), the Brokerage Relationships in Real…' },
  '/real-estate-salesperson/ky': { title: 'Kentucky Real Estate Sales Associate Exam | PassExamHQ', description: 'Practice questions covering Kentucky Revised Statutes Chapter 324 and the Real Estate Commission\'s regulations at 201 KAR Chapter 11 -- the…' },
  '/real-estate-broker/ky': { title: 'Kentucky Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering PSI\'s official Kentucky Real Estate Commission content outline: a separately-scored, separately-timed National/General…' },
  '/real-estate-salesperson/la': { title: 'Louisiana Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Louisiana Real Estate License Law (La. R.S. 37:1430-1470) and the Louisiana Real Estate Commission\'s Rules (Louisiana…' },
  '/real-estate-broker/la': { title: 'Louisiana Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering Pearson VUE\'s official Louisiana content outlines: an 80-item National/General portion (real property characteristics and…' },
  '/real-estate-salesperson/ma': { title: 'Massachusetts Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Massachusetts General Laws Chapter 112, Sections 87PP-87DDD 1/2 and 254 CMR 2.00-7.00 (Board of Registration of Real Estate…' },
  '/real-estate-broker/ma': { title: 'Massachusetts Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering PSI Services LLC\'s official Massachusetts Real Estate Broker exam content outline (administered on behalf of the Division of…' },
  '/real-estate-salesperson/md': { title: 'Maryland Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Maryland Real Estate Commission Law (Business Occupations and Professions Article, Title 17) and COMAR Title 09, Subtitle…' },
  '/real-estate-broker/md': { title: 'Maryland Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering PSI Services LLC\'s official Maryland Real Estate Broker exam content outline (administered on behalf of the Maryland Real…' },
  '/real-estate-salesperson/me': { title: 'Maine Real Estate Sales Agent Exam | PassExamHQ', description: 'Practice questions covering the Maine Real Estate Commission\'s Maine Law content outline -- grounded in 32 M.R.S. Chapter 114 and the Commission\'s Rules…' },
  '/real-estate-salesperson/mn': { title: 'Minnesota Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Minnesota Statutes Chapter 82, Sections 82.55-82.89 (Real Estate Broker, Salesperson, and Closing Agent Licensing Law):…' },
  '/real-estate-broker/mn': { title: 'Minnesota Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering PSI Services LLC\'s official Minnesota Real Estate Broker exam content outline (administered on behalf of the Minnesota…' },
  '/real-estate-salesperson/mo': { title: 'Missouri Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Missouri Real Estate Practice Act (RSMo Chapter 339) and the statutory Agency Relationships subchapter (RSMo…' },
  '/real-estate-broker/mo': { title: 'Missouri Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering PSI Services LLC\'s official Missouri Real Estate Broker exam content outline (administered on behalf of the Missouri Real…' },
  '/real-estate-salesperson/ms': { title: 'Mississippi Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Mississippi Real Estate Brokers License Law of 1954 (Miss. Code Ann. §§ 73-35-1 to 73-35-105) and the Mississippi Real…' },
  '/real-estate-salesperson/mt': { title: 'Montana Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Montana Real Estate License Act (Montana Code Annotated Title 37, Chapter 51) and the Montana Board of Realty…' },
  '/real-estate-salesperson/nd': { title: 'North Dakota Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering North Dakota Century Code Chapter 43-23 (State Real Estate Commission) and the implementing rules at North Dakota…' },
  '/real-estate-salesperson/ne': { title: 'Nebraska Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Nebraska Real Estate License Act (Neb. Rev. Stat. &sect;&sect; 81-885 to 81-885.56), the agency relationships statute…' },
  '/real-estate-salesperson/nh': { title: 'New Hampshire Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the New Hampshire Real Estate Practice Act (RSA 331-A) and the Real Estate Commission\'s administrative rules (N.H. Code of…' },
  '/real-estate-salesperson/nj': { title: 'New Jersey Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the New Jersey Real Estate License Act (N.J.S.A. 45:15) and the Real Estate Commission\'s implementing regulations (N.J.A.C.…' },
  '/real-estate-salesperson/nm': { title: 'New Mexico Real Estate Broker Examination | PassExamHQ', description: 'Practice questions covering the New Mexico Real Estate Brokers and Salesmen Act (NMSA 1978 §§ 61-29-1 to 61-29-29) and the New Mexico Real Estate…' },
  '/real-estate-salesperson/nv': { title: 'Nevada Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Nevada Revised Statutes (NRS) Chapter 645 and Nevada Administrative Code (NAC) Chapter 645 -- Real Estate Brokers and…' },
  '/real-estate-broker/nv': { title: 'Nevada Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (property ownership, forms of ownership and title, valuation and…' },
  '/real-estate-salesperson/ok': { title: 'Oklahoma Real Estate Provisional Sales Associate Exam | PassExamHQ', description: 'Practice questions covering the Oklahoma Real Estate License Code (59 O.S. § 858-101 et seq.) and Title 605 of the Oklahoma Administrative Code: laws and…' },
  '/real-estate-broker/ok': { title: 'Oklahoma Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering PSI\'s official Oklahoma Real Estate Commission content outline: a 75-item National/General portion (property ownership, land…' },
  '/real-estate-salesperson/or': { title: 'Oregon Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering Oregon Revised Statutes Chapter 696 (Real Estate and Escrow Activities) and Oregon Administrative Rules Chapter 863 (Real…' },
  '/real-estate-salesperson/ri': { title: 'Rhode Island Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Rhode Island\'s real estate licensing law -- R.I. Gen. Laws Chapter 5-20.5 (Real Estate Brokers and Salespersons), Chapter…' },
  '/real-estate-salesperson/sc': { title: 'South Carolina Real Estate Associate Exam | PassExamHQ', description: 'Practice questions covering the South Carolina Real Estate License Act (S.C. Code Title 40, Chapter 57) and the Real Estate Commission\'s Regulations…' },
  '/real-estate-broker/sc': { title: 'South Carolina Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering PSI Services LLC\'s official South Carolina Real Estate Broker exam content outline (administered on behalf of the SC Real…' },
  '/real-estate-salesperson/sd': { title: 'South Dakota Real Estate Broker Associate Exam | PassExamHQ', description: 'Practice questions covering South Dakota real estate licensing law (SDCL Title 36, Chapter 21A) and the Real Estate Commission\'s rules (ARSD Article…' },
  '/real-estate-salesperson/tn': { title: 'Tennessee Real Estate Affiliate Broker Exam | PassExamHQ', description: 'Practice questions covering the Tennessee Real Estate Broker License Act of 1973 (Tenn. Code Ann. Title 62, Chapter 13) and the Real Estate Commission\'s…' },
  '/real-estate-broker/tn': { title: 'Tennessee Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering PSI Services LLC\'s official Tennessee Real Estate Broker exam content outline (administered on behalf of the Tennessee Real…' },
  '/real-estate-salesperson/ut': { title: 'Utah Real Estate Sales Agent Exam | PassExamHQ', description: 'Practice questions covering the Utah Real Estate Licensing and Practices Act (Utah Code Title 61, Chapter 2f) and its implementing regulations, Utah…' },
  '/real-estate-broker/ut': { title: 'Utah Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering Pearson VUE\'s national real estate broker content outline (property ownership, forms of ownership and title, valuation and…' },
  '/real-estate-salesperson/vt': { title: 'Vermont Real Estate Salesperson State Examination | PassExamHQ', description: 'Practice questions covering 26 V.S.A. Chapter 41 (Real Estate Brokers and Salespersons) and the Vermont Real Estate Commission\'s Administrative Rules:…' },
  '/real-estate-salesperson/wi': { title: 'Wisconsin Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Wisconsin Statutes Chapter 452 and Wisconsin Administrative Code chs. REEB 11, 12, 15, 16, 17, 18, 23, 24, and 25 (Real…' },
  '/real-estate-broker/wi': { title: 'Wisconsin Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering Pearson VUE\'s official Wisconsin Real Estate Broker exam content outline (administered on behalf of the Wisconsin Real Estate…' },
  '/real-estate-salesperson/wv': { title: 'West Virginia Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the West Virginia Real Estate License Act (W. Va. Code Chapter 30, Article 40) and the Real Estate Commission\'s Title 174…' },
  '/real-estate-salesperson/wy': { title: 'Wyoming Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Wyoming Real Estate License Act (Wyoming Statutes Title 33, Chapter 28) and the Wyoming Real Estate Commission\'s Rules…' },
  '/real-estate-salesperson/fl': { title: 'Florida Real Estate Sales Associate Exam Prep (Licensing Law & Regulatory Content) | PassExamHQ', description: 'Practice questions covering Florida Statutes Chapter 475, Part I (Real Estate Brokers, Sales Associates, and Schools) and Florida Administrative Code…' },
  '/real-estate-broker/fl': { title: 'Florida Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering FREC\'s official 12-area broker exam content outline: real estate brokerage business (licensure, brokerage entities and office…' },
  '/real-estate-salesperson/tx': { title: 'Texas Real Estate Sales Agent Exam | PassExamHQ', description: 'Practice questions covering the Real Estate License Act (TRELA), Texas Occupations Code Chapter 1101, and the Texas Real Estate Commission\'s (TREC) rules…' },
  '/real-estate-broker/tx': { title: 'Texas Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the Pearson VUE-administered Texas Broker exam\'s combined National and State content, weighted by Pearson VUE\'s own official…' },
  '/real-estate-salesperson/ny': { title: 'New York Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering New York Real Property Law Article 12-A (Sections 440-443-a), the Property Condition Disclosure Act (RPL Article 14, Sections…' },
  '/real-estate-broker/ny': { title: 'New York Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering New York Real Property Law Article 12-A at broker level and 19 NYCRR Part 175 (Department of State real estate rules): broker…' },
  '/real-estate-broker/pa': { title: 'Pennsylvania Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering Pennsylvania\'s Real Estate Licensing and Registration Act (RELRA, 63 P.S. Sections 455.101-455.902) and 49 Pa. Code Chapter…' },
  '/real-estate-broker/oh': { title: 'Ohio Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the Ohio Revised Code Chapter 4735 (Real Estate Brokers, Salespersons) and Ohio Administrative Code Chapter 1301:5, scoped…' },
  '/real-estate-broker/ga': { title: 'Georgia Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering O.C.G.A. Title 43, Chapter 40 (Real Estate Brokers and Salespersons) and Ga. Comp. R. & Regs. Chapter 520: broker licensure…' },
  '/real-estate-broker/mi': { title: 'Michigan Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the Occupational Code Article 25 (MCL 339.2501-339.2518) and Michigan Administrative Code Real Estate Brokers and…' },
  '/real-estate-broker/nj': { title: 'New Jersey Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering PSI Services LLC\'s official New Jersey Real Estate Broker exam content outline (administered on behalf of the NJ Real Estate…' },
  '/notary/al': { title: 'Alabama Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering the Alabama Notary Public Act (Code of Alabama 1975, Title 36, Chapter 20), effective 9/1/2023: commissioning, qualifications…' },
  '/notary/fl': { title: 'Florida Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Florida Statutes Chapter 117 (Notaries Public), Part I general provisions (from the Governor\'s Reference Manual for Notaries…' },
  '/notary/ga': { title: 'Georgia Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering O.C.G.A. Title 45, Chapter 17 (Notaries Public), weighted proportional to each topic\'s real share of the statute\'s own text:…' },
  '/notary/tx': { title: 'Texas Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Texas Government Code Chapter 406 (Notary Public; Commissioner of Deeds) and Civil Practice and Remedies Code Chapter 121…' },
  '/notary/ak': { title: 'Alaska Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Alaska\'s notary law under AS 44.50 (Notaries Public) and AS 09.63 (Oath, Acknowledgment, and Other Proof): commissioning and…' },
  '/notary/de': { title: 'Delaware Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Delaware Code Title 29, Chapter 43 (Notaries Public) — Subchapter I "Office and Duties" (§§4301-4314) and Subchapter II, the…' },
  '/notary/id': { title: 'Idaho Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering the Idaho Revised Uniform Law on Notarial Acts (2018) (RULONA), Idaho Code Title 51, Chapter 1, Sections 51-101 through…' },
  '/notary/ia': { title: 'Iowa Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Iowa Code Chapter 9B (Notarial Acts), Iowa\'s enactment of the Revised Uniform Law on Notarial Acts (2018): definitions,…' },
  '/notary/ks': { title: 'Kansas Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering the Kansas Revised Uniform Law on Notarial Acts (RULONA), K.S.A. 53-5a01 through 53-5a31, effective 1/1/2022: notarial-act…' },
  '/notary/ky': { title: 'Kentucky Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Kentucky Revised Statutes Chapter 423 (Notaries Public and Commissioners of Foreign Deeds): the Uniform Recognition of…' },
  '/notary/ma': { title: 'Massachusetts Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Massachusetts General Laws Chapter 222 ("Justices of the Peace, Notaries Public and Commissioners"), as comprehensively…' },
  '/notary/mi': { title: 'Michigan Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Michigan\'s Law on Notarial Acts (2003 PA 238, MCL 55.261-55.315): notary qualifications and appointment by the Secretary of…' },
  '/notary/mn': { title: 'Minnesota Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Minnesota Statutes Chapter 359 (Notaries Public) and Chapter 358, sections 358.51-358.76 (the Revised Uniform Law on Notarial…' },
  '/notary/ms': { title: 'Mississippi Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Mississippi Code Title 25, Chapter 34 — the Revised Mississippi Law on Notarial Acts (RULONA-based act effective July 1,…' },
  '/notary/nh': { title: 'New Hampshire Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering New Hampshire\'s notary statutes: RSA Chapter 455 (Notaries Public and Commissioners) and RSA Chapter 456-B (New Hampshire\'s…' },
  '/notary/nd': { title: 'North Dakota Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering North Dakota Century Code Chapter 44-06.1, North Dakota\'s adoption of the Revised Uniform Law on Notarial Acts (RULONA), NDCC…' },
  '/notary/ok': { title: 'Oklahoma Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Oklahoma\'s notary law, spread across three separate sub-acts within Title 49 of the Oklahoma Statutes: the base Notary Public…' },
  '/notary/sc': { title: 'South Carolina Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering South Carolina\'s Notaries Public Act (S.C. Code Title 26, Chapter 1, Sections 26-1-5 through 26-1-240) and the Electronic…' },
  '/notary/sd': { title: 'South Dakota Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering South Dakota notary law across SDCL Chapter 18-1 (Notaries Public), Chapter 18-4 (Acknowledgment and Proof of Instruments),…' },
  '/notary/tn': { title: 'Tennessee Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Tennessee Code Annotated Title 8, Chapter 16 (Notaries Public), Parts 1-3 (T.C.A. §§ 8-16-101 through 8-16-313), plus…' },
  '/notary/va': { title: 'Virginia Notary Public Practice Questions | PassExamHQ', description: 'Note: Virginia\'s notary commissioning requirements are changing on July 1, 2027 — a newly enacted law (HB163/SB316, creating Code of Virginia § 47.1-5.2)…' },
  '/notary/wa': { title: 'Washington Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Washington Revised Code Chapter 42.45, the Uniform Law on Notarial Acts (RULONA): notarial-act authority and requirements,…' },
  '/notary/wv': { title: 'West Virginia Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering the West Virginia Revised Uniform Law on Notarial Acts (W. Va. Code §39-4-1 through §39-4-38, effective 7/1/2014) and the…' },
  '/notary/vt': { title: 'Vermont Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Vermont\'s Uniform Law on Notarial Acts (26 V.S.A. Chapter 103, §§5301-5380), Vermont\'s 2019 RULONA enactment: general…' },
  '/notary/az': { title: 'Arizona Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering the Arizona Revised Uniform Law on Notarial Acts (A.R.S. Title 41, Chapter 2, Article 1, §§ 41-251 to 41-277) and the…' },
  '/notary/ar': { title: 'Arkansas Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Arkansas Code Annotated Title 21, Chapter 14 (Notaries Public): General Provisions and qualification/commissioning…' },
  '/notary/co': { title: 'Colorado Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Colorado\'s Revised Uniform Law on Notarial Acts (RULONA), C.R.S. 24-21-501 to 24-21-540: general provisions, commissioning…' },
  '/notary/ct': { title: 'Connecticut Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Connecticut\'s notary statute (Conn. Gen. Stat. §§ 3-94a to 3-95b): definitions, appointment and qualifications, notarial…' },
  '/notary/hi': { title: 'Hawaii Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Hawaii Revised Statutes Chapter 456 (Notaries Public), Sections 456-1 through 456-27, and the Department of the Attorney…' },
  '/notary/il': { title: 'Illinois Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering the Illinois Notary Public Act (5 ILCS 312), including its 2023 Article/Section renumbering and substantive rewrite under…' },
  '/notary/in': { title: 'Indiana Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Indiana Code Title 33, Article 42 (Notaries Public) and Indiana\'s Revised Uniform Law on Notarial Acts framework:…' },
  '/notary/la': { title: 'Louisiana Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Louisiana Revised Statutes Title 35 (Notaries Public and Commissioners, including the Remote Online Notarization Act)…' },
  '/notary/md': { title: 'Maryland Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Maryland notary law under Md. Code, State Government Article, Title 18 (Notaries Public) and its implementing regulations at…' },
  '/notary/me': { title: 'Maine Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Maine Revised Statutes Title 4, Chapter 39 (the Revised Uniform Law on Notarial Acts, or RULONA) and the Secretary of State\'s…' },
  '/notary/mo': { title: 'Missouri Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Missouri Revised Statutes Chapter 486, Notaries Public and Notarial Acts: general/paper notarial acts (RSMo 486.600-486.830),…' },
  '/notary/mt': { title: 'Montana Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Montana Code Annotated Title 1, Chapter 5, Part 6 (the Revised Uniform Law on Notarial Acts, MCA 1-5-601 to 1-5-632) and…' },
  '/notary/ne': { title: 'Nebraska Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Nebraska Revised Statutes Chapter 64 (Notaries Public), including general provisions, qualifications and commissioning;…' },
  '/notary/nj': { title: 'New Jersey Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering New Jersey\'s Law on Notarial Acts (N.J.S.A. 52:7-10 et seq., as amended by P.L. 2021, c.179): commissioning, application,…' },
  '/notary/nm': { title: 'New Mexico Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering New Mexico\'s Revised Uniform Law on Notarial Acts (RULONA), NMSA 1978, Chapter 14, Article 14A (Sections 14-14A-1 to…' },
  '/notary/nv': { title: 'Nevada Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Nevada Revised Statutes Chapter 240 (Notaries Public and Commissioned Abstracters), including the Uniform Law on Notarial…' },
  '/notary/oh': { title: 'Ohio Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Ohio Revised Code Chapter 147 (Notaries Public), as substantially rewritten by the 2019 notary modernization act (Senate Bill…' },
  '/notary/or': { title: 'Oregon Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Oregon Revised Statutes Chapter 194 (Notaries Public and Other Officers Performing Notarial Acts), including the Uniform Law…' },
  '/notary/pa': { title: 'Pennsylvania Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Pennsylvania\'s Revised Uniform Law on Notarial Acts (57 Pa.C.S. Chapter 3) and its newly effective implementing regulations…' },
  '/notary/ri': { title: 'Rhode Island Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Rhode Island General Laws Chapter 42-30.1 (Uniform Law on Notarial Acts): commissioning and qualification requirements,…' },
  '/notary/ut': { title: 'Utah Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Utah\'s Notaries Public Reform Act (Utah Code Title 46, Chapter 1, Sections 46-1-2 to 46-1-23): general provisions and…' },
  '/notary/wi': { title: 'Wisconsin Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering Wisconsin\'s Notaries Public and Notarial Acts law (Wis. Stat. Chapter 140), the state\'s 2018 enactment of the Revised Uniform…' },
  '/notary/wy': { title: 'Wyoming Notary Public Exam Prep | PassExamHQ', description: 'Practice questions covering the Wyoming Revised Uniform Law on Notarial Acts, Wyo. Stat. §§ 32-3-101 to 32-3-131: general provisions, definitions and…' },
  '/driver/al': { title: 'Alabama Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Alabama Driver Manual (Alabama Law Enforcement Agency, November 2024 edition): licensing and the graduated driver license…' },
  '/driver/ak': { title: 'Alaska Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Alaska Driver Manual (REV.10/2025, Alaska Department of Administration, Division of Motor Vehicles): licensing, permits…' },
  '/driver/az': { title: 'Arizona Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Arizona Driver License Manual and Customer Service Guide: licensing and Graduated Driver License rules, vehicle equipment…' },
  '/driver/ar': { title: 'Arkansas Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Arkansas Driver License Study Guide (Volume 1, Edition 10, published by the Arkansas State Police / Department of Finance…' },
  '/driver/co': { title: 'Colorado Driving Knowledge Test | PassExamHQ', description: 'Practice questions covering the Colorado Driver Handbook (DR 2337): basic vehicle control, fitness to drive and vehicle readiness, the licensing process…' },
  '/driver/ct': { title: 'Connecticut Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Connecticut Driver\'s Manual (Connecticut Department of Motor Vehicles, Revised March 2023): licensing, testing and…' },
  '/driver/de': { title: 'Delaware Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Delaware Driver Manual (Delaware Division of Motor Vehicles): licensing requirements and the Graduated Driver License…' },
  '/driver/hi': { title: 'Hawaii Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Hawaii Driver\'s Manual (State of Hawaii Department of Transportation, Highways Division): licensing requirements and the…' },
  '/driver/id': { title: 'Idaho Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Idaho Driver\'s Handbook: licensing, permits, credentials and the graduated driver\'s license (GDL) program, required…' },
  '/driver/in': { title: 'Indiana Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Indiana Driver\'s Manual, published by the Indiana Bureau of Motor Vehicles (BMV): licensing, permits and the…' },
  '/driver/ia': { title: 'Iowa Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Iowa Driver\'s License Manual, published by the Iowa Department of Transportation: licensing requirements and the…' },
  '/driver/ks': { title: 'Kansas Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Kansas Driving Handbook (Non-Commercial Driver\'s Manual), published by the Kansas Department of Revenue, Division of…' },
  '/driver/ky': { title: 'Kentucky Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Kentucky Driver Manual (Kentucky State Police, rev. 10-11-2023): licensing requirements and the three-phase Graduated…' },
  '/driver/la': { title: 'Louisiana Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Louisiana Class D & E Driver\'s Guide: licensing requirements and the graduated driver license process, traffic signs,…' },
  '/driver/me': { title: 'Maine Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Maine Driver\'s License Manual (Maine Secretary of State / Bureau of Motor Vehicles, Rev. 4/24 edition): licensing and the…' },
  '/driver/md': { title: 'Maryland Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Maryland MVA Driver\'s Manual (DL-002): licensing requirements and the Graduated Driver Licensing (GDL) system,…' },
  '/driver/ma': { title: 'Massachusetts Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Massachusetts RMV Driver\'s Manual (Revised December 2022): licensing and the Junior Operator (GDL) law, learner\'s permit…' },
  '/driver/mn': { title: 'Minnesota Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Minnesota Driver\'s Manual (Department of Public Safety, Driver and Vehicle Services): licensing, the written test and…' },
  '/driver/ms': { title: 'Mississippi Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Mississippi Driver\'s License Manual (Revised December 2024 / effective January 15, 2025), published by the Driver Service…' },
  '/driver/mo': { title: 'Missouri Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the official Missouri Driver Guide (Missouri Department of Revenue, Driver License Bureau, revised August 2025): licensing,…' },
  '/driver/mt': { title: 'Montana Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Montana Driver Manual (Form 25-0100M), published by the Montana Department of Justice, Motor Vehicle Division (MVD):…' },
  '/driver/ne': { title: 'Nebraska Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Nebraska Class O Driver\'s Manual (Nebraska Department of Motor Vehicles, English edition 1-2025): licensing and the…' },
  '/driver/nv': { title: 'Nevada Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Nevada Driver\'s Handbook (DMV 700, March 2024 edition): licensing and the Graduated Driver License…' },
  '/driver/nh': { title: 'New Hampshire Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the New Hampshire Driver Manual (DSMV 360, Rev. 07/19) -- the last full edition the DMV published on its own domain,…' },
  '/driver/nj': { title: 'New Jersey Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the New Jersey MVC Driver Manual (2025 edition): license types and Graduated Driver Licensing (GDL), driver testing, driver…' },
  '/driver/nm': { title: 'New Mexico Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the New Mexico Driver Manual (ver. 11.19.19), published by the New Mexico Motor Vehicle Division (MVD, part of the Taxation…' },
  '/driver/nd': { title: 'North Dakota Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the 2025-2027 North Dakota Noncommercial Driver License Manual (Class D), published by the NDDOT Driver License Division:…' },
  '/driver/ok': { title: 'Oklahoma Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Oklahoma Driver Manual (Copyright 2025, Service Oklahoma -- the newly created state agency that took over driver…' },
  '/driver/or': { title: 'Oregon Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Oregon DMV Online Driver Manual: licensing, permits and testing procedures; road signs, traffic signals and pavement…' },
  '/driver/ri': { title: 'Rhode Island Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Rhode Island Driver\'s Manual (April 2024 edition, RI Division of Motor Vehicles): licensing requirements and the state\'s…' },
  '/driver/sc': { title: 'South Carolina Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the South Carolina Driver\'s License Manual (South Carolina Department of Motor Vehicles, 2026 edition): licensing and the…' },
  '/driver/sd': { title: 'South Dakota Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the South Dakota Driver\'s Manual (South Dakota Department of Public Safety, content revision 12/2023): licensing and the…' },
  '/driver/tn': { title: 'Tennessee Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Tennessee Comprehensive Driver License Manual (Tennessee Department of Safety and Homeland Security,…' },
  '/driver/ut': { title: 'Utah Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Utah Driver Handbook, published by the Driver License Division (DLD) -- a separate agency from the Division of Motor…' },
  '/driver/vt': { title: 'Vermont Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Vermont Driver\'s Manual (VN-007, 2025 edition), published by the Vermont Agency of Transportation, Department of Motor…' },
  '/driver/wv': { title: 'West Virginia Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the official West Virginia Driver\'s Licensing Handbook (Rev. 07/2022), published by the WV Department of Transportation,…' },
  '/driver/wi': { title: 'Wisconsin Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Wisconsin Motorists\' Handbook (Wisconsin Department of Transportation / Division of Motor Vehicles, 2026 edition):…' },
  '/driver/wy': { title: 'Wyoming Driver Knowledge Test | PassExamHQ', description: 'Practice questions covering the Wyoming Rules of the Road Driver License Manual (2021 edition, published by WYDOT\'s Driver Services Program): driver…' },
  '/cdl/al': { title: 'Alabama CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Alabama Commercial Driver License Manual (ALEA Driver License Division, 2005 CDL Testing System / AAMVA, Version July…' },
  '/cdl/ak': { title: 'Alaska CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Alaska Commercial Driver License Manual (Alaska DMV, Division of Motor Vehicles): CDL licensing and vehicle inspection,…' },
  '/cdl/az': { title: 'Arizona CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Arizona Commercial Driver License Manual (ADOT Motor Vehicle Division, Customer Service Guide for Commercial Drivers,…' },
  '/cdl/ar': { title: 'Arkansas CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Arkansas Commercial Driver License Manual (AAMVA 2022 Modernized CDL Testing System, Version: March 2025, with the…' },
  '/cdl/co': { title: 'Colorado CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Colorado Commercial Driver License Manual (2023 CDL Testing System, DR 2251, June 2023, Colorado Department of Revenue –…' },
  '/cdl/ct': { title: 'Connecticut CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Connecticut Commercial Driver License Manual (R-295 Rev. 12/2024, AAMVA 2022 Modernized CDL Testing System), published by…' },
  '/cdl/de': { title: 'Delaware CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Delaware Commercial Driver\'s Manual (2022 CDL Testing System, Version 4.0, AAMVA Modernized Testing System, Release Date:…' },
  '/cdl/hi': { title: 'Hawaii CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Hawaii Commercial Driver License Manual (2005 CDL Testing System / AAMVA, Version July 2017, Hawaii: May 2023 update),…' },
  '/cdl/id': { title: 'Idaho CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Idaho Commercial Driver License Manual (Idaho Transportation Department, Division of Motor Vehicles, 2022 CDL Testing…' },
  '/cdl/il': { title: 'Illinois CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Illinois Commercial Driver\'s License Guide (Illinois Secretary of State, document code DSD CDL 10.30, July 2025 edition):…' },
  '/cdl/in': { title: 'Indiana CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Indiana Commercial Driver\'s License Manual (Indiana Bureau of Motor Vehicles (BMV), AAMVA \'Modernized Testing System\'…' },
  '/cdl/ia': { title: 'Iowa CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Iowa Commercial Driver License Manual (Iowa Department of Transportation, National CDL Manual, 2005 AAMVA Testing System…' },
  '/cdl/ks': { title: 'Kansas CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Kansas Commercial Driver\'s License Manual (Kansas Department of Revenue, Division of Vehicles, AAMVA Modernized Testing…' },
  '/cdl/ky': { title: 'Kentucky CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Kentucky Commercial Driver\'s License Manual (Kentucky State Police / Kentucky Transportation Cabinet Division of Driver…' },
  '/cdl/la': { title: 'Louisiana CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Louisiana Commercial Driver\'s License Manual (Louisiana Department of Public Safety & Corrections, Office of Motor…' },
  '/cdl/ma': { title: 'Massachusetts CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Massachusetts Commercial Driver\'s License Manual (Massachusetts Registry of Motor Vehicles (RMV), AAMVA Modernized…' },
  '/cdl/md': { title: 'Maryland CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Maryland Commercial Driver\'s License Manual (DL-151, 05/26), published by the Maryland Department of Transportation Motor…' },
  '/cdl/me': { title: 'Maine CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Maine Commercial Driver License Manual (Maine Department of the Secretary of State, Bureau of Motor Vehicles, 2005 CDL…' },
  '/cdl/mn': { title: 'Minnesota CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Minnesota Commercial Driver\'s License Manual (Minnesota Department of Public Safety, Division of Driver and Vehicle…' },
  '/cdl/mo': { title: 'Missouri CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Missouri Commercial Driver License Manual (Missouri Department of Revenue, in cooperation with the Missouri State Highway…' },
  '/cdl/ms': { title: 'Mississippi CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Mississippi Commercial Driver\'s License Manual (AAMVA \'Modernized Testing System\' base content -- interior section…' },
  '/cdl/mt': { title: 'Montana CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Montana Commercial Driver License Manual (Montana Department of Justice, Motor Vehicle Division (MVD), base AAMVA…' },
  '/cdl/nd': { title: 'North Dakota CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the North Dakota 2025-2027 Commercial Driver License Manual, Class A, B and C (AAMVA \'2005 Model Commercial Driver License…' },
  '/cdl/ne': { title: 'Nebraska CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Nebraska Commercial Driver\'s License Manual (Nebraska Department of Motor Vehicles, AAMVA 2005 CDL Testing System /…' },
  '/cdl/nh': { title: 'New Hampshire CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the New Hampshire Commercial Driver\'s License Manual (New Hampshire Division of Motor Vehicles, NH Department of Safety,…' },
  '/cdl/nj': { title: 'New Jersey CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the New Jersey Commercial Driver\'s License Manual (New Jersey Motor Vehicle Commission, base AAMVA \'Modernized Testing…' },
  '/cdl/nm': { title: 'New Mexico CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the New Mexico Commercial Driver License Manual (base AAMVA \'2005 CDL Testing System\' content, Version: July 2017), published…' },
  '/cdl/nv': { title: 'Nevada CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Nevada Commercial Driver\'s License Manual (Nevada Department of Motor Vehicles, AAMVA-authored base content,…' },
  '/cdl/ok': { title: 'Oklahoma CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Oklahoma Commercial Driver\'s License Manual (Service Oklahoma, AAMVA Modernized Testing System base content,…' },
  '/cdl/or': { title: 'Oregon CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Oregon Commercial Driver License Manual (Oregon Department of Transportation, Driver and Motor Vehicle Services Division,…' },
  '/cdl/ri': { title: 'Rhode Island CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Rhode Island Commercial Driver License Manual (Rhode Island Division of Motor Vehicles (RI DMV), base AAMVA 2005 CDL…' },
  '/cdl/sc': { title: 'South Carolina CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'This 681-question South Carolina CDL practice bank is built directly from the South Carolina Commercial Driver License Manual (Version: March 2025, AAMVA…' },
  '/cdl/sd': { title: 'South Dakota CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the South Dakota Commercial Driver License Manual (South Dakota Department of Public Safety, base AAMVA \'2005 CDL Testing…' },
  '/cdl/tn': { title: 'Tennessee CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Tennessee Commercial Driver License Manual (Tennessee Department of Safety and Homeland Security, base AAMVA 2005 CDL…' },
  '/cdl/ut': { title: 'Utah CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Utah Commercial Driver\'s License Handbook (2025 Edition, base AAMVA \'Modernized Testing System\' content, cover page…' },
  '/cdl/vt': { title: 'Vermont CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Vermont Commercial Driver\'s Manual (Form VN-111, AAMVA 2005 CDL Testing System base content, Version: July 2017, with…' },
  '/cdl/wi': { title: 'Wisconsin CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions are drawn directly from the Wisconsin Commercial Driver\'s Manual (May 2026 edition), published by the Wisconsin Department of…' },
  '/cdl/wv': { title: 'West Virginia CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the West Virginia Commercial Driver\'s License Manual (West Virginia Department of Transportation, Division of Motor Vehicles,…' },
  '/cdl/wy': { title: 'Wyoming CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Wyoming Commercial Driver License Manual -- "Rules of the Road: Driver License Manual, Commercial & Heavy Vehicles 2024"…' },
  '/blog': { title: 'Guides & Tips — Exam Prep Articles | PassExamHQ', description: 'Guides and tips for passing your licensing exam, from notary to real estate to boating safety.' },
  '/blog/nmls-continuing-education-license-renewal': { title: 'NMLS Continuing Education and Renewal Rules | PassExamHQ', description: 'The SAFE Act sets a federal continuing education floor for state-licensed MLOs. Here\'s what it requires and where states can add more.' },
  '/blog/conventional-fha-va-usda-loans-explained': { title: 'Conventional vs. FHA vs. VA vs. USDA Loans | PassExamHQ', description: 'A clear, structural breakdown of what actually separates conventional, FHA, VA, and USDA mortgage loans for SAFE MLO exam candidates.' },
  '/blog/mortgage-loan-process-application-to-closing': { title: 'The Mortgage Loan Process Explained | PassExamHQ', description: 'From application to closing, every mortgage loan moves through the same core stages. A step-by-step breakdown for MLO exam candidates.' },
  '/blog/tila-respa-disclosures-mlos-need-to-know': { title: 'TILA and RESPA Disclosure Rules for MLOs | PassExamHQ', description: 'A verified breakdown of how TILA and RESPA\'s mortgage disclosure rules work together under TRID, including the Loan Estimate and Closing Disclosure…' },
  '/blog/cap-rate-noi-grm-broker-exam-math': { title: 'Cap Rate, NOI & GRM for the Broker Exam | PassExamHQ', description: 'The income-property formulas real estate broker exams test heavily - NOI, cap rate, and GRM - explained precisely with worked examples.' },
  '/blog/how-to-open-your-own-real-estate-brokerage': { title: 'How to Open a Real Estate Brokerage | PassExamHQ', description: 'The practical and legal basics of starting your own real estate brokerage after earning your broker license - entity setup, E&O insurance, and…' },
  '/blog/trust-account-rules-that-trip-up-broker-candidates': { title: 'Broker Exam Trust Account Rules Explained | PassExamHQ', description: 'Commingling, deposit timing, and reconciliation - the trust account rules that trip up real estate broker exam candidates, and how to study them right.' },
  '/blog/what-broker-supervision-actually-means': { title: 'What Broker Supervision Really Means Legally | PassExamHQ', description: 'The legal doctrine behind a broker\'s duty to supervise agents, why it creates personal liability, and why broker exams test it so heavily.' },
  '/blog/how-escrow-and-earnest-money-work': { title: 'How Escrow and Earnest Money Work in Real Estate | PassExamHQ', description: 'How earnest money deposits and escrow actually function in a real estate transaction, who holds the funds, and what happens if a deal falls through.' },
  '/blog/what-material-fact-disclosure-means-real-estate': { title: 'What Material Fact Disclosure Means in Real Estate | PassExamHQ', description: 'What actually makes a fact "material" in real estate, who owes disclosure to whom, and the knew-or-should-have-known standard tested on licensing exams.' },
  '/blog/fair-housing-law-basics-real-estate-exam': { title: 'Fair Housing Law Basics for the Real Estate Exam | PassExamHQ', description: 'The Fair Housing Act\'s seven federally protected classes, the practices it prohibits, and why fair housing is some of the most heavily tested exam content.' },
  '/blog/real-estate-exam-math-commissions-prorations-ltv': { title: 'Real Estate Exam Math: Commissions, Prorations, LTV | PassExamHQ', description: 'How to work through the real estate exam\'s most common math problems: commission splits, tax prorations, loan-to-value, and simple interest, with worked…' },
  '/blog/float-plans-why-experts-recommend-them': { title: 'Float Plans: Why Boating Safety Experts Recommend Them | PassExamHQ', description: 'No state requires you to file a float plan, but the Coast Guard and boating safety organizations call it one of the most effective habits a boater can…' },
  '/blog/why-alcohol-is-more-dangerous-on-a-boat': { title: 'Why Alcohol Is More Dangerous on a Boat | PassExamHQ', description: 'BUI is treated a lot like drunk driving legally, but the physical effects of alcohol on the water are genuinely different, and worse, than most boaters…' },
  '/blog/aids-to-navigation-buoys-red-right-returning': { title: 'Aids to Navigation: Buoys and Red Right Returning | PassExamHQ', description: 'Red right returning is the mnemonic everyone memorizes, but knowing what it actually means and where it stops applying is what the exam is really after.' },
  '/blog/stand-on-give-way-vessel-right-of-way': { title: 'Stand-On vs. Give-Way Vessel Rules Explained | PassExamHQ', description: 'If you learned right-of-way from driving a car, boating\'s rules will feel almost familiar and then betray you. Here\'s what stand-on and give-way actually…' },
  '/blog/motorcycle-passenger-cargo-rules-knowledge-test': { title: 'Motorcycle Passenger & Cargo Rules for Tests | PassExamHQ', description: 'See the safety principles behind motorcycle passenger and cargo questions on knowledge tests, and why exact ages and limits vary so much by state.' },
  '/blog/motorcycle-gear-knowledge-tests-actually-ask-about': { title: 'Motorcycle Gear Knowledge Tests Ask About | PassExamHQ', description: 'Learn which motorcycle gear -- like DOT-certified helmets -- is backed by an actual legal standard, and which gear is just universally good safety…' },
  '/blog/why-knowledge-tests-emphasize-common-motorcycle-crashes': { title: 'Common Motorcycle Crashes & Knowledge Tests | PassExamHQ', description: 'Learn why left-turn collisions and driver-visibility failures dominate motorcycle crash research, and why knowledge tests are built around those scenarios.' },
  '/blog/msf-basic-ridercourse-what-to-expect': { title: 'MSF Basic RiderCourse: What to Expect | PassExamHQ', description: 'See what the MSF Basic RiderCourse\'s classroom and range sessions actually cover, and why whether it waives your state\'s skills test varies by state.' },
  '/blog/cdl-skills-test-how-it-actually-works': { title: 'CDL Skills Test Explained: How It Actually Works | PassExamHQ', description: 'The CDL skills test\'s three parts (inspection, basic control, road test) explained, and how it differs from the CDL knowledge test.' },
  '/blog/eldt-federal-training-requirement-explained': { title: 'ELDT Explained: The Federal CDL Training Rule | PassExamHQ', description: 'What FMCSA\'s Entry-Level Driver Training (ELDT) rule actually requires, who it applies to, and how it changed the path to a first-time CDL.' },
  '/blog/air-brakes-endorsement-cdl-restriction-explained': { title: 'Air Brakes and the CDL \'L\' Restriction Explained | PassExamHQ', description: 'Why skipping the CDL air brakes test leaves you restricted from most trucking jobs, and what the air brakes knowledge test actually covers.' },
  '/blog/cdl-pre-trip-inspection-what-examiners-look-for': { title: 'CDL Pre-Trip Inspection: What Examiners Look For | PassExamHQ', description: 'Why the CDL pre-trip vehicle inspection fails so many test-takers, what examiners are actually scoring, and how to prepare beyond memorizing a script.' },
  '/blog/what-happens-if-you-fail-your-permit-or-road-test': { title: 'What Happens If You Fail Your Permit or Road Test | PassExamHQ', description: 'Failing a permit or road test isn\'t the end of the road. Here\'s the general pattern of what happens next, and why exact retake rules vary so much by state.' },
  '/blog/right-of-way-rules-that-confuse-new-drivers': { title: 'Right-of-Way Rules That Confuse New Drivers | PassExamHQ', description: 'Four-way stops, roundabouts, and unmarked intersections trip up new drivers more than almost anything else. Here\'s how to reason through the right-of-way…' },
  '/blog/what-examiners-look-for-on-the-road-test': { title: 'What Examiners Score on the Driving Road Test | PassExamHQ', description: 'The road test isn\'t guesswork — examiners follow a fairly consistent scoring framework. Here\'s what\'s actually being evaluated while you drive.' },
  '/blog/how-graduated-licensing-works-for-teens': { title: 'How Graduated Driver Licensing (GDL) Works | PassExamHQ', description: 'A plain-English breakdown of how graduated driver licensing phases teens toward full driving privileges — and why exact requirements vary so much by state.' },
  '/blog/tricky-notarization-scenarios': { title: 'Tricky Notary Scenarios to Know | PassExamHQ', description: 'Notarizing for family, blank documents, and photocopies are common gray-area situations. Here\'s how to think through each one correctly.' },
  '/blog/remote-online-notarization-explained': { title: 'Remote Online Notarization (RON) Basics | PassExamHQ', description: 'Remote online notarization lets notaries work over live video — but the rules vary significantly by state. Here\'s a plain-English breakdown.' },
  '/blog/acknowledgment-vs-jurat': { title: 'Acknowledgment vs. Jurat Explained | PassExamHQ', description: 'Acknowledgments and jurats are two different notarial acts that are easy to confuse. Here\'s a clear breakdown of what separates them.' },
  '/blog/notary-journal-requirements': { title: 'What Is a Notary Journal? | PassExamHQ', description: 'A notary journal is one of the most misunderstood parts of the job. Here\'s what it records, why it matters, and how requirements vary by state.' },
  '/blog/federal-vs-state-mlo-licensing-differences': { title: 'Federal vs. State MLO Licensing Differences | PassExamHQ', description: 'The SAFE Act created two MLO paths, not one. Here\'s what genuinely differs between federal registration and state licensing.' },
  '/blog/what-is-the-nmls-and-why-mlos-register': { title: 'What Is the NMLS and Why Must MLOs Register? | PassExamHQ', description: 'The NMLS traces directly to the 2008 SAFE Act. Here\'s the real regulatory history behind mortgage loan originator registration and licensing.' },
  '/blog/common-safe-mlo-exam-mistakes': { title: 'Common SAFE MLO Exam Mistakes to Avoid | PassExamHQ', description: 'The same avoidable mistakes trip up SAFE MLO exam candidates repeatedly — from under-studying federal law to ignoring retake wait periods.' },
  '/blog/what-to-expect-on-the-nmls-safe-mlo-exam': { title: 'What to Expect on the NMLS SAFE MLO Exam | PassExamHQ', description: 'A verified breakdown of the NMLS SAFE MLO exam\'s real structure — question count, time limit, content domains, and passing score.' },
  '/blog/how-long-salesperson-to-broker-license-takes': { title: 'Salesperson to Broker: How Long It Takes | PassExamHQ', description: 'The salesperson-to-broker path follows the same general pattern in every state: experience, education, and an exam. Here\'s what that looks like.' },
  '/blog/managing-broker-vs-salesperson-differences': { title: 'Managing Broker vs Salesperson: Key Differences | PassExamHQ', description: 'What actually changes when you move from salesperson to managing broker - supervision duties, trust account responsibility, and legal liability.' },
  '/blog/common-real-estate-broker-exam-mistakes': { title: 'Common Real Estate Broker Exam Mistakes | PassExamHQ', description: 'The broker exam trips up experienced agents in predictable ways. Here are the most common mistakes candidates make and how to avoid them.' },
  '/blog/what-to-expect-on-your-real-estate-broker-exam': { title: 'Real Estate Broker Exam: What to Expect | PassExamHQ', description: 'Learn how the real estate broker exam differs from the salesperson exam - format, trust account questions, supervision content, and how to prepare.' },
  '/blog/how-real-estate-agency-relationships-work': { title: 'How Real Estate Agency Relationships Work | PassExamHQ', description: 'Buyer’s agent, listing agent, and dual agency explained — how real estate agency relationships and fiduciary duties work, and why they’re heavily tested.' },
  '/blog/real-estate-salesperson-vs-broker': { title: 'Real Estate Salesperson vs. Broker License | PassExamHQ', description: 'Real estate salesperson and broker licenses are related but distinct. Here’s the general path from one to the other and what changes along the way.' },
  '/blog/common-real-estate-exam-mistakes': { title: 'Common Real Estate Exam Mistakes to Avoid | PassExamHQ', description: 'The same avoidable mistakes trip up first-time real estate salesperson exam candidates over and over. Here’s how to sidestep them.' },
  '/blog/what-to-expect-on-your-real-estate-salesperson-exam': { title: 'What to Expect on the Real Estate Exam | PassExamHQ', description: 'Most state real estate salesperson exams share a national + state-specific structure and core topics. Here’s how the format works and what it tests.' },
  '/blog/cold-water-safety-basics-for-boaters': { title: 'Cold Water Safety Basics for Boaters | PassExamHQ', description: 'Cold water is dangerous long before hypothermia sets in. Here\'s how immersion actually affects the body, and what boating safety courses want you to…' },
  '/blog/pfd-types-explained': { title: 'PFD Types Explained: Type I, II, III, V | PassExamHQ', description: 'Not all life jackets are built for the same situation. Here\'s what the USCG\'s PFD type classifications actually mean, and why the difference matters.' },
  '/blog/common-boating-safety-exam-mistakes': { title: 'Common Boating Safety Exam Mistakes to Avoid | PassExamHQ', description: 'The same handful of avoidable mistakes trip up boating safety exam takers over and over. Here\'s how to sidestep them.' },
  '/blog/what-to-expect-on-your-boating-safety-exam': { title: 'What to Expect on Your Boating Safety Exam | PassExamHQ', description: 'A plain-English walkthrough of how state boating safety exams are typically structured, what they test, and how to walk in prepared.' },
  '/blog/see-strategy-motorcycle-safety-fundamentals': { title: 'SEE Strategy & Motorcycle Safety Basics | PassExamHQ', description: 'Learn the MSF\'s SEE strategy, lane positioning, and gear fundamentals that appear on nearly every state\'s motorcycle permit knowledge test.' },
  '/blog/common-mistakes-motorcycle-knowledge-test': { title: 'Common Motorcycle Knowledge Test Mistakes | PassExamHQ', description: 'Avoid the most common study mistakes that cause people to fail their motorcycle permit knowledge test, from generic quizzes to skipped gear sections.' },
  '/blog/motorcycle-permit-endorsement-license-explained': { title: 'Motorcycle Permit vs Endorsement vs License | PassExamHQ', description: 'Confused about motorcycle permits, endorsements, and full licenses? Here\'s the general licensing progression most states follow, and what actually varies.' },
  '/blog/what-to-expect-motorcycle-permit-knowledge-test': { title: 'Motorcycle Permit Knowledge Test: What to Expect | PassExamHQ', description: 'Learn what topics, format, and study resources to expect on your state\'s motorcycle permit knowledge test, from safe riding practices to gear questions.' },
  '/blog/common-cdl-test-mistakes': { title: 'Common CDL Test Mistakes to Avoid | PassExamHQ', description: 'The CDL testing process trips up first-time applicants in predictable ways. Here are the most common mistakes and how to avoid each one.' },
  '/blog/cdl-endorsements-explained': { title: 'CDL Endorsements Explained: H, N, P, S, T, X | PassExamHQ', description: 'What do the H, N, P, S, T, and X endorsements on a CDL actually authorize? A verified, plain-English breakdown of each federal CDL endorsement code.' },
  '/blog/cdl-class-a-vs-class-b-vs-class-c': { title: 'CDL Class A vs B vs C: Federal Difference | PassExamHQ', description: 'CDL classes are defined by weight ratings and passenger/hazmat criteria, not truck size. Here\'s the real federal distinction between Class A, B, and C.' },
  '/blog/what-to-expect-on-the-cdl-general-knowledge-test': { title: 'CDL General Knowledge Test: What to Expect | PassExamHQ', description: 'A clear breakdown of the CDL general knowledge test: how it\'s administered, core topics (air brakes, combination vehicles), and how to prepare.' },
  '/blog/written-test-vs-road-test-difference': { title: 'Written Knowledge Test vs. Road Test | PassExamHQ', description: 'The written knowledge test and behind-the-wheel road test check completely different skills. Here\'s what each evaluates and how to prepare for both.' },
  '/blog/permit-vs-license-vs-provisional-license': { title: 'Permit vs. License vs. Provisional License | PassExamHQ', description: 'Permit, provisional license, and full license are three distinct stages, not interchangeable terms. Here\'s how the graduated licensing progression works.' },
  '/blog/common-permit-test-mistakes': { title: 'Common Permit Test Mistakes to Avoid | PassExamHQ', description: 'The same handful of study habits trip up first-time permit applicants over and over. Here\'s how to avoid them and study smarter.' },
  '/blog/what-to-expect-on-your-permit-test': { title: 'What to Expect on Your Permit Knowledge Test | PassExamHQ', description: 'A plain-English walkthrough of how state learner\'s permit knowledge tests are typically structured, what they cover, and how to walk in prepared.' },
  '/blog/notary-public-vs-notary-signing-agent': { title: 'Notary Public vs. Notary Signing Agent | PassExamHQ', description: 'These two terms get used interchangeably, but they’re not the same thing. Here’s what actually separates them.' },
  '/blog/common-notary-exam-mistakes': { title: 'Common Notary Exam Mistakes to Avoid | PassExamHQ', description: 'The same handful of mistakes trip up first-time notary applicants over and over. Here’s how to sidestep them.' },
  '/blog/what-to-expect-on-your-notary-exam': { title: 'What to Expect on Your Notary Exam | PassExamHQ', description: 'A plain-English walkthrough of how state notary exams are typically structured, what they test, and how to walk in prepared.' },
};
// SEO_META_END

// Static, hand-maintained SEO overrides for pages outside HUB_EXAMS/blog -- NOT touched by
// scripts/generate-seo-meta.js, which only rewrites the SEO_META_START/END block above.
const GUIDES_SEO_META = {
  '/guides/notary-requirements-by-state': { title: 'Notary Public Exam Requirements by State | PassExamHQ', description: 'Real, sourced notary exam requirements for every state -- which states require an exam, question counts, time limits, and passing scores, compared side by side.' },
  '/guides/real-estate-salesperson-requirements-by-state': { title: 'Real Estate Salesperson Exam Requirements by State | PassExamHQ', description: 'Real, sourced real estate salesperson licensing exam requirements for all 50 states -- question counts, time limits, and passing scores, compared side by side.' },
  '/guides/real-estate-broker-requirements-by-state': { title: 'Real Estate Broker Exam Requirements by State | PassExamHQ', description: 'Real, sourced real estate broker licensing exam requirements by state -- question counts, time limits, and passing scores, compared side by side.' },
  '/guides/driver-requirements-by-state': { title: "Driver's License Knowledge Test Requirements by State | PassExamHQ", description: "Real, sourced driver's license knowledge test requirements for all 50 states -- question counts, time limits, and passing scores, compared side by side." },
  '/guides/cdl-requirements-by-state': { title: 'CDL Knowledge Test Requirements by State | PassExamHQ', description: 'Real, sourced CDL general knowledge test requirements for all 50 states -- question counts, time limits, and passing scores, compared side by side.' },
  '/guides/motorcycle-requirements-by-state': { title: 'Motorcycle Knowledge Test Requirements by State | PassExamHQ', description: 'Real, sourced motorcycle permit/license knowledge test requirements by state -- question counts, time limits, and passing scores, compared side by side.' },
  '/guides/boating-requirements-by-state': { title: 'Boating Safety Exam Requirements by State | PassExamHQ', description: 'Real, sourced boating safety exam requirements by state -- which states mandate an exam, question counts, time limits, and passing scores, compared side by side.' },
};

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function setStateCookieHeader(headers, stateCode) {
  headers.append('Set-Cookie', 'pxq_state=' + encodeURIComponent(stateCode) + '; path=/; max-age=31536000; SameSite=Lax');
}

// Injects a self-referencing <link rel="canonical"> on every HTML page (every route currently
// serves the identical static index.html otherwise -- see wwwroot/index.html's header comment --
// so without this every page looks like a duplicate to a crawler), plus a per-route <title>/
// <meta name="description"> override where SEO_META has one (category and track pages). Streaming
// transform (HTMLRewriter), not a body rewrite -- no need to buffer/parse the whole HTML doc.
function withSeoMeta(response, canonicalHref, meta) {
  const rewriter = new HTMLRewriter().on('head', {
    element(el) {
      el.append('<link rel="canonical" href="' + canonicalHref + '">', { html: true });
      // Open Graph / Twitter Card tags. Falls back to the site-wide default (matching index.html's
      // own static <title>/<meta name="description">) for routes with no SEO_META entry -- the
      // homepage and anything not yet covered by generate-seo-meta.js -- so every page ships valid
      // OG/Twitter tags, not just the ones with a per-route override. og:image/twitter:image point
      // at wwwroot/og-image.png (1200x630, added 2026-08-31 -- the real header logo mark/wordmark/
      // tagline, rebuilt at OG-card size+resolution rather than upscaling a low-res screenshot of
      // the actual header) -- same image site-wide, no per-route variants.
      const title = (meta && meta.title) || 'PassExamHQ';
      const description = (meta && meta.description) || 'Exam prep practice questions, timed to how you actually study.';
      // Derived from canonicalHref's own origin (not a hardcoded domain) -- same "correct on prod
      // and any preview domain alike" reasoning as canonicalHref itself, just above.
      const ogImage = new URL(canonicalHref).origin + '/og-image.png';
      el.append('<meta property="og:title" content="' + escapeAttr(title) + '">', { html: true });
      el.append('<meta property="og:description" content="' + escapeAttr(description) + '">', { html: true });
      el.append('<meta property="og:type" content="website">', { html: true });
      el.append('<meta property="og:url" content="' + canonicalHref + '">', { html: true });
      el.append('<meta property="og:site_name" content="PassExamHQ">', { html: true });
      el.append('<meta property="og:image" content="' + ogImage + '">', { html: true });
      el.append('<meta property="og:image:width" content="1200">', { html: true });
      el.append('<meta property="og:image:height" content="630">', { html: true });
      el.append('<meta name="twitter:card" content="summary_large_image">', { html: true });
      el.append('<meta name="twitter:title" content="' + escapeAttr(title) + '">', { html: true });
      el.append('<meta name="twitter:description" content="' + escapeAttr(description) + '">', { html: true });
      el.append('<meta name="twitter:image" content="' + ogImage + '">', { html: true });
    },
  });
  if (meta) {
    rewriter
      .on('title', { element(el) { el.setInnerContent(meta.title); } })
      .on('meta[name="description"]', { element(el) { el.setAttribute('content', meta.description); } });
  }
  return rewriter.transform(response);
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const target = new URL(request.url);
      target.pathname = url.pathname.replace(/^\/api/, '');
      const proxied = new Request(target, request);
      return env.API.fetch(proxied);
    }
    if (url.pathname === '/mcp') return env.API.fetch(request);

    // California's real estate track was originally launched as /ca_dre (examType ca_dre),
    // breaking this project's {state}_{category} naming convention -- renamed to /ca_real_estate
    // 2026-08-24, which is itself now redirected again by TRACK_REDIRECTS below to
    // /real-estate-salesperson/ca. Kept as its own explicit hop (rather than pointing straight at
    // the final URL) so this comment's history stays legible and either link in the chain keeps
    // working if the other end ever moves again.
    if (url.pathname === '/ca_dre' || url.pathname.startsWith('/ca_dre/')) {
      const target = new URL(url.pathname.replace('/ca_dre', '/ca_real_estate') + url.search, url);
      return Response.redirect(target.toString(), 301);
    }

    if (request.method === 'GET') {
      const directHit = TRACK_REDIRECTS[url.pathname];
      if (directHit) {
        return Response.redirect(new URL(directHit + url.search, url).toString(), 301);
      }

      // Old /{state}/{kind-slug} filtered-hub URL -> new /{category-slug} category page, state
      // carried forward via cookie rather than the URL (that page shows every state).
      const stateKindMatch = url.pathname.match(/^\/([a-zA-Z]{2})\/([a-z-]+)\/?$/);
      if (stateKindMatch) {
        const stateCode = stateKindMatch[1].toUpperCase();
        const rawKindSlug = stateKindMatch[2].toLowerCase();
        const kindSlugPart = LEGACY_KIND_SLUG_ALIASES[rawKindSlug] || rawKindSlug;
        if (KNOWN_STATE_CODES.has(stateCode) && KIND_SLUGS[kindSlugPart]) {
          const headers = new Headers();
          setStateCookieHeader(headers, stateCode);
          headers.set('Location', new URL('/' + kindSlugPart + url.search, url).toString());
          return new Response(null, { status: 301, headers });
        }
      }

      // Old bare /{state} URL -> "/" (no more per-state hub to land on), state carried via cookie.
      const stateOnlyMatch = url.pathname.match(/^\/([a-zA-Z]{2})\/?$/);
      if (stateOnlyMatch) {
        const stateCode = stateOnlyMatch[1].toUpperCase();
        if (KNOWN_STATE_CODES.has(stateCode)) {
          const headers = new Headers();
          setStateCookieHeader(headers, stateCode);
          headers.set('Location', new URL('/' + url.search, url).toString());
          return new Response(null, { status: 301, headers });
        }
      }
    }

    let response = await env.ASSETS.fetch(request);
    const isHtml = (response.headers.get('content-type') || '').includes('text/html');

    if (url.pathname === '/') {
      // Best-effort geolocation-derived state cookie for a first-time visitor with no cookie yet
      // -- purely "for next time" (app.js doesn't read this back client-side yet, see the header
      // comment), so it's fine if this never fires for a non-US visitor/bot/VPN Cloudflare can't
      // place. Never cached: a cached Set-Cookie here would leak one visitor's detected state to
      // every later visitor hitting the same cached edge response.
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'private, no-store');
      if (!parseCookie(request.headers.get('Cookie'), 'pxq_state')) {
        const region = request.cf && request.cf.country === 'US' ? request.cf.regionCode : null;
        if (region && KNOWN_STATE_CODES.has(region)) setStateCookieHeader(headers, region);
      }
      response = new Response(response.body, { status: response.status, headers });
    }

    if (isHtml) {
      const canonicalHref = url.origin + url.pathname; // self-referencing -- correct on prod and any preview domain alike
      // /guides/* are real static directory-style files (wwwroot/guides/{slug}/index.html) --
      // Cloudflare Pages' asset handler 308s the bare "/guides/{slug}" request to a trailing-slash
      // "/guides/{slug}/" before this branch ever runs, so the pathname actually seen here always
      // has the trailing slash even though GUIDES_SEO_META's keys (and SEO_META's, for consistency)
      // don't. Strip it for the lookup only -- every other route on this site is flat (single
      // wwwroot/index.html SPA shell) so this never affects them.
      const seoLookupPath = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
      response = withSeoMeta(response, canonicalHref, SEO_META[seoLookupPath] || GUIDES_SEO_META[seoLookupPath]);
    }
    return response;
  },
};
