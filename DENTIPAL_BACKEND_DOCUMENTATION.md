# Dentipal Backend — Technical Documentation

> Complete reference for the Dentipal AWS CDK backend. Built from: [lib/denti_pal_cdk-stack.ts](lib/denti_pal_cdk-stack.ts), [lambda/src/index.ts](lambda/src/index.ts), 128 handler files in [lambda/src/handlers/](lambda/src/handlers/).

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Lambda Handlers](#2-lambda-handlers)
3. [API Endpoints](#3-api-endpoints)
4. [WebSocket APIs](#4-websocket-apis)
5. [Cognito Configuration](#5-cognito-configuration)
6. [SES (Email Service)](#6-ses-email-service)
7. [DynamoDB Tables](#7-dynamodb-tables)
8. [Validation & Error Handling](#8-validation--error-handling)
9. [Security & Authorization](#9-security--authorization)
10. [Special Backend Features](#10-special-backend-features)
11. [Architecture Insights](#11-architecture-insights)
12. [Schemas Summary](#12-schemas-summary)
13. [Summary Metrics](#13-summary-metrics)

---

## 1. Project Overview

### 1.1 What Dentipal is

Dentipal is a two-sided marketplace that matches **dental clinics** with **dental professionals** (associate dentists, hygienists, assistants, front-desk, billing and compliance specialists). Clinics post jobs (temporary shifts, multi-day consulting projects, permanent positions), professionals apply and negotiate rates, and accepted shifts flow into a realtime inbox for both parties.

### 1.2 Architecture style

- **Serverless, AWS-native**, provisioned entirely via AWS CDK v2 (TypeScript).
- **Monolithic REST Lambda** pattern — a single `Node.js 18.x` function serves all REST endpoints via an in-process route table.
- **Dedicated WebSocket Lambda** for realtime chat.
- **Event-driven bridge** — state changes (hires, rejects, negotiation acceptances, completed shifts) emit EventBridge events, and a dedicated Lambda converts them into inbox system messages.
- **Custom-auth flow** via Cognito Lambda triggers for password-less Google sign-in.

### 1.3 Key AWS services

| Service | Purpose |
|---------|---------|
| **AWS Lambda** | 7 functions — REST monolith, WebSocket handler, EventBridge→inbox bridge, 4 Cognito triggers |
| **Amazon API Gateway (REST v1)** | Public REST API with catch-all `/{proxy+}` → monolith |
| **Amazon API Gateway (WebSocket v2)** | Realtime chat channel (`$connect`, `$disconnect`, `$default`) |
| **Amazon Cognito** | User pool, 20 groups, custom-auth flow, 4 Lambda triggers |
| **Amazon DynamoDB** | 18 tables, 25 GSIs, single-digit-ms NoSQL persistence |
| **Amazon S3** | 7 buckets for profile images, resumes, licenses, video resumes, clinic office images |
| **Amazon SES** | Transactional emails (OTP, welcome, referral, feedback) |
| **Amazon SNS** | SMS notifications via `DentiPal-SMS-Notifications` topic |
| **Amazon EventBridge** | `DentiPal-ShiftEvent-to-Inbox` rule triggers inbox message creation |
| **Amazon Location Service** | `DentiPalGeocoder` Place Index (HERE data source) for postal-code → city/state + lat/lng |
| **AWS IAM** | Least-privilege roles scoped per Lambda (DynamoDB, Cognito, S3, SES, SNS, EventBridge, Location) |
| **AWS X-Ray** | Distributed tracing enabled on REST API Gateway |
| **Amazon CloudWatch** | INFO-level API Gateway logs, Lambda metrics |

### 1.4 Design patterns

| Pattern | Where it's applied |
|---------|--------------------|
| **Serverless** | No containers, no EC2 — everything is Lambda + managed AWS services |
| **Monolithic Lambda with internal routing** | One function handles 116 routes (cold-start amortization) |
| **Event-driven decoupling** | REST handlers emit events; downstream handler posts inbox messages |
| **CQRS-lite** | GSIs provide read-optimized access paths; mutations go through the base table |
| **Single-table design (partial)** | `Feedback` table uses generic `PK/SK`; other tables are entity-specific |
| **Denormalization** | `JobPostings` embed clinic data; `Conversations` embed last-message preview |
| **Custom-auth flow** | 3 Lambda triggers (`DefineAuthChallenge`, `CreateAuthChallenge`, `VerifyAuthChallenge`) implement password-less Google login |
| **Proxy integration** | Single `ANY /{proxy+}` at API Gateway forwards every request to the monolith |
| **Multi-tenant via membership** | `Clinics.AssociatedUsers` list defines which users can access which clinic |
| **Fire-and-forget counters** | Non-blocking view/click/application counters (`promotionCounters`, `jobPostingCounters`) |

---

## 2. Lambda Handlers

### 2.1 Totals

- **Total handler files**: 128 TypeScript files in [lambda/src/handlers/](lambda/src/handlers/)
- **Total REST endpoints**: 116 (counting dashboard sub-paths as distinct)
- **Lambda functions provisioned by CDK**: 7 (monolith + websocket + event-to-message + 4 Cognito triggers)
- **Internal helpers (not routed)**: 12 — `utils.ts`, `corsHeaders.ts`, `geo.ts`, `jobPostingCounters.ts`, `promotionCounters.ts`, `migrateJobRates.ts`, `BonusAwarding.ts`, `professionalRoles.ts`, `uploadFile.ts`, `createAssignment-prof.ts`, `event-to-message.ts`, `createJobApplication-prof.ts`

### 2.2 Handler categorization

| Category | Count | Representative handlers |
|----------|------:|-------------------------|
| **Auth / Registration / OTP** | 9 | `loginUser`, `refreshToken`, `forgotPassword`, `checkEmail`, `confirmPassword`, `googleLogin`, `initiateUserRegistration`, `verifyOTPAndCreateUser`, `resendOtp` |
| **Cognito Lambda triggers** | 4 | `preSignUp`, `defineAuthChallenge`, `createAuthChallenge`, `verifyAuthChallenge` |
| **User management** | 6 | `createUser`, `getUser`, `getUserMe`, `updateUser`, `deleteUser`, `deleteOwnAccount` |
| **Clinic management** | 8 | `createClinic`, `getAllClinics`, `getClinic`, `updateClinic`, `deleteClinic`, `getClinicAddress`, `getUsersClinics`, `getClinicUsers` |
| **Clinic profiles** | 5 | `createClinicProfile`, `getClinicProfile`, `getClinicProfileDetails`, `updateClinicProfileDetails`, `deleteClinicProfile` |
| **Professional profiles** | 7 | `createProfessionalProfile`, `getProfessionalProfile`, `updateProfessionalProfile`, `deleteProfessionalProfile`, `getProfessionalQuestions`, `getPublicProfessionalProfile`, `getAllProfessionals`, `publicProfessionals` |
| **User addresses** | 4 | `createUserAddress`, `getUserAddresses`, `updateUserAddress`, `deleteUserAddress` |
| **Assignments (legacy)** | 5 | `createAssignment`, `getAssignments`, `updateAssignment`, `deleteAssignment`, `createAssignment-prof` |
| **Job postings (generic)** | 6 | `createJobPosting`, `getJobPostings`, `browseJobPostings`, `getJobPosting`, `updateJobPosting`, `deleteJobPosting` |
| **Temporary jobs** | 6 | `createTemporaryJob`, `getTemporaryJob`, `getAllTemporaryJobs`, `updateTemporaryJob`, `deleteTemporaryJob`, `getTemporary-Clinic` |
| **Multi-day consulting jobs** | 7 | `createMultiDayConsulting`, `getMultiDayConsulting`, `getAllMultiDayConsulting`, `updateMultiDayConsulting`, `deleteMultiDayConsulting`, `getAllMultidayForClinic`, `getAllMultidayJobs` |
| **Permanent jobs** | 6 | `createPermanentJob`, `getPermanentJob`, `getAllPermanentJobs`, `updatePermanentJob`, `deletePermanentJob`, `getAllPermanentJobsForClinic` |
| **Public / browse** | 3 | `findJobs`, `publicProfessionals`, `getProfessionalFilteredJobs` |
| **Job applications** | 7 | `createJobApplication`, `getJobApplications`, `getJobApplicationsForClinic`, `getJobApplicantsOfAClinic`, `updateJobApplication`, `deleteJobApplication`, `createJobApplication-prof` |
| **Job invitations** | 4 | `sendJobInvitations`, `respondToInvitation`, `getJobInvitations`, `getJobInvitationsForClinics` |
| **Negotiations** | 2 | `respondToNegotiation`, `getAllNegotiations-Prof` |
| **Hiring / Status / Feedback** | 4 | `acceptProf`, `rejectProf`, `updateJobStatus`, `submitFeedback` |
| **Shift dashboards** | 6 | `getAllClinicsShifts`, `getClinicShifts`, `getScheduledShifts`, `getCompletedShifts`, `updateCompletedShifts`, `getActionNeeded` |
| **Clinic favorites** | 3 | `addClinicFavorite`, `getClinicFavorites`, `removeClinicFavorite` |
| **File management (S3)** | 14 | `generatePresignedUrl`, `getFileUrl` (+5 typed exports), `updateFile` (+5 typed exports), `deleteFile`, `uploadFile`, `getClinicOfficeImages` |
| **Referrals** | 2 | `sendReferralInvite`, `BonusAwarding` (internal) |
| **Promotions (job boosting)** | 8 | `getPromotionPlans`, `createPromotion`, `getPromotions`, `getPromotion`, `cancelPromotion`, `activatePromotion`, `trackPromotionClick`, `promotionCounters` |
| **Geocoding** | 2 | `geocodePostal`, `geo` (internal) |
| **WebSocket chat** | 1 | `websocketHandler` (routes: `$connect`, `$disconnect`, `$default` with 4+ actions) |
| **EventBridge → Inbox** | 1 | `event-to-message` |
| **Utilities (not routed)** | 7 | `utils`, `corsHeaders`, `jobPostingCounters`, `migrateJobRates`, `professionalRoles`, `BonusAwarding`, `geo` |

### 2.3 Per-handler reference

The following table summarizes every handler with its key operational details. See §3 for full request/response schemas.

#### 2.3.1 Auth & Registration

##### `loginUser.ts`
- **File**: `lambda/src/handlers/loginUser.ts`
- **Purpose**: Authenticate user via email/password; return Cognito tokens; attach associated clinics for clinic-role users.
- **Trigger**: API Gateway — `POST /auth/login`
- **Input**: `{ email, password, userType? }`
- **Output**: `{ status, data: { tokens, user: { email, sub, groups, associatedClinics }, loginAt } }`
- **Errors**: 400 missing fields · 401 invalid credentials · 403 portal mismatch / UserNotConfirmedException · 404 user not found · 429 rate-limit · 500 internal
- **Validation**: email + password required; portal-side validation if `userType` supplied
- **Dependencies**: Cognito (`InitiateAuth`, `AdminGetUser`), DynamoDB (`Clinics` Scan)
- **Importance**: **High** (entry point for every session)

##### `refreshToken.ts`
- **File**: `lambda/src/handlers/refreshToken.ts`
- **Purpose**: Exchange refresh token for new access + ID tokens.
- **Trigger**: `POST /auth/refresh`
- **Input**: `{ refreshToken }`
- **Output**: `{ status, data: { accessToken, idToken, refreshToken, expiresIn, tokenType } }`
- **Errors**: 400 missing field · 401 invalid/expired token · 404 user not found · 500
- **Dependencies**: Cognito `InitiateAuth` (REFRESH_TOKEN_AUTH)
- **Importance**: High

##### `forgotPassword.ts`
- **File**: `lambda/src/handlers/forgotPassword.ts`
- **Purpose**: Send a Cognito reset code to the user's email.
- **Trigger**: `POST /auth/forgot`
- **Input**: `{ email, expectedUserType? }`
- **Output**: `{ status, statusCode: 200, message: "If the email exists..." }`
- **Errors**: 400 missing email / user-type mismatch · 404 no account · 500
- **Dependencies**: Cognito (`ListUsers`, `AdminListGroupsForUser`, `ForgotPassword`)
- **Importance**: High

##### `checkEmail.ts`
- **File**: `lambda/src/handlers/checkEmail.ts`
- **Purpose**: Verify an email against the caller's JWT; derive user type.
- **Trigger**: `POST /auth/check-email` (JWT required)
- **Input**: `{ email }`
- **Output**: `{ status, data: { email, userType, groups, tokenEmail } }`
- **Importance**: Medium

##### `confirmPassword.ts`
- **File**: `lambda/src/handlers/confirmPassword.ts`
- **Purpose**: Complete the password-reset flow with the code from email.
- **Trigger**: `POST /auth/confirm-forgot-password`
- **Input**: `{ email, code, newPassword }`
- **Output**: `{ status, message: "Password reset successful" }`
- **Errors**: 400 code mismatch/expired/invalid password · 404 user not found · 429 · 500
- **Dependencies**: Cognito (`ListUsers`, `ConfirmForgotPassword`)
- **Importance**: High

##### `googleLogin.ts`
- **File**: `lambda/src/handlers/googleLogin.ts`
- **Purpose**: Google-OAuth login; creates the Cognito user on first login; uses custom-auth for existing users.
- **Trigger**: `POST /auth/google-login`
- **Input**: `{ googleToken, userType, redirectUri? }`
- **Output**: `{ status, data: { tokens, user, isNewUser, loginAt } }`
- **Dependencies**: Google `tokeninfo` endpoint, Cognito (`ListUsers`, `AdminCreateUser`, `AdminSetUserPassword`, `AdminAddUserToGroup`, `AdminInitiateAuth` CUSTOM_AUTH, `AdminRespondToAuthChallenge`)
- **Importance**: High

##### `initiateUserRegistration.ts`
- **File**: `lambda/src/handlers/initiateUserRegistration.ts`
- **Purpose**: Create a Cognito user (UNCONFIRMED) and send the verification OTP via email.
- **Trigger**: `POST /auth/initiate-registration`
- **Input**: `{ email, firstName, lastName, userType, password, role?, clinicName?, phoneNumber?, referrerUserSub? }`
- **Output**: `{ status: "success", statusCode: 201, data: { userSub, email, userType, role, cognitoGroup, nextStep, codeDeliveryDetails } }`
- **Errors**: 400 invalid role · 409 email exists (confirmed) · 500
- **Dependencies**: Cognito (`SignUp`, `AdminGetUser`, `AdminDeleteUser`, `AdminAddUserToGroup`), DynamoDB (`Referrals` Scan + UpdateItem)
- **Importance**: **High**

##### `verifyOTPAndCreateUser.ts`
- **File**: `lambda/src/handlers/verifyOTPAndCreateUser.ts`
- **Purpose**: Confirm signup with OTP; send welcome email and SMS; trigger referral bonus flow.
- **Trigger**: `POST /auth/verify-otp`
- **Input**: `{ email, confirmationCode }`
- **Output**: `{ status, data: { isVerified, userSub, email, fullName, userType, welcomeMessageSent, smsSent, nextSteps } }`
- **Dependencies**: Cognito (`ConfirmSignUp`, `AdminGetUser`), SES `SendEmail`, SNS `Publish`, `BonusAwarding` helper
- **Importance**: **High**

##### `resendOtp.ts`
- **File**: `lambda/src/handlers/resendOtp.ts`
- **Purpose**: Resend the signup OTP if the user didn't receive it.
- **Trigger**: `POST /auth/resend-otp`
- **Dependencies**: Cognito (`AdminGetUser`, `ResendConfirmationCode`)
- **Importance**: Medium

##### `preSignUp.ts`
- **File**: `lambda/src/handlers/preSignUp.ts`
- **Purpose**: Auto-fill address/phone for Google federated signups; auto-confirm the user.
- **Trigger**: Cognito `PRE_SIGN_UP` trigger
- **Importance**: High

##### `createAuthChallenge.ts` · `defineAuthChallenge.ts` · `verifyAuthChallenge.ts`
- **Purpose**: Implement the password-less custom-auth flow used by Google login (answer `"google-verified"`).
- **Trigger**: Cognito `CREATE_AUTH_CHALLENGE` · `DEFINE_AUTH_CHALLENGE` · `VERIFY_AUTH_CHALLENGE_RESPONSE`
- **Importance**: High

#### 2.3.2 User management

| Handler | Method/Path | Purpose | Importance |
|---------|-------------|---------|------------|
| `createUser.ts` | `POST /users` | Root creates clinic staff user and assigns to clinic(s) | High |
| `getUser.ts` | `GET /users` | Root/Admin lists all clinic staff | Medium |
| `getUserMe.ts` | `GET /users/me` | Returns caller profile from Cognito | High |
| `updateUser.ts` | `PUT /users/{userId}` | Root/Admin edits staff attributes, group, clinic assignments | High |
| `deleteUser.ts` | `DELETE /users/{userId}` | Root deletes clinic staff from Cognito + cleans memberships | Medium |
| `deleteOwnAccount.ts` | `DELETE /users/me` | Self-service account deletion | Medium |

#### 2.3.3 Clinic management

| Handler | Method/Path | Purpose | Importance |
|---------|-------------|---------|------------|
| `createClinic.ts` | `POST /clinics` | Root/ClinicAdmin creates a clinic + geocodes address | High |
| `getAllClinics.ts` | `GET /clinics` | Lists clinics the caller belongs to (with filters) | High |
| `getClinic.ts` | `GET /clinics/{clinicId}` | Single-clinic read | High |
| `updateClinic.ts` | `PUT /clinics/{clinicId}` | Update clinic name/address; re-geocodes | High |
| `deleteClinic.ts` | `DELETE /clinics/{clinicId}` | Root-only clinic delete | Medium |
| `getClinicAddress.ts` | `GET /clinics/{clinicId}/address` | **Public** address lookup | Low |
| `getUsersClinics.ts` | `GET /clinics-user` | User's clinics + `isRoot` flag | Medium |
| `getClinicUsers.ts` | `GET /clinics/{clinicId}/users` | List `AssociatedUsers` subs for a clinic | Medium |

#### 2.3.4 Clinic profiles

| Handler | Method/Path | Purpose | Importance |
|---------|-------------|---------|------------|
| `createClinicProfile.ts` | `POST /clinic-profiles` | Create practice profile (staff counts, parking, etc.) | High |
| `getClinicProfile.ts` | `GET /clinic-profiles` | Caller's profiles + job/paid-stat aggregates | High |
| `getClinicProfileDetails.ts` | `GET /clinic-profile/{clinicId}` | Single clinic profile + merged address | Medium |
| `updateClinicProfileDetails.ts` | `PUT /clinic-profiles/{clinicId}` | Update whitelisted profile fields | High |
| `deleteClinicProfile.ts` | `DELETE /clinic-profiles/{clinicId}` | Delete profile row | Low |

#### 2.3.5 Professional profiles

| Handler | Method/Path | Purpose | Importance |
|---------|-------------|---------|------------|
| `createProfessionalProfile.ts` | `POST /profiles` | Create professional profile + optional address | High |
| `getProfessionalProfile.ts` | `GET /profiles` | Caller's professional profile(s) | High |
| `updateProfessionalProfile.ts` | `PUT /profiles` | Field-level validated updates | High |
| `deleteProfessionalProfile.ts` | `DELETE /profiles` | Delete (blocks default profile) | Low |
| `getProfessionalQuestions.ts` | `GET /profiles/questions` | Role-specific onboarding form schema | Medium |
| `getPublicProfessionalProfile.ts` | `GET /profiles/{userSub}` | Authenticated read of any profile | Medium |
| `getAllProfessionals.ts` | `GET /allprofessionals` | Admin directory (all professionals + addresses) | Medium |
| `publicProfessionals.ts` | `GET /professionals/public` | **Public** professional directory + lat/lng | Medium |

#### 2.3.6 Job postings

| Handler | Method/Path | Purpose | Importance |
|---------|-------------|---------|------------|
| `createJobPosting.ts` | `POST /jobs` | Create a single job (any type) | **High** |
| `getJobPostings.ts` | `GET /job-postings` | Caller's job postings | High |
| `browseJobPostings.ts` | `GET /jobs/browse` | Authenticated multi-filter browse | High |
| `getJobPosting.ts` | `GET /jobs/{jobId}` | Single job + application count | High |
| `updateJobPosting.ts` | `PUT /jobs/{jobId}` | Update job fields with state validation | High |
| `deleteJobPosting.ts` | `DELETE /jobs/{jobId}` | Delete job + cascade to applications | Medium |
| `createTemporaryJob.ts` | `POST /jobs/temporary` | Bulk-create temporary jobs across clinics | High |
| `getTemporaryJob.ts` | `GET /jobs/temporary/{jobId}` | Temporary job details | Medium |
| `getAllTemporaryJobs.ts` | `GET /jobs/temporary` | Future temporary jobs for professionals | High |
| `updateTemporaryJob.ts` | `PUT /jobs/temporary/{jobId}` | Update temporary job | High |
| `deleteTemporaryJob.ts` | `DELETE /jobs/temporary/{jobId}` | Delete temporary job + cancel apps | Medium |
| `getTemporary-Clinic.ts` | `GET /jobs/clinictemporary/{clinicId}` | Clinic-scoped temporary jobs | Medium |
| `createMultiDayConsulting.ts` | `POST /jobs/consulting` | Bulk-create multi-day consulting | High |
| `getMultiDayConsulting.ts` | `GET /jobs/consulting/{jobId}` | Multi-day job details | Medium |
| `getAllMultiDayConsulting.ts` | `GET /jobs/consulting` | All multi-day jobs | High |
| `updateMultiDayConsulting.ts` | `PUT /jobs/consulting/{jobId}` | Update multi-day job | High |
| `deleteMultiDayConsulting.ts` | `DELETE /jobs/consulting/{jobId}` | Delete multi-day job + cancel apps | Medium |
| `getAllMultidayForClinic.ts` | `GET /jobs/multiday/clinic/{clinicId}` | Clinic multi-day jobs | Medium |
| `getAllMultidayJobs.ts` | `GET /jobs/multiday/{jobId}` | Duplicate of getAllMultiDayConsulting | Low |
| `createPermanentJob.ts` | `POST /jobs/permanent` | Bulk-create permanent jobs (supports all types) | High |
| `getPermanentJob.ts` | `GET /jobs/permanent/{jobId}` | Permanent job details | Medium |
| `getAllPermanentJobs.ts` | `GET /jobs/permanent` | All permanent jobs | High |
| `updatePermanentJob.ts` | `PUT /jobs/permanent/{jobId}` | Update permanent job | High |
| `deletePermanentJob.ts` | `DELETE /jobs/permanent/{jobId}` | Delete permanent job + cancel apps | Medium |
| `getAllPermanentJobsForClinic.ts` | `GET /jobs/clinicpermanent/{clinicId}` | Clinic permanent jobs | Medium |
| `findJobs.ts` | `GET /jobs/public`, `/public/publicJobs` | **Public** browse, promotion-sorted | High |
| `getProfessionalFilteredJobs.ts` | `GET /professionals/filtered-jobs` | Advanced job search (relevance, radius, promo tier) | **High** |
| `updateJobStatus.ts` | `PUT /jobs/{jobId}/status` | FSM status transitions with history | High |

#### 2.3.7 Applications, invitations, negotiations, hiring

| Handler | Method/Path | Purpose | Importance |
|---------|-------------|---------|------------|
| `createJobApplication.ts` | `POST /applications` | Apply to job; optional negotiation kickoff | **High** |
| `getJobApplications.ts` | `GET /applications` | Professional's applications + negotiations | High |
| `getJobApplicationsForClinic.ts` | `GET /clinics/{clinicId}/jobs` | Clinic grouped applicants-per-job view | High |
| `getJobApplicantsOfAClinic.ts` | `GET /{clinicId}/jobs` | Paginated applicants list, flat + by-job | High |
| `updateJobApplication.ts` | `PUT /applications/{applicationId}` | Edit application fields | Medium |
| `deleteJobApplication.ts` | `DELETE /applications/{applicationId}` | Withdraw (blocked if accepted) | Medium |
| `sendJobInvitations.ts` | `POST /jobs/{jobId}/invitations` | Bulk invite professionals (max 50) | High |
| `respondToInvitation.ts` | `POST /invitations/{invitationId}/response` | Accept / decline / negotiate invitation | **High** |
| `getJobInvitations.ts` | `GET /invitations` | Professional's invitations | High |
| `getJobInvitationsForClinics.ts` | `GET /invitations/{clinicId}` | Clinic's sent invitations | Medium |
| `respondToNegotiation.ts` | `PUT /applications/{applicationId}/negotiations/{negotiationId}/response` | Accept / decline / counter | **High** |
| `getAllNegotiations-Prof.ts` | `GET /allnegotiations`, `/negotiations` | Professional's negotiations | High |
| `acceptProf.ts` | `POST /jobs/{jobId}/hire` | Clinic hires an applicant | **High** |
| `rejectProf.ts` | `POST /{clinicId}/reject/{jobId}` | Clinic rejects an applicant | High |
| `submitFeedback.ts` | `POST /submitfeedback` | Bug/suggestion feedback (DynamoDB + email) | Low |

#### 2.3.8 Shift dashboards

| Handler | Method/Path | Purpose | Importance |
|---------|-------------|---------|------------|
| `getAllClinicsShifts.ts` | `GET /dashboard/all/{open-shifts,action-needed,scheduled-shifts,completed-shifts,invites-shifts}` | 5-path dashboard aggregator across all user clinics | **High** |
| `getClinicShifts.ts` | `GET /clinics/{clinicId}/{open-shifts,action-needed,scheduled-shifts,completed-shifts,invites-shifts}` | Same 5 views scoped to one clinic | **High** |
| `getScheduledShifts.ts` | `GET /scheduled/{clinicId}` | Legacy scheduled-shifts listing | Medium |
| `getCompletedShifts.ts` | `GET /completed/{clinicId}` | Legacy completed-shifts listing | Medium |
| `updateCompletedShifts.ts` | `PUT /professionals/completedshifts` + EventBridge | Scheduled shift-completion sweep + referral bonuses | High |
| `getActionNeeded.ts` | `GET /action-needed`, `GET /clinics/{clinicId}/action-needed` | Pending + negotiating applications | High |

#### 2.3.9 User addresses / favorites / assignments

| Handler | Method/Path | Purpose | Importance |
|---------|-------------|---------|------------|
| `createUserAddress.ts` | `POST /user-addresses` | Create home/work address + geocode | High |
| `getUserAddresses.ts` | `GET /user-addresses` | Caller's addresses | Medium |
| `updateUserAddress.ts` | `PUT /user-addresses` | Update + re-geocode | Medium |
| `deleteUserAddress.ts` | `DELETE /user-addresses` | Delete (blocks default) | Low |
| `addClinicFavorite.ts` | `POST /clinics/favorites` | Favorite a professional | Medium |
| `getClinicFavorites.ts` | `GET /clinics/favorites` | Clinic's favorites + role histogram | Medium |
| `removeClinicFavorite.ts` | `DELETE /clinics/favorites/{professionalUserSub}` | Unfavorite | Low |
| `createAssignment.ts` | `POST /assignments` | Root-only legacy UCA row | Low |
| `getAssignments.ts` | `GET /assignments`, `/assignments/{userSub}` | Self assignments | Low |
| `updateAssignment.ts` | `PUT /assignments` | Root-only legacy update | Low |
| `deleteAssignment.ts` | `DELETE /assignments` | Root-only legacy delete | Low |

#### 2.3.10 Files / Promotions / Referrals

| Handler | Method/Path | Purpose | Importance |
|---------|-------------|---------|------------|
| `generatePresignedUrl.ts` | `POST /files/presigned-urls` | S3 presigned POST for browser uploads | **High** |
| `getFileUrl.ts` (5 exports) | `GET /files/{profile-images,professional-resumes,professional-licenses,driving-licenses,video-resumes}` | Presigned GET with ownership check (clinic bypass) | High |
| `updateFile.ts` (5 exports) | `PUT /files/{profile-image,professional-resumes,professional-licenses,driving-licenses,video-resumes}` | Update profile `*Key` attributes after upload | High |
| `deleteFile.ts` | `DELETE /files/{profile-images,certificates,video-resumes}` | Delete S3 object (strict ownership) | Medium |
| `uploadFile.ts` | internal (not routed) | Base64 direct upload fallback | Low |
| `getClinicOfficeImages.ts` | `GET /files/clinic-office-images` | Latest clinic office image | Medium |
| `getPromotionPlans.ts` | `GET /promotions/plans` | Public plan catalog | Low |
| `createPromotion.ts` | `POST /promotions` | Create promotion (status `pending_payment`) | Medium |
| `getPromotions.ts` | `GET /promotions` | List promotions (per-clinic or all) | Medium |
| `getPromotion.ts` | `GET /promotions/{promotionId}` | Single promotion | Low |
| `cancelPromotion.ts` | `PUT /promotions/{promotionId}/cancel` | Cancel (reverts job flag if active) | Medium |
| `activatePromotion.ts` | `PUT /promotions/{promotionId}/activate` | Activate after payment; sets expiry | High |
| `trackPromotionClick.ts` | `POST /promotions/track-click` | **Public** atomic click counter | Low |
| `sendReferralInvite.ts` | `POST /referrals/invite` | Send referral email + DynamoDB record | Medium |

#### 2.3.11 Real-time chat + EventBridge

| Handler | Trigger | Purpose | Importance |
|---------|---------|---------|------------|
| `websocketHandler.ts` | WebSocket `$connect`, `$disconnect`, `$default` (actions: `sendMessage`, `getHistory`, `markRead`, `getConversations`) | Realtime chat between clinic and professional | **High** |
| `event-to-message.ts` | EventBridge `ShiftEvent` rule | System-message ingestion into inbox | **High** |

#### 2.3.12 Utility modules (not REST-routed)

| Module | Purpose |
|--------|---------|
| `utils.ts` | Auth/RBAC gates (`canAccessClinic`, `canWriteClinic`, `listAccessibleClinicIds`, `getClinicRole`, `isRoot`, `extractUserFromBearerToken`) |
| `corsHeaders.ts` | Origin-whitelisted CORS headers |
| `geo.ts` | `geocodeAddressParts`, `haversineDistance` |
| `geocodePostal.ts` | `GET /geocode/postal`, `GET /location/lookup` — public postal lookup |
| `jobPostingCounters.ts` | Fire-and-forget `applicationsCount` increments |
| `promotionCounters.ts` | `PROMOTION_TIER_WEIGHT`, impression/click/application counters |
| `professionalRoles.ts` | 18 role definitions, category helpers, `VALID_ROLE_VALUES` |
| `BonusAwarding.ts` | Referral bonus award (streams + in-process) |
| `migrateJobRates.ts` | One-shot column migration |

---

## 3. API Endpoints

All endpoints are served by `DentiPal-Backend-Monolith` via API Gateway's catch-all `ANY /{proxy+}` proxy. Authorization type at API Gateway = **NONE**; auth is enforced **inside each handler** via JWT-in-`Authorization: Bearer <token>` header (see §9).

### 3.1 Authentication endpoints

#### `POST /auth/login`
**Handler**: `loginUser.ts` · **Auth**: Public

**Request**:
```json
{
  "email": "clinic@example.com",
  "password": "SecurePass123!",
  "userType": "clinic"
}
```

**Response 200**:
```json
{
  "status": "success",
  "statusCode": 200,
  "message": "Login successful",
  "data": {
    "tokens": {
      "accessToken": "eyJhbGciOiJSUzI1NiIsInR5...",
      "idToken": "eyJhbGciOiJSUzI1NiIsInR5...",
      "refreshToken": "eyJjdHkiOiJKV1QiLCJl...",
      "expiresIn": 3600,
      "tokenType": "Bearer"
    },
    "user": {
      "email": "clinic@example.com",
      "sub": "3e2a9a1d-...",
      "groups": ["Root"],
      "associatedClinics": [
        {
          "clinicId": "f8a1...",
          "name": "Bright Smile Dental",
          "address": "123 Main St, Austin, TX 78701"
        }
      ]
    },
    "loginAt": "2026-04-24T12:00:00Z"
  }
}
```

**Error 401**:
```json
{ "status": "error", "statusCode": 401, "message": "Invalid email or password" }
```

#### `POST /auth/refresh`
**Handler**: `refreshToken.ts` · **Auth**: Public

**Request**: `{ "refreshToken": "eyJjdHkiOiJKV1QiLC..." }`

**Response 200**:
```json
{
  "status": "success",
  "statusCode": 200,
  "message": "Tokens refreshed successfully",
  "data": {
    "accessToken": "...", "idToken": "...", "refreshToken": "...",
    "expiresIn": 3600, "tokenType": "Bearer"
  },
  "timestamp": "2026-04-24T12:00:00Z"
}
```

#### `POST /auth/forgot`
**Handler**: `forgotPassword.ts` · **Auth**: Public

**Request**: `{ "email": "user@example.com", "expectedUserType": "clinic" }`

**Response 200**: `{ "status": "success", "message": "If the email exists in our system, a password reset code has been sent." }`

#### `POST /auth/check-email`
**Handler**: `checkEmail.ts` · **Auth**: JWT required

**Request**: `{ "email": "user@example.com" }`

**Response 200**:
```json
{
  "status": "success",
  "data": {
    "email": "user@example.com",
    "userType": "professional",
    "groups": ["DentalHygienist"],
    "tokenEmail": "user@example.com"
  }
}
```

#### `POST /auth/confirm-forgot-password`
**Handler**: `confirmPassword.ts` · **Auth**: Public

**Request**: `{ "email": "...", "code": "123456", "newPassword": "NewSecurePass123!" }`

**Response 200**: `{ "status": "success", "message": "Password reset successful" }`

#### `POST /auth/google-login`
**Handler**: `googleLogin.ts` · **Auth**: Public (validates Google token)

**Request**:
```json
{
  "googleToken": "ya29.a0Af...",
  "userType": "professional",
  "redirectUri": "http://localhost:5173/callback"
}
```

**Response 200**: Same shape as `/auth/login` + `"isNewUser": false`

#### `POST /auth/initiate-registration`
**Handler**: `initiateUserRegistration.ts` · **Auth**: Public

**Request**:
```json
{
  "email": "new@example.com",
  "firstName": "Jane",
  "lastName": "Doe",
  "userType": "professional",
  "password": "SecurePass123!",
  "role": "dental_hygienist",
  "phoneNumber": "+15555551234",
  "referrerUserSub": "abc-123"
}
```

**Response 201**:
```json
{
  "status": "success",
  "statusCode": 201,
  "message": "Registration initiated successfully. Please check your email for verification code.",
  "data": {
    "userSub": "3e2a9a1d-...",
    "email": "new@example.com",
    "userType": "professional",
    "role": "dental_hygienist",
    "cognitoGroup": "DentalHygienist",
    "nextStep": "Please check your email and use the verification code to complete registration by calling /auth/verify-otp",
    "codeDeliveryDetails": { "Destination": "n***@example.com", "DeliveryMedium": "EMAIL", "AttributeName": "email" }
  }
}
```

#### `POST /auth/verify-otp`
**Handler**: `verifyOTPAndCreateUser.ts` · **Auth**: Public

**Request**: `{ "email": "new@example.com", "confirmationCode": "123456" }`

**Response 201**:
```json
{
  "status": "success",
  "data": {
    "isVerified": true,
    "userSub": "3e2a9a1d-...",
    "email": "new@example.com",
    "fullName": "Jane Doe",
    "userType": "professional",
    "welcomeMessageSent": true,
    "smsSent": true,
    "nextSteps": "Complete your professional profile..."
  }
}
```

#### `POST /auth/resend-otp`
**Handler**: `resendOtp.ts` · **Auth**: Public

**Request**: `{ "email": "new@example.com" }`

**Response 200**: `{ "status": "success", "data": { "email", "codeDeliveryDetails", "nextStep" } }`

### 3.2 User endpoints

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| POST | `/users` | `createUser.ts` | Root |
| GET | `/users` | `getUser.ts` | Root / ClinicAdmin |
| GET | `/users/me` | `getUserMe.ts` | JWT |
| PUT | `/users/{userId}` | `updateUser.ts` | Root / ClinicAdmin |
| DELETE | `/users/{userId}` | `deleteUser.ts` | Root |
| DELETE | `/users/me` | `deleteOwnAccount.ts` | JWT |
| GET | `/clinics/{clinicId}/users` | `getClinicUsers.ts` | JWT + `canAccessClinic` |

**`POST /users` request**:
```json
{
  "firstName": "Alice",
  "lastName": "Smith",
  "phoneNumber": "+15555551234",
  "email": "alice@example.com",
  "password": "TempPass123!",
  "verifyPassword": "TempPass123!",
  "subgroup": "ClinicManager",
  "clinicIds": ["f8a1...", "b7c3..."],
  "sendWelcomeEmail": true
}
```
**Response 201**: `{ "status": "success", "data": { "userSub", "email", "firstName", "lastName", "subgroup", "clinics", "createdAt" } }`

**`GET /users/me` response 200**:
```json
{
  "status": "success",
  "data": {
    "sub": "3e2a9a1d-...",
    "name": "Alice Smith",
    "email": "alice@example.com",
    "phone": "+15555551234",
    "givenName": "Alice",
    "familyName": "Smith"
  }
}
```

### 3.3 Clinic endpoints

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| POST | `/clinics` | `createClinic.ts` | Root / ClinicAdmin |
| GET | `/clinics` | `getAllClinics.ts` | JWT |
| GET | `/clinics-user` | `getUsersClinics.ts` | JWT |
| GET | `/clinics/{clinicId}` | `getClinic.ts` | `canAccessClinic` |
| PUT | `/clinics/{clinicId}` | `updateClinic.ts` | Root/Admin/Manager + `canAccessClinic` |
| DELETE | `/clinics/{clinicId}` | `deleteClinic.ts` | Root only |
| GET | `/clinics/{clinicId}/address` | `getClinicAddress.ts` | Public |

**`POST /clinics` request**:
```json
{
  "name": "Bright Smile Dental",
  "addressLine1": "123 Main St",
  "addressLine2": "Suite 200",
  "addressLine3": "",
  "city": "Austin",
  "state": "TX",
  "pincode": "78701"
}
```
**Response 201**: `{ "status": "success", "data": { "clinicId (UUID)", "name", "addressLine1-3", "city", "state", "pincode", "address", "createdBy", "createdAt", "updatedAt", "associatedUsers" } }`

### 3.4 Clinic profile endpoints

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| POST | `/clinic-profiles` | `createClinicProfile.ts` | JWT + `AssociatedUsers` |
| GET | `/clinic-profiles` | `getClinicProfile.ts` | JWT |
| GET | `/clinic-profile/{clinicId}` | `getClinicProfileDetails.ts` | `canAccessClinic` |
| PUT | `/clinic-profiles/{clinicId}` | `updateClinicProfileDetails.ts` | `canWriteClinic("manageClinic")` |
| DELETE | `/clinic-profiles/{clinicId}` | `deleteClinicProfile.ts` | Clinic user or Root |

### 3.5 Professional profile endpoints

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| POST | `/profiles` | `createProfessionalProfile.ts` | JWT |
| GET | `/profiles` | `getProfessionalProfile.ts` | JWT |
| PUT | `/profiles` | `updateProfessionalProfile.ts` | JWT (self) |
| DELETE | `/profiles` | `deleteProfessionalProfile.ts` | JWT (self) |
| GET | `/profiles/questions` | `getProfessionalQuestions.ts` | JWT |
| GET | `/profiles/{userSub}` | `getPublicProfessionalProfile.ts` | JWT |
| GET | `/allprofessionals` | `getAllProfessionals.ts` | JWT |
| GET | `/professionals/public` | `publicProfessionals.ts` | Public |
| GET | `/public/publicprofessionals` | `publicProfessionals.ts` | Public |

### 3.6 Assignment endpoints

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| POST | `/assignments` | `createAssignment.ts` | Root |
| GET | `/assignments` | `getAssignments.ts` | JWT (self) |
| GET | `/assignments/{userSub}` | `getAssignments.ts` | JWT (self) |
| PUT | `/assignments` | `updateAssignment.ts` | Root |
| DELETE | `/assignments` | `deleteAssignment.ts` | Root |

### 3.7 Job posting endpoints

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| POST | `/jobs` | `createJobPosting.ts` | `canWriteClinic("manageJobs")` |
| GET | `/job-postings` | `getJobPostings.ts` | JWT (caller's postings) |
| GET | `/jobs/browse` | `browseJobPostings.ts` | JWT |
| GET | `/jobs/{jobId}` | `getJobPosting.ts` | JWT (composite-key) |
| PUT | `/jobs/{jobId}` | `updateJobPosting.ts` | `canWriteClinic` |
| DELETE | `/jobs/{jobId}` | `deleteJobPosting.ts` | `canWriteClinic` |
| GET | `/jobs/public` | `findJobs.ts` | Public |
| GET | `/public/publicJobs` | `findJobs.ts` | Public |
| POST | `/jobs/temporary` | `createTemporaryJob.ts` | Root/Admin/Manager |
| GET | `/jobs/temporary` | `getAllTemporaryJobs.ts` | JWT |
| GET | `/jobs/temporary/{jobId}` | `getTemporaryJob.ts` | JWT |
| PUT | `/jobs/temporary/{jobId}` | `updateTemporaryJob.ts` | JWT |
| DELETE | `/jobs/temporary/{jobId}` | `deleteTemporaryJob.ts` | `canWriteClinic` |
| GET | `/jobs/clinictemporary/{clinicId}` | `getTemporary-Clinic.ts` | `canAccessClinic` |
| POST | `/jobs/consulting` | `createMultiDayConsulting.ts` | Root/Admin/Manager |
| GET | `/jobs/consulting` | `getAllMultiDayConsulting.ts` | JWT |
| GET | `/jobs/consulting/{jobId}` | `getMultiDayConsulting.ts` | JWT |
| PUT | `/jobs/consulting/{jobId}` | `updateMultiDayConsulting.ts` | JWT |
| DELETE | `/jobs/consulting/{jobId}` | `deleteMultiDayConsulting.ts` | Root/Admin/Manager |
| GET | `/jobs/multiday/{jobId}` | `getAllMultidayJobs.ts` | JWT |
| GET | `/jobs/multiday/clinic/{clinicId}` | `getAllMultidayForClinic.ts` | JWT |
| POST | `/jobs/permanent` | `createPermanentJob.ts` | Root/Admin/Manager |
| GET | `/jobs/permanent` | `getAllPermanentJobs.ts` | JWT |
| GET | `/jobs/permanent/{jobId}` | `getPermanentJob.ts` | JWT |
| PUT | `/jobs/permanent/{jobId}` | `updatePermanentJob.ts` | JWT |
| DELETE | `/jobs/permanent/{jobId}` | `deletePermanentJob.ts` | Root/Admin/Manager |
| GET | `/jobs/clinicpermanent/{clinicId}` | `getAllPermanentJobsForClinic.ts` | JWT |
| PUT | `/jobs/{jobId}/status` | `updateJobStatus.ts` | JWT (composite-key) |
| POST | `/jobs/{jobId}/hire` | `acceptProf.ts` | Root/Admin/Manager |
| POST | `/{clinicId}/reject/{jobId}` | `rejectProf.ts` | Root/Admin/Manager |
| GET | `/professionals/filtered-jobs` | `getProfessionalFilteredJobs.ts` | JWT |

**`POST /jobs` request** (all job types):
```json
{
  "clinicId": "f8a1...",
  "job_type": "temporary",
  "professional_role": "dental_hygienist",
  "professional_roles": ["dental_hygienist"],
  "shift_speciality": "general",
  "pay_type": "per_hour",
  "rate": 55,
  "date": "2026-05-15",
  "hours": 8,
  "start_time": "08:00",
  "end_time": "16:00",
  "meal_break": true,
  "assisted_hygiene": true,
  "work_location_type": "onsite",
  "job_title": "Dental Hygienist — Temp Shift",
  "job_description": "Full day shift covering hygiene and basic restorative",
  "requirements": ["X-ray cert", "2+ yrs experience"]
}
```
**Response 201**:
```json
{
  "message": "Job posting created successfully",
  "jobId": "uuid",
  "job_type": "temporary",
  "professional_roles": ["dental_hygienist"],
  "date": "2026-05-15",
  "hours": 8,
  "rate": 55,
  "payType": "per_hour"
}
```

**`POST /jobs/permanent` request** (permanent-specific fields):
```json
{
  "clinicIds": ["f8a1..."],
  "job_type": "permanent",
  "professional_role": "associate_dentist",
  "shift_speciality": "general",
  "employment_type": "full_time",
  "salary_min": 120000,
  "salary_max": 180000,
  "benefits": ["health", "dental", "401k"],
  "vacation_days": 15,
  "work_schedule": "Mon–Fri 8:00–17:00",
  "start_date": "2026-06-01",
  "job_title": "Associate Dentist",
  "job_description": "Full-time position ..."
}
```

**`POST /jobs/consulting` request** (multi-day):
```json
{
  "clinicIds": ["f8a1..."],
  "professional_role": "dentist",
  "shift_speciality": "endodontics",
  "dates": ["2026-05-15", "2026-05-16", "2026-05-17"],
  "total_days": 3,
  "hours_per_day": 8,
  "start_time": "09:00",
  "end_time": "17:00",
  "rate": 120,
  "pay_type": "per_hour",
  "meal_break": "60min",
  "project_duration": "3-day endodontic coverage"
}
```

### 3.8 Application, invitation, negotiation endpoints

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| POST | `/applications` | `createJobApplication.ts` | JWT |
| GET | `/applications` | `getJobApplications.ts` | JWT |
| PUT | `/applications/{applicationId}` | `updateJobApplication.ts` | JWT (owner) |
| DELETE | `/applications/{applicationId}` | `deleteJobApplication.ts` | JWT (owner) |
| GET | `/clinics/{clinicId}/jobs` | `getJobApplicationsForClinic.ts` | JWT |
| GET | `/{clinicId}/jobs` | `getJobApplicantsOfAClinic.ts` | `canAccessClinic` |
| POST | `/jobs/{jobId}/invitations` | `sendJobInvitations.ts` | JWT |
| POST | `/invitations/{invitationId}/response` | `respondToInvitation.ts` | JWT (invitee) |
| GET | `/invitations` | `getJobInvitations.ts` | JWT |
| GET | `/invitations/{clinicId}` | `getJobInvitationsForClinics.ts` | JWT |
| PUT | `/applications/{applicationId}/negotiations/{negotiationId}/response` | `respondToNegotiation.ts` | JWT (party) |
| GET | `/allnegotiations` | `getAllNegotiations-Prof.ts` | JWT |
| GET | `/negotiations` | `getAllNegotiations-Prof.ts` | JWT |

**`POST /applications` request**:
```json
{
  "jobId": "uuid",
  "message": "I'd love to work this shift...",
  "proposedRate": 60,
  "availability": "Weekdays mornings",
  "startDate": "2026-05-15",
  "notes": "CPR certified"
}
```

**Response 201**:
```json
{
  "status": "success",
  "statusCode": 201,
  "message": "Job application submitted successfully",
  "data": {
    "applicationId": "uuid",
    "jobId": "uuid",
    "applicationStatus": "negotiating",
    "appliedAt": "2026-04-24T12:00:00Z",
    "job": { "title": "...", "type": "temporary", "role": "dental_hygienist", "rate": 55, "payType": "per_hour", "date": "2026-05-15", "dates": [] },
    "clinic": { "name": "Bright Smile Dental", "city": "Austin", "state": "TX", "practiceType": "general", "primaryPracticeArea": "general", "contactName": "Dr. Smith" }
  }
}
```

**`POST /invitations/{invitationId}/response` request**:
```json
{
  "response": "negotiating",
  "message": "I'd like to propose a higher rate",
  "proposedHourlyRate": 65,
  "availabilityNotes": "Only mornings",
  "counterProposalMessage": "Can we do $65/hr?"
}
```

**`PUT /applications/{applicationId}/negotiations/{negotiationId}/response` request**:
```json
{
  "response": "counter_offer",
  "message": "How about $60/hr?",
  "clinicCounterRate": 60,
  "payType": "per_hour"
}
```

**`POST /jobs/{jobId}/hire` request**: `{ "professionalUserSub": "abc-123", "clinicId": "f8a1..." }`

### 3.9 Shift dashboards

| Method | Path | Handler |
|--------|------|---------|
| GET | `/dashboard/all/open-shifts` | `getAllClinicsShifts.ts` (branch: open-shifts) |
| GET | `/dashboard/all/action-needed` | `getAllClinicsShifts.ts` (branch: action-needed) |
| GET | `/dashboard/all/scheduled-shifts` | `getAllClinicsShifts.ts` (branch: scheduled-shifts) |
| GET | `/dashboard/all/completed-shifts` | `getAllClinicsShifts.ts` (branch: completed-shifts) |
| GET | `/dashboard/all/invites-shifts` | `getAllClinicsShifts.ts` (branch: invites-shifts) |
| GET | `/clinics/{clinicId}/open-shifts` | `getClinicShifts.ts` |
| GET | `/clinics/{clinicId}/action-needed` | `getClinicShifts.ts` |
| GET | `/clinics/{clinicId}/scheduled-shifts` | `getClinicShifts.ts` |
| GET | `/clinics/{clinicId}/completed-shifts` | `getClinicShifts.ts` |
| GET | `/clinics/{clinicId}/invites-shifts` | `getClinicShifts.ts` |
| GET | `/scheduled/{clinicId}` | `getScheduledShifts.ts` |
| GET | `/completed/{clinicId}` | `getCompletedShifts.ts` |
| PUT | `/professionals/completedshifts` | `updateCompletedShifts.ts` |
| GET | `/action-needed` | `getActionNeeded.ts` |

### 3.10 Clinic favorites

| Method | Path | Handler |
|--------|------|---------|
| POST | `/clinics/favorites` | `addClinicFavorite.ts` |
| GET | `/clinics/favorites` | `getClinicFavorites.ts` |
| DELETE | `/clinics/favorites/{professionalUserSub}` | `removeClinicFavorite.ts` |

### 3.11 User address

| Method | Path | Handler |
|--------|------|---------|
| POST | `/user-addresses` | `createUserAddress.ts` |
| GET | `/user-addresses` | `getUserAddresses.ts` |
| PUT | `/user-addresses` | `updateUserAddress.ts` |
| DELETE | `/user-addresses` | `deleteUserAddress.ts` |

### 3.12 File management

| Method | Path | Handler |
|--------|------|---------|
| POST | `/files/presigned-urls` | `generatePresignedUrl.ts` |
| GET | `/files/profile-images` | `getFileUrl.getProfileImage` |
| GET | `/files/professional-resumes` | `getFileUrl.getProfessionalResume` |
| GET | `/files/professional-licenses` | `getFileUrl.getProfessionalLicense` |
| GET | `/files/driving-licenses` | `getFileUrl.getDrivingLicense` |
| GET | `/files/video-resumes` | `getFileUrl.getVideoResume` |
| GET | `/files/clinic-office-images` | `getClinicOfficeImages.ts` |
| PUT | `/files/profile-image` | `updateFile.updateProfileImage` |
| PUT | `/files/professional-resumes` | `updateFile.updateProfessionalResume` |
| PUT | `/files/professional-licenses` | `updateFile.updateProfessionalLicense` |
| PUT | `/files/driving-licenses` | `updateFile.updateDrivingLicense` |
| PUT | `/files/video-resumes` | `updateFile.updateVideoResume` |
| DELETE | `/files/profile-images` | `deleteFile.ts` |
| DELETE | `/files/certificates` | `deleteFile.ts` |
| DELETE | `/files/video-resumes` | `deleteFile.ts` |

**`POST /files/presigned-urls` request**:
```json
{
  "fileType": "profile-image",
  "fileName": "headshot.jpg",
  "contentType": "image/jpeg",
  "fileSize": 204800
}
```
**Response 200**:
```json
{
  "url": "https://bucket-name.s3.us-east-1.amazonaws.com/",
  "fields": {
    "key": "userSub/profile-image/1714000000-headshot.jpg",
    "Content-Type": "image/jpeg",
    "Policy": "eyJleHBpcmF0...",
    "X-Amz-Signature": "...",
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256"
  },
  "objectKey": "userSub/profile-image/1714000000-headshot.jpg",
  "bucket": "profileimagesbucket-...",
  "expiresIn": 900,
  "limits": { "min": 5120, "max": 10485760, "minLabel": "5 KB", "maxLabel": "10 MB" }
}
```

### 3.13 Promotions

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| GET | `/promotions/plans` | `getPromotionPlans.ts` | Public |
| POST | `/promotions` | `createPromotion.ts` | `canWriteClinic("manageJobs")` |
| GET | `/promotions` | `getPromotions.ts` | JWT |
| GET | `/promotions/{promotionId}` | `getPromotion.ts` | JWT |
| PUT | `/promotions/{promotionId}/cancel` | `cancelPromotion.ts` | `canWriteClinic` |
| PUT | `/promotions/{promotionId}/activate` | `activatePromotion.ts` | `canWriteClinic` |
| POST | `/promotions/track-click` | `trackPromotionClick.ts` | Public |

**`GET /promotions/plans` response 200**:
```json
{
  "status": "success",
  "plans": [
    { "planId": "basic",    "name": "Basic",    "durationDays":  3, "priceCents":  999, "features": ["Top of search", "Badge"] },
    { "planId": "featured", "name": "Featured", "durationDays":  7, "priceCents": 2499, "features": ["Top", "Featured badge", "Email digest"] },
    { "planId": "premium",  "name": "Premium",  "durationDays": 14, "priceCents": 4999, "features": ["Top", "Premium badge", "Email digest", "Push notifications"] }
  ]
}
```

### 3.14 Referrals, feedback, geocoding

| Method | Path | Handler | Auth |
|--------|------|---------|------|
| POST | `/referrals/invite` | `sendReferralInvite.ts` | JWT |
| POST | `/submitfeedback` | `submitFeedback.ts` | Optional |
| GET | `/location/lookup` | `geocodePostal.ts` | Public |
| GET | `/geocode/postal` | `geocodePostal.ts` | Public |

**`GET /geocode/postal?postalCode=78701&country=US` response 200**:
```json
{
  "status": "success",
  "data": {
    "city": "Austin",
    "state": "TX",
    "stateFull": "Texas",
    "country": "USA",
    "postalCode": "78701",
    "label": "78701, Austin, TX, USA",
    "coordinates": { "lng": -97.7431, "lat": 30.2672 }
  }
}
```

### 3.15 Standard error response envelope

All handlers return errors in this shape:

```json
{
  "status": "error",
  "statusCode": 400,
  "message": "Human-readable description",
  "error": "Optional error code or context",
  "timestamp": "2026-04-24T12:00:00Z"
}
```

Router-level 404:
```json
{
  "error": "Endpoint not found",
  "resource": "/unknown/path",
  "method": "GET",
  "tried": ["/unknown/path", "/unknown/path/", "/prod/unknown/path"]
}
```

Router-level 500:
```json
{
  "error": "Internal server error: <details>",
  "resource": "/some/path",
  "method": "POST"
}
```

---

## 4. WebSocket APIs

### 4.1 Overview

| Property | Value |
|----------|-------|
| API Gateway type | WebSocket (v2) |
| API name | `DentiPal-Chat-API` |
| Stage | `prod` (auto-deploy) |
| Endpoint | `wss://<api-id>.execute-api.<region>.amazonaws.com/prod` |
| Handler | `websocketHandler.ts` (single Lambda, 512 MB, 30 s timeout) |

### 4.2 Routes

| Route | Purpose |
|-------|---------|
| `$connect` | Establish connection; verify JWT (via `aws-jwt-verify`); store `userKey + connectionId` in `Connections` table |
| `$disconnect` | Clean up the row in `Connections` via `connectionId-index` reverse lookup |
| `$default` | All application messages; dispatched internally by the `action` field |

### 4.3 Client auth at `$connect`

Cognito access token is passed as a querystring parameter:

```
wss://<api>.execute-api.us-east-1.amazonaws.com/prod?token=eyJhbGciOi...&clinicId=f8a1...
```

- Token signature + expiration + issuer + `token_use=access` are verified by `CognitoJwtVerifier.create(...)`.
- `userKey` is derived: `clinic#{clinicId}` (clinic-side groups) or `prof#{sub}` (professional groups).

### 4.4 Client → server message format

```json
{
  "action": "sendMessage | getHistory | markRead | getConversations",
  "clinicId": "f8a1...",
  "professionalSub": "3e2a9a1d-...",
  "content": "string (sendMessage only)",
  "messageType": "text | system (optional, default text)",
  "limit": 50,
  "nextKey": { "conversationId": "...", "messageId": "..." }
}
```

### 4.5 Actions (dispatched inside `$default`)

#### `sendMessage`
**Client sends**:
```json
{ "action": "sendMessage", "clinicId": "...", "professionalSub": "...", "content": "Hi, I'm interested", "messageType": "text" }
```
**Server pushes to recipient + sender's OTHER tabs**:
```json
{
  "type": "message",
  "conversationId": "clinic#f8a1|prof#3e2a",
  "messageId": "uuid",
  "senderKey": "prof#3e2a",
  "senderName": "Jane Doe",
  "content": "Hi, I'm interested",
  "timestamp": 1714000000000,
  "messageType": "text",
  "clinicId": "...",
  "professionalSub": "...",
  "message": { /* full message row */ }
}
```
**Server pushes to current connection (ACK)**:
```json
{ "type": "ack", "messageId": "uuid", "conversationId": "...", "timestamp": 1714000000000, "status": "delivered" }
```

**DynamoDB writes**:
- `Messages` PutItem (`conversationId` + `messageId`)
- `Conversations` UpdateItem (create-or-update; sets `clinicKey, profKey, clinicName, profName, lastMessageAt, lastPreview`; increments recipient unread; resets sender unread)

#### `getHistory`
**Client**: `{ "action": "getHistory", "clinicId": "...", "professionalSub": "...", "limit": 50, "nextKey": null }`

**Server**:
```json
{
  "type": "history",
  "conversationId": "...",
  "items": [
    { "messageId": "uuid", "timestamp": 1714000000000, "senderKey": "prof#3e2a", "senderName": "Jane", "content": "...", "messageType": "text", "status": "read" }
  ],
  "nextKey": { "conversationId": "...", "messageId": "..." }
}
```

#### `markRead`
**Client**: `{ "action": "markRead", "clinicId": "...", "professionalSub": "..." }`

**Server ACK to caller**: `{ "type": "ack", "conversationId": "...", "action": "markRead" }`

**Server push to other side (read-receipt)**:
```json
{ "type": "readReceipt", "conversationId": "...", "readBy": "prof#3e2a" }
```

#### `getConversations` (two-phase)

**Client**: `{ "action": "getConversations", "clinicId": "all | <id>", "limit": 50, "nextKey": null }`

**Phase 1 (fast)**:
```json
{
  "type": "conversationsResponse",
  "conversations": [
    {
      "conversationId": "clinic#f8a1|prof#3e2a",
      "recipientName": "Jane Doe",
      "lastMessage": "See you Monday!",
      "lastMessageAt": 1714000000000,
      "unreadCount": 2,
      "isOnline": true
    }
  ],
  "nextKey": null,
  "hasMore": false
}
```

**Phase 2 (deferred avatars)**:
```json
{ "type": "avatarsUpdate", "avatars": { "clinic#f8a1|prof#3e2a": "https://...presigned-url..." } }
```

### 4.6 Server-initiated system messages (via EventBridge → `event-to-message`)

When a clinic hires / rejects / responds to a negotiation / a shift completes, an EventBridge event triggers a system message written to the conversation and pushed to both parties:

```json
{
  "type": "message",
  "conversationId": "clinic#f8a1|prof#3e2a",
  "messageId": "uuid",
  "senderKey": "clinic#f8a1",
  "senderName": "Bright Smile Dental",
  "content": "📅 Shift scheduled\nRole: Dental Hygienist\nDate: 2026-05-15\nTime: 08:00–16:00\nRate: $55/hr\nLocation: Austin, TX",
  "timestamp": 1714000000000,
  "messageType": "system"
}
```

### 4.7 Error frame

```json
{ "type": "error", "error": "Unknown or missing action. Expected one of: sendMessage, getHistory, markRead, getConversations." }
```

### 4.8 Use cases

- Realtime clinic ↔ professional chat (hiring conversations, logistics, post-shift follow-up).
- System-message delivery for status changes (hired, rejected, invite accepted, shift completed).
- Multi-tab synchronization — sender's other open tabs get the same message.
- Read receipts + unread counters for inbox UI.
- Presence / online indicator via Connections-table reverse lookup.

---

## 5. Cognito Configuration

### 5.1 User Pool

| Property | Value |
|----------|-------|
| Construct ID | `ClinicUserPoolV5` |
| Self-signup | Enabled |
| Auto-verify | Email |
| Sign-in alias | Email |
| Password min length | 8 |
| Password policy | digits + lowercase + uppercase + symbols |
| Required attributes | `given_name`, `family_name`, `phone_number`, `email`, `address` |
| Removal policy | DESTROY (flagged to switch to RETAIN for prod) |

### 5.2 App Client

| Property | Value |
|----------|-------|
| Client name | `ClinicAppClientV5` |
| Client secret | None (SPA/public client) |
| Auth flows | `userPassword`, `userSrp`, `adminUserPassword`, `custom` |
| `preventUserExistenceErrors` | true |

### 5.3 Identity Pool

Not provisioned. Frontend authenticates directly against the User Pool and passes the Cognito access token on each REST call.

### 5.4 Groups — **all 20**

| # | Group name | Audience | Purpose |
|---|-----------|----------|---------|
| 1 | `Root` | Clinic super-admin | Highest clinic privilege; full write on clinics they are members of |
| 2 | `ClinicAdmin` | Clinic admin | Full write on assigned clinics |
| 3 | `ClinicManager` | Clinic manager | Full write on assigned clinics |
| 4 | `ClinicViewer` | Clinic viewer | Read-only on assigned clinics |
| 5 | `AssociateDentist` | Professional (doctor) | Associate dentist |
| 6 | `DentalAssistant` | Professional (clinical) | Chairside dental assistant |
| 7 | `DualRoleFrontDA` | Professional (dual role) | Front-desk + DA hybrid |
| 8 | `DentalHygienist` | Professional (clinical) | Licensed hygienist |
| 9 | `FrontDesk` | Professional (front office) | Receptionist / admin |
| 10 | `Dentist` | Professional (doctor) | Licensed dentist |
| 11 | `Hygienist` | Professional (clinical) | Alias of `DentalHygienist` |
| 12 | `DHComboRole` | Professional (clinical) | DA + hygienist combo |
| 13 | `BillingCoordinator` | Professional (billing) | Billing ops |
| 14 | `InsuranceVerification` | Professional (billing) | Insurance verification |
| 15 | `PaymentPosting` | Professional (billing) | Payment posting |
| 16 | `ClaimsSending` | Professional (billing) | Claims submission |
| 17 | `ClaimsResolution` | Professional (billing) | Rejections / appeals |
| 18 | `HIPAATrainee` | Professional (compliance) | HIPAA training |
| 19 | `OSHATrainee` | Professional (compliance) | OSHA training |
| 20 | `Accounting` | Professional (accounting) | Dental practice accounting |

### 5.5 Clinic-side role capability matrix

| Action | `root` | `clinicadmin` | `clinicmanager` | `clinicviewer` |
|--------|:------:|:-------------:|:---------------:|:--------------:|
| Read clinic (`canAccessClinic`) | ✅ | ✅ | ✅ | ✅ |
| `manageJobs` (create/edit/delete postings, promotions) | ✅ | ✅ | ✅ | ❌ |
| `manageApplicants` (hire/reject/negotiate) | ✅ | ✅ | ✅ | ❌ |
| `manageClinic` (edit profile/settings) | ✅ | ✅ | ✅ | ❌ |
| `manageUsers` | ✅ | ✅ | ✅ | ❌ |
| `createClinic` | ✅ | ✅ | ❌ | ❌ |
| `deleteClinic` | ✅ | ❌ | ❌ | ❌ |
| Legacy `UserClinicAssignments` CRUD | ✅ | ❌ | ❌ | ❌ |
| Create clinic user (`POST /users`) | ✅ | ❌ | ❌ | ❌ |
| Delete any user (`DELETE /users/{id}`) | ✅ | ❌ | ❌ | ❌ |
| Aggregated `/action-needed?aggregate=true` | ✅ | ❌ | ❌ | ❌ |

### 5.6 Professional role categories

```js
DOCTOR:       ["Dentist", "AssociateDentist"]
CLINICAL:     ["DentalHygienist", "Hygienist", "DentalAssistant", "DHComboRole"]
FRONT_OFFICE: ["FrontDesk"]
DUAL_ROLE:    ["DualRoleFrontDA"]
BILLING:      ["BillingCoordinator", "InsuranceVerification", "PaymentPosting", "ClaimsSending", "ClaimsResolution"]
COMPLIANCE:   ["HIPAATrainee", "OSHATrainee"]
ACCOUNTING:   ["Accounting"]
```

### 5.7 Lambda triggers

| Cognito operation | Lambda function | Purpose |
|-------------------|-----------------|---------|
| `PRE_SIGN_UP` | `DentiPal-PreSignUp` | Auto-fill missing attributes + auto-confirm Google signups |
| `CREATE_AUTH_CHALLENGE` | `DentiPal-CreateAuthChallenge` | Set `"google-verified"` as the expected answer |
| `DEFINE_AUTH_CHALLENGE` | `DentiPal-DefineAuthChallenge` | Issue tokens after custom challenge passes |
| `VERIFY_AUTH_CHALLENGE_RESPONSE` | `DentiPal-VerifyAuthChallenge` | Compare answer vs `"google-verified"` |

### 5.8 Authentication flows supported

| Flow | Mechanism |
|------|-----------|
| Email + password | `InitiateAuth` with `USER_PASSWORD_AUTH` or `USER_SRP_AUTH` |
| Sign-up via OTP | `SignUp` → SES-sent code → `ConfirmSignUp` |
| Password reset | `ForgotPassword` → code → `ConfirmForgotPassword` |
| Refresh | `InitiateAuth` with `REFRESH_TOKEN_AUTH` |
| Google OAuth (password-less) | Google `tokeninfo` → `AdminCreateUser` (if new) → `AdminInitiateAuth` (CUSTOM_AUTH) → `AdminRespondToAuthChallenge` with `"google-verified"` |

---

## 6. SES (Email Service)

### 6.1 Configuration

| Setting | Value |
|---------|-------|
| IAM actions | `ses:SendEmail`, `ses:SendRawEmail` |
| Resource scope | `*` (all verified identities) |
| `SES_FROM` env var | `viswanadhapallivennela19@gmail.com` (must be SES-verified) |
| `SES_REGION` env var | Stack region (us-east-1) |
| `SES_TO` env var | `shashitest2004@gmail.com` (default support recipient) |

### 6.2 Handlers that send emails

| # | Handler | Use case | Template style |
|---|---------|----------|----------------|
| 1 | `verifyOTPAndCreateUser.ts` | Welcome email after OTP confirmation | HTML + text, role-specific next-steps |
| 2 | `createUser.ts` | Welcome email with credentials for staff created by Root | Plain template with login credentials |
| 3 | `initiateUserRegistration.ts` | OTP verification code (indirectly via Cognito `SignUp`) | Cognito-managed template |
| 4 | `forgotPassword.ts` | Password reset code (via Cognito `ForgotPassword`) | Cognito-managed template |
| 5 | `resendOtp.ts` | OTP resend (via Cognito `ResendConfirmationCode`) | Cognito-managed template |
| 6 | `confirmPassword.ts` | Password-reset confirmation (Cognito-managed) | Cognito-managed |
| 7 | `sendReferralInvite.ts` | Referral invitation email to a friend | HTML + text with branded CTA + referral link |
| 8 | `submitFeedback.ts` | Forward feedback submission to support inbox | HTML with color-coded badge (bug/suggestion/other) |

### 6.3 Total SES integrations

**8 handlers** send email. Of these, **5 use Cognito-managed templates** (OTP / password reset via Cognito) and **3 send custom HTML via SES directly** (`verifyOTPAndCreateUser`, `sendReferralInvite`, `submitFeedback`).

### 6.4 Explicit SES-defined templates

None. All email bodies are constructed inline inside the handler (HTML + text strings). No `SES.CreateTemplate` / `SendTemplatedEmail` usage.

### 6.5 Email use cases

- **OTP delivery** — signup verification code (Cognito-managed).
- **Welcome emails** — post-registration (`verifyOTPAndCreateUser`) and staff-created (`createUser`).
- **Password reset** — code + confirmation (Cognito-managed).
- **Referral invitations** — to potential new professional users.
- **Feedback forwarding** — user-submitted feedback → support email.

### 6.6 SNS (companion SMS channel)

- **Topic ARN env var**: `SMS_TOPIC_ARN = arn:aws:sns:${region}:${account}:DentiPal-SMS-Notifications`
- **Used by**: `verifyOTPAndCreateUser.ts` (welcome SMS if `phone_number` is present)
- **IAM**: `sns:Publish` on `*`

---

## 7. DynamoDB Tables

### 7.1 Total

**18 tables** (naming convention `DentiPal-V5-*`), **25 GSIs**, all **PAY_PER_REQUEST**.

### 7.2 Per-table reference

#### 7.2.1 `DentiPal-V5-Clinic-Profiles`
**Purpose**: Rich clinic profile per (clinic, admin user).

| Key | Type |
|-----|------|
| PK `clinicId` | STRING |
| SK `userSub` | STRING |

**Attributes**: `clinic_name, clinic_type, practice_type, primary_practice_area, primary_contact_first_name, primary_contact_last_name, assisted_hygiene_available (BOOL), number_of_operatories (N), num_hygienists (N), num_assistants (N), num_doctors (N), booking_out_period, clinic_software, software_used (L), parking_type, parking_cost (N), free_parking_available (BOOL), addressLine1-3, city, state, zipCode, contact_email, contact_phone, special_requirements (L), office_image_key, notes, description, createdAt, updatedAt`.

**GSIs**:
| Name | PK | SK | Projection |
|------|----|----|-----------|
| `userSub-index` | `userSub` | — | ALL |

**Example item**:
```json
{
  "clinicId": "f8a1...",
  "userSub": "3e2a9a1d-...",
  "clinic_name": "Bright Smile Dental",
  "practice_type": "General",
  "primary_practice_area": "General Dentistry",
  "primary_contact_first_name": "John",
  "primary_contact_last_name": "Doe",
  "assisted_hygiene_available": true,
  "number_of_operatories": 6,
  "num_hygienists": 2,
  "num_assistants": 3,
  "num_doctors": 2,
  "booking_out_period": "2_weeks",
  "software_used": ["Dentrix", "Eaglesoft"],
  "parking_type": "free_street",
  "free_parking_available": true,
  "city": "Austin", "state": "TX", "zipCode": "78701",
  "createdAt": "2026-01-15T10:00:00Z"
}
```

**Related handlers**: `createClinicProfile`, `getClinicProfile`, `getClinicProfileDetails`, `updateClinicProfileDetails`, `deleteClinicProfile`.

---

#### 7.2.2 `DentiPal-V5-ClinicFavorites`
**PK** `clinicUserSub` · **SK** `professionalUserSub` · **GSIs**: none

**Attributes**: `favoriteAddedAt, notes?, tags (SS)?`.

**Example**:
```json
{ "clinicUserSub": "abc-123", "professionalUserSub": "xyz-789", "favoriteAddedAt": "2026-04-01T00:00:00Z", "notes": "Reliable hygienist", "tags": ["emergency", "experienced"] }
```

**Handlers**: `addClinicFavorite`, `getClinicFavorites`, `removeClinicFavorite`.

---

#### 7.2.3 `DentiPal-V5-Clinics`
**PK** `clinicId` · **SK** — · **GSIs**: `CreatedByIndex` (PK `createdBy`)

**Attributes**: `name, addressLine1-3, city, state, pincode, createdBy, AssociatedUsers (SS | L), lat (N), lng (N), createdAt, updatedAt`.

**Example**:
```json
{
  "clinicId": "f8a1...",
  "name": "Bright Smile Dental",
  "addressLine1": "123 Main St",
  "city": "Austin", "state": "TX", "pincode": "78701",
  "createdBy": "3e2a9a1d-...",
  "AssociatedUsers": ["3e2a9a1d-...", "bcd-456"],
  "lat": 30.2672, "lng": -97.7431,
  "createdAt": "2026-01-10T09:00:00Z"
}
```

**Handlers**: `createClinic`, `getClinic`, `updateClinic`, `deleteClinic`, `getAllClinics`, `utils.canAccessClinic`, `utils.listAccessibleClinicIds`.

---

#### 7.2.4 `DentiPal-V5-Connections` (WebSocket)
**PK** `userKey` (e.g. `clinic#f8a1` or `prof#3e2a`) · **SK** `connectionId`

**GSIs**: `connectionId-index` (PK `connectionId`, SK `userKey`)

**Attributes**: `connectedAt (N, epoch ms), ttl (N), userType, display, sub, email`.

**Handlers**: `websocketHandler.ts` (`$connect`, `$disconnect`, broadcasts).

---

#### 7.2.5 `DentiPal-V5-Conversations`
**PK** `conversationId` (sorted `clinic#{id}|prof#{sub}`) · **SK** —

**GSIs**:
- `clinicKey-lastMessageAt` (PK `clinicKey` (S), SK `lastMessageAt` (N)) — clinic inbox
- `profKey-lastMessageAt` (PK `profKey` (S), SK `lastMessageAt` (N)) — professional inbox

**Attributes**: `clinicKey, profKey, clinicName, profName, lastMessageAt (N), lastPreview, clinicUnread (N), profUnread (N), participants (L)`.

---

#### 7.2.6 `DentiPal-V5-Feedback`
**PK** `PK` (generic, e.g. `site#feedback`) · **SK** `SK` (e.g. `feedback#{timestamp}#{id}`)

**Attributes**: `feedbackId, userId?, feedback, rating (N)?, type, createdAt, userAgent, referer, sourceIP, userType`.

**Handler**: `submitFeedback.ts`.

---

#### 7.2.7 `DentiPal-V5-JobApplications`
**PK** `jobId` · **SK** `professionalUserSub`

**GSIs (5)**:
- `applicationId-index` (PK `applicationId`)
- `clinicId-index` (PK `clinicId`)
- `clinicId-jobId-index` (PK `clinicId`, SK `jobId`)
- `JobIdIndex-1` (PK `jobId`)
- `professionalUserSub-index` (PK `professionalUserSub`, SK `jobId`)

**Attributes**: `applicationId, clinicId, clinicUserSub, applicationStatus (pending/negotiating/accepted/rejected/scheduled/completed/job_cancelled), appliedAt, updatedAt, applicationMessage, availability, startDate, notes, proposedRate (N), proposedHourlyRate (N), acceptedRate (N), negotiationId`.

**Example**:
```json
{
  "jobId": "job-123",
  "professionalUserSub": "prof-789",
  "applicationId": "app-456",
  "clinicId": "clinic-111",
  "clinicUserSub": "admin-222",
  "applicationStatus": "negotiating",
  "appliedAt": "2026-04-24T10:00:00Z",
  "proposedRate": 60,
  "negotiationId": "neg-777"
}
```

**Handlers**: `createJobApplication`, `getJobApplications`, `updateJobApplication`, `deleteJobApplication`, `getJobApplicationsForClinic`, `getJobApplicantsOfAClinic`, `acceptProf`, `rejectProf`, `updateCompletedShifts`.

---

#### 7.2.8 `DentiPal-V5-JobInvitations`
**PK** `jobId` · **SK** `professionalUserSub`

**GSIs (2)**:
- `invitationId-index` (PK `invitationId`)
- `ProfessionalIndex` (PK `professionalUserSub`)

**Attributes**: `invitationId, clinicId, clinicUserSub, invitationStatus (sent/accepted/declined), invitationMessage, sentAt, respondedAt, response, urgency, customNotes`.

**Handlers**: `sendJobInvitations`, `respondToInvitation`, `getJobInvitations`, `getJobInvitationsForClinics`.

---

#### 7.2.9 `DentiPal-V5-JobNegotiations`
**PK** `applicationId` · **SK** `negotiationId`

**GSIs (3)**:
- `index` (PK `applicationId`)
- `GSI1` (PK `gsi1pk`, SK `gsi1sk`, INCLUDE projection for `negotiationId, clinicId, jobId, professionalUserSub, status, lastOfferPay, lastOfferFrom, updatedAt`)
- `JobIndex` (PK `jobId`, SK `createdAt`)

**Attributes**: `jobId, clinicId, professionalUserSub, negotiationStatus (pending/accepted/declined/counter_offer), proposedHourlyRate (N), lastOfferPay (N), lastOfferFrom (clinic|professional), clinicCounterRate (N), professionalCounterRate (N), agreedRate (N), counterSalaryMin (N), counterSalaryMax (N), payType, clinicMessage, professionalMessage, status, gsi1pk, gsi1sk, createdAt, updatedAt`.

**Handlers**: `createJobApplication`, `respondToInvitation`, `respondToNegotiation`, `getAllNegotiations-Prof`.

---

#### 7.2.10 `DentiPal-V5-JobPostings`
**PK** `clinicUserSub` · **SK** `jobId`

**GSIs (5)**:
- `ClinicIdIndex` (PK `clinicId`, SK `jobId`)
- `DateIndex` (PK `date`, SK `jobId`)
- `jobId-index-1` (PK `jobId`)
- `JobIdIndex-2` (PK `jobId`) — duplicate
- `status-createdAt-index` (PK `status`, SK `createdAt`)

**Attributes**: `clinicId, job_type (temporary|multi_day_consulting|permanent), professional_role, professional_roles (L), shift_speciality, status (active|inactive|scheduled|action_needed|completed), job_title, job_description, requirements (SS), date, dates (L|SS), hours (N), hours_per_day (N), total_days (N), hourly_rate (N), pay_type, rate (N), rate_per_transaction (N), revenue_percentage (N), meal_break (BOOL|S), start_time, end_time, employment_type (full_time|part_time), salary_min (N), salary_max (N), benefits (SS), vacation_days (N), work_schedule, start_date, project_duration, assisted_hygiene (BOOL), work_location_type, addressLine1-3, city, state, pincode, clinic_name, clinic_type, parking_type, parking_rate (N), clinicSoftware, freeParkingAvailable (BOOL), lat (N), lng (N), isPromoted (BOOL), promotionId, promotionPlanId, promotionExpiresAt, applicationsCount (N), statusHistory (L), createdAt, updatedAt, created_by`.

**Example (temporary)**:
```json
{
  "clinicUserSub": "admin-222",
  "jobId": "job-123",
  "clinicId": "clinic-111",
  "job_type": "temporary",
  "professional_role": "dental_hygienist",
  "shift_speciality": "general",
  "status": "active",
  "date": "2026-05-15",
  "hours": 8,
  "rate": 55,
  "pay_type": "per_hour",
  "start_time": "08:00",
  "end_time": "16:00",
  "meal_break": true,
  "assisted_hygiene": true,
  "addressLine1": "123 Main St", "city": "Austin", "state": "TX", "pincode": "78701",
  "lat": 30.2672, "lng": -97.7431,
  "clinic_name": "Bright Smile Dental",
  "createdAt": "2026-04-24T10:00:00Z"
}
```

**Handlers**: all job handlers (§2.3.6), `findJobs`, `getProfessionalFilteredJobs`.

---

#### 7.2.11 `DentiPal-V5-Messages`
**PK** `conversationId` · **SK** `messageId` · **GSIs**: `ConversationIdIndex` (redundant, flagged for removal)

**Attributes**: `senderKey, senderDisplay, content, timestamp (N), messageType (text|system), type`.

**Handlers**: `websocketHandler.sendMessage`, `websocketHandler.getHistory`, `event-to-message`.

---

#### 7.2.12 `DentiPal-V5-Notifications`
**PK** `recipientUserSub` · **SK** `notificationId`

**Attributes**: `message, type, relatedItemId, isRead (BOOL), createdAt`.

> **Note**: The CDK stack provisions this table but the handlers reviewed do not write to it. Reserved for future in-app notification delivery.

---

#### 7.2.13 `DentiPal-V5-OTPVerification`
**PK** `email` · **SK** —

**Attributes**: `otp, expiresAt (N), attempts (N), createdAt`.

> **Note**: Presence in the stack; Cognito `SignUp` handles OTP delivery in-process via SES. This table would be used if a custom OTP scheme replaces Cognito-native verification.

---

#### 7.2.14 `DentiPal-V5-ProfessionalProfiles`
**PK** `userSub` · **SK** —

**Attributes**: `role, first_name, last_name, email, phone, bio, yearsExperience (N), qualifications, skills (SS), certificates (SS), professionalCertificates (SS), license_number, specialties (SS), specializations (SS), is_willing_to_travel (BOOL), max_travel_distance (N), dentalSoftwareExperience (SS|L|S), profileImageKey, professionalResumeKeys (L), professionalLicenseKeys (L), drivingLicenseKeys (L), videoResumeKey, bonusBalance (N), isDefault (BOOL), createdAt, updatedAt, <dynamic fields>`.

**Example**:
```json
{
  "userSub": "3e2a9a1d-...",
  "role": "dental_hygienist",
  "first_name": "Jane", "last_name": "Doe",
  "specialties": ["General", "Pediatric"],
  "yearsExperience": 5,
  "license_number": "TX-1234",
  "bonusBalance": 100,
  "profileImageKey": "3e2a/profile-image/1714000000-photo.jpg"
}
```

---

#### 7.2.15 `DentiPal-V5-Referrals`
**PK** `referralId` · **SK** —

**GSIs (2)**:
- `ReferredUserSubIndex` (PK `referredUserSub`)
- `ReferrerIndex` (PK `referrerUserSub`, SK `sentAt`)

**Attributes**: `referrerUserSub, referrerName, referredUserSub, referredEmail, referredName, status (sent|signed_up|completed|bonus_due), friendEmail, sentAt, acceptedAt, updatedAt, referralBonus (N), bonusAwarded (BOOL), bonusAmount (N)`.

---

#### 7.2.16 `DentiPal-V5-UserAddresses`
**PK** `userSub` · **SK** —

**Attributes**: `addressLine1-3, city, state, pincode, country (default USA), addressType (home|work), isDefault (BOOL), lat (N), lng (N), createdAt, updatedAt`.

---

#### 7.2.17 `DentiPal-V5-UserClinicAssignments`
**PK** `userSub` · **SK** `clinicId`

**Attributes**: `accessLevel (ClinicAdmin|ClinicManager|ClinicViewer|Professional), assignedAt, assignedBy`.

> **Legacy** — not populated by the Add-User flow; `utils.hasClinicAccess` marks its callers as deprecated. The effective source of truth for clinic membership is `Clinics.AssociatedUsers`.

---

#### 7.2.18 `DentiPal-V5-JobPromotions`
**PK** `jobId` · **SK** `promotionId`

**GSIs (3)**:
- `clinicUserSub-index` (PK `clinicUserSub`, SK `createdAt`) — legacy, pending removal
- `clinicId-createdAt-index` (PK `clinicId`, SK `createdAt`)
- `status-expiresAt-index` (PK `status`, SK `expiresAt`)

**Attributes**: `clinicUserSub, clinicId, status (pending_payment|active|cancelled|expired), plan (basic|featured|premium), amount (N), currency, impressions (N), clicks (N), applications (N), createdAt, activatedAt, expiresAt, cancelledAt`.

### 7.3 GSI catalog (summary)

| # | Table | GSI | Access pattern |
|---|-------|-----|----------------|
| 1 | Clinic-Profiles | `userSub-index` | Find profiles by admin user |
| 2 | Clinics | `CreatedByIndex` | Find clinics by owner |
| 3 | Connections | `connectionId-index` | Reverse lookup by WebSocket connection |
| 4 | Conversations | `clinicKey-lastMessageAt` | Clinic chat inbox (recency-sorted) |
| 5 | Conversations | `profKey-lastMessageAt` | Professional chat inbox |
| 6 | JobApplications | `applicationId-index` | Application by UUID |
| 7 | JobApplications | `clinicId-index` | All applications per clinic |
| 8 | JobApplications | `clinicId-jobId-index` | Applications per (clinic, job) |
| 9 | JobApplications | `JobIdIndex-1` | Applications by job |
| 10 | JobApplications | `professionalUserSub-index` | Professional's application history |
| 11 | JobInvitations | `invitationId-index` | Invitation by UUID |
| 12 | JobInvitations | `ProfessionalIndex` | Professional's invitation inbox |
| 13 | JobNegotiations | `index` | Negotiations by application |
| 14 | JobNegotiations | `GSI1` | Overloaded composite queries |
| 15 | JobNegotiations | `JobIndex` | Negotiations by job, chronological |
| 16 | JobPostings | `ClinicIdIndex` | Jobs by clinic |
| 17 | JobPostings | `DateIndex` | Jobs by date |
| 18 | JobPostings | `jobId-index-1` | Job lookup by UUID |
| 19 | JobPostings | `JobIdIndex-2` | Duplicate of #18 (cleanup) |
| 20 | JobPostings | `status-createdAt-index` | Open jobs chronologically |
| 21 | Messages | `ConversationIdIndex` | Redundant (cleanup) |
| 22 | Referrals | `ReferredUserSubIndex` | Check if user was referred |
| 23 | Referrals | `ReferrerIndex` | Referral history by sender |
| 24 | JobPromotions | `clinicId-createdAt-index` | Promotions per clinic |
| 25 | JobPromotions | `status-expiresAt-index` | Expiry cron support |

---

## 8. Validation & Error Handling

### 8.1 Validation approach

No external validation library (no Joi / Zod / class-validator). **All validation is hand-rolled inside handlers**.

### 8.2 Common validation patterns

| Pattern | Example |
|---------|---------|
| Required-field check with explicit 400 | `if (!email \|\| !password) return { statusCode: 400, body: ... }` |
| Regex field validation | `first_name` / `last_name`: `/^[A-Za-z\s\-']{2,50}$/`; `phone`: `/^\+?\d{10,15}$/`; `license_number`: `/^[A-Za-z0-9\-]{4,20}$/` |
| Range check | `hours ∈ [1, 12]`; `yearsExperience ∈ [0, 70]`; `rate (per_hour) ∈ [10, 300]`; `rate (percentage_of_revenue) ∈ [0, 100]`; `vacation_days ∈ [0, 50]` |
| Enum whitelist | `job_type ∈ {temporary, multi_day_consulting, permanent}`; `subgroup ∈ {ClinicAdmin, ClinicManager, ClinicViewer}`; `role ∈ VALID_ROLE_VALUES`; `accessLevel ∈ {ClinicAdmin, ClinicManager, ClinicViewer, Professional}` |
| Cross-field validation | `verifyPassword === password`; `salary_max > salary_min`; `dates.length === total_days`; unique `dates`; all `dates >= today` |
| Business-state guard | Cannot update `completed` jobs (409); cannot withdraw `accepted` applications (409); cannot activate `cancelled`/`expired` promotions (409); cannot double-respond to invitations |
| Whitelist update | `updateClinicProfileDetails` allows only 28 named fields; unknown keys rejected |
| Blocked-field list | `updateProfessionalProfile` blocks `userSub, createdAt, email, role`; `updateUser` blocks `phoneNumber, phone_number, username` |
| Length caps | Message content ≤ 1000; feedback message ≤ 5000; bio ≤ 500; `clicks` counter only on `status="active"` |
| String-array dedup | `skills/certificates/specializations` ≤ 50 items; empty arrays stored as REMOVE (avoiding empty-SS error) |

### 8.3 Standard response envelope

#### Success
```json
{
  "status": "success",
  "statusCode": 200,
  "message": "Operation completed",
  "data": { /* payload */ },
  "timestamp": "2026-04-24T12:00:00Z"
}
```

#### Error
```json
{
  "status": "error",
  "statusCode": 400,
  "message": "Human-readable description",
  "error": "Optional error code or further context",
  "timestamp": "2026-04-24T12:00:00Z"
}
```

### 8.4 Error-case catalog

#### 8.4.1 Validation error (400)
```json
{
  "status": "error",
  "statusCode": 400,
  "message": "Missing required fields: email, password",
  "missingFields": ["email", "password"]
}
```

#### 8.4.2 Authorization error (401)
```json
{
  "status": "error",
  "statusCode": 401,
  "message": "User not authenticated or token invalid"
}
```

#### 8.4.3 Forbidden (403)
```json
{
  "status": "error",
  "statusCode": 403,
  "message": "Only Root users can perform this action"
}
```

#### 8.4.4 Not found (404)
```json
{
  "status": "error",
  "statusCode": 404,
  "message": "Job posting not found"
}
```

#### 8.4.5 Conflict (409)
```json
{
  "status": "error",
  "statusCode": 409,
  "message": "Professional has already applied to this job"
}
```

#### 8.4.6 Rate limit (429)
```json
{
  "status": "error",
  "statusCode": 429,
  "message": "Too many login attempts. Please try again later."
}
```

#### 8.4.7 Internal server error (500)
```json
{
  "status": "error",
  "statusCode": 500,
  "message": "Internal server error: <cause>"
}
```

#### 8.4.8 Partial success (207) — multi-clinic creates
```json
{
  "status": "partial_success",
  "statusCode": 207,
  "message": "Created 2 of 3 job postings",
  "data": {
    "jobIds": ["uuid-1", "uuid-2"],
    "failed": [{ "clinicId": "f8a1...", "error": "User does not have manageJobs permission" }]
  }
}
```

### 8.5 Error-to-exception mapping (Cognito)

| Cognito exception | HTTP status | Handler response |
|-------------------|:-----------:|------------------|
| `NotAuthorizedException` | 401 | "Invalid email or password" (or portal mismatch 403) |
| `UserNotFoundException` | 404 | "User not found" |
| `UserNotConfirmedException` | 403 | "Please verify your email before logging in" |
| `UsernameExistsException` | 409 | "Email is already registered" |
| `CodeMismatchException` | 400 | "Invalid verification code" |
| `ExpiredCodeException` | 400 | "Verification code has expired" |
| `InvalidParameterException` | 400 | "Password does not meet policy requirements" |
| `LimitExceededException` | 429 | "Too many requests. Please try again later." |

---

## 9. Security & Authorization

### 9.1 Cognito usage

- **Issuer of trust**: Cognito User Pool `ClinicUserPoolV5` produces JWTs.
- **Token type used by handlers**: access token (carried in `Authorization: Bearer <token>`).
- **Claims consumed**: `sub`, `email`, `cognito:groups`, `custom:user_type`.
- **Group-based role model**: see §5.

### 9.2 IAM roles (provisioned by CDK)

#### 9.2.1 REST monolith Lambda role

| Service | Actions | Resource |
|---------|---------|----------|
| DynamoDB | `grantReadWriteData` | All 18 tables + their GSIs |
| DynamoDB | `dynamodb:Scan` | `DentiPal-JobPostings` (legacy-named) |
| Cognito | `SignUp`, `ConfirmSignUp`, `ResendConfirmationCode`, `AdminAddUserToGroup`, `AdminGetUser`, `AdminCreateUser`, `AdminSetUserPassword`, `AdminUpdateUserAttributes`, `AdminDeleteUser`, `DeleteUser`, `AdminRemoveUserFromGroup`, `ListUsers`, `AdminListGroupsForUser`, `AdminInitiateAuth`, `AdminRespondToAuthChallenge` | `userPool.userPoolArn` |
| SES | `SendEmail`, `SendRawEmail` | `*` |
| SNS | `Publish` | `*` |
| EventBridge | `PutEvents` | `*` |
| S3 | `grantReadWrite` | 7 bucket ARNs |
| Location | `SearchPlaceIndexForText`, `SearchPlaceIndexForPosition` | `DentiPalGeocoder` ARN |

#### 9.2.2 WebSocket Lambda role

| Service | Actions | Resource |
|---------|---------|----------|
| DynamoDB | `grantReadWriteData` | `Connections`, `Conversations`, `Messages`, `Clinics` |
| DynamoDB | `grantReadData` | `ProfessionalProfiles`, `ClinicProfiles`, `UserClinicAssignments` |
| S3 | `grantRead` | `ProfileImagesBucket`, `ClinicOfficeImagesBucket` |
| Cognito | `AdminGetUser` | `userPool.userPoolArn` |
| API Gateway Mgmt | `execute-api:ManageConnections` | `arn:aws:execute-api:*:*:*/*` |

#### 9.2.3 event-to-message Lambda role

Same as WebSocket except: only write access on chat tables, no S3 read.

### 9.3 API protection

- **API Gateway authorizer**: **NONE** (`authorizationType: NONE` on the proxy resource).
- **Actual enforcement**: each handler extracts & inspects the JWT via helpers in [lambda/src/handlers/utils.ts](lambda/src/handlers/utils.ts):
  - `extractUserFromBearerToken(authHeader)` — base64-decodes the JWT payload and returns `{ sub, userType, email?, groups[] }`.
  - `validateToken(event)` — throws if no `sub` claim.
  - `canAccessClinic(sub, groups, clinicId)` — GetItem on `Clinics`, checks `createdBy == sub OR contains(AssociatedUsers, sub)`.
  - `canWriteClinic(sub, groups, clinicId, action)` — above + `role !== "clinicviewer"`.
  - `listAccessibleClinicIds(sub, groups)` — Scan on `Clinics` with membership filter.
  - `getClinicRole(groups)` — returns highest-priority clinic role.
  - `isRoot(groups)` — case-insensitive `Root` group check.

### 9.4 Role-based access matrix

| Action space | Gate |
|--------------|------|
| Platform-only (create/update/delete `UserClinicAssignments`, delete any user) | `isRoot(groups)` |
| Clinic delete | `isRoot(groups)` |
| Clinic create | `root \|\| clinicadmin` |
| Mutating clinic data | `canWriteClinic(..., "manage*")` |
| Reading clinic data | `canAccessClinic(...)` |
| Multi-clinic dashboard | `listAccessibleClinicIds(...)` |
| Professional self-service (profile, applications, negotiations) | `sub == resource.owner` |
| Public browse (`/jobs/public`, `/professionals/public`, `/geocode/*`, promotion plans, click tracking, clinic address) | None |

### 9.5 WebSocket authorization

- `$connect` verifies the JWT signature via `aws-jwt-verify` (`CognitoJwtVerifier.create(...)`).
- Per-action authorization: clinic-side actions verify clinic membership via `UserClinicAssignments` (or fall back to `AssociatedUsers`); professional-side verifies `professionalSub == caller.sub`.
- API Gateway Mgmt API `GoneException` handling auto-removes stale connection rows.

### 9.6 Secrets / sensitive config

- `GOOGLE_CLIENT_SECRET` is stored as a plaintext env var in the stack — should be migrated to AWS Secrets Manager or SSM Parameter Store (`SecureString`).
- No database passwords (DynamoDB is IAM-authenticated).
- No long-lived AWS access keys used — all IAM is role-assumption.

### 9.7 CORS policy

| Origin | Allowed |
|--------|:-------:|
| `http://localhost:5173` (Vite dev) | ✅ |
| `https://main.d3agcvis750ojb.amplifyapp.com` (prod) | ✅ |
| Everything else | ❌ (falls back to default) |

Headers allowed: `Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token, X-Requested-With`.

Methods allowed: `OPTIONS, GET, POST, PUT, PATCH, DELETE`.

Credentials: `true` (supports cookies / auth headers cross-origin).

S3 buckets carry matching CORS rules for presigned POST/PUT uploads.

---

## 10. Special Backend Features

### 10.1 Three job types with shared schema

Single `JobPostings` table stores **temporary shifts, multi-day consulting projects, and permanent positions**. Differentiated by `job_type` attribute. Each type has its own validation:

- **Temporary** — single `date` (future), `hours ∈ [1, 12]`.
- **Multi-day consulting** — `dates[]` (unique, future, ≤30), `total_days` matches array length, `hours_per_day ∈ [1, 12]`.
- **Permanent** — `employment_type ∈ {full_time, part_time}`, `salary_min ≤ salary_max`, optional `benefits[]`, `vacation_days ∈ [0, 50]`.

Bulk creation across multiple clinics supports **partial success (HTTP 207)** — some clinics can succeed while others fail.

### 10.2 Multi-step negotiation flow

Applications start `pending` → if a `proposedRate` is included, they become `negotiating` and a `Negotiation` row is created. Clinics and professionals then exchange counter-offers via `respondToNegotiation`. Final acceptance transitions both Application and Negotiation to `scheduled`, and an EventBridge `ShiftEvent` fires.

### 10.3 Clinic-initiated invitations + applications hybrid

- `sendJobInvitations` lets a clinic bulk-invite up to 50 professionals.
- `respondToInvitation` lets the invitee accept / decline / counter — acceptance creates a `JobApplication` row; counter creates a `JobNegotiation` row.
- Unified flow: whether the professional applied first or was invited first, the final state converges on `JobApplication` + optional `JobNegotiation`.

### 10.4 Multi-view shift dashboards

Two handlers — `getAllClinicsShifts` and `getClinicShifts` — each serve **5 REST sub-paths** from a single Lambda handler by branching on `event.resource`:

| Sub-path | Returned dataset |
|----------|------------------|
| `open-shifts` | Job postings without any scheduled/completed applications |
| `action-needed` | Applications in `pending` or `negotiating` (require clinic action) |
| `scheduled-shifts` | Applications in `scheduled/accepted/booked` |
| `completed-shifts` | Applications in `completed/paid`; time-based auto-completion for past end-times |
| `invites-shifts` | Sent invitations that aren't yet accepted |

### 10.5 Time-based shift auto-completion

`getAllClinicsShifts` / `getClinicShifts` compare the **job's end-time + end-date** to `Date.now()` on read; if the shift is in the past, the UI treats it as `completed` regardless of DB state. A scheduled EventBridge cron (`aws.events` source short-circuit in `index.ts`) calls `updateCompletedShifts` nightly to persist this state and trigger referral bonuses.

Time-parsing handles: ISO datetimes, `HH:mm` 24-hour, `HH:mm AM/PM`, and for multi-day consulting uses the latest date in `dates[]`.

### 10.6 Referral program

- Signup flow: `initiateUserRegistration` accepts `referrerUserSub` and marks the referral `signed_up`.
- `sendReferralInvite` creates a pending referral row + sends a branded email.
- `updateCompletedShifts` (nightly cron): when a referred professional completes their first shift, adds `$50` (constant `BONUS_AMOUNT`) to the referrer's `bonusBalance` and flips the referral row to `bonus_due` (atomic conditional update).
- `BonusAwarding.ts` (DynamoDB Streams handler, external wiring) adds extra bonus points on every completed shift.

### 10.7 LinkedIn-style job promotion

- Three plan tiers (`basic`, `featured`, `premium`) with increasing price and duration.
- `createPromotion` → `pending_payment` → (external Stripe hook) → `activatePromotion` sets `active` + `expiresAt`.
- `findJobs` sorts promoted jobs first, weighted by `PROMOTION_TIER_WEIGHT = { premium: 3, featured: 2, basic: 1 }`; expired promotions are masked at read time.
- `trackPromotionClick` is a public endpoint that atomically increments `clicks` with a `status = "active"` condition (expired promos don't count).
- Impression counters fire-and-forget from the browse handlers.

### 10.8 Real-time chat with read-receipts and unread counts

- WebSocket-backed conversations with separate `clinicUnread` / `profUnread` counters.
- Read receipts pushed to the other party via `type: "readReceipt"` frames.
- Multi-tab sync — sender's other tabs receive the same `message` frame.
- Two-phase `getConversations` response: names/unread/online status first (fast); avatars (presigned S3 URLs) as a deferred `avatarsUpdate` frame.

### 10.9 Inbox system messages via EventBridge

State-changing REST handlers (`acceptProf`, `rejectProf`, `respondToInvitation`, `respondToNegotiation`, `updateCompletedShifts`) emit `ShiftEvent` events to EventBridge. A dedicated rule (`DentiPal-ShiftEvent-to-Inbox`) routes them to `event-to-message` Lambda, which generates a formatted system message into the conversation and pushes it over WebSocket. This decouples REST latency from messaging fanout.

### 10.10 Distance-aware job search

`getProfessionalFilteredJobs` supports:
- `?radius=<miles>` filter using Haversine distance between the caller's coords and each job's coords.
- Live geolocation (`?userLat=`, `?userLng=`) overrides the caller's stored profile coords.
- On-the-fly geocoding fallback in `findJobs` — clinics without coords get geocoded on-read and the result is fire-and-forget written back to `Clinics`.

### 10.11 Relevance scoring

`getProfessionalFilteredJobs` relevance score (`0–140` range, trending sort):

| Factor | Points |
|--------|-------:|
| Recency | 0–40 |
| Role match | 0–30 |
| Rate competitiveness | 0–20 |
| Completeness of posting | 0–10 |
| Within-radius distance | 0–10 |
| Applied-clinic familiarity | +15 |
| Popularity (`applicationsCount`) | 0–15 |

### 10.12 Multi-tenant clinic membership

Multi-tenancy is expressed via `Clinics.AssociatedUsers`. Every mutating handler gates on either:
- Membership (`canAccessClinic`) — user must be in `AssociatedUsers` or `createdBy`.
- Role-capability (`canWriteClinic`) — membership + role ≠ `clinicviewer`.

Users with memberships in multiple clinics see all of them in dashboard views; each write is scoped to a specific `clinicId`. The legacy `UserClinicAssignments` table is retained but not the source of truth.

### 10.13 Direct-from-browser S3 uploads

- `generatePresignedUrl` issues presigned POST policies with enforced `content-length-range` and `Content-Type` conditions.
- Per-file-type MIME/extension allowlists and min/max size bounds (5 KB – 100 MB).
- `updateFile` updates the profile row's `*Key` attribute after the direct S3 upload succeeds.
- Ownership metadata tag (`x-amz-meta-uploaded-by`) enforced on `getFileUrl` and `deleteFile`.

### 10.14 Role-specific onboarding questionnaires

`getProfessionalQuestions?role=<role>` returns a hardcoded schema of form fields per professional role, enabling a frontend form-builder to render role-appropriate onboarding (7 role templates covering associate-dentist, DA, hygienist, expanded-functions DA, dual-role FD/DA, patient-coordinator-front, treatment-coordinator-front).

### 10.15 Custom-auth flow for Google sign-in

Three Cognito Lambda triggers implement a password-less custom-auth flow:
1. Client presents a Google ID token.
2. Server-side validation against Google's `tokeninfo`.
3. Cognito `CUSTOM_AUTH` is initiated; the `CreateAuthChallenge` trigger sets the expected answer to `"google-verified"`.
4. `DefineAuthChallenge` issues tokens when the answer matches.
5. `VerifyAuthChallenge` compares the caller's `challengeAnswer`.

This avoids provisioning a Cognito password for Google users while preserving the Cognito-issued JWT chain of trust.

---

## 11. Architecture Insights

### 11.1 Service interaction map

```
Frontend (Vite / Amplify)
    │
    │  HTTPS + Cognito JWT                WSS + Cognito JWT (querystring)
    ▼                                     ▼
REST API Gateway (v1)                  WebSocket API Gateway (v2)
    │ /{proxy+}                          │ $connect / $disconnect / $default
    ▼                                     ▼
DentiPal-Backend-Monolith (Lambda)    DentiPal-Chat-WebSocket (Lambda)
    │                                     │
    ├── DynamoDB (18 tables) ◄────────────┤
    ├── Cognito User Pool ◄───────────────┤
    ├── S3 (7 buckets) ◄──────────────────┤
    ├── SES (emails)                      │
    ├── SNS (SMS)                         │
    ├── Amazon Location (geocoder)        │
    ├── EventBridge ─────►────────► DentiPal-event-to-message (Lambda)
    │                                     │
    │                                     ├── DynamoDB (chat tables)
    │                                     ├── API Gateway Mgmt (PostToConnection)
    │                                     └── Cognito AdminGetUser
    │
    └── Cognito Triggers:
           ├── DentiPal-PreSignUp
           ├── DentiPal-DefineAuthChallenge
           ├── DentiPal-CreateAuthChallenge
           └── DentiPal-VerifyAuthChallenge
```

### 11.2 Request life cycle (REST)

1. Browser sends `POST /jobs/temporary` with `Authorization: Bearer <access token>` and JSON body.
2. API Gateway accepts (no authorizer) and forwards to the monolith Lambda via proxy integration.
3. `lambda/src/index.ts` router:
   - Extracts `method + path`.
   - Generates candidate paths (with / without trailing slash, with / without `/prod` prefix).
   - Matches against the 170+-entry `routes` table using `matchesPattern()` for `{param}` wildcards.
4. Matched handler runs:
   - `setOriginFromEvent(event)` sets the correct CORS origin.
   - `extractUserFromBearerToken(event.headers.Authorization)` decodes the JWT.
   - `getClinicRole(groups)` / `canWriteClinic(sub, groups, clinicId, "manageJobs")` gate.
   - Business logic: Get/Put/Update DynamoDB, optional SES/SNS/EventBridge side effects.
5. Handler returns `{ statusCode, headers: CORS_HEADERS, body }`.
6. API Gateway wraps it in the HTTP response.

### 11.3 Request life cycle (WebSocket)

1. Browser opens `wss://<api>/prod?token=<accessToken>&clinicId=<id>`.
2. API Gateway triggers `$connect` → Lambda verifies JWT (`aws-jwt-verify`) and persists `{ userKey, connectionId }` in `Connections`.
3. Client sends `{ "action": "sendMessage", ... }` on the socket.
4. `$default` route → Lambda dispatches by `action`:
   - Authorization check (membership / self-ownership).
   - `Messages` PutItem, `Conversations` UpdateItem.
   - Reverse lookup on `Connections` (GSI `connectionId-index`) to find recipient sockets.
   - `ApiGatewayManagementApi.PostToConnection` fan-out.
5. Stale connections (HTTP 410) are cleaned up automatically.

### 11.4 Event-driven inbox flow

1. REST handler (e.g. `acceptProf`) writes DB state and calls `new EventBridgeClient().send(new PutEventsCommand(...))` with `Source: "denti-pal.api", DetailType: "ShiftEvent"`.
2. EventBridge rule `DentiPal-ShiftEvent-to-Inbox` matches and invokes `event-to-message`.
3. `event-to-message` formats a system message, creates / updates the `Conversations` row, writes to `Messages`, and pushes over WebSocket to both parties' active connections.

### 11.5 Data flow — creating a temporary job

```
Client
  │ POST /jobs/temporary { clinicIds, date, rate, ... }
  ▼
Router (index.ts)
  │
  ▼
createTemporaryJob.ts
  │ 1. extractUserFromBearerToken
  │ 2. group check: root | clinicadmin | clinicmanager
  │ 3. AdminGetUser for created_by name
  │
  │ for each clinicId (parallel):
  │   ┌─────────────────────────────────────────┐
  │   │ canWriteClinic(..., "manageJobs")        │
  │   │ GetItem Clinics (address)                │
  │   │ GetItem ClinicProfiles (practice info)   │
  │   │ Location.SearchPlaceIndexForText (geo)   │
  │   │ PutItem JobPostings (denormalized)       │
  │   └─────────────────────────────────────────┘
  │
  ▼
Response: 201 (all success) or 207 (partial)
```

### 11.6 Data flow — hiring a professional

```
acceptProf.ts (POST /jobs/{jobId}/hire)
  │ 1. Group check
  │ 2. GetItem JobApplications (jobId, professionalUserSub)
  │ 3. UpdateItem JobApplications (status → "scheduled")
  │ 4. Query JobPostings (jobId-index-1) for shift details
  │ 5. EventBridge PutEvents (ShiftEvent, eventType: "shift-scheduled")
  ▼
EventBridge Rule
  ▼
event-to-message.ts
  │ 1. AdminGetUser (professional display name)
  │ 2. PutItem Messages (system message)
  │ 3. UpdateItem Conversations (preview, lastMessageAt, unread)
  │ 4. Query Connections (both parties)
  │ 5. PostToConnection to every active connection
  ▼
Both parties' inboxes update in real-time
```

### 11.7 Scalability considerations

| Concern | Current design | Scale behavior |
|---------|----------------|----------------|
| REST cold starts | 1024 MB Lambda, Node 18, single asset bundle with 128 handlers imported eagerly | Baseline ~400–600 ms cold start; handlers tree-shaken poorly due to monolith imports |
| DynamoDB billing | `PAY_PER_REQUEST` on every table | No capacity provisioning; auto-scales; cost scales linearly with traffic |
| Scan hot-spots | `findJobs`, `getAllTemporaryJobs`, `getAllPermanentJobs`, `getAllMultiDayConsulting`, `getAllClinicsShifts` (aggregator), `loginUser` clinic lookup, `updateCompletedShifts` | Will throttle at high job counts; candidates for GSI introduction |
| WebSocket | 512 MB Lambda per connection event; `Connections` table key has per-user hot-partition risk at very high concurrency | Broadly horizontal; Cognito name cache (30 min LRU, 500 entries) and avatar cache (50 min) reduce repeat Cognito / S3 calls |
| API Gateway throttling | Default account limits (10,000 rps burst) | Well below for expected user base |
| S3 presigning | 15 min for uploads, 1–24 h for downloads | No scaling concerns |
| EventBridge | `PAY_PER_USE` | No capacity considerations |

### 11.8 Optimizations used

- **Monolithic Lambda** — amortizes cold starts across 128 handlers.
- **In-process name / avatar / access caches** in the WebSocket Lambda (LRU with TTL).
- **Fire-and-forget counters** — view/click/application increments don't block the response.
- **Parallelism with `Promise.all` / `Promise.allSettled`** — per-clinic job creation, per-user Cognito lookups.
- **BatchGetItem chunking** at 100 items (DynamoDB limit) in `getJobApplicationsForClinic`, `getJobApplicantsOfAClinic`, `getClinicFavorites`.
- **Two-phase `getConversations` response** — fast initial frame, deferred avatar frame.
- **Denormalization** — `JobPostings` embeds clinic metadata to avoid joins on read.
- **Process-level clinic coord cache** in `findJobs` — avoids re-geocoding the same clinic across a single invocation.

### 11.9 Weak spots (see also §23 in `DENTIPAL_CDK_ANALYSIS.md`)

- **JWT signatures not verified** — `extractAndDecodeAccessToken` only base64-decodes. `aws-jwt-verify` is in `package.json` but unused. Must fix before production hardening.
- **`GOOGLE_CLIENT_SECRET` plaintext in stack** — migrate to Secrets Manager.
- **Several `Scan`-based queries** — replace with GSIs at scale (notably `loginUser`, `getJobInvitationsForClinics`, `getActionNeeded` aggregate).
- **Orphaned `CertificatesBucket`** — no env var references it; handlers all point at `ProfessionalLicensesBucket`. Safe to remove from the stack.
- **Hardcoded dev URL** in `sendReferralInvite.ts` — signup URL uses `http://localhost:5173/...`.

---

## 12. Schemas Summary

### 12.1 Standardized API response envelope

**Success**:
```json
{
  "status": "success",
  "statusCode": 200,
  "message": "string (optional)",
  "data": { /* payload */ },
  "timestamp": "ISO8601"
}
```

**Error**:
```json
{
  "status": "error",
  "statusCode": 4xx | 5xx,
  "message": "string",
  "error": "string (optional, additional context)",
  "timestamp": "ISO8601"
}
```

### 12.2 Domain schemas (JSON)

#### 12.2.1 `Clinic`
```json
{
  "clinicId": "UUID",
  "name": "string",
  "addressLine1": "string",
  "addressLine2": "string | null",
  "addressLine3": "string | null",
  "city": "string",
  "state": "string",
  "pincode": "string",
  "createdBy": "userSub",
  "AssociatedUsers": ["userSub"],
  "lat": 30.2672,
  "lng": -97.7431,
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

#### 12.2.2 `ClinicProfile`
```json
{
  "clinicId": "UUID",
  "userSub": "userSub",
  "clinic_name": "string",
  "practice_type": "string",
  "primary_practice_area": "string",
  "primary_contact_first_name": "string",
  "primary_contact_last_name": "string",
  "assisted_hygiene_available": true,
  "number_of_operatories": 6,
  "num_hygienists": 2,
  "num_assistants": 3,
  "num_doctors": 2,
  "booking_out_period": "2_weeks",
  "clinic_software": "Dentrix",
  "software_used": ["Dentrix", "Eaglesoft"],
  "parking_type": "free_street",
  "parking_cost": 0,
  "free_parking_available": true,
  "addressLine1": "string",
  "city": "string", "state": "string", "zipCode": "string",
  "contact_email": "string",
  "contact_phone": "string",
  "special_requirements": ["string"],
  "office_image_key": "string",
  "notes": "string",
  "description": "string",
  "createdAt": "ISO8601", "updatedAt": "ISO8601"
}
```

#### 12.2.3 `ProfessionalProfile`
```json
{
  "userSub": "userSub",
  "role": "dental_hygienist",
  "first_name": "Jane",
  "last_name": "Doe",
  "specialties": ["General"],
  "specializations": ["Pediatric"],
  "yearsExperience": 5,
  "bio": "string",
  "qualifications": "string",
  "skills": ["string"],
  "certificates": ["string"],
  "professionalCertificates": ["string"],
  "license_number": "TX-1234",
  "phone": "+15555551234",
  "is_willing_to_travel": true,
  "max_travel_distance": 25,
  "dentalSoftwareExperience": ["Dentrix"],
  "profileImageKey": "s3-key",
  "professionalResumeKeys": ["s3-key"],
  "professionalLicenseKeys": ["s3-key"],
  "drivingLicenseKeys": ["s3-key"],
  "videoResumeKey": "s3-key",
  "bonusBalance": 100,
  "isDefault": false,
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

#### 12.2.4 `JobPosting` (temporary)
```json
{
  "clinicUserSub": "userSub",
  "jobId": "UUID",
  "clinicId": "UUID",
  "job_type": "temporary",
  "professional_role": "dental_hygienist",
  "professional_roles": ["dental_hygienist"],
  "shift_speciality": "general",
  "status": "active",
  "date": "2026-05-15",
  "hours": 8,
  "start_time": "08:00",
  "end_time": "16:00",
  "rate": 55,
  "pay_type": "per_hour",
  "meal_break": true,
  "assisted_hygiene": true,
  "work_location_type": "onsite",
  "job_title": "string",
  "job_description": "string",
  "requirements": ["string"],
  "addressLine1": "string", "city": "string", "state": "string", "pincode": "string",
  "lat": 30.2672, "lng": -97.7431,
  "clinic_name": "string",
  "isPromoted": false,
  "applicationsCount": 0,
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "created_by": "string"
}
```

#### 12.2.5 `JobPosting` (permanent)
```json
{
  "clinicUserSub": "userSub",
  "jobId": "UUID",
  "job_type": "permanent",
  "professional_role": "associate_dentist",
  "employment_type": "full_time",
  "salary_min": 120000,
  "salary_max": 180000,
  "benefits": ["health", "dental", "401k"],
  "vacation_days": 15,
  "work_schedule": "Mon–Fri 8:00–17:00",
  "start_date": "2026-06-01",
  "status": "active"
}
```

#### 12.2.6 `JobPosting` (multi-day consulting)
```json
{
  "job_type": "multi_day_consulting",
  "dates": ["2026-05-15", "2026-05-16", "2026-05-17"],
  "total_days": 3,
  "hours_per_day": 8,
  "start_time": "09:00",
  "end_time": "17:00",
  "rate": 120,
  "pay_type": "per_hour",
  "project_duration": "3-day endodontic coverage"
}
```

#### 12.2.7 `JobApplication`
```json
{
  "jobId": "UUID",
  "professionalUserSub": "userSub",
  "applicationId": "UUID",
  "clinicId": "UUID",
  "clinicUserSub": "userSub",
  "applicationStatus": "pending | negotiating | accepted | rejected | scheduled | completed | job_cancelled",
  "appliedAt": "ISO8601",
  "updatedAt": "ISO8601",
  "applicationMessage": "string",
  "proposedRate": 60,
  "acceptedRate": 58,
  "availability": "string",
  "startDate": "ISO8601",
  "notes": "string",
  "negotiationId": "UUID | null"
}
```

#### 12.2.8 `JobInvitation`
```json
{
  "jobId": "UUID",
  "professionalUserSub": "userSub",
  "invitationId": "UUID",
  "clinicId": "UUID",
  "clinicUserSub": "userSub",
  "invitationStatus": "sent | accepted | declined",
  "invitationMessage": "string",
  "urgency": "medium",
  "customNotes": "string",
  "sentAt": "ISO8601",
  "respondedAt": "ISO8601 | null",
  "response": "string | null"
}
```

#### 12.2.9 `JobNegotiation`
```json
{
  "applicationId": "UUID",
  "negotiationId": "UUID",
  "jobId": "UUID",
  "clinicId": "UUID",
  "professionalUserSub": "userSub",
  "negotiationStatus": "pending | accepted | declined | counter_offer",
  "proposedHourlyRate": 60,
  "clinicCounterRate": 58,
  "professionalCounterRate": 62,
  "agreedRate": null,
  "counterSalaryMin": null,
  "counterSalaryMax": null,
  "lastOfferPay": 62,
  "lastOfferFrom": "professional",
  "payType": "per_hour",
  "clinicMessage": "string",
  "professionalMessage": "string",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

#### 12.2.10 `Conversation`
```json
{
  "conversationId": "clinic#f8a1|prof#3e2a",
  "clinicKey": "clinic#f8a1",
  "profKey": "prof#3e2a",
  "clinicName": "Bright Smile Dental",
  "profName": "Jane Doe",
  "lastMessageAt": 1714000000000,
  "lastPreview": "See you Monday!",
  "clinicUnread": 0,
  "profUnread": 2,
  "participants": ["clinic#f8a1", "prof#3e2a"]
}
```

#### 12.2.11 `Message`
```json
{
  "conversationId": "clinic#f8a1|prof#3e2a",
  "messageId": "UUID",
  "senderKey": "prof#3e2a",
  "senderDisplay": "Jane Doe",
  "content": "Hi!",
  "timestamp": 1714000000000,
  "messageType": "text | system"
}
```

#### 12.2.12 `Referral`
```json
{
  "referralId": "UUID",
  "referrerUserSub": "userSub",
  "referrerName": "John Referrer",
  "referredUserSub": "userSub | null",
  "referredEmail": "friend@example.com",
  "referredName": "Friend Name",
  "status": "sent | signed_up | completed | bonus_due",
  "sentAt": "ISO8601",
  "acceptedAt": "ISO8601 | null",
  "referralBonus": 50,
  "bonusAwarded": false,
  "bonusAmount": 50
}
```

#### 12.2.13 `JobPromotion`
```json
{
  "jobId": "UUID",
  "promotionId": "UUID",
  "clinicUserSub": "userSub",
  "clinicId": "UUID",
  "planId": "premium",
  "status": "pending_payment | active | cancelled | expired",
  "impressions": 234,
  "clicks": 12,
  "applications": 3,
  "createdAt": "ISO8601",
  "activatedAt": "ISO8601 | 'PENDING'",
  "expiresAt": "ISO8601 | 'PENDING'",
  "cancelledAt": "ISO8601 | null"
}
```

#### 12.2.14 `UserAddress`
```json
{
  "userSub": "userSub",
  "addressLine1": "string",
  "addressLine2": "string",
  "city": "string",
  "state": "string",
  "pincode": "string",
  "country": "USA",
  "addressType": "home | work",
  "isDefault": true,
  "lat": 30.2672,
  "lng": -97.7431,
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

#### 12.2.15 `Connection` (WebSocket)
```json
{
  "userKey": "clinic#f8a1 | prof#3e2a",
  "connectionId": "AgE4K...=",
  "connectedAt": 1714000000000,
  "ttl": 1714086400,
  "userType": "Clinic | Professional",
  "display": "Jane Doe",
  "sub": "userSub",
  "email": "user@example.com"
}
```

### 12.3 Common request schemas

#### Login
```json
{ "email": "string", "password": "string", "userType": "clinic | professional" }
```

#### Create temporary job
```json
{
  "clinicIds": ["string"],
  "professional_role": "string (from VALID_ROLE_VALUES)",
  "shift_speciality": "string",
  "date": "YYYY-MM-DD (future)",
  "hours": 1,
  "start_time": "HH:mm",
  "end_time": "HH:mm",
  "rate": 1,
  "pay_type": "per_hour | per_transaction | percentage_of_revenue",
  "meal_break": true,
  "job_title": "string",
  "job_description": "string",
  "requirements": ["string"],
  "assisted_hygiene": false,
  "work_location_type": "onsite | us_remote | global_remote"
}
```

#### Apply for job
```json
{
  "jobId": "UUID",
  "message": "string",
  "proposedRate": 1,
  "availability": "string",
  "startDate": "ISO8601",
  "notes": "string"
}
```

#### Respond to invitation
```json
{
  "response": "accepted | declined | negotiating",
  "message": "string",
  "proposedHourlyRate": 1,
  "proposedSalaryMin": 1,
  "proposedSalaryMax": 1,
  "availabilityNotes": "string",
  "counterProposalMessage": "string"
}
```

#### Respond to negotiation
```json
{
  "response": "accepted | declined | counter_offer",
  "message": "string",
  "clinicCounterRate": 1,
  "professionalCounterRate": 1,
  "counterSalaryMin": 1,
  "counterSalaryMax": 1,
  "payType": "per_hour"
}
```

#### Generate presigned URL
```json
{
  "fileType": "profile-image | professional-resume | video-resume | professional-license | certificate | driving-license | clinic-office-image",
  "fileName": "string",
  "contentType": "mime/type",
  "fileSize": 1,
  "clinicId": "string (for clinic-office-image only)"
}
```

---

## 13. Summary Metrics

| Metric | Value |
|--------|------:|
| **Total Lambda handler files** | 128 |
| **Total Lambda functions provisioned by CDK** | 7 (monolith, websocket, event-to-message, 4 Cognito triggers) |
| **Total REST API endpoints** | 116 |
| **Total DynamoDB tables** | 18 |
| **Total DynamoDB GSIs** | 25 |
| **Total S3 buckets** | 7 |
| **Total Cognito groups** | 20 |
| **Total SES-integrated handlers** | 8 (3 custom HTML + 5 Cognito-managed) |
| **Total SNS-integrated handlers** | 1 (`verifyOTPAndCreateUser`) |
| **Total EventBridge producers** | 5 handlers (`acceptProf`, `rejectProf`, `respondToInvitation`, `respondToNegotiation`, `updateCompletedShifts`) |
| **Total EventBridge rules** | 1 (`DentiPal-ShiftEvent-to-Inbox`) |
| **Total Cognito Lambda triggers** | 4 |
| **Amazon Location Place Indexes** | 1 (`DentiPalGeocoder`, HERE) |
| **WebSocket API** | **Yes** — `DentiPalChatApi` at `wss://<id>.execute-api.<region>.amazonaws.com/prod` |
| **WebSocket routes** | 3 (`$connect`, `$disconnect`, `$default`) |
| **WebSocket actions** (dispatched inside `$default`) | 4 (`sendMessage`, `getHistory`, `markRead`, `getConversations`) |
| **Identity Pool** | Not used |
| **API Gateway authorizer** | None (enforced in-Lambda) |
| **REST API Gateway stage** | `prod` |
| **REST API tracing (X-Ray)** | Enabled |
| **REST API logging level** | INFO with data tracing |
| **Binary media types** | `multipart/form-data` |
| **CORS origins allowed** | `http://localhost:5173`, `https://main.d3agcvis750ojb.amplifyapp.com` |
| **Lambda memory — monolith** | 1024 MB |
| **Lambda memory — WebSocket** | 512 MB |
| **Lambda memory — event-to-message** | 256 MB |
| **Lambda memory — Cognito triggers** | 128 MB each |
| **Lambda timeout — monolith** | 60 s |
| **Lambda timeout — WebSocket** | 30 s |
| **DynamoDB billing mode** | PAY_PER_REQUEST (all tables) |
| **S3 encryption** | S3_MANAGED (all buckets) |
| **S3 public access** | BLOCK_ALL (all buckets) |
| **CDK stack name** | `DentiPalCDKStackV5` |
| **CDK runtime** | Node.js 18.x across all Lambdas |
| **Total handler source LOC** | ~32,700 |
| **CDK stack LOC (active code)** | ~900 (lines 655–1563) |
| **Total CDK project LOC** | ~1,563 (lib) + ~33,000 (lambda) = ~34,500 |

---

*End of documentation.*
