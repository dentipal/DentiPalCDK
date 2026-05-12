# DentiPal — Test Generation Prompt (paste into ChatGPT/Claude)

> Copy everything from the line `## PROMPT — copy from here` to `## END OF PROMPT` and paste into ChatGPT-5, Claude Opus 4.7, Gemini 2.5 Pro, or any AI test generator.
>
> The prompt is filled in with the **actual** DentiPal backend inventory (extracted from the CDK code in `lib/denti_pal_cdk-stack.ts` and the 128 handler files in `lambda/src/handlers/`). No placeholders left.

---

## PROMPT — copy from here

You are a Senior QA Engineer and Software Test Architect.

Generate **comprehensive enterprise-grade software testing documentation** for my web application **DentiPal** — a two-sided AWS-native marketplace that matches dental clinics with dental professionals (temp shifts, multi-day consulting projects, and permanent positions). It is **not** a patient-management platform — there is no Patient role.

For every feature/module listed below, generate the following in **seven separate sections**:

1. Unit Test Cases (at least 10 per feature)
2. Functional Test Cases (at least 20 per feature)
3. QA Test Cases (at least 15 per feature)
4. Feature Testing Scenarios (at least 10 per feature)
5. Usability Testing Scenarios (at least 10 per feature)
6. Performance Testing Scenarios (at least 10 per feature)
7. User Acceptance Testing (UAT) Cases (at least 10 per feature)

For each test case, include these columns in a **markdown table**:

| Test Case ID | Module Name | Feature Name | Test Scenario | Preconditions | Test Steps | Test Data | Expected Result | Actual Result | Status (Pass/Fail) | Priority (High/Medium/Low) | Severity | Test Type | Environment | Browser/Device | Created By |

Test Case ID format: `DP-<MODULE>-<TYPE>-<###>` (e.g. `DP-AUTH-UNIT-001`, `DP-JOB-FUNC-014`).

### Coverage requirements

Cover **all** of these scenario types:
- Positive (happy path)
- Negative (invalid input, missing fields, wrong types)
- Edge cases (boundary values: empty strings, 0, max int, very long strings, special chars, emojis, RTL text)
- Validation (required fields, regex patterns, business rules)
- Security (JWT tampering, SQL/NoSQL injection attempts, XSS payloads, IDOR, broken object-level auth, bypassing role gates, presigned-URL replay)
- Accessibility (WCAG 2.1 AA: keyboard nav, screen-reader, color contrast, ARIA, focus order)
- Responsive / mobile (320 px, 375 px, 768 px, 1024 px, 1920 px viewports)
- API contract validation (request/response schemas, HTTP status codes, headers, CORS)
- Role-based access (all roles listed below, including cross-role access attempts)
- Database validation (DynamoDB read-after-write consistency, GSI propagation, conditional updates)
- Load / stress / soak (concurrency, sustained throughput, cold-start, spike traffic)
- Usability for non-technical users
- Production-ready QA coverage (smoke, regression, exploratory)

### Output rules

- Use **markdown tables only** — one table per of the 7 sections per feature.
- Separate sections with `---` and a clear `## Section N — <type>` heading per feature.
- Output must be **CSV-friendly** so it can be exported to Excel/Google Sheets/Jira/TestRail/Zephyr — no merged cells, no nested lists inside table cells (use `;` or `\n` if needed).
- Test Steps cell: numbered like `1) ... 2) ... 3) ...` separated by `;` so it stays on one row.
- Always populate `Actual Result` with `Not executed` and `Status` with `Pending` for fresh cases.
- `Created By` = `QA-Team`.

---

## Project Name

**DentiPal**

## Tech Stack

**Backend (AWS, serverless, CDK-provisioned)**
- AWS CDK v2 (TypeScript), CloudFormation stack name `DentiPalCDKStackV5`
- AWS Lambda — Node.js 18.x — **7 functions**:
  - `DentiPal-Backend-Monolith` (REST monolith, 1024 MB, 60 s timeout, ~128 handlers)
  - `DentiPal-Chat-WebSocket` (chat, 512 MB, 30 s)
  - `DentiPal-event-to-message` (EventBridge → inbox bridge, 256 MB)
  - `DentiPal-PreSignUp`, `DentiPal-DefineAuthChallenge`, `DentiPal-CreateAuthChallenge`, `DentiPal-VerifyAuthChallenge` (Cognito triggers, 128 MB each)
- Amazon API Gateway v1 (REST) — `/{proxy+}` to monolith, stage `prod`, CORS for `http://localhost:5173` and `https://main.d3agcvis750ojb.amplifyapp.com`, binary media `multipart/form-data`, X-Ray tracing on
- Amazon API Gateway v2 (WebSocket) — `DentiPal-Chat-API` at `wss://<id>.execute-api.<region>.amazonaws.com/prod`, routes `$connect / $disconnect / $default`
- Amazon Cognito User Pool `ClinicUserPoolV5` — email alias, SRP + user-password + admin-user-password + **custom** auth flows, 20 groups
- Amazon DynamoDB — **18 tables, 25 GSIs**, PAY_PER_REQUEST
- Amazon S3 — **7 buckets** (`ProfileImagesBucket, CertificatesBucket, VideoResumesBucket, ProfessionalResumesBucket, DrivingLicensesBucket, ProfessionalLicensesBucket, ClinicOfficeImagesBucket`), encryption SSE-S3, block-public-access, CORS configured
- Amazon SES — transactional email (welcome, OTP via Cognito, referral, feedback)
- Amazon SNS — SMS via `DentiPal-SMS-Notifications` topic
- Amazon EventBridge — rule `DentiPal-ShiftEvent-to-Inbox` (source `denti-pal.api`, detailType `ShiftEvent`)
- Amazon Location Service — `DentiPalGeocoder` Place Index (HERE data source)

**Frontend (assumed; consume backend)**
- React + Vite, dev at `http://localhost:5173`
- Production at `https://main.d3agcvis750ojb.amplifyapp.com` (AWS Amplify)

**Auth (over the wire)**
- `Authorization: Bearer <Cognito access token>` on every authenticated REST request
- WebSocket auth via querystring `?token=<accessToken>` on `$connect`
- Cognito JWT verified at WebSocket `$connect` (signature, expiration, issuer, `token_use=access`)
- REST handlers currently **do not verify JWT signature** — this is a known gap; QA security cases should cover it

## User Roles (actual DentiPal roles, not the template defaults)

DentiPal does **not** have a `Patient` role. Replace any patient-centric assumptions with the real role model below.

**Clinic-side roles** (case-insensitive in code; lower-cased for comparison)
| Role | Capabilities |
|------|--------------|
| `Root` | Highest clinic privilege; full write on clinics they belong to (NOT a platform-wide override) |
| `ClinicAdmin` | Full write on assigned clinics — manage jobs, applicants, profile, users |
| `ClinicManager` | Same write scope as `ClinicAdmin` |
| `ClinicViewer` | Read-only on assigned clinics |

**Professional-side roles** (one or more per professional account)
| Role | Category |
|------|----------|
| `Dentist`, `AssociateDentist` | Doctor |
| `DentalHygienist`, `Hygienist` (alias), `DentalAssistant`, `DHComboRole` | Clinical |
| `FrontDesk` | Front Office |
| `DualRoleFrontDA` | Dual Role |
| `BillingCoordinator`, `InsuranceVerification`, `PaymentPosting`, `ClaimsSending`, `ClaimsResolution` | Billing |
| `HIPAATrainee`, `OSHATrainee` | Compliance |
| `Accounting` | Accounting |

Test coverage requirement: include **cross-role IDOR and privilege-escalation cases** for every mutating endpoint — e.g. ClinicViewer attempting to call `PUT /clinics/{clinicId}` should return 403; a `Dentist` from clinic A attempting `POST /jobs/{jobId}/hire` on clinic B's job should return 403.

---

## Features / Modules to test

Generate the seven sections **for every module listed below**. Where the module has multiple sub-features, list test cases for each.

### Module 1 — Authentication, Registration & OTP

REST endpoints:
- `POST /auth/login` — email/password login; portal-side validation (clinic users on clinic portal, professional users on professional portal); returns Cognito tokens + associated clinics for clinic-role users.
- `POST /auth/refresh` — refresh token exchange.
- `POST /auth/forgot` — initiate password reset (Cognito-managed email).
- `POST /auth/check-email` — verify email against JWT, return derived `userType`.
- `POST /auth/confirm-forgot-password` — complete reset with `email`, `code`, `newPassword`.
- `POST /auth/google-login` — Google OAuth with password-less custom-auth flow; auto-provisions user on first login.
- `POST /auth/initiate-registration` — start signup; sends OTP via Cognito `SignUp`; stale UNCONFIRMED users get replaced.
- `POST /auth/verify-otp` — confirm signup, send welcome email + SMS, trigger referral bonus flow.
- `POST /auth/resend-otp` — resend signup OTP.

Validation rules:
- Password: min 8 chars, must include digits + lower + upper + symbols.
- Sign-in alias = email.
- Required Cognito attributes: `given_name, family_name, phone_number, email, address`.

Edge cases to cover:
- Locked-out user (5+ failed attempts → `LimitExceededException`).
- Google-only user attempting password login.
- Portal-mismatch (clinic user on professional portal → 403).
- Expired / mismatched / reused OTP codes.
- Refresh token replay after rotation.
- Custom-auth flow: client answers `"google-verified"` correctly vs. tampered answer.

### Module 2 — User Management

REST endpoints:
- `POST /users` (Root-only) — create clinic staff with subgroup `ClinicAdmin | ClinicManager | ClinicViewer`, assign to multiple `clinicIds`, optional welcome email.
- `GET /users` (Root / ClinicAdmin) — list all clinic staff in caller's clinics.
- `GET /users/me` (JWT) — caller's Cognito attributes.
- `PUT /users/{userId}` (Root / ClinicAdmin) — update firstName, lastName, subgroup, clinicIds, password.
- `DELETE /users/{userId}` (Root) — delete from Cognito + clean `AssociatedUsers`.
- `DELETE /users/me` (JWT) — self-service account deletion.
- `GET /clinics/{clinicId}/users` (member) — list `AssociatedUsers` subs.

Validation: firstName/lastName regex `/^[A-Za-z\s\-']{2,50}$/`, phone `/^\+?\d{10,15}$/`, password match check.

### Module 3 — Clinic Management & Multi-Tenancy

- `POST /clinics` (Root / ClinicAdmin) — create clinic, geocode address.
- `GET /clinics` (JWT, membership-scoped) — caller's clinics with filters `?state=&city=&name=&limit=`.
- `GET /clinics-user` (JWT) — caller's clinics + `isRoot` flag.
- `GET /clinics/{clinicId}` (`canAccessClinic`).
- `PUT /clinics/{clinicId}` (`canWriteClinic`, re-geocodes if address changed).
- `DELETE /clinics/{clinicId}` (Root only; no cascade — known limitation, test for orphans).
- `GET /clinics/{clinicId}/address` (**Public**).

Multi-tenancy: membership is `Clinics.AssociatedUsers` list (stored as L or SS). Test cross-clinic IDOR.

### Module 4 — Clinic Profiles

- `POST /clinic-profiles` — create with `clinicId, practice_type, primary_practice_area, primary_contact_first_name, primary_contact_last_name, assisted_hygiene_available, number_of_operatories, num_hygienists, num_assistants, num_doctors, booking_out_period, free_parking_available` + dynamic fields.
- `GET /clinic-profiles` — caller's profiles, enriched with `jobsPosted, jobsCompleted, totalPaid` aggregates.
- `GET /clinic-profile/{clinicId}` — single profile (member-only).
- `PUT /clinic-profiles/{clinicId}` (`canWriteClinic("manageClinic")`) — 28 whitelisted fields, unknown fields rejected.
- `DELETE /clinic-profiles/{clinicId}` (clinic user or Root).

### Module 5 — Professional Profiles

- `POST /profiles` — create with `first_name, last_name, role, specialties[], specializations[], yearsExperience, bio, phone, qualifications, skills[], certificates[], professionalCertificates[], license_number, is_willing_to_travel, max_travel_distance, profileImageKey, professionalResumeKeys[], professionalLicenseKeys[], drivingLicenseKeys[], videoResumeKey, dentalSoftwareExperience[]` + optional nested address.
- `GET /profiles` — caller's profile(s).
- `PUT /profiles` — field-level validation (regex + ranges); blocked fields `userSub, createdAt, email, role`.
- `DELETE /profiles` — blocks default profile (409).
- `GET /profiles/questions?role=<role>` — role-specific form schema (7 role templates).
- `GET /profiles/{userSub}` — any professional (JWT).
- `GET /allprofessionals` (admin directory).
- `GET /professionals/public` (**Public**) — directory with lat/lng for distance filter.

### Module 6 — Job Postings (Three Types)

**Generic CRUD** (`/jobs`, `/jobs/{jobId}`, `PUT /jobs/{jobId}/status`):
- `job_type ∈ {temporary, multi_day_consulting, permanent}`
- `professional_role ∈ VALID_ROLE_VALUES` (18 values)
- `pay_type ∈ {per_hour, per_transaction, percentage_of_revenue}`
- Per-hour rate: $10–$200 (createTemporaryJob) or $10–$300 (others)
- Per-transaction blocked for doctor roles
- Percentage_of_revenue: 0–100

**Temporary** (`/jobs/temporary*`) — `date` (future), `hours ∈ [1, 12]`, `start_time`, `end_time`, `meal_break`.

**Multi-day consulting** (`/jobs/consulting*`, `/jobs/multiday/*`) — `dates[]` (unique, future, ≤30), `total_days === dates.length`, `hours_per_day ∈ [1, 12]`. Meal-break parser accepts `"no break" | "HH:MM" | "1.5h" | "90min" | "30"`.

**Permanent** (`/jobs/permanent*`) — `employment_type ∈ {full_time, part_time}`, `salary_min ≤ salary_max`, `benefits[]`, `vacation_days ∈ [0, 50]`, `work_schedule`, `start_date`.

**Bulk creation** (`POST /jobs/temporary | consulting | permanent`) — `clinicIds: string[]`, partial success returns HTTP 207 with `failed: [{clinicId, error}]`.

**Search**:
- `GET /jobs/browse` (auth) — multi-filter.
- `GET /jobs/public` (public) — promotion-sorted, on-the-fly geocoding fallback.
- `GET /professionals/filtered-jobs` (auth) — `role, jobType, location, minRate, maxRate, payType, workLocationType, start, end, radius, userLat, userLng, sort ∈ {trending, newest, highestPay, priority}, limit ≤ 100, cursor (base64)`. Relevance scoring 0–140; MAX_SCAN safety cap = 500.

**Status FSM** (`PUT /jobs/{jobId}/status`): `open → {scheduled, action_needed, completed}` · `scheduled → {action_needed, completed, open}` · `action_needed → {scheduled, completed, open}` · `completed → {open}`. `active` ≡ `open`. Required: `status`, plus `acceptedProfessionalUserSub + scheduledDate` if `status=scheduled`.

### Module 7 — Job Applications

- `POST /applications` — apply; if `proposedRate` supplied, auto-creates `JobNegotiation` and sets status `negotiating`.
- `GET /applications` — caller's applications + latest negotiation; filters `status, jobType, limit`.
- `PUT /applications/{applicationId}` — owner-only; blocked terminal states.
- `DELETE /applications/{applicationId}` — withdraw (blocked if `accepted`).
- `GET /clinics/{clinicId}/jobs` — clinic grouped applicants per job.
- `GET /{clinicId}/jobs` (a.k.a. applicants of a clinic) — paginated `?jobId=&limit=&nextToken=`; excludes terminal-status apps; flat + `byJobId`.

### Module 8 — Job Invitations

- `POST /jobs/{jobId}/invitations` — clinic bulk-invite up to 50 professionals: `{professionalUserSubs[], invitationMessage?, urgency? (default "medium"), customNotes?}`.
- `POST /invitations/{invitationId}/response` — `response ∈ {accepted, declined, negotiating}` + rate fields (permanent vs. temporary). Emits EventBridge `ShiftEvent` on acceptance.
- `GET /invitations` — professional's invites (sent/pending).
- `GET /invitations/{clinicId}` — clinic's sent invites with status filter.

### Module 9 — Negotiations

- `PUT /applications/{applicationId}/negotiations/{negotiationId}/response` — actor inferred from caller; `response ∈ {accepted, declined, counter_offer}`; rate selection logic differs by actor and job type. Accepting transitions both Application and Negotiation to `scheduled` + emits EventBridge.
- `GET /allnegotiations` and `GET /negotiations` — three modes: by `applicationId`, by `jobId + professionalUserSub`, or list-all.

### Module 10 — Hiring & Rejection

- `POST /jobs/{jobId}/hire` — body `{professionalUserSub, clinicId?}`; group must be `root | clinicadmin | clinicmanager`; sets Application `scheduled`; emits ShiftEvent.
- `POST /{clinicId}/reject/{jobId}` — body `{professionalUserSub}`; sets Application `rejected`; no event emitted.

### Module 11 — Shift Dashboards (10 endpoints, 2 handlers)

Two handlers (`getAllClinicsShifts`, `getClinicShifts`) serve 5 paths each, branching on `event.resource`:
- `open-shifts` · `action-needed` · `scheduled-shifts` · `completed-shifts` · `invites-shifts`
- Aggregated (`/dashboard/all/*`) is scoped to `listAccessibleClinicIds`.
- Per-clinic (`/clinics/{clinicId}/*`) gated by `canAccessClinic`.

Plus:
- `GET /scheduled/{clinicId}` · `GET /completed/{clinicId}` (legacy)
- `PUT /professionals/completedshifts` + EventBridge `aws.events` source-short-circuit — nightly sweep; flips past-end-time scheduled shifts to `completed`; triggers referral bonus payouts of $50.
- `GET /action-needed` (root aggregator) and `GET /clinics/{clinicId}/action-needed`.

### Module 12 — Real-time Chat (WebSocket)

WebSocket endpoint: `wss://<api-id>.execute-api.<region>.amazonaws.com/prod?token=<accessToken>&clinicId=<id>`

Routes:
- `$connect` — JWT verified via `aws-jwt-verify`; row written to `Connections` with TTL 24 h.
- `$disconnect` — reverse lookup via `connectionId-index`; row deleted.
- `$default` — dispatched by `action` field:
  - `sendMessage` — `{clinicId, professionalSub, content (≤1000), messageType: "text" | "system"}` — writes Messages + Conversations; broadcasts to recipient + sender's other tabs; ACK to current connection.
  - `getHistory` — paginated descending message list with read status.
  - `markRead` — resets caller's unread counter; pushes `readReceipt` to other party.
  - `getConversations` — two-phase: fast `conversationsResponse` then deferred `avatarsUpdate` with S3 presigned avatar URLs.
- System-message frames pushed by `event-to-message` Lambda for `shift-applied | invite-accepted | shift-cancelled | shift-scheduled` events.

### Module 13 — File Management (S3)

- `POST /files/presigned-urls` — issues presigned POST policy with `content-length-range` + `Content-Type` conditions; per-fileType MIME allowlist; sizes 5 KB – 100 MB; 15-min TTL.
- `GET /files/{profile-images | professional-resumes | professional-licenses | driving-licenses | video-resumes | clinic-office-images}` — presigned GET (24 h); ownership enforced by S3 metadata `uploaded-by` tag; clinic groups bypass for cross-professional access.
- `PUT /files/{profile-image | professional-resumes | professional-licenses | driving-licenses | video-resumes}` — update profile `*Key` attribute (overwrite or list_append).
- `DELETE /files/{profile-images | certificates | video-resumes}` — strict ownership; no clinic bypass.
- Test: presigned-URL expiration, signature replay, content-type spoofing, oversized upload, race conditions on multi-key list_append.

### Module 14 — Clinic Favorites

- `POST /clinics/favorites` — `{professionalUserSub, notes?, tags? (SS)}`; 409 on duplicate.
- `GET /clinics/favorites?limit=&role=&tags=` — sorted desc by `addedAt`; returns `roleDistribution` histogram.
- `DELETE /clinics/favorites/{professionalUserSub}`.

### Module 15 — Referrals

- `POST /referrals/invite` — `{friendEmail (regex-validated), personalMessage?}` — DynamoDB Put + SES branded HTML email; sender hardcoded to `jelladivya369@gmail.com`.
- Referral state machine: `sent → signed_up → bonus_due → completed`.
- Bonus: `$50` per first completed shift; `BonusAwarding.ts` DynamoDB Streams handler awards extra bonuses per completed shift (50 credits each).

### Module 16 — Job Promotions (LinkedIn-style boosting)

Three plan tiers: `basic` (3d, $9.99), `featured` (7d, $24.99), `premium` (14d, $49.99). Tier weights: `premium=3 / featured=2 / basic=1`.

- `GET /promotions/plans` (public).
- `POST /promotions` — `{jobId, planId}`; status `pending_payment`; `canWriteClinic("manageJobs")`.
- `GET /promotions?clinicId=<id|all>` — fan-out across accessible clinics if `all`.
- `GET /promotions/{promotionId}?clinicId=<id>`.
- `PUT /promotions/{promotionId}/cancel`.
- `PUT /promotions/{promotionId}/activate` — sets `expiresAt = now + durationDays`; denormalizes `isPromoted` onto JobPosting.
- `POST /promotions/track-click` (public) — atomic `ADD clicks :one` with `status = "active"` condition.

Test: tier sorting in `findJobs` and `getProfessionalFilteredJobs`, expiry masking, click counter idempotency.

### Module 17 — User Addresses

- `POST /user-addresses` — geocodes via Amazon Location.
- `GET /user-addresses`.
- `PUT /user-addresses` — re-geocodes on change; removes stale `lat/lng` if geocoding fails.
- `DELETE /user-addresses` — blocks default address (403).

### Module 18 — Geocoding (Public)

- `GET /geocode/postal?postalCode=<code>&country=<ISO2>` — returns `{city, state (abbr), stateFull, country, postalCode, label, coordinates: {lng, lat} | null}`.
- `GET /location/lookup` — same handler, different alias.

### Module 19 — Feedback

- `POST /submitfeedback` — `{feedbackType, message (≤5000), contactMe?, email?}`; DynamoDB Put + SES email forward. Auth optional (anonymous allowed).

### Module 20 — EventBridge Inbox Bridge

- Producers emit `ShiftEvent` events from `acceptProf`, `rejectProf`, `respondToInvitation`, `respondToNegotiation`, `updateCompletedShifts`.
- `event-to-message` Lambda creates a system-message in the conversation and pushes it via WebSocket.
- Test event-loss scenarios, WebSocket `GoneException` cleanup, `WS_ENDPOINT` env missing fallback.

### Module 21 — Cognito Lambda Triggers (custom-auth flow)

- `preSignUp` — auto-fills missing `address`/`phone_number` for Google federation; auto-confirms email.
- `defineAuthChallenge` — issues custom challenge on first call; issues tokens on success.
- `createAuthChallenge` — sets private answer `"google-verified"`.
- `verifyAuthChallenge` — compares `challengeAnswer` to `"google-verified"`.

Test: bypassing custom-auth flow, replay of `"google-verified"` answer with a different sub, lockout after 5 wrong answers.

---

## Cross-cutting test requirements

For **every** module above:

1. **API contract tests** — verify HTTP status (200/201/207/400/401/403/404/409/429/500), response envelope `{ status, statusCode, message, data, timestamp }`, error envelope `{ status: "error", statusCode, message, error?, timestamp }`, presence of `Access-Control-Allow-Origin` matching whitelist.
2. **Role matrix tests** — for each mutating endpoint, generate 5 cases (one per role: `Root, ClinicAdmin, ClinicManager, ClinicViewer, Professional`) plus one anonymous case.
3. **JWT security tests** — unsigned token, expired token, tampered claim (different `sub`), missing `cognito:groups`, group claim as string vs. array, Bearer prefix missing.
4. **Database validation tests** — read-after-write consistency on GSI; condition-expression failures returned correctly; `BatchGetItem`/`BatchWriteItem` 25/100-item chunking; `ConditionalCheckFailedException` translated to user-friendly errors.
5. **Performance tests**
   - Cold-start latency on each Lambda (p50, p95, p99).
   - Warm-start latency under 100 rps sustained.
   - DynamoDB throttling under 1,000 wps writes.
   - WebSocket: 500 concurrent connections per Lambda, message broadcast fan-out latency.
   - `Scan`-based endpoints (`loginUser`, `findJobs`, `getActionNeeded?aggregate=true`, `getJobInvitationsForClinics`) — degradation curves at 10k / 100k / 1M rows.
   - `getProfessionalFilteredJobs` MAX_SCAN cap behavior at the 500-item boundary.
6. **Responsive tests** — viewport widths 320, 375, 414, 768, 1024, 1280, 1440, 1920 px; iOS Safari, Android Chrome, desktop Chrome/Firefox/Edge.
7. **Accessibility tests** — WCAG 2.1 AA on every form: form labels, error announcements, focus traps in modals, color contrast on status badges (pending/negotiating/accepted/rejected/scheduled/completed).
8. **Localization & input edge cases** — emoji in `job_title`, RTL text, Chinese characters, ZWJ sequences, surrogate pairs in message content, very long email (320 chars), addresses with non-ASCII.
9. **CORS tests** — origin not in whitelist returns 403 from S3 / falls back to first allowed origin on REST.
10. **Race conditions** — two clinics simultaneously hiring the same professional for two different jobs at the same time; double-OTP submission; presigned-URL double-upload.

---

## Output format

For each of the 21 modules, output:

```
# Module <N> — <Name>

## Section 1 — Unit Test Cases (≥10)
| Test Case ID | Module Name | Feature Name | Test Scenario | Preconditions | Test Steps | Test Data | Expected Result | Actual Result | Status | Priority | Severity | Test Type | Environment | Browser/Device | Created By |
| ... |

---

## Section 2 — Functional Test Cases (≥20)
| ... |

---

## Section 3 — QA Test Cases (≥15)
| ... |

---

## Section 4 — Feature Testing Scenarios (≥10)
| ... |

---

## Section 5 — Usability Testing Scenarios (≥10)
| ... |

---

## Section 6 — Performance Testing Scenarios (≥10)
| ... |

---

## Section 7 — UAT Cases (≥10)
| ... |

---
```

Use these defaults inside cells:
- `Environment`: `Dev | Staging | Production` (specify per case).
- `Browser/Device`: list specific combos like `Chrome 124 / Win11`, `Safari 17 / iPhone 15`, `Android Chrome / Pixel 7`, `Firefox 125 / Ubuntu 22.04`, `iPad Safari / iPadOS 17` — pick the most relevant per case.
- `Actual Result`: `Not executed`.
- `Status`: `Pending`.
- `Created By`: `QA-Team`.
- `Priority`: weight by user impact (login = High, geocoding = Medium, feedback = Low).
- `Severity`: `Critical | Major | Minor | Cosmetic`.
- `Test Type`: `Unit | Functional | Regression | Smoke | Integration | E2E | Security | Performance | Load | Stress | Soak | Accessibility | Usability | UAT | API | Database | Negative | Boundary | Edge`.

After all 21 modules are generated, append a final **section** titled `# Master Coverage Summary` containing:
- Total cases per module per section (table).
- Per-role coverage count (table).
- Per-severity distribution (table).
- A `# Traceability Matrix` mapping each REST endpoint and WebSocket action listed above to its test case IDs.

Then append: **"Generate the response in CSV-friendly format so it can be directly copied into Excel or Google Sheets."**

## END OF PROMPT

---

## Tips for using this prompt

1. **Output will be very large** — expect 21 × ~85 = ~1,800+ test cases. Most chat models will hit context limits in a single response. Run module-by-module:
   - First pass: paste the **entire prompt** and ask the model to produce **Modules 1–3**.
   - Follow-up: `continue with Modules 4–6` (the prompt is already in context).
   - Repeat until Module 21 + the Master Coverage Summary.
2. **Pin the model**: use Claude Opus 4.7 / GPT-5 / Gemini 2.5 Pro for highest-quality tables; smaller models will hallucinate field names and statuses.
3. **For Excel export**, ask explicitly: _"Now reformat Modules 1–3 as one CSV per section, comma-separated, with proper quote-escaping. Do not use markdown."_
4. **For Jira/TestRail import**, ask: _"Now convert Section 2 (Functional Test Cases) for Module 6 to TestRail's bulk-import CSV format (Title, Section, Type, Priority, Estimate, References, Preconditions, Steps, Expected Result)."_
5. **For Zephyr/Xray**, ask: _"Reformat as Zephyr Scale BDD Gherkin (Feature, Scenario, Given/When/Then) keeping the same coverage."_
6. **Sanity check** — after generation, randomly pick 20 cases and verify against this codebase (e.g. that the JWT-signature-not-verified gap is actually tested, that the `pay_type=per_transaction` is blocked for doctor roles, that bulk-create returns 207, that the WebSocket `$connect` token-in-querystring is asserted).

---

*Save this file. Copy the prompt section into any LLM chat. Done.*
