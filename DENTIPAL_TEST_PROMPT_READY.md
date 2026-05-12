# 🦷 DentiPal — Ready-to-Paste Test Generation Prompt

> Copy everything between the `<<<BEGIN PROMPT>>>` and `<<<END PROMPT>>>` markers below and paste it into ChatGPT, Claude, or any AI test-case generator.

---

<<<BEGIN PROMPT>>>

You are a Senior QA Engineer and Software Test Architect.

Generate comprehensive software testing documentation for my website **"DentiPal"** — a **two-sided AWS-native marketplace** that matches dental **clinics** with dental **professionals** (associate dentists, hygienists, dental assistants, front-desk, billing, compliance, accounting staff) for **temporary shifts, multi-day consulting projects, and permanent positions**.

⚠️ Important: DentiPal is **NOT** a patient-management platform. There is no Patient role. The platform connects clinics (employers) with professionals (workers). Replace any patient-centric assumptions with this marketplace model.

For every feature/module I provide, generate the following in separate sections:

1. Unit Test Cases (≥ 10)
2. Functional Test Cases (≥ 20)
3. QA Test Cases (≥ 15)
4. Feature Testing Scenarios (≥ 10)
5. Usability Testing Scenarios (≥ 10)
6. Performance Testing Scenarios (≥ 10)
7. User Acceptance Testing (UAT) Cases (≥ 10)

For each test case, use a markdown table with these exact columns:

| Test Case ID | Module Name | Feature Name | Test Scenario | Preconditions | Test Steps | Test Data | Expected Result | Actual Result | Status | Priority | Severity | Test Type | Environment | Browser/Device | Created By |

Test Case ID format: `DP-<MODULE>-<TYPE>-<###>` (e.g. `DP-AUTH-UNIT-001`).
Default values: `Actual Result = "Not executed"`, `Status = "Pending"`, `Created By = "QA-Team"`.

Cover all of these scenario types: positive, negative, edge, validation, security (JWT tampering, IDOR, injection, XSS, presigned-URL replay), accessibility (WCAG 2.1 AA), responsive/mobile (320 / 375 / 768 / 1024 / 1920 px), API contract validation, role-based access, database validation, load/performance, usability for non-technical users.

Output format: markdown tables only, sections separated by `---`, CSV-friendly cells (use `;` for multi-step joins, no merged cells, no nested lists).

---

## Project Name

**DentiPal**

---

## Feature/Module Details

Generate the 7 sections above for **each** of the 21 modules below. Endpoint paths and validation rules are exact (extracted from the production CDK + Lambda code).

### Module 1 — Authentication, Registration & OTP
Endpoints: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/forgot`, `POST /auth/check-email`, `POST /auth/confirm-forgot-password`, `POST /auth/google-login`, `POST /auth/initiate-registration`, `POST /auth/verify-otp`, `POST /auth/resend-otp`.
Rules: password ≥ 8 chars with digits + lower + upper + symbols; sign-in alias = email; required Cognito attributes `given_name, family_name, phone_number, email, address`. Cover: Google OAuth password-less custom-auth flow (challenge answer `"google-verified"`), portal-mismatch 403 (clinic user on professional portal), stale UNCONFIRMED user replacement, OTP replay/expiry, refresh-token rotation, lockout on 5+ failed attempts.

### Module 2 — User Management
Endpoints: `POST /users` (Root), `GET /users` (Root/ClinicAdmin), `GET /users/me`, `PUT /users/{userId}`, `DELETE /users/{userId}` (Root), `DELETE /users/me`, `GET /clinics/{clinicId}/users`.
Rules: name regex `/^[A-Za-z\s\-']{2,50}$/`, phone `/^\+?\d{10,15}$/`, password+verifyPassword match, blocked fields `phoneNumber, phone_number, username`.

### Module 3 — Clinic Management & Multi-Tenancy
Endpoints: `POST /clinics`, `GET /clinics`, `GET /clinics-user`, `GET /clinics/{clinicId}`, `PUT /clinics/{clinicId}`, `DELETE /clinics/{clinicId}` (Root only), `GET /clinics/{clinicId}/address` (public).
Rules: membership via `Clinics.AssociatedUsers` list; geocoding via Amazon Location; cross-clinic IDOR; orphan cascades on delete.

### Module 4 — Clinic Profiles
Endpoints: `POST /clinic-profiles`, `GET /clinic-profiles`, `GET /clinic-profile/{clinicId}`, `PUT /clinic-profiles/{clinicId}`, `DELETE /clinic-profiles/{clinicId}`.
Rules: 28 whitelisted update fields; unknown fields rejected; gated by `canWriteClinic("manageClinic")`.

### Module 5 — Professional Profiles
Endpoints: `POST /profiles`, `GET /profiles`, `PUT /profiles`, `DELETE /profiles`, `GET /profiles/questions?role=<role>`, `GET /profiles/{userSub}`, `GET /allprofessionals`, `GET /professionals/public`.
Rules: role from `VALID_ROLE_VALUES` (18 values); blocked update fields `userSub, createdAt, email, role`; default profile cannot be deleted (409); role-specific form schema (7 role templates).

### Module 6 — Job Postings (Three Types)
Endpoints: `POST/GET/PUT/DELETE /jobs/{...}` plus type-specific `/jobs/temporary*`, `/jobs/consulting*`, `/jobs/permanent*`, `/jobs/multiday/*`, `/jobs/clinictemporary/{clinicId}`, `/jobs/clinicpermanent/{clinicId}`, `/jobs/multiday/clinic/{clinicId}`. Status FSM: `open ↔ scheduled ↔ action_needed ↔ completed`.
Rules: `job_type ∈ {temporary, multi_day_consulting, permanent}`; `pay_type ∈ {per_hour, per_transaction, percentage_of_revenue}`; per_hour $10–$300; percentage 0–100; per_transaction blocked for doctor roles; temporary requires future `date` and `hours ∈ [1,12]`; multi-day requires `dates.length === total_days`, unique future dates ≤30, `hours_per_day ∈ [1,12]`; permanent requires `employment_type, salary_min ≤ salary_max, vacation_days ∈ [0,50]`; bulk-create returns 207 on partial success.

### Module 7 — Job Search & Browse
Endpoints: `GET /jobs/browse` (auth), `GET /jobs/public` and `GET /public/publicJobs` (public, promotion-sorted), `GET /professionals/filtered-jobs` (auth, advanced).
Rules: filters `role, jobType, location, minRate, maxRate, payType, workLocationType, start, end, radius (mi), userLat, userLng, sort ∈ {trending, newest, highestPay, priority}, limit ≤ 100, cursor (base64)`. Relevance score 0–140 (recency 0–40, role match 0–30, rate 0–20, completeness 0–10, distance 0–10, applied-clinic boost +15, popularity 0–15). MAX_SCAN safety cap = 500. Haversine distance in miles (R = 3959).

### Module 8 — Job Applications
Endpoints: `POST /applications`, `GET /applications`, `PUT /applications/{applicationId}`, `DELETE /applications/{applicationId}`, `GET /clinics/{clinicId}/jobs`, `GET /{clinicId}/jobs`.
Rules: if `proposedRate` is supplied, auto-creates `JobNegotiation` and sets `applicationStatus = "negotiating"`; statuses `pending | negotiating | accepted | rejected | scheduled | completed | job_cancelled`; terminal statuses block update; `accepted` blocks withdrawal.

### Module 9 — Job Invitations
Endpoints: `POST /jobs/{jobId}/invitations` (bulk, ≤50), `POST /invitations/{invitationId}/response`, `GET /invitations`, `GET /invitations/{clinicId}`.
Rules: response `∈ {accepted, declined, negotiating}`; permanent jobs require salary min+max; temporary jobs require `proposedHourlyRate`; emits EventBridge `ShiftEvent` on acceptance.

### Module 10 — Negotiations
Endpoints: `PUT /applications/{applicationId}/negotiations/{negotiationId}/response`, `GET /allnegotiations`, `GET /negotiations`.
Rules: actor inferred from caller; response `∈ {accepted, declined, counter_offer}`; final rate selection takes the other party's latest counter; accepting transitions Application + Negotiation to `scheduled` and emits ShiftEvent.

### Module 11 — Hiring & Rejection
Endpoints: `POST /jobs/{jobId}/hire`, `POST /{clinicId}/reject/{jobId}`.
Rules: caller group must be `root | clinicadmin | clinicmanager`; hire flips application to `scheduled` and emits ShiftEvent; reject silently fires no event (professional not notified).

### Module 12 — Shift Dashboards (10 endpoints, 2 handlers)
Endpoints: `GET /dashboard/all/{open-shifts | action-needed | scheduled-shifts | completed-shifts | invites-shifts}`, `GET /clinics/{clinicId}/{same 5}`, `GET /scheduled/{clinicId}`, `GET /completed/{clinicId}`, `PUT /professionals/completedshifts` (also EventBridge `aws.events` scheduled), `GET /action-needed`, `GET /clinics/{clinicId}/action-needed`.
Rules: time-based auto-completion when end-time has passed; `updateCompletedShifts` is the nightly sweep that triggers `$50` referral bonuses.

### Module 13 — Real-time Chat (WebSocket)
Endpoint: `wss://<api-id>.execute-api.<region>.amazonaws.com/prod?token=<accessToken>&clinicId=<id>`.
Routes: `$connect` (JWT signature **verified** via `aws-jwt-verify`), `$disconnect`, `$default`.
Actions inside `$default`:
- `sendMessage`: `{clinicId, professionalSub, content (≤1000), messageType: "text" | "system"}` — broadcast to recipient + sender's other tabs; ACK to caller.
- `getHistory`: paginated desc; sender messages get `status: "read" | "delivered"`.
- `markRead`: resets caller's unread count; pushes `readReceipt` to other party.
- `getConversations`: two-phase response — fast metadata frame, then async `avatarsUpdate` with S3 presigned URLs.
System frames pushed by `event-to-message` Lambda for ShiftEvent (`shift-applied | invite-accepted | shift-cancelled | shift-scheduled`).

### Module 14 — File Management (S3)
Endpoints: `POST /files/presigned-urls`, `GET /files/{profile-images | professional-resumes | professional-licenses | driving-licenses | video-resumes | clinic-office-images}`, `PUT /files/{profile-image | professional-resumes | professional-licenses | driving-licenses | video-resumes}`, `DELETE /files/{profile-images | certificates | video-resumes}`.
Rules: presigned POST policies enforce `content-length-range` (5 KB–100 MB) and `Content-Type` allowlist; 15-min upload TTL, 24-h download TTL; ownership via `x-amz-meta-uploaded-by` tag; clinic groups can bypass ownership on GET; DELETE is strict ownership only.

### Module 15 — Clinic Favorites
Endpoints: `POST /clinics/favorites`, `GET /clinics/favorites?limit=&role=&tags=`, `DELETE /clinics/favorites/{professionalUserSub}`.
Rules: 409 on duplicate; returns `roleDistribution` histogram.

### Module 16 — Referrals
Endpoints: `POST /referrals/invite`.
Rules: state machine `sent → signed_up → bonus_due → completed`; `$50` bonus per first completed shift (constant `BONUS_AMOUNT`); SES sender hardcoded `jelladivya369@gmail.com`; `BonusAwarding.ts` DynamoDB Streams handler tops up on every completed shift.

### Module 17 — Job Promotions
Endpoints: `GET /promotions/plans` (public), `POST /promotions`, `GET /promotions?clinicId=<id|all>`, `GET /promotions/{promotionId}`, `PUT /promotions/{promotionId}/cancel`, `PUT /promotions/{promotionId}/activate`, `POST /promotions/track-click` (public).
Rules: tiers `basic` (3d / $9.99), `featured` (7d / $24.99), `premium` (14d / $49.99); weights `premium=3, featured=2, basic=1`; expired promotions masked at read; click counter `ADD :one` with `status="active"` condition (silent failure for inactive).

### Module 18 — User Addresses
Endpoints: `POST/GET/PUT/DELETE /user-addresses`.
Rules: geocoded via Amazon Location; re-geocodes on update; removes stale `lat/lng` if geocoding fails; deleting default address blocked (403).

### Module 19 — Geocoding (Public)
Endpoints: `GET /geocode/postal?postalCode=<code>&country=<ISO2>`, `GET /location/lookup`.
Rules: ISO2 → ISO3 country code conversion; US state abbreviation map; returns `{city, state, stateFull, country, postalCode, label, coordinates: {lng, lat} | null}`.

### Module 20 — Feedback
Endpoints: `POST /submitfeedback`.
Rules: anonymous allowed; message ≤ 5000 chars; DynamoDB Put + SES forward.

### Module 21 — EventBridge Inbox Bridge + Cognito Triggers
- EventBridge rule `DentiPal-ShiftEvent-to-Inbox` (source `denti-pal.api`, detailType `ShiftEvent`) → `event-to-message` Lambda → system message → WebSocket push.
- Cognito Lambda triggers: `preSignUp` (auto-fill for Google federation + auto-confirm), `defineAuthChallenge`, `createAuthChallenge`, `verifyAuthChallenge` (compare to `"google-verified"`).

---

## Tech Stack

**Backend**
- AWS CDK v2 (TypeScript), CloudFormation stack `DentiPalCDKStackV5`
- AWS Lambda Node.js 18.x — 7 functions (REST monolith 1024 MB / 60 s; WebSocket 512 MB / 30 s; event-to-message 256 MB / 30 s; 4 Cognito triggers 128 MB / 10 s)
- Amazon API Gateway v1 (REST) — stage `prod`, `/{proxy+}` to monolith, X-Ray on, INFO logs + data trace, CORS for `http://localhost:5173` + `https://main.d3agcvis750ojb.amplifyapp.com`, binary types `multipart/form-data`
- Amazon API Gateway v2 (WebSocket) — `DentiPal-Chat-API` at `wss://<id>.execute-api.<region>.amazonaws.com/prod`
- Amazon Cognito User Pool `ClinicUserPoolV5` — email alias, custom + SRP + user-password + admin-user-password auth flows, 20 groups
- Amazon DynamoDB — 18 tables, 25 GSIs, PAY_PER_REQUEST
- Amazon S3 — 7 buckets (`ProfileImagesBucket, CertificatesBucket, VideoResumesBucket, ProfessionalResumesBucket, DrivingLicensesBucket, ProfessionalLicensesBucket, ClinicOfficeImagesBucket`), SSE-S3, block-all-public, CORS for upload origins
- Amazon SES — 8 integrated handlers (3 custom HTML, 5 Cognito-managed)
- Amazon SNS — `DentiPal-SMS-Notifications` topic for welcome SMS
- Amazon EventBridge — `DentiPal-ShiftEvent-to-Inbox` rule
- Amazon Location Service — `DentiPalGeocoder` Place Index (HERE)

**Frontend (consumes backend)**
- React + Vite (dev `http://localhost:5173`)
- AWS Amplify hosting (`https://main.d3agcvis750ojb.amplifyapp.com`)

**Auth over the wire**
- REST: `Authorization: Bearer <Cognito access token>`
- WebSocket: `?token=<accessToken>` querystring on `$connect`
- Known gap: REST handlers do not verify JWT signature (`extractAndDecodeAccessToken` only base64-decodes) — security tests must cover this.

---

## User Roles

⚠️ DentiPal does **not** have an `Admin / Dentist / Receptionist / Patient` model. It uses **AWS Cognito groups**. Use exactly these 20 groups:

**Clinic-side (4 roles, capability matrix below)**
- `Root` — clinic super-admin
- `ClinicAdmin` — full write on assigned clinics
- `ClinicManager` — full write on assigned clinics
- `ClinicViewer` — read-only

**Professional-side (16 roles)**
- Doctor: `Dentist`, `AssociateDentist`
- Clinical: `DentalHygienist`, `Hygienist`, `DentalAssistant`, `DHComboRole`
- Front Office: `FrontDesk`
- Dual Role: `DualRoleFrontDA`
- Billing: `BillingCoordinator`, `InsuranceVerification`, `PaymentPosting`, `ClaimsSending`, `ClaimsResolution`
- Compliance: `HIPAATrainee`, `OSHATrainee`
- Accounting: `Accounting`

**Clinic-role capability matrix** (use for role-based access tests):

| Action | Root | ClinicAdmin | ClinicManager | ClinicViewer |
|--------|:----:|:-----------:|:-------------:|:------------:|
| Read clinic | ✅ | ✅ | ✅ | ✅ |
| `manageJobs` (CRUD postings + promotions) | ✅ | ✅ | ✅ | ❌ |
| `manageApplicants` (hire/reject/negotiate) | ✅ | ✅ | ✅ | ❌ |
| `manageClinic` (edit profile) | ✅ | ✅ | ✅ | ❌ |
| `manageUsers` | ✅ | ✅ | ✅ | ❌ |
| `createClinic` | ✅ | ✅ | ❌ | ❌ |
| `deleteClinic` | ✅ | ❌ | ❌ | ❌ |
| Create/delete users | ✅ | ❌ | ❌ | ❌ |

For every mutating endpoint, generate 6 role-access cases (one per clinic-side role + one professional + one anonymous).

---

## Additional Requirements

- Cover positive, negative, edge, validation, security, accessibility scenarios.
- Include responsive/mobile test cases (320, 375, 414, 768, 1024, 1280, 1920 px).
- Include API contract validation (status codes 200/201/207/400/401/403/404/409/429/500, response envelope, CORS headers).
- Include role-based access tests per the matrix above + cross-clinic IDOR cases.
- Include DynamoDB validation: read-after-write consistency, GSI propagation, conditional-update failures, BatchGet/BatchWrite 100/25-item chunking.
- Include load/performance: cold-start p50/p95/p99, sustained 100 rps, DynamoDB throttling at 1000 wps, WebSocket fan-out at 500 concurrent connections, Scan-based endpoint degradation at 10k/100k/1M rows, `getProfessionalFilteredJobs` MAX_SCAN cap boundary.
- Include usability checks for non-technical users (jargon-free errors, sensible defaults, clear progress indicators).
- Production-ready QA coverage: smoke / regression / exploratory / security / accessibility.
- Generate professional enterprise-level test cases suitable for Jira, TestRail, Zephyr, or Excel export.

---

## Output Format

- Use markdown tables only — one per section per module.
- Separate sections with `---` and `## Section N — <type>` headings.
- CSV-friendly cells: no merged cells, no nested lists, multi-step joined with `;` (e.g. `1) Open page; 2) Enter email; 3) Click submit`).
- For each of the 21 modules, output 7 tables (Unit / Functional / QA / Feature / Usability / Performance / UAT) totaling ≥ 85 cases per module.

Defaults inside cells:
- `Environment`: `Dev | Staging | Production`
- `Browser/Device`: e.g. `Chrome 124 / Win11`, `Safari 17 / iPhone 15`, `Android Chrome / Pixel 7`, `Firefox 125 / Ubuntu 22.04`, `iPad Safari / iPadOS 17`
- `Priority`: `High | Medium | Low` (login = High, geocoding = Medium, feedback = Low)
- `Severity`: `Critical | Major | Minor | Cosmetic`
- `Test Type`: `Unit | Functional | Regression | Smoke | Integration | E2E | Security | Performance | Load | Stress | Soak | Accessibility | Usability | UAT | API | Database | Negative | Boundary | Edge`
- `Actual Result`: `Not executed`
- `Status`: `Pending`
- `Created By`: `QA-Team`

After all 21 modules, append a **Master Coverage Summary** with: per-module case totals, per-role coverage, per-severity distribution, and a Traceability Matrix mapping each REST endpoint + WebSocket action to its test case IDs.

**Generate the response in CSV-friendly format so it can be directly copied into Excel or Google Sheets.**

<<<END PROMPT>>>

---

## 📋 How to use this prompt

1. **Copy** everything between `<<<BEGIN PROMPT>>>` and `<<<END PROMPT>>>`.
2. **Paste** into ChatGPT-5 / Claude Opus 4.7 / Gemini 2.5 Pro / any LLM.
3. The expected output is ~1,800 test cases (21 modules × ≥ 85 each). No single LLM response will fit them all — run module-by-module:
   - First message: paste the full prompt and ask for **Modules 1–3**.
   - Reply: `continue with Modules 4–6`.
   - Repeat until Module 21 + Master Coverage Summary.
4. To get clean CSV for Excel/Sheets, add at the end of each response:
   _"Now reformat the last 3 modules as one CSV per section (comma-separated, RFC 4180 quote-escaping). No markdown."_
5. To get TestRail import format:
   _"Convert Module 6 Section 2 (Functional) to TestRail bulk-import CSV: Title, Section, Type, Priority, Estimate, References, Preconditions, Steps, Expected Result."_
6. To get Zephyr/Xray BDD:
   _"Reformat as Zephyr Scale BDD Gherkin (Feature, Scenario, Given/When/Then) keeping the same coverage."_

---

*Saved by Claude Code based on a deep analysis of the actual DentiPal CDK + Lambda source.*
