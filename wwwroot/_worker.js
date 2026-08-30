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
  '/driver/ca': { title: 'California Driver Knowledge Test (Class C) | PassExamHQ', description: 'Practice questions covering the California Driver Handbook: right-of-way rules, signs and signals, safe driving practices, and DUI/financial…' },
  '/cdl/ca': { title: 'California CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the California Commercial Driver Handbook: general knowledge, air brakes, combination vehicles, and endorsement topics for…' },
  '/motorcycle/ca': { title: 'California Motorcycle Knowledge Test (M1/M2) | PassExamHQ', description: 'Practice questions covering the California Motorcycle Handbook: safe riding techniques, hazard avoidance, licensing requirements, and DUI law for the…' },
  '/driver/tx': { title: 'Texas Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the Texas Driver Handbook: licensing and application steps, right-of-way and vehicle equipment rules, traffic signs and…' },
  '/cdl/tx': { title: 'Texas CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Texas Commercial Motor Vehicle Driver Handbook: general knowledge, air brakes, combination vehicles, and endorsement…' },
  '/driver/fl': { title: 'Florida Class E Knowledge Exam | PassExamHQ', description: 'Practice questions covering the Florida Driver License Handbook: licensing and ID requirements, driver fitness, traffic controls, rules of the road, and…' },
  '/cdl/fl': { title: 'Florida CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Florida Commercial Driver License Handbook: general knowledge, air brakes, combination vehicles, and endorsement topics…' },
  '/driver/ny': { title: 'New York Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the New York State Driver\'s Manual: licensing and learner permit rules, right-of-way and traffic control,…' },
  '/cdl/ny': { title: 'New York CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the New York State Commercial Driver\'s Manual: general knowledge, air brakes, combination vehicles, and endorsement topics…' },
  '/notary/ny': { title: 'New York Notary Public Exam | PassExamHQ', description: 'Practice questions covering the New York Notary Public License Law: appointment and professional conduct, powers and duties, statutory fees, real…' },
  '/driver/il': { title: 'Illinois Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the Illinois Rules of the Road: licensing and exam procedures, roadway signs and signals, traffic laws, safe driving and…' },
  '/real-estate-salesperson/il': { title: 'Illinois Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the Illinois Real Estate License Act of 2000 (225 ILCS 454): licensing requirements, the License Act itself, additional…' },
  '/real-estate-broker/il': { title: 'Illinois Managing Broker Exam | PassExamHQ', description: 'Practice questions covering the Illinois Real Estate License Act of 2000 (225 ILCS 454) for the Managing Broker upgrade credential: brokerage…' },
  '/driver/pa': { title: 'Pennsylvania Driver\'s License Knowledge Test | PassExamHQ', description: 'Practice questions covering the Pennsylvania Driver\'s Manual (PennDOT, PUB 95): licensing and permit basics, traffic signals/signs/pavement markings,…' },
  '/cdl/pa': { title: 'Pennsylvania CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Pennsylvania Commercial Driver\'s Manual (PennDOT, PUB223): general knowledge, cargo and passenger safety, vehicle control…' },
  '/real-estate-salesperson/pa': { title: 'Pennsylvania Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering 49 Pa. Code Chapter 35 (State Real Estate Commission regulations): the Real Estate Commission, licensure, agency and…' },
  '/real-estate-salesperson/ca': { title: 'California DRE Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the California Real Estate Law (Business and Professions Code, Division 4), scoped to DRE\'s own official RE 425 exam content…' },
  '/real-estate-broker/ca': { title: 'California Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the California Real Estate Law (Business and Professions Code, Division 4) at broker level, scoped to the DRE\'s own official…' },
  '/driver/oh': { title: 'Ohio Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the Ohio Driver Manual (BMV): licensing process and requirements, rules of the road and driving maneuvers, sharing the road…' },
  '/cdl/oh': { title: 'Ohio CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Ohio CDL Manual (BMV, AAMVA content): CDL licensing and regulations, vehicle inspection and cargo/passenger safety,…' },
  '/motorcycle/oh': { title: 'Ohio Motorcycle Written Knowledge Test | PassExamHQ', description: 'Practice questions covering the Ohio Motorcycle Operator Manual: basic operation, cornering and braking, gear, rider readiness and impairment, licensing,…' },
  '/real-estate-salesperson/oh': { title: 'Ohio Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Ohio Revised Code Chapter 4735 (Real Estate Brokers) and Ohio Administrative Code Chapter 1301:5: licensing, applications,…' },
  '/boating/oh': { title: 'Ohio Boater Education Certification Exam | PassExamHQ', description: 'Practice questions covering the Ohio Boat Operators Guide (ODNR Division of Parks & Watercraft): registration, titling and required equipment, federal…' },
  '/driver/ga': { title: 'Georgia Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the Georgia Driver\'s Manual (Department of Driver Services): general licensing and obtaining a license, permit or ID card,…' },
  '/cdl/ga': { title: 'Georgia CDL (Commercial Driver\'s License) Exam & Endorsements | PassExamHQ', description: 'Practice questions covering the Georgia CDL Manual/Study Guide (Department of Driver Services): CDL licensing and vehicle inspection, vehicle control/air…' },
  '/motorcycle/ga': { title: 'Georgia Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the Georgia Motorcycle Operator\'s Manual (Department of Driver Services): licensing/permits and road signs/signals,…' },
  '/real-estate-salesperson/ga': { title: 'Georgia Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Georgia Real Estate Commission Rules (Chapter 520) and O.C.G.A. Title 43, Chapter 40 -- the licensing and regulatory…' },
  '/driver/nc': { title: 'North Carolina Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the North Carolina Driver\'s Handbook: licensing, permits and required documents, alcohol, points and license consequences,…' },
  '/cdl/nc': { title: 'North Carolina CDL (Commercial Driver\'s License) Exam | PassExamHQ', description: 'Practice questions covering the North Carolina CDL Manual: vehicle control, air brakes and combination vehicles, CDL licensing, vehicle inspection and…' },
  '/real-estate-salesperson/nc': { title: 'North Carolina Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the North Carolina Real Estate License Law and Commission Rules: handling trust funds and broker price opinions/CMAs, broker…' },
  '/notary/nc': { title: 'North Carolina Notary Public Exam | PassExamHQ', description: 'Practice questions covering the North Carolina Notary Public Act (General Statutes Chapter 10B): general provisions and commissioning, notarial acts,…' },
  '/driver/va': { title: 'Virginia Driver License Knowledge Exam | PassExamHQ', description: 'Practice questions covering the Virginia Driver\'s Manual: traffic signals, signs and pavement markings, space cushion, sharing the road and hazardous…' },
  '/cdl/va': { title: 'Virginia CDL (Commercial Driver\'s License) Exam | PassExamHQ', description: 'Practice questions covering the Virginia CDL Manual: vehicle control, air brakes and combination vehicles, CDL licensing and driving safety, hazardous…' },
  '/motorcycle/va': { title: 'Virginia Motorcycle Knowledge Exam | PassExamHQ', description: 'Practice questions covering the Virginia Motorcycle Rider\'s Manual: visibility, lane positioning and following distance, gear, pre-ride inspection and…' },
  '/real-estate-salesperson/va': { title: 'Virginia Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Virginia Code Chapter 21 (Real Estate Board) and 18VAC135-20: licensing, qualifications, continuing education and escrow…' },
  '/boating/va': { title: 'Virginia Boating Safety Education Exam | PassExamHQ', description: 'Practice questions covering the Virginia DWR Boater\'s Guide: required safety equipment, operating laws and safety course requirements, safety, accidents…' },
  '/driver/mi': { title: 'Michigan Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the Michigan Driver\'s Manual (Secretary of State): traffic laws, signs, pavement markings and signals, licensing, GDL…' },
  '/cdl/mi': { title: 'Michigan CDL (Commercial Driver\'s License) Exam | PassExamHQ', description: 'Practice questions covering the Michigan Commercial Driver License Manual: CDL licensing and driving safety, vehicle control, air brakes and combination…' },
  '/motorcycle/mi': { title: 'Michigan Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the Michigan Motorcycle Operator Manual: licensing, permits and endorsement requirements, Michigan motorcycle laws and…' },
  '/boating/mi': { title: 'Michigan Boater Safety Certification Exam | PassExamHQ', description: 'Practice questions covering Michigan Boating Laws and Responsibilities: required safety equipment, boating basics and navigation rules, operating laws,…' },
  '/boating/ca': { title: 'California Boater Card Knowledge Exam | PassExamHQ', description: 'Practice questions covering California\'s Boater Card education requirement (California State Parks Division of Boating and Waterways, DBW): boat types…' },
  '/boating/tx': { title: 'Texas Boater Education Knowledge Exam | PassExamHQ', description: 'Practice questions covering Texas\'s boater education requirement (Texas Parks & Wildlife Department, TPWD) and the Texas Boating Laws and…' },
  '/boating/fl': { title: 'Florida Boating Safety Education Knowledge Exam | PassExamHQ', description: 'Practice questions covering Florida\'s Boating Safety Education ID Card requirement (Florida Fish and Wildlife Conservation Commission, FWC) and the…' },
  '/boating/ny': { title: 'New York Boater Safety Certificate Exam (Brianna\'s Law) | PassExamHQ', description: 'Practice questions covering New York\'s Brianna\'s Law boater safety certificate requirement (New York State Office of Parks, Recreation and Historic…' },
  '/boating/pa': { title: 'Pennsylvania Boating Safety Education Certificate Exam | PassExamHQ', description: 'Practice questions covering the Pennsylvania Boating Safety Education Certificate requirement (Pennsylvania Fish and Boat Commission, PFBC) and the…' },
  '/boating/il': { title: 'Illinois Boating Safety Certificate Exam | PassExamHQ', description: 'Practice questions covering the Handbook of Illinois Boating Laws and Responsibilities (Illinois Department of Natural Resources): vessel basics,…' },
  '/boating/ga': { title: 'Georgia Boating Education Exam | PassExamHQ', description: 'Practice questions covering the Handbook of Georgia Boating Laws and Responsibilities (Georgia Department of Natural Resources): vessel basics, required…' },
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
  '/real-estate-salesperson/mi': { title: 'Michigan Real Estate Salesperson Exam Prep (Michigan-Specific Content) | PassExamHQ', description: 'Practice questions covering Michigan\'s Occupational Code Article 25 (Real Estate Brokers and Salespersons, MCL 339.2501-2518): licensing, applications…' },
  '/driver/wa': { title: 'Washington Driver License Knowledge Test | PassExamHQ', description: 'Practice questions covering the Washington Driver Guide (Department of Licensing): licensing, permits and endorsements, vehicles, safety technology and…' },
  '/cdl/wa': { title: 'Washington CDL (Commercial Driver\'s License) Exam | PassExamHQ', description: 'Practice questions covering the Washington Commercial Driver Guide: vehicle control, air brakes and combination vehicles, CDL licensing, driving safety…' },
  '/motorcycle/wa': { title: 'Washington Motorcycle Endorsement Knowledge Test | PassExamHQ', description: 'Practice questions covering the Washington Motorcycle Operator Manual: licensing, permits and endorsement process, gear, motorcycle inspection and…' },
  '/motorcycle/al': { title: 'Alabama Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the Alabama Motorcycle Operator Manual (18th Edition, ALEA): protective gear and Alabama motorcycle licensing/road rules,…' },
  '/motorcycle/ar': { title: 'Arkansas Motorcycle Endorsement Knowledge Test | PassExamHQ', description: 'Practice questions covering the Motorcycle Operator Manual (Motorcycle Safety Foundation, distributed by the Arkansas Department of Public Safety /…' },
  '/motorcycle/ct': { title: 'Connecticut Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the Connecticut DMV Motorcycle Operator Manual: preparing to ride and gear, knowing your motorcycle, the CT motorcycle…' },
  '/motorcycle/mn': { title: 'Minnesota Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the Minnesota DPS Motorcycle and Motorized Bicycle Manual (PS30001-21, 11/2021), published by the Minnesota Department of…' },
  '/motorcycle/ms': { title: 'Mississippi Motorcycle Endorsement Written Knowledge Test | PassExamHQ', description: 'Practice questions covering the Mississippi Motorcycle Operator Manual (Mississippi Department of Public Safety, Driver Service Bureau): protective gear,…' },
  '/motorcycle/nc': { title: 'North Carolina Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the NC DMV Motorcyclists\' Handbook, Thirteenth Edition (NCDMV): gear and motorcycle responsibilities, basic vehicle control,…' },
  '/motorcycle/ny': { title: 'New York Motorcycle Written Knowledge Test | PassExamHQ', description: 'Practice questions covering the New York State DMV Motorcycle Manual: licenses, registration and moped rules, protective gear and passenger/equipment…' },
  '/motorcycle/pa': { title: 'Pennsylvania Motorcycle Written Knowledge Test | PassExamHQ', description: 'Practice questions covering the PennDOT Motorcycle Operator Manual, Pub 147 (Pennsylvania Department of Transportation): gear and basic vehicle control,…' },
  '/motorcycle/tx': { title: 'Texas Motorcycle Knowledge Test | PassExamHQ', description: 'Practice questions covering the Texas Motorcycle Operator Training Manual 2020-2021 (Texas Department of Licensing & Regulation / Texas Department of…' },
  '/motorcycle/ut': { title: 'Utah Motorcycle Endorsement Knowledge Test | PassExamHQ', description: 'Practice questions covering the Utah Motorcycle Operator Manual (Utah Driver License Division, DLD): basic vehicle control, keeping distance, SEE…' },
  '/real-estate-salesperson/wa': { title: 'Washington Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering RCW 18.85 (broker licensing), RCW 18.86 (brokerage relationships/agency) and RCW 49.60.222-.227 (fair housing): licensing…' },
  '/real-estate-broker/wa': { title: 'Washington Managing Broker Exam | PassExamHQ', description: 'Practice questions covering RCW 18.85 (managing-broker sections), WAC 308-124C (Records and Responsibilities), WAC 308-124E (Trust Account Procedures)…' },
  '/real-estate-salesperson/ak': { title: 'Alaska Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Alaska Real Estate Law Content Outline (Alaska Statutes Title 08, Chapter 88 and the Real Estate Commission\'s regulations…' },
  '/real-estate-salesperson/al': { title: 'Alabama Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Alabama Real Estate License Law (Code of Alabama 1975, Title 34, Chapter 27) and the Alabama Real Estate Commission\'s…' },
  '/real-estate-salesperson/ar': { title: 'Arkansas Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Arkansas Real Estate License Law (Arkansas Code Annotated Title 17, Chapter 42) and the Arkansas Real Estate Commission\'s…' },
  '/real-estate-salesperson/az': { title: 'Arizona Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Arizona Department of Real Estate\'s Arizona Real Estate Law Book (A.R.S. Title 32, Chapter 20 and A.A.C. Title 4, Chapter…' },
  '/real-estate-salesperson/co': { title: 'Colorado Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the Colorado Real Estate Manual, Colorado Revised Statutes Title 12, Article 10, and 4 CCR 725-1 (Rules Regarding Real Estate…' },
  '/real-estate-salesperson/ct': { title: 'Connecticut Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Connecticut General Statutes Title 20, Chapter 392 (Real Estate Licensees) and its implementing Regulations of Connecticut…' },
  '/real-estate-salesperson/de': { title: 'Delaware Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Delaware Code Title 24, Chapter 29 (Real Estate Services, Brokers, Associate Brokers and Salespersons) and the Delaware Real…' },
  '/real-estate-salesperson/hi': { title: 'Hawaii Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Hawaii Real Estate Brokers and Salespersons Law (Hawaii Revised Statutes Chapter 467) and the Real Estate Commission\'s…' },
  '/real-estate-salesperson/ia': { title: 'Iowa Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Iowa Code Chapter 543B (Real Estate Brokers and Salespersons) and Iowa Administrative Code 193E (Real Estate Commission):…' },
  '/real-estate-salesperson/id': { title: 'Idaho Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Idaho Real Estate Commission\'s License Law and Rules (Idaho Code Title 54, Chapter 20 and IDAPA 24.37.01) -- the…' },
  '/real-estate-salesperson/in': { title: 'Indiana Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering Indiana Code Title 25, Article 34.1 (the Real Estate Broker Licensing Act) and 876 IAC (Indiana Administrative Code, Indiana…' },
  '/real-estate-salesperson/ks': { title: 'Kansas Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Kansas Real Estate Brokers\' and Salespersons\' License Act (K.S.A. 58-3034 et seq.), the Brokerage Relationships in Real…' },
  '/real-estate-salesperson/ky': { title: 'Kentucky Real Estate Sales Associate Exam | PassExamHQ', description: 'Practice questions covering Kentucky Revised Statutes Chapter 324 and the Real Estate Commission\'s regulations at 201 KAR Chapter 11 -- the…' },
  '/real-estate-salesperson/la': { title: 'Louisiana Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Louisiana Real Estate License Law (La. R.S. 37:1430-1470) and the Louisiana Real Estate Commission\'s Rules (Louisiana…' },
  '/real-estate-salesperson/ma': { title: 'Massachusetts Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Massachusetts General Laws Chapter 112, Sections 87PP-87DDD 1/2 and 254 CMR 2.00-7.00 (Board of Registration of Real Estate…' },
  '/real-estate-salesperson/md': { title: 'Maryland Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Maryland Real Estate Commission Law (Business Occupations and Professions Article, Title 17) and COMAR Title 09, Subtitle…' },
  '/real-estate-salesperson/me': { title: 'Maine Real Estate Sales Agent Exam | PassExamHQ', description: 'Practice questions covering the Maine Real Estate Commission\'s Maine Law content outline -- grounded in 32 M.R.S. Chapter 114 and the Commission\'s Rules…' },
  '/real-estate-salesperson/mn': { title: 'Minnesota Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Minnesota Statutes Chapter 82, Sections 82.55-82.89 (Real Estate Broker, Salesperson, and Closing Agent Licensing Law):…' },
  '/real-estate-salesperson/mo': { title: 'Missouri Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Missouri Real Estate Practice Act (RSMo Chapter 339) and the statutory Agency Relationships subchapter (RSMo…' },
  '/real-estate-salesperson/ms': { title: 'Mississippi Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Mississippi Real Estate Brokers License Law of 1954 (Miss. Code Ann. §§ 73-35-1 to 73-35-105) and the Mississippi Real…' },
  '/real-estate-salesperson/mt': { title: 'Montana Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Montana Real Estate License Act (Montana Code Annotated Title 37, Chapter 51) and the Montana Board of Realty…' },
  '/real-estate-salesperson/nd': { title: 'North Dakota Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering North Dakota Century Code Chapter 43-23 (State Real Estate Commission) and the implementing rules at North Dakota…' },
  '/real-estate-salesperson/ne': { title: 'Nebraska Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Nebraska Real Estate License Act (Neb. Rev. Stat. &sect;&sect; 81-885 to 81-885.56), the agency relationships statute…' },
  '/real-estate-salesperson/nh': { title: 'New Hampshire Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the New Hampshire Real Estate Practice Act (RSA 331-A) and the Real Estate Commission\'s administrative rules (N.H. Code of…' },
  '/real-estate-salesperson/nj': { title: 'New Jersey Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the New Jersey Real Estate License Act (N.J.S.A. 45:15) and the Real Estate Commission\'s implementing regulations (N.J.A.C.…' },
  '/real-estate-salesperson/nm': { title: 'New Mexico Real Estate Broker Examination | PassExamHQ', description: 'Practice questions covering the New Mexico Real Estate Brokers and Salesmen Act (NMSA 1978 §§ 61-29-1 to 61-29-29) and the New Mexico Real Estate…' },
  '/real-estate-salesperson/nv': { title: 'Nevada Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Nevada Revised Statutes (NRS) Chapter 645 and Nevada Administrative Code (NAC) Chapter 645 -- Real Estate Brokers and…' },
  '/real-estate-salesperson/ok': { title: 'Oklahoma Real Estate Provisional Sales Associate Exam | PassExamHQ', description: 'Practice questions covering the Oklahoma Real Estate License Code (59 O.S. § 858-101 et seq.) and Title 605 of the Oklahoma Administrative Code: laws and…' },
  '/real-estate-salesperson/or': { title: 'Oregon Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering Oregon Revised Statutes Chapter 696 (Real Estate and Escrow Activities) and Oregon Administrative Rules Chapter 863 (Real…' },
  '/real-estate-salesperson/ri': { title: 'Rhode Island Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Rhode Island\'s real estate licensing law -- R.I. Gen. Laws Chapter 5-20.5 (Real Estate Brokers and Salespersons), Chapter…' },
  '/real-estate-salesperson/sc': { title: 'South Carolina Real Estate Associate Exam | PassExamHQ', description: 'Practice questions covering the South Carolina Real Estate License Act (S.C. Code Title 40, Chapter 57) and the Real Estate Commission\'s Regulations…' },
  '/real-estate-salesperson/sd': { title: 'South Dakota Real Estate Broker Associate Exam | PassExamHQ', description: 'Practice questions covering South Dakota real estate licensing law (SDCL Title 36, Chapter 21A) and the Real Estate Commission\'s rules (ARSD Article…' },
  '/real-estate-salesperson/tn': { title: 'Tennessee Real Estate Affiliate Broker Exam | PassExamHQ', description: 'Practice questions covering the Tennessee Real Estate Broker License Act of 1973 (Tenn. Code Ann. Title 62, Chapter 13) and the Real Estate Commission\'s…' },
  '/real-estate-salesperson/ut': { title: 'Utah Real Estate Sales Agent Exam | PassExamHQ', description: 'Practice questions covering the Utah Real Estate Licensing and Practices Act (Utah Code Title 61, Chapter 2f) and its implementing regulations, Utah…' },
  '/real-estate-salesperson/vt': { title: 'Vermont Real Estate Salesperson State Examination | PassExamHQ', description: 'Practice questions covering 26 V.S.A. Chapter 41 (Real Estate Brokers and Salespersons) and the Vermont Real Estate Commission\'s Administrative Rules:…' },
  '/real-estate-salesperson/wi': { title: 'Wisconsin Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering Wisconsin Statutes Chapter 452 and Wisconsin Administrative Code chs. REEB 11, 12, 15, 16, 17, 18, 23, 24, and 25 (Real…' },
  '/real-estate-salesperson/wv': { title: 'West Virginia Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the West Virginia Real Estate License Act (W. Va. Code Chapter 30, Article 40) and the Real Estate Commission\'s Title 174…' },
  '/real-estate-salesperson/wy': { title: 'Wyoming Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering the Wyoming Real Estate License Act (Wyoming Statutes Title 33, Chapter 28) and the Wyoming Real Estate Commission\'s Rules…' },
  '/real-estate-salesperson/fl': { title: 'Florida Real Estate Sales Associate Exam Prep (Licensing Law & Regulatory Content) | PassExamHQ', description: 'Practice questions covering Florida Statutes Chapter 475, Part I (Real Estate Brokers, Sales Associates, and Schools) and Florida Administrative Code…' },
  '/real-estate-broker/fl': { title: 'Florida Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering FREC\'s official 12-area broker exam content outline: real estate brokerage business (licensure, brokerage entities and office…' },
  '/real-estate-salesperson/tx': { title: 'Texas Real Estate Sales Agent Exam | PassExamHQ', description: 'Practice questions covering the Real Estate License Act (TRELA), Texas Occupations Code Chapter 1101, and the Texas Real Estate Commission\'s (TREC) rules…' },
  '/real-estate-broker/tx': { title: 'Texas Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the Pearson VUE-administered Texas Broker exam\'s combined National and State content: broker supervision, intermediary…' },
  '/real-estate-salesperson/ny': { title: 'New York Real Estate Salesperson Exam | PassExamHQ', description: 'Practice questions covering New York Real Property Law Article 12-A (Sections 440-443-a), the Property Condition Disclosure Act (RPL Article 14, Sections…' },
  '/real-estate-broker/ny': { title: 'New York Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering New York Real Property Law Article 12-A at broker level and 19 NYCRR Part 175 (Department of State real estate rules): broker…' },
  '/real-estate-broker/pa': { title: 'Pennsylvania Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering Pennsylvania\'s Real Estate Licensing and Registration Act (RELRA, 63 P.S. Sections 455.101-455.902) and 49 Pa. Code Chapter…' },
  '/real-estate-broker/oh': { title: 'Ohio Real Estate Broker Exam | PassExamHQ', description: 'Practice questions covering the Ohio Revised Code Chapter 4735 (Real Estate Brokers, Salespersons) and Ohio Administrative Code Chapter 1301:5: broker…' },
  '/notary/al': { title: 'Alabama Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering the Alabama Notary Public Act (Code of Alabama 1975, Title 36, Chapter 20), effective 9/1/2023: commissioning, qualifications…' },
  '/notary/fl': { title: 'Florida Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering Florida Statutes Chapter 117 (Notaries Public), Part I general provisions and Part II online notarizations: qualifications…' },
  '/notary/ga': { title: 'Georgia Notary Public Practice Questions | PassExamHQ', description: 'Practice questions covering O.C.G.A. Title 45, Chapter 17 (Notaries Public): notarial powers, duties, fees and limitations, definitions and…' },
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
};
// SEO_META_END

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
    },
  });
  if (meta) {
    rewriter
      .on('title', { element(el) { el.setInnerContent(meta.title); } })
      .on('meta[name="description"]', { element(el) { el.setAttribute('content', meta.description); } });
  }
  return rewriter.transform(response);
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
      response = withSeoMeta(response, canonicalHref, SEO_META[url.pathname]);
    }
    return response;
  },
};
