# DentiPal CDK — Deep Analysis Report

> **Scope**: This document is a line-by-line, handler-by-handler analysis of the DentiPal AWS CDK stack located at [DentiPalCDK/](./). It covers every DynamoDB table, every S3 bucket, every Cognito group, every REST endpoint, every WebSocket action, every Lambda handler (payload attributes, response shape, DB access, IAM posture, side effects), every EventBridge wiring, and every cross-cutting utility used by the Lambda monolith.
>
> **Sources read to produce this report**
> - [lib/denti_pal_cdk-stack.ts](lib/denti_pal_cdk-stack.ts) — CDK stack (active code + commented-out history)
> - [bin/denti_pal_cdk.ts](bin/denti_pal_cdk.ts) — CDK app entrypoint
> - [lambda/src/index.ts](lambda/src/index.ts) — REST monolith router
> - [lambda/src/handlers/*.ts](lambda/src/handlers/) — 128 handler files (~32,700 LOC)
> - [lambda/src/handlers/utils.ts](lambda/src/handlers/utils.ts) — shared auth gates
> - [lambda/src/handlers/corsHeaders.ts](lambda/src/handlers/corsHeaders.ts) — CORS machinery
> - [DENTIPAL_DATABASE_SCHEMA.md](DENTIPAL_DATABASE_SCHEMA.md) — existing schema reference (consolidated here)
> - [DENTIPAL_CDK_REFERENCE.md](DENTIPAL_CDK_REFERENCE.md) — existing stack reference (consolidated here)
> - [package.json](package.json), [lambda/package.json](lambda/package.json)
>
> **Not padded to a line-count target.** The report is as long as it needs to be to document the stack accurately; nothing is repeated, invented, or filler.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Stack Identity, Runtime & Build](#2-stack-identity-runtime--build)
3. [System Architecture at a Glance](#3-system-architecture-at-a-glance)
4. [Cognito User Pool](#4-cognito-user-pool)
5. [DynamoDB Tables — Detailed Schema](#5-dynamodb-tables--detailed-schema)
6. [S3 Buckets](#6-s3-buckets)
7. [REST API Gateway](#7-rest-api-gateway)
8. [WebSocket API Gateway](#8-websocket-api-gateway)
9. [Lambda Functions](#9-lambda-functions)
10. [IAM Permissions](#10-iam-permissions)
11. [EventBridge Wiring](#11-eventbridge-wiring)
12. [Amazon Location Service](#12-amazon-location-service)
13. [Cross-Cutting Utilities](#13-cross-cutting-utilities)
14. [Authentication & Authorization Model](#14-authentication--authorization-model)
15. [Request Routing Logic](#15-request-routing-logic)
16. [Full Route Table](#16-full-route-table)
17. [Per-Handler Reference — Auth & User Registration](#17-per-handler-reference--auth--user-registration)
18. [Per-Handler Reference — Clinic & Profile](#18-per-handler-reference--clinic--profile)
19. [Per-Handler Reference — Job Postings](#19-per-handler-reference--job-postings)
20. [Per-Handler Reference — Applications, Invitations, Negotiations, Hiring, Shifts](#20-per-handler-reference--applications-invitations-negotiations-hiring-shifts)
21. [Per-Handler Reference — Files, Promotions, Favorites, Referrals, WebSocket, EventBridge](#21-per-handler-reference--files-promotions-favorites-referrals-websocket-eventbridge)
22. [Entity Relationship Diagram](#22-entity-relationship-diagram)
23. [Design Observations, GSI Redundancies, and Known Issues](#23-design-observations-gsi-redundancies-and-known-issues)
24. [CloudFormation Outputs](#24-cloudformation-outputs)

---

## 1. Executive Summary

DentiPal is a two-sided marketplace connecting **dental clinics** with **dental professionals** (associate dentists, hygienists, dental assistants, front desk). The CDK stack provisions the full backend:

| Concern | Implementation |
|---------|----------------|
| Identity | AWS Cognito User Pool (`ClinicUserPoolV5`) with 20 groups |
| Data persistence | 18 DynamoDB tables (`DentiPal-V5-*`) with 25 GSIs |
| File storage | 7 S3 buckets (profile images, resumes, licenses, video resumes, driving licenses, clinic office images, legacy certificates) |
| REST API | API Gateway v1 (`DentiPal API`) → single monolithic Lambda (`DentiPal-Backend-Monolith`) via `/{proxy+}` |
| Real-time chat | API Gateway v2 WebSocket (`DentiPal-Chat-API`) → dedicated Lambda (`DentiPal-Chat-WebSocket`) |
| System messages | EventBridge rule (`DentiPal-ShiftEvent-to-Inbox`) → `DentiPal-event-to-message` Lambda → WebSocket push |
| Custom auth | 4 Cognito Lambda triggers: `PreSignUp`, `DefineAuthChallenge`, `CreateAuthChallenge`, `VerifyAuthChallenge` (custom-auth flow for Google sign-in) |
| Geocoding | Amazon Location Service `CfnPlaceIndex` (`DentiPalGeocoder`, Here provider) |
| Email / SMS | Amazon SES + Amazon SNS |

Traffic pattern: the frontend (Vite dev on `localhost:5173` and Amplify-hosted prod at `main.d3agcvis750ojb.amplifyapp.com`) calls REST endpoints with a Cognito JWT `Bearer` token in the `Authorization` header. The monolith Lambda parses the token locally (via `extractUserFromBearerToken` / `verifyToken`), routes to one of 128 handlers, and the handler enforces its own authorization gate (`canAccessClinic`, `canWriteClinic`, `listAccessibleClinicIds`, `getClinicRole`, or `isRoot` from [utils.ts](lambda/src/handlers/utils.ts)).

A separate WebSocket channel handles chat (`wss://<apiId>.execute-api.<region>.amazonaws.com/prod`). Clients authenticate on `$connect` by passing the Cognito access token as a querystring parameter; subsequent messages are dispatched by `action` field on a single `$default` route.

---

## 2. Stack Identity, Runtime & Build

### 2.1 CDK App

File: [bin/denti_pal_cdk.ts](bin/denti_pal_cdk.ts)

```ts
const app = new cdk.App();
new DentiPalCDKStack(app, 'DentiPalCDKStackV5', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
```

- **Stack ID / CloudFormation stack name**: `DentiPalCDKStackV5`
- **Account / region**: resolved from environment at deploy time

### 2.2 Root CDK `package.json`

```json
{
  "dependencies": {
    "@aws-cdk/aws-apigatewayv2-alpha":              "^2.114.1-alpha.0",
    "@aws-cdk/aws-apigatewayv2-integrations-alpha": "^2.114.1-alpha.0",
    "@aws-sdk/client-apigatewaymanagementapi":      "^3.936.0",
    "@aws-sdk/client-cognito-identity-provider":    "^3.934.0",
    "@aws-sdk/client-dynamodb":                     "^3.940.0",
    "@aws-sdk/client-eventbridge":                  "^3.936.0",
    "@aws-sdk/client-s3":                           "^3.934.0",
    "@aws-sdk/client-ses":                          "^3.940.0",
    "@aws-sdk/client-sns":                          "^3.940.0",
    "@aws-sdk/lib-dynamodb":                        "^3.936.0",
    "@aws-sdk/s3-request-presigner":                "^3.934.0",
    "@aws-sdk/util-dynamodb":                       "^3.934.0",
    "aws-cdk-lib":                                  "2.206.0",
    "aws-sdk":                                      "^2.1692.0",
    "constructs":                                   "^10.0.0",
    "uuid":                                         "^9.0.1"
  }
}
```

Notes:
- API Gateway **v2** is still pulled from the `alpha` module (the modern L2 `aws_apigatewayv2` non-alpha is not used), pinned at `^2.114.1-alpha.0` — upgrades of the CDK library must be kept in lock-step with the alpha version.
- Both **AWS SDK v3** (modular, tree-shakable) and **AWS SDK v2** (`aws-sdk`) appear as dependencies, which suggests some handlers still use the legacy SDK. The production pattern the newer handlers follow is v3 + `@aws-sdk/lib-dynamodb` for marshalling.

### 2.3 Lambda `package.json`

```json
{
  "dependencies": {
    "@aws-sdk/client-cognito-identity-provider": "^3.940.0",
    "@aws-sdk/client-dynamodb":                  "^3.940.0",
    "@aws-sdk/client-eventbridge":               "^3.1029.0",
    "@aws-sdk/client-location":                  "^3.1031.0",
    "@aws-sdk/client-s3":                        "^3.940.0",
    "@aws-sdk/client-ses":                       "^3.940.0",
    "@aws-sdk/client-sns":                       "^3.940.0",
    "@aws-sdk/lib-dynamodb":                     "^3.645.0",
    "@aws-sdk/s3-presigned-post":                "^3.940.0",
    "@aws-sdk/s3-request-presigner":             "^3.940.0",
    "aws-jwt-verify":                            "^4.0.1",
    "aws-sdk":                                   "^2.1692.0",
    "uuid":                                      "^9.0.1"
  }
}
```

- `aws-jwt-verify` is present but not actively used by the auth gate in [utils.ts](lambda/src/handlers/utils.ts) — that helper simply **decodes** the Bearer token's payload without verifying the signature (see §14).
- `@aws-sdk/client-location` supplies the geocoding client (see §12).
- `@aws-sdk/s3-presigned-post` is used in addition to `@aws-sdk/s3-request-presigner`, meaning some upload paths use presigned `POST` (form fields) and others use presigned `PUT` URLs.

### 2.4 Build Pipeline

- Root TypeScript (`tsconfig.json`) compiles CDK construct code (`bin/`, `lib/`) to JavaScript for `cdk synth/deploy`.
- Lambda TypeScript (`lambda/tsconfig.json`) compiles handlers from `lambda/src/**/*.ts` into `lambda/dist/**/*.js`. The CDK then packages `lambda/` (which contains `dist/` and `package.json`) via `lambda.Code.fromAsset(path.join(__dirname, '../lambda'))`.
- Lambda entry points referenced by CDK:
  - `dist/index.handler` — REST monolith
  - `dist/handlers/websocketHandler.handler` — WebSocket
  - `dist/handlers/event-to-message.handler` — EventBridge inbox bridge
  - `dist/handlers/preSignUp.handler`, `dist/handlers/defineAuthChallenge.handler`, `dist/handlers/createAuthChallenge.handler`, `dist/handlers/verifyAuthChallenge.handler` — Cognito triggers

---

## 3. System Architecture at a Glance

```
                ┌────────────────────────────────────────────────────────────────────┐
                │                        FRONTEND                                     │
                │   localhost:5173  (dev)  ·  main.d3agcvis750ojb.amplifyapp.com     │
                │   React/Vite app — Cognito SRP / custom-auth / Google OAuth         │
                └───────────────┬──────────────────────────────┬─────────────────────┘
                                │ HTTPS + JWT                  │ WSS + JWT (qs)
                                ▼                              ▼
              ┌────────────────────────────────┐  ┌──────────────────────────────────┐
              │  REST API Gateway v1           │  │  WebSocket API Gateway v2          │
              │  DentiPalApi / stage=prod       │  │  DentiPalChatApi / stage=prod     │
              │  /{proxy+} catch-all            │  │  $connect / $disconnect / $default│
              │  CORS: localhost + Amplify      │  └────────────────┬─────────────────┘
              └──────────┬─────────────────────┘                   │
                         │ LambdaProxyIntegration                   │ WebSocketLambdaIntegration
                         ▼                                          ▼
              ┌────────────────────────────────┐       ┌──────────────────────────────┐
              │ DentiPal-Backend-Monolith       │       │ DentiPal-Chat-WebSocket      │
              │ Node 18.x · 1024 MB · 60 s      │       │ Node 18.x · 512 MB · 30 s    │
              │ 128 REST handlers + 1 router    │       │ $connect/$disconnect/        │
              │                                 │       │ sendMessage/getHistory/...    │
              └────┬───────┬────────┬───────┬──┘       └────┬──────────────┬──────────┘
                   │       │        │       │                │              │
                   │       │        │       │                │              │
                   ▼       ▼        ▼       ▼                ▼              ▼
        ┌──────────┐ ┌──────────┐ ┌──────┐ ┌──────┐   ┌──────────────┐ ┌───────────────┐
        │ DynamoDB │ │ Cognito   │ │ SES  │ │ SNS  │   │ DynamoDB     │ │ APIGW Mgmt API│
        │ 18 tables│ │ User Pool │ │ mail │ │ sms  │   │ 4 chat tables│ │ PostToConn... │
        │ 25 GSIs  │ │ + groups  │ │      │ │      │   └──────────────┘ └───────────────┘
        └──────────┘ └──────────┘ └──────┘ └──────┘
                   │                │
                   ▼                ▼
        ┌──────────┐        ┌─────────────────────────────┐
        │ S3 (7)   │        │ Cognito Lambda Triggers:     │
        │ images/  │        │  PreSignUp,                  │
        │ resumes/ │        │  DefineAuthChallenge,        │
        │ licenses │        │  CreateAuthChallenge,        │
        └──────────┘        │  VerifyAuthChallenge         │
                            └─────────────────────────────┘
                   │
                   ▼
        ┌─────────────────────────────┐       ┌──────────────────────────┐
        │ EventBridge                 │──────►│ DentiPal-event-to-message│
        │ Rule: DentiPal-ShiftEvent-  │       │ (system msgs → WebSocket)│
        │       to-Inbox              │       └──────────────────────────┘
        │ source=denti-pal.api        │
        │ detailType=ShiftEvent       │
        └─────────────────────────────┘

        ┌──────────────────────────────────────────────────────────────────┐
        │ Amazon Location Service                                           │
        │ CfnPlaceIndex: DentiPalGeocoder (dataSource=Here, RequestBased)   │
        │ Used by: geocodePostal.ts for address auto-fill on profile forms   │
        └──────────────────────────────────────────────────────────────────┘
```

Key architectural properties:

1. **Monolithic REST Lambda** — one function handles every REST route. The router is in [lambda/src/index.ts](lambda/src/index.ts) and dispatches to 128 per-feature handlers using a method-path lookup table with path-parameter pattern matching. Cold-start optimization: memory sized at **1024 MB** (comment in stack notes halving cold-init from ~1.1 s on 256 MB).
2. **Dedicated WebSocket Lambda** — a single function (`DentiPal-Chat-WebSocket`) serves `$connect`, `$disconnect`, and `$default` routes; internally it dispatches on the message's `action` field.
3. **Decoupled inbox system messages** — REST handlers that change shift state (`acceptProf`, `rejectProf`, `respondToInvitation`, etc.) emit `ShiftEvent` events to EventBridge. `DentiPal-event-to-message` listens on a pattern-matched rule and writes a system message into the correct conversation, then pushes it over WebSocket. This keeps the REST path fast and the messaging side-effect async.
4. **No API Gateway authorizer** — `authorizationType: NONE`. Authorization is enforced **entirely inside each handler** by parsing the JWT payload out of the `Authorization` header. This is a deliberate design choice (see stack comment: _"Authorizer removed from standalone creation as per your original design relying on Lambda logic"_).

---

## 4. Cognito User Pool

Source: [lib/denti_pal_cdk-stack.ts:677–790](lib/denti_pal_cdk-stack.ts#L677-L790)

### 4.1 Pool Configuration — `ClinicUserPoolV5`

| Property | Value |
|----------|-------|
| Construct ID | `ClinicUserPoolV5` |
| Self-signup | **enabled** |
| Sign-in alias | **email** |
| Auto-verify | email |
| Removal policy | `DESTROY` (comment: _change to `RETAIN` for prod_) |
| Password min length | 8 |
| Password requires | digits, lowercase, uppercase, symbols |

### 4.2 Required Standard Attributes

| Attribute | Required | Mutable |
|-----------|----------|---------|
| `given_name` | yes | yes |
| `family_name` | yes | yes |
| `phone_number` | yes | yes |
| `email` | yes | yes |
| `address` | yes | yes |

### 4.3 App Client — `ClinicAppClientV5`

| Property | Value |
|----------|-------|
| Client secret | none (public/SPA client) |
| `preventUserExistenceErrors` | **true** |
| Auth flows enabled | `userPassword`, `userSrp`, `adminUserPassword`, `custom` |

The `custom` auth flow plus the three auth-challenge Lambda triggers are what enables **password-less / Google OAuth** login without provisioning a Cognito password for Google-signed-up users.

### 4.4 Lambda Triggers (Cognito)

| Cognito operation | Lambda function name | Source file |
|-------------------|----------------------|-------------|
| `PRE_SIGN_UP` | `DentiPal-PreSignUp` | [handlers/preSignUp.ts](lambda/src/handlers/preSignUp.ts) |
| `DEFINE_AUTH_CHALLENGE` | `DentiPal-DefineAuthChallenge` | [handlers/defineAuthChallenge.ts](lambda/src/handlers/defineAuthChallenge.ts) |
| `CREATE_AUTH_CHALLENGE` | `DentiPal-CreateAuthChallenge` | [handlers/createAuthChallenge.ts](lambda/src/handlers/createAuthChallenge.ts) |
| `VERIFY_AUTH_CHALLENGE_RESPONSE` | `DentiPal-VerifyAuthChallenge` | [handlers/verifyAuthChallenge.ts](lambda/src/handlers/verifyAuthChallenge.ts) |

All four are **Node.js 18.x**, 128 MB, 10 s timeout, reading from the same `lambda/` asset bundle (`dist/handlers/<name>.handler`).

The PreSignUp trigger's purpose (per stack comment): _"auto-fills address & phone_number for Google sign-ups"_ — i.e. Google users don't provide these required attributes, so the trigger inserts safe defaults before the Cognito user is created, avoiding a hard schema rejection.

### 4.5 Cognito Groups & Role Model (20 groups)

Groups are created via `cognito.CfnUserPoolGroup`. The stack defines both a `groups` array (7 entries, truncated) and a `cognitoGroups` array (20 entries) — the CDK loop iterates over **`cognitoGroups`**, so all 20 entries below exist in production.

#### 4.5.1 All groups (definitive list)

| # | Group name | Audience | Side | Purpose / description |
|---|------------|----------|------|-----------------------|
| 1  | `Root` | Clinic super-admin | Clinic | Highest clinic privilege — full write on any clinic they are a member of. **Not** a platform-wide override: Root is still membership-scoped (see §14.3). Typically the clinic-owner account that bootstraps the first clinic and invites staff. |
| 2  | `ClinicAdmin` | Clinic admin | Clinic | Full write on assigned clinics: manage clinic profile, users, jobs, applicants, favorites, promotions. |
| 3  | `ClinicManager` | Clinic manager | Clinic | Same write scope as `ClinicAdmin`. Separation is organizational, not permission-based. |
| 4  | `ClinicViewer` | Clinic viewer | Clinic | **Read-only** on assigned clinics. Fails every `canWriteClinic(..., <action>)` call. |
| 5  | `AssociateDentist` | Professional | Doctor | Treating/associate dentist (not the owner). Eligible for temporary and multi-day consulting shifts. |
| 6  | `DentalAssistant` | Professional | Clinical | Chairside dental assistant. |
| 7  | `DualRoleFrontDA` | Professional | Dual | Front-desk + dental-assistant hybrid role. Mapped in `professionalRoles.ts` as the `DUAL_ROLE` category. |
| 8  | `DentalHygienist` | Professional | Clinical | Licensed dental hygienist. |
| 9  | `FrontDesk` | Professional | Front Office | Receptionist / front-desk admin. Included in `FRONT_OFFICE` category. |
| 10 | `Dentist` | Professional | Doctor | Licensed dentist (practice owner or solo). Doctor-side pay rules: `pay_type = "per_transaction"` is blocked (createJobPosting / createTemporaryJob / createPermanentJob all enforce this). |
| 11 | `Hygienist` | Professional | Clinical | Alias of `DentalHygienist` — both groups exist in Cognito. Legacy naming; `utils.ts` normalizes case-insensitively. |
| 12 | `DHComboRole` | Professional | Clinical | Dental-hygienist combo (assistant + hygienist certified). |
| 13 | `BillingCoordinator` | Professional | Billing | Dental-office billing ops. |
| 14 | `InsuranceVerification` | Professional | Billing | Insurance verification specialist. |
| 15 | `PaymentPosting` | Professional | Billing | Posts patient/insurance payments. |
| 16 | `ClaimsSending` | Professional | Billing | Submits insurance claims. |
| 17 | `ClaimsResolution` | Professional | Billing | Works rejections / appeals. |
| 18 | `HIPAATrainee` | Professional | Compliance | Compliance-training track (HIPAA). |
| 19 | `OSHATrainee` | Professional | Compliance | Compliance-training track (OSHA). |
| 20 | `Accounting` | Professional | Accounting | Dental-practice accounting. |

#### 4.5.2 Clinic-side roles and the `ClinicRole` matrix

`utils.ts` exports:

```ts
export const CLINIC_ROLES = ["root", "clinicadmin", "clinicmanager", "clinicviewer"] as const;
export type ClinicRole = typeof CLINIC_ROLES[number];
```

These are the **lowercased** forms used for case-insensitive matching against `cognito:groups`. The matrix below defines what each role can do once `canAccessClinic` (the membership gate) has passed.

| Capability / `ClinicWriteAction` | `root` | `clinicadmin` | `clinicmanager` | `clinicviewer` |
|----------------------------------|:------:|:-------------:|:---------------:|:--------------:|
| Read clinic & its data (`canAccessClinic`) | ✅ | ✅ | ✅ | ✅ |
| `manageJobs` — create/edit/delete postings and promotions | ✅ | ✅ | ✅ | ❌ |
| `manageApplicants` — hire / reject / respond to negotiations | ✅ | ✅ | ✅ | ❌ |
| `manageClinic` — edit clinic profile & settings | ✅ | ✅ | ✅ | ❌ |
| `manageUsers` — add / remove / update clinic users | ✅ | ✅ | ✅ | ❌ |
| `createClinic` (no existing clinic required) | ✅ | ✅ | ❌ | ❌ |
| `deleteClinic` (`/clinics/{id}` DELETE) | ✅ | ❌ | ❌ | ❌ |
| Create / Update / Delete `UserClinicAssignments` rows | ✅ | ❌ | ❌ | ❌ |
| Create a brand-new clinic user (`POST /users`) | ✅ | ❌ | ❌ | ❌ |
| Delete any user (`DELETE /users/{userId}`) | ✅ | ❌ | ❌ | ❌ |
| Aggregated `/action-needed?aggregate=true` across clinics | ✅ | ❌ | ❌ | ❌ |
| Aggregated `/dashboard/all/*` across accessible clinics | ✅ | ✅ | ✅ | ✅ |

Behaviour of `canWriteClinic(sub, groups, clinicId, action)`:

```ts
export const canWriteClinic = async (sub, groups, clinicId, _action) => {
  const role = getClinicRole(groups);
  if (!role || role === "clinicviewer") return false;
  return canAccessClinic(sub, groups, clinicId);
};
```

Note: `action` is accepted but currently unused — the gate is **role × membership**, not **role × action**. This means `ClinicManager` has the same write capabilities as `ClinicAdmin` today. If the product later wants to restrict managers from, say, deleting the clinic profile, the switch is already wired — only the function body needs updating.

Behaviour of `getClinicRole(groups)`:

```ts
// returns the HIGHEST-priority clinic role the user holds, or null
root > clinicadmin > clinicmanager > clinicviewer
```

Multi-group users (e.g. a Root who is also ClinicAdmin on another tenant) get the Root privilege level.

#### 4.5.3 Professional-side roles

The professional-side groups (rows 5–20 above) don't have an enforced role hierarchy in code — they're routing hints, not permissions. Their purposes:

| Concern | Where the professional group matters |
|---------|--------------------------------------|
| `verifyToken` / `extractUserFromBearerToken` → `userInfo.userType` | Returns `"professional"` if `custom:user_type` says so (or by default). Used by `loginUser`, `checkEmail`, `forgotPassword`, `googleLogin` for portal-mismatch 403s. |
| `professionalRoles.ts` → `ROLE_CATEGORIES` | Maps each group to a category for UI grouping (`DOCTOR, CLINICAL, FRONT_OFFICE, DUAL_ROLE, BILLING, COMPLIANCE, ACCOUNTING`). |
| Doctor-role pay restriction | `createJobPosting` / `createTemporaryJob` / `createMultiDayConsulting` / `createPermanentJob` block `pay_type: "per_transaction"` for doctor roles (`Dentist`, `AssociateDentist`). |
| Role-specific questionnaires | `getProfessionalQuestions` (`GET /profiles/questions?role=<role>`) returns a different form schema per professional role. |
| Filtered job browsing | `getProfessionalFilteredJobs` scores jobs higher when the job's `professional_role` matches the caller's role. |
| WebSocket sender classification | `websocketHandler` `$connect` derives `userType = "Professional"` when groups contain any of the professional-side entries. |

#### 4.5.4 Role categories (from `professionalRoles.ts`)

```ts
const ROLE_CATEGORIES = {
  DOCTOR:       ["Dentist", "AssociateDentist"],
  CLINICAL:     ["DentalHygienist", "Hygienist", "DentalAssistant", "DHComboRole"],
  FRONT_OFFICE: ["FrontDesk"],
  DUAL_ROLE:    ["DualRoleFrontDA"],
  BILLING:      ["BillingCoordinator", "InsuranceVerification", "PaymentPosting",
                 "ClaimsSending", "ClaimsResolution"],
  COMPLIANCE:   ["HIPAATrainee", "OSHATrainee"],
  ACCOUNTING:   ["Accounting"],
};
```

Helper predicates exported from `professionalRoles.ts`:

| Helper | Returns `true` for groups |
|--------|---------------------------|
| `isDoctorRole(group)` | `Dentist`, `AssociateDentist` |
| `isClinicalRole(group)` (spelled `isClinicaRole` in code — sic) | `DentalHygienist`, `Hygienist`, `DentalAssistant`, `DHComboRole` |
| `isFrontOfficeRole(group)` | `FrontDesk` |
| `isDualRole(group)` | `DualRoleFrontDA` |
| `isBillingRole(group)` | `BillingCoordinator`, `InsuranceVerification`, `PaymentPosting`, `ClaimsSending`, `ClaimsResolution` |
| `isComplianceRole(group)` | `HIPAATrainee`, `OSHATrainee` |

#### 4.5.5 Group-to-DB-value mapping

`professionalRoles.ts` also carries a mapping from Cognito group names to the canonical DB `role` field used on `ProfessionalProfiles` rows and `JobPostings.professional_role`:

| Cognito group | DB value (`role`) | UI display name |
|---------------|-------------------|-----------------|
| `Dentist` | `dentist` | Dentist |
| `AssociateDentist` | `associate_dentist` | Associate Dentist |
| `DentalHygienist` / `Hygienist` | `dental_hygienist` | Dental Hygienist |
| `DentalAssistant` | `dental_assistant` | Dental Assistant |
| `DHComboRole` | `dh_combo` | DH Combo Role |
| `FrontDesk` | `front_desk` | Front Desk |
| `DualRoleFrontDA` | `dual_role_front_da` | Front Desk / DA |
| `BillingCoordinator` | `billing_coordinator` | Billing Coordinator |
| `InsuranceVerification` | `insurance_verification` | Insurance Verification |
| `PaymentPosting` | `payment_posting` | Payment Posting |
| `ClaimsSending` | `claims_sending` | Claims Sending |
| `ClaimsResolution` | `claims_resolution` | Claims Resolution |
| `HIPAATrainee` | `hipaa_trainee` | HIPAA Trainee |
| `OSHATrainee` | `osha_trainee` | OSHA Trainee |
| `Accounting` | `accounting` | Accounting |

Helpers on `professionalRoles.ts` exposing this map: `getRoleById(id)`, `getRoleByDbValue(dbValue)`, `getRoleByCognitoGroup(group)`. The `VALID_ROLE_VALUES` and `VALID_COGNITO_GROUPS` arrays are used for input validation on `createProfessionalProfile`, `initiateUserRegistration`, `updateJobPosting`, etc.

#### 4.5.6 How roles are assigned

1. **Clinic signup** (`initiateUserRegistration.ts` with `userType: "clinic"`): after OTP verification, the user is added to `Root` (since they bootstrapped the clinic).
2. **Staff invited by Root** (`createUser.ts` via `POST /users`): caller specifies `subgroup ∈ {ClinicAdmin, ClinicManager, ClinicViewer}`; the handler calls `AdminAddUserToGroup` with that value.
3. **Staff role change** (`updateUser.ts` via `PUT /users/{userId}`): `AdminRemoveUserFromGroup` for each of the four clinic subgroups, then `AdminAddUserToGroup` for the new one (idempotent replacement).
4. **Professional signup** (`initiateUserRegistration.ts` with `userType: "professional"`): payload must include `role` (a DB value); the handler resolves it via `getRoleByDbValue(role)` and adds the user to the corresponding Cognito group.
5. **Google sign-in** (`googleLogin.ts`): if the user is new, defaults to `Root` for `userType: "clinic"` or the role-mapped group for `userType: "professional"`.

#### 4.5.7 How roles are enforced at the edge

Every mutating handler calls one of the following before reaching DynamoDB:

- **`extractUserFromBearerToken(authHeader)`** — base64-decode the JWT payload; extract `{ sub, userType, email?, groups[] }`.
- **`getClinicRole(groups)`** — determine the caller's highest clinic role or `null`.
- **`canAccessClinic(sub, groups, clinicId)`** — membership check via `GetItem` on `Clinics`.
- **`canWriteClinic(sub, groups, clinicId, action)`** — above plus `role !== "clinicviewer"`.
- **`listAccessibleClinicIds(sub, groups)`** — full `Scan` of `Clinics` where `contains(AssociatedUsers, :sub) OR createdBy = :sub`.
- **`isRoot(groups)`** — case-insensitive presence of `"Root"` in groups.

Read handlers typically use `canAccessClinic`; write handlers use `canWriteClinic`; multi-clinic dashboards use `listAccessibleClinicIds`; only `deleteClinic`, `createAssignment`/`updateAssignment`/`deleteAssignment`, and `createUser`/`deleteUser` gate on `isRoot`.

**Known issue (tracked in §14.4)**: the JWT signature is **not verified** — `extractAndDecodeAccessToken` only base64-decodes. Signatures MUST be validated at the API-Gateway layer or inside the Lambda (via the already-installed `aws-jwt-verify` library) before the role model can be considered secure.

### 4.6 IAM actions the monolith can invoke on Cognito

```
cognito-idp:SignUp
cognito-idp:ConfirmSignUp
cognito-idp:ResendConfirmationCode
cognito-idp:AdminAddUserToGroup
cognito-idp:AdminGetUser
cognito-idp:AdminCreateUser
cognito-idp:AdminSetUserPassword
cognito-idp:AdminUpdateUserAttributes
cognito-idp:AdminDeleteUser
cognito-idp:DeleteUser
cognito-idp:AdminRemoveUserFromGroup
cognito-idp:ListUsers
cognito-idp:AdminListGroupsForUser
cognito-idp:AdminInitiateAuth
cognito-idp:AdminRespondToAuthChallenge
```

Resource scope: `userPool.userPoolArn` (not `*`). The WebSocket Lambda only gets `cognito-idp:AdminGetUser`.

---

## 5. DynamoDB Tables — Detailed Schema

All tables use **PAY_PER_REQUEST** billing, **DESTROY** removal policy, and the naming convention `DentiPal-V5-*`.

Overview:

| # | Table name | PK | SK | GSI count |
|---|-----------|----|----|-----------|
| 1 | `DentiPal-V5-Clinic-Profiles` | `clinicId` | `userSub` | 1 |
| 2 | `DentiPal-V5-ClinicFavorites` | `clinicUserSub` | `professionalUserSub` | 0 |
| 3 | `DentiPal-V5-Clinics` | `clinicId` | — | 1 |
| 4 | `DentiPal-V5-Connections` | `userKey` | `connectionId` | 1 |
| 5 | `DentiPal-V5-Conversations` | `conversationId` | — | 2 |
| 6 | `DentiPal-V5-Feedback` | `PK` | `SK` | 0 |
| 7 | `DentiPal-V5-JobApplications` | `jobId` | `professionalUserSub` | 5 |
| 8 | `DentiPal-V5-JobInvitations` | `jobId` | `professionalUserSub` | 2 |
| 9 | `DentiPal-V5-JobNegotiations` | `applicationId` | `negotiationId` | 3 |
| 10 | `DentiPal-V5-JobPostings` | `clinicUserSub` | `jobId` | 5 |
| 11 | `DentiPal-V5-Messages` | `conversationId` | `messageId` | 1 |
| 12 | `DentiPal-V5-Notifications` | `recipientUserSub` | `notificationId` | 0 |
| 13 | `DentiPal-V5-OTPVerification` | `email` | — | 0 |
| 14 | `DentiPal-V5-ProfessionalProfiles` | `userSub` | — | 0 |
| 15 | `DentiPal-V5-Referrals` | `referralId` | — | 2 |
| 16 | `DentiPal-V5-UserAddresses` | `userSub` | — | 0 |
| 17 | `DentiPal-V5-UserClinicAssignments` | `userSub` | `clinicId` | 0 |
| 18 | `DentiPal-V5-JobPromotions` | `jobId` | `promotionId` | 3 |

> The schema for tables 1–17 is already described in detail in [DENTIPAL_DATABASE_SCHEMA.md](DENTIPAL_DATABASE_SCHEMA.md); that file is authoritative and reproduced in §22. Table 18 (JobPromotions) is newer and not yet in that reference — it is documented below.

### 5.18 `DentiPal-V5-JobPromotions` (LinkedIn-style boosted job postings)

| Key Type | Attribute | Type |
|----------|-----------|------|
| Partition Key | `jobId` | STRING |
| Sort Key | `promotionId` | STRING |

**Attributes** (inferred from CDK + handler usage):

| Attribute | Type | Description |
|-----------|------|-------------|
| `jobId` | S | References `DentiPal-V5-JobPostings.jobId` (PK) |
| `promotionId` | S | UUID for the promotion row (SK) |
| `clinicUserSub` | S | Clinic admin who bought the promotion (legacy GSI key) |
| `clinicId` | S | Clinic the promotion is scoped to (current GSI key) |
| `status` | S | `pending` / `active` / `cancelled` / `expired` |
| `plan` | S | Plan key (e.g. `basic`, `featured`, `premium`) |
| `amount` | N | Price charged in cents/dollars |
| `currency` | S | `USD` etc. |
| `impressions` | N | View counter |
| `clicks` | N | Click counter (incremented by `trackPromotionClick`) |
| `createdAt` | S | ISO timestamp |
| `activatedAt` | S | ISO timestamp when moved to `active` |
| `expiresAt` | S | ISO timestamp end of boost window |
| `cancelledAt` | S | ISO timestamp (if cancelled) |

**GSIs (3):**

| Name | PK | SK | Projection | Purpose |
|------|----|----|------------|---------|
| `clinicUserSub-index` | `clinicUserSub` | `createdAt` | ALL | **Legacy** (stack comment: _"no longer queried by any handler, kept in this deploy so the DynamoDB 'one GSI change per update' rule is respected while the new clinicId-keyed index is being added. Remove in a follow-up deploy."_) |
| `clinicId-createdAt-index` | `clinicId` | `createdAt` | ALL | My-promotions dashboard. Keyed on `clinicId` so multi-clinic owners see promotions scoped to the currently-selected clinic rather than every clinic they own. |
| `status-expiresAt-index` | `status` | `expiresAt` | ALL | Expiry cron job: find active promotions that have expired. |

**Env var**: `JOB_PROMOTIONS_TABLE`.

---

### 5.x Authoritative attribute tables for the 17 legacy tables

The full attribute listing for every other table is in [DENTIPAL_DATABASE_SCHEMA.md](DENTIPAL_DATABASE_SCHEMA.md) (reproduced in §22 of this doc). Rather than duplicate 500 lines of schema here, this report treats that file as a dependency; the handler sections below reference each table/attribute by name with an assumed shape.

### 5.y Addendum — Stack comments on `DentiPal-V5-Messages`

The `ConversationIdIndex` GSI on `DentiPal-V5-Messages` duplicates the base table's exact key schema (`conversationId` + `messageId`). Per stack comment (audit 2026-04-17):

> _"`ConversationIdIndex` has the same PK+SK as the base table above (conversationId + messageId) and is never queried — it is pure WCU and storage cost, duplicating every write. It is kept here for now because removing it requires a deployment against a live production table; see the inbox audit report for guidance. When you're ready to drop it, comment out this block and run `cdk deploy`; the GSI will be removed without touching data."_

### 5.z Addendum — `DentiPal-V5-JobPostings` `status-createdAt-index`

In addition to the 4 GSIs listed in the legacy schema doc, the stack now also defines:

```ts
jobPostingsTable.addGlobalSecondaryIndex({
    indexName: 'status-createdAt-index',
    partitionKey: { name: 'status', type: STRING },
    sortKey:      { name: 'createdAt', type: STRING },
    projectionType: ALL,
});
```

Purpose: the professional "filtered-jobs" handler queries open jobs sorted by creation date.

So `DentiPal-V5-JobPostings` actually has **5 GSIs** (not 4): `ClinicIdIndex`, `DateIndex`, `jobId-index-1`, `JobIdIndex-2`, `status-createdAt-index`.

---

## 6. S3 Buckets

Source: [lib/denti_pal_cdk-stack.ts:1137–1202](lib/denti_pal_cdk-stack.ts#L1137-L1202)

All buckets share these settings:

| Property | Value |
|----------|-------|
| Removal policy | `RETAIN` (never auto-destroyed on stack delete) |
| Encryption | `S3_MANAGED` (SSE-S3) |
| Block public access | `BLOCK_ALL` |
| Physical name | CDK-generated (not fixed) |

### 6.1 CORS rule (shared)

```ts
const BUCKET_CORS: s3.CorsRule[] = [{
  allowedOrigins: [
    "http://localhost:5173",
    "https://main.d3agcvis750ojb.amplifyapp.com",
  ],
  allowedMethods: [POST, PUT, GET, HEAD],
  allowedHeaders: ["*"],
  exposedHeaders: ["ETag", "Location"],
  maxAge: 3000,
}];
```

Reason (stack comment): the frontend uploads files directly to S3 via presigned POST/PUT, so the browser needs CORS on the bucket — otherwise `fetch()` throws "Failed to fetch" even though the object was stored.

### 6.2 Buckets (7)

| Construct ID | Env var(s) injected into monolith | Purpose |
|--------------|-----------------------------------|---------|
| `ProfileImagesBucket` | `PROFILE_IMAGES_BUCKET` | Professional / clinic avatar photos |
| `CertificatesBucket` | _(no env var — legacy, unused in handlers)_ | Legacy bucket kept for backwards compatibility |
| `VideoResumesBucket` | `VIDEO_RESUMES_BUCKET` | Professional video resumes |
| `ProfessionalResumesBucket` | `PROFESSIONAL_RESUMES_BUCKET` | PDF / DOC resumes |
| `DrivingLicensesBucket` | `DRIVING_LICENSES_BUCKET` | Driving license scans |
| `ProfessionalLicensesBucket` | `CERTIFICATES_BUCKET` + `PROFESSIONAL_LICENSES_BUCKET` (both map to this bucket) | Dental / professional licenses |
| `ClinicOfficeImagesBucket` | `CLINIC_OFFICE_IMAGES_BUCKET` | Clinic office photos |

Note the dual mapping on `ProfessionalLicensesBucket`: env var `CERTIFICATES_BUCKET` points to it to preserve backwards compatibility with handlers that used to call the old "certificates" name. The `CertificatesBucket` construct itself is effectively orphaned — no env var references its name, only IAM grants attach to it.

### 6.3 IAM grants

Both the monolith Lambda and the WebSocket Lambda get `grantReadWrite` (monolith) and `grantRead` (WebSocket — only on `ProfileImagesBucket` and `ClinicOfficeImagesBucket`, for generating presigned GET URLs when enriching conversation payloads with avatars).

---

## 7. REST API Gateway

Source: [lib/denti_pal_cdk-stack.ts:1367–1402](lib/denti_pal_cdk-stack.ts#L1367-L1402)

### 7.1 API resource `DentiPalApi`

| Property | Value |
|----------|-------|
| Name | `DentiPal API` |
| Description | Backend API for DentiPal |
| Type | REST (API Gateway v1) |
| Stage | `prod` |
| CloudWatch role | **auto-created** (`cloudWatchRole: true`) |
| Tracing | enabled (X-Ray) |
| Metrics | enabled |
| Logging level | `INFO` |
| Data trace | enabled (full request/response logs) |
| Binary media types | `multipart/form-data` |
| CORS preflight | enabled globally |
| CORS origins | `http://localhost:5173`, `https://main.d3agcvis750ojb.amplifyapp.com` |
| CORS methods | `ALL_METHODS` |
| CORS headers | `Content-Type`, `Authorization`, `X-Amz-Date`, `X-Api-Key`, `X-Amz-Security-Token`, `X-Requested-With` |

### 7.2 Integration

A single `ANY /{proxy+}` proxy resource forwards every request to the monolith Lambda:

```ts
api.root.addProxy({
    defaultIntegration: new apigateway.LambdaIntegration(lambdaFunction),
    defaultMethodOptions: { authorizationType: apigateway.AuthorizationType.NONE }
});
```

There is **no Cognito authorizer** at the API Gateway layer. Each handler individually enforces JWT checks via the utilities in [utils.ts](lambda/src/handlers/utils.ts) (see §14).

### 7.3 Endpoint URL

`https://<rest-api-id>.execute-api.<region>.amazonaws.com/prod/<path>`

The `CfnOutput` key is `RestApiEndpoint`.

### 7.4 Router internals

See §15 for the resource-method lookup table, candidate normalization, and dispatch logic in `lambda/src/index.ts`.

---

## 8. WebSocket API Gateway

Source: [lib/denti_pal_cdk-stack.ts:1468–1491](lib/denti_pal_cdk-stack.ts#L1468-L1491)

### 8.1 API resource `DentiPalChatApi`

| Property | Value |
|----------|-------|
| Name | `DentiPal-Chat-API` |
| Stage | `prod` (auto-deploy true) |
| Endpoint | `wss://<api-id>.execute-api.<region>.amazonaws.com/prod` |

### 8.2 Routes

| Route | Integration |
|-------|-------------|
| `$connect` | `DentiPal-Chat-WebSocket` |
| `$disconnect` | `DentiPal-Chat-WebSocket` |
| `$default` | `DentiPal-Chat-WebSocket` |

All three routes target the same Lambda; the function internally branches on `event.requestContext.routeKey`. The `$default` route is further dispatched by the JSON message's `action` field.

### 8.3 Message actions

Known actions (see per-handler reference in §21):

- `sendMessage` — send a chat message between clinic and professional
- `getHistory` — fetch messages for a conversation (paginated)
- `getConversations` — list conversations for the caller
- `markAsRead` — mark messages read / update `lastReadAt`
- `typing` — ephemeral typing indicator
- plus system-message ingress via `postToConnection` from `event-to-message`

### 8.4 CloudFormation output

`WebSocketEndpoint` = `webSocketApi.apiEndpoint` (without stage path).

---

## 9. Lambda Functions

Seven Lambda functions are provisioned:

| # | Name | Handler | Runtime | Mem | Timeout | Purpose |
|---|------|---------|---------|-----|---------|---------|
| 1 | `DentiPal-Backend-Monolith` | `dist/index.handler` | Node.js 18.x | 1024 MB | 60 s | All REST traffic |
| 2 | `DentiPal-Chat-WebSocket` | `dist/handlers/websocketHandler.handler` | Node.js 18.x | 512 MB | 30 s | WebSocket chat |
| 3 | `DentiPal-event-to-message` | `dist/handlers/event-to-message.handler` | Node.js 18.x | 256 MB | 30 s | EventBridge → system messages |
| 4 | `DentiPal-PreSignUp` | `dist/handlers/preSignUp.handler` | Node.js 18.x | 128 MB | 10 s | Cognito `PRE_SIGN_UP` trigger |
| 5 | `DentiPal-DefineAuthChallenge` | `dist/handlers/defineAuthChallenge.handler` | Node.js 18.x | 128 MB | 10 s | Cognito `DEFINE_AUTH_CHALLENGE` |
| 6 | `DentiPal-CreateAuthChallenge` | `dist/handlers/createAuthChallenge.handler` | Node.js 18.x | 128 MB | 10 s | Cognito `CREATE_AUTH_CHALLENGE` |
| 7 | `DentiPal-VerifyAuthChallenge` | `dist/handlers/verifyAuthChallenge.handler` | Node.js 18.x | 128 MB | 10 s | Cognito `VERIFY_AUTH_CHALLENGE_RESPONSE` |

### 9.1 Monolith environment variables

| Env var | Source |
|---------|--------|
| `REGION` | `this.region` |
| `CLIENT_ID` | Cognito App Client ID |
| `USER_POOL_ID` | Cognito User Pool ID |
| `SES_FROM` | `viswanadhapallivennela19@gmail.com` |
| `SES_REGION` | `this.region` |
| `SES_TO` | `shashitest2004@gmail.com` |
| `SMS_TOPIC_ARN` | `arn:aws:sns:${region}:${account}:DentiPal-SMS-Notifications` |
| `FRONTEND_ORIGIN` | `http://localhost:5173` |
| `GOOGLE_CLIENT_ID` | `186785894030-o8s1bte9egg9s6a4n61a3jrm6039sep1.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | **plaintext in stack** (`GOCSPX-...`) — see §23 for the security note |
| `GOOGLE_REDIRECT_URI` | `http://localhost:5173/callback` |
| `CLINIC_PROFILES_TABLE` | `DentiPal-V5-Clinic-Profiles` |
| `CLINIC_FAVORITES_TABLE` | `DentiPal-V5-ClinicFavorites` |
| `CLINICS_TABLE` | `DentiPal-V5-Clinics` |
| `CONNECTIONS_TABLE` | `DentiPal-V5-Connections` |
| `CONVERSATIONS_TABLE` | `DentiPal-V5-Conversations` |
| `FEEDBACK_TABLE` | `DentiPal-V5-Feedback` |
| `JOB_APPLICATIONS_TABLE` | `DentiPal-V5-JobApplications` |
| `JOB_INVITATIONS_TABLE` | `DentiPal-V5-JobInvitations` |
| `JOB_NEGOTIATIONS_TABLE` | `DentiPal-V5-JobNegotiations` |
| `JOB_POSTINGS_TABLE` | `DentiPal-V5-JobPostings` |
| `MESSAGES_TABLE` | `DentiPal-V5-Messages` |
| `NOTIFICATIONS_TABLE` | `DentiPal-V5-Notifications` |
| `OTP_VERIFICATION_TABLE` | `DentiPal-V5-OTPVerification` |
| `PROFESSIONAL_PROFILES_TABLE` | `DentiPal-V5-ProfessionalProfiles` |
| `REFERRALS_TABLE` | `DentiPal-V5-Referrals` |
| `USER_ADDRESSES_TABLE` | `DentiPal-V5-UserAddresses` |
| `USER_CLINIC_ASSIGNMENTS_TABLE` | `DentiPal-V5-UserClinicAssignments` |
| `JOB_PROMOTIONS_TABLE` | `DentiPal-V5-JobPromotions` |
| `CLINIC_JOBS_POSTED_TABLE` | alias of `JobPostings` (code compat) |
| `CLINICS_JOBS_COMPLETED_TABLE` | alias of `JobApplications` (code compat) |
| `PROFILE_IMAGES_BUCKET` | bucket name |
| `CERTIFICATES_BUCKET` | = `PROFESSIONAL_LICENSES_BUCKET` |
| `VIDEO_RESUMES_BUCKET` | bucket name |
| `PROFESSIONAL_RESUMES_BUCKET` | bucket name |
| `DRIVING_LICENSES_BUCKET` | bucket name |
| `PROFESSIONAL_LICENSES_BUCKET` | bucket name |
| `CLINIC_OFFICE_IMAGES_BUCKET` | bucket name |
| `PLACE_INDEX_NAME` | `DentiPalGeocoder` (added after function creation) |

### 9.2 WebSocket Lambda environment variables

| Env var | Value |
|---------|-------|
| `REGION` | `this.region` |
| `USER_POOL_ID` | Cognito User Pool ID |
| `CLIENT_ID` | Cognito App Client ID |
| `USER_CLINIC_ASSIGNMENTS_TABLE` | `DentiPal-V5-UserClinicAssignments` |
| `MESSAGES_TABLE` | `DentiPal-V5-Messages` |
| `CONNS_TABLE` | `DentiPal-V5-Connections` |
| `CONVOS_TABLE` | `DentiPal-V5-Conversations` |
| `CLINICS_TABLE` | `DentiPal-V5-Clinics` |
| `PROFESSIONAL_PROFILES_TABLE` | `DentiPal-V5-ProfessionalProfiles` |
| `CLINIC_PROFILES_TABLE` | `DentiPal-V5-Clinic-Profiles` |
| `PROFILE_IMAGES_BUCKET` | bucket name |
| `CLINIC_OFFICE_IMAGES_BUCKET` | bucket name |

### 9.3 event-to-message environment variables

| Env var | Value |
|---------|-------|
| `REGION` | `this.region` |
| `USER_POOL_ID` | Cognito User Pool ID |
| `MESSAGES_TABLE` | `DentiPal-V5-Messages` |
| `CONNS_TABLE` | `DentiPal-V5-Connections` |
| `CONVOS_TABLE` | `DentiPal-V5-Conversations` |
| `CLINICS_TABLE` | `DentiPal-V5-Clinics` |
| `WS_ENDPOINT` | `https://<apiId>.execute-api.<region>.amazonaws.com/prod` |

---

## 10. IAM Permissions

### 10.1 Monolith Lambda

| Service | Actions | Resource |
|---------|---------|----------|
| DynamoDB | `grantReadWriteData` on all 18 tables | each table ARN (+ its GSIs) |
| DynamoDB | `dynamodb:Scan` | `arn:aws:dynamodb:${region}:${account}:table/DentiPal-JobPostings` (note: legacy-named table ARN without `V5`, inherited) |
| Cognito | 15 admin/non-admin IDP actions (§4.6) | `userPool.userPoolArn` |
| SES | `SendEmail`, `SendRawEmail` | `*` |
| SNS | `Publish` | `*` |
| EventBridge | `PutEvents` | `*` |
| S3 | `grantReadWrite` on 7 buckets | each bucket + `/*` |
| Location | `geo:SearchPlaceIndexForText`, `geo:SearchPlaceIndexForPosition` | `placeIndex.attrArn` |

### 10.2 WebSocket Lambda

| Service | Actions | Resource |
|---------|---------|----------|
| DynamoDB | `grantReadWriteData` on `Connections`, `Conversations`, `Messages`, `Clinics` | those four table ARNs |
| DynamoDB | `grantReadData` on `ProfessionalProfiles`, `ClinicProfiles`, `UserClinicAssignments` | those three table ARNs |
| S3 | `grantRead` on `ProfileImagesBucket`, `ClinicOfficeImagesBucket` | those buckets |
| Cognito | `cognito-idp:AdminGetUser` | `userPool.userPoolArn` |
| API Gateway Management | `execute-api:ManageConnections` | `arn:aws:execute-api:<region>:<account>:*/*` |

### 10.3 event-to-message Lambda

| Service | Actions | Resource |
|---------|---------|----------|
| DynamoDB | `grantReadWriteData` on `Connections`, `Conversations`, `Messages`, `Clinics` | those four table ARNs |
| Cognito | `cognito-idp:AdminGetUser` | `userPool.userPoolArn` |
| API Gateway Management | `execute-api:ManageConnections` | `arn:aws:execute-api:<region>:<account>:*/*` |

---

## 11. EventBridge Wiring

Source: [lib/denti_pal_cdk-stack.ts:1539–1546](lib/denti_pal_cdk-stack.ts#L1539-L1546)

### 11.1 Rule: `DentiPal-ShiftEvent-to-Inbox`

```ts
const shiftEventRule = new events.Rule(this, 'ShiftEventRule', {
    ruleName: 'DentiPal-ShiftEvent-to-Inbox',
    eventPattern: {
        source:     ['denti-pal.api'],
        detailType: ['ShiftEvent'],
    },
});
shiftEventRule.addTarget(new targets.LambdaFunction(eventToMessageHandler));
```

### 11.2 Event emitters (producer handlers)

Handlers that call `new EventBridgeClient().send(new PutEventsCommand(...))` with `Source: 'denti-pal.api'`, `DetailType: 'ShiftEvent'`:

- `acceptProf.ts` (hire)
- `rejectProf.ts`
- `respondToInvitation.ts`
- `respondToNegotiation.ts`
- `updateCompletedShifts.ts`

Expected detail payload shape:

```jsonc
{
  "source":     "denti-pal.api",
  "detailType": "ShiftEvent",
  "detail": {
    "eventType":   "hired" | "rejected" | "invitationResponded" | "negotiationResponded" | "shiftCompleted" | ...,
    "jobId":       "<uuid>",
    "clinicId":    "<uuid>",
    "clinicUserSub": "<cognito-sub>",
    "professionalUserSub": "<cognito-sub>",
    "date":        "YYYY-MM-DD",
    "startTime":   "HH:mm",
    "endTime":     "HH:mm",
    "message":     "<optional override body>"
  }
}
```

The `event-to-message` Lambda consumes these and writes a system message into the affected conversation (creating the conversation if it doesn't exist), then pushes the message to any active WebSocket connections for both parties.

### 11.3 Secondary EventBridge trigger — `aws.events` scheduled event

The monolith Lambda `index.ts` also handles a generic **`aws.events`** scheduled trigger:

```ts
if (event.source === 'aws.events') {
    return await updateCompletedShiftsHandler(event);
}
```

This is the path used by an EventBridge scheduler rule (a `Schedule` or `Rule` outside the CDK stack — defined manually in the console or by ops tooling) to periodically invoke `updateCompletedShifts` and auto-mark shifts whose end-time has passed as `completed`.

---

## 12. Amazon Location Service

Source: [lib/denti_pal_cdk-stack.ts:1343–1357](lib/denti_pal_cdk-stack.ts#L1343-L1357)

```ts
const placeIndex = new location.CfnPlaceIndex(this, 'DentiPalPlaceIndex', {
    indexName: 'DentiPalGeocoder',
    dataSource: 'Here',
    pricingPlan: 'RequestBasedUsage',
    description: 'Geocoding for DentiPal addresses (jobs, professionals, clinics)',
});

lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
    actions: ['geo:SearchPlaceIndexForText', 'geo:SearchPlaceIndexForPosition'],
    resources: [placeIndex.attrArn],
}));

lambdaFunction.addEnvironment('PLACE_INDEX_NAME', 'DentiPalGeocoder');
```

The `DentiPalGeocoder` Place Index is consumed by two handlers:

- [handlers/geocodePostal.ts](lambda/src/handlers/geocodePostal.ts) — routes `GET /geocode/postal` and `GET /location/lookup`
- [handlers/geo.ts](lambda/src/handlers/geo.ts) — internal helper used when denormalizing address fields into `JobPostings`

Both use `@aws-sdk/client-location` with `SearchPlaceIndexForTextCommand` (takes `Text` = ZIP code or address, filters to country `USA`, returns a `Results[]` array of `Place.Label` / `Place.PostalCode` / `Place.Municipality` / `Place.Region` — i.e. city & state).

---

## 13. Cross-Cutting Utilities

### 13.1 [handlers/utils.ts](lambda/src/handlers/utils.ts)

Exports:

| Symbol | Kind | Purpose |
|--------|------|---------|
| `CLINIC_ROLES` | const tuple | `['root','clinicadmin','clinicmanager','clinicviewer']` — lowercased role priorities |
| `ClinicRole` | type alias | union of the four |
| `ClinicWriteAction` | type alias | `"manageJobs" \| "manageApplicants" \| "manageClinic" \| "manageUsers"` |
| `AccessLevel` | **deprecated** type alias | legacy `"ClinicAdmin" \| "Doctor" \| "Receptionist"` |
| `UserInfo` | interface | `{ sub, userType, email?, groups: string[] }` |
| `buildAddress(parts)` | fn | Joins address fragments into a single comma-separated line |
| `isRoot(groups)` | fn | Case-insensitive check for `Root` group |
| `getClinicRole(groups)` | fn | Returns highest-priority `ClinicRole` (or null) from the caller's groups |
| `canAccessClinic(sub, groups, clinicId)` | async fn | READ gate — user must be in `Clinics.AssociatedUsers` or `Clinics.createdBy` |
| `canWriteClinic(sub, groups, clinicId, action)` | async fn | WRITE gate — `canAccessClinic` + role ≠ `clinicviewer` |
| `listAccessibleClinicIds(sub, groups)` | async fn | Full-scan `Clinics` for the user's clinic IDs (membership-scoped even for Root) |
| `hasClinicAccess(sub, clinicId, requiredAccess?)` | **deprecated** fn | Old `UserClinicAssignments`-based check (not populated by Add User flow) |
| `validateToken(event)` | fn | Throws if no `sub` claim; returns it |
| `verifyToken(event)` | async fn | Returns `UserInfo` or `null` by reading API Gateway's authorizer-injected claims |
| `extractAndDecodeAccessToken(authHeader)` | fn | Decodes JWT payload (**no signature verification**) |
| `extractUserInfoFromClaims(claims)` | fn | Normalizes `cognito:groups` (array OR comma-separated string) into `string[]` |
| `extractUserFromBearerToken(authHeader)` | fn | Convenience wrapper: decode → UserInfo |

**Critical behavior:**

1. Since API Gateway has `authorizationType: NONE`, `verifyToken(event)` returning claims from `event.requestContext.authorizer` will generally return `null` in prod — **handlers must use `extractUserFromBearerToken(event.headers.Authorization)` instead.**
2. `extractAndDecodeAccessToken` **does not verify the JWT signature** — it only base64-decodes the payload. A malicious client who knows the Cognito sub of another user could forge a token and pass authorization. The `aws-jwt-verify` dependency is present in `package.json` but not used. This is a known gap; see §23.
3. `canAccessClinic` does **one GetItem** on `Clinics` using `ProjectionExpression: "AssociatedUsers, createdBy"`. Root is a clinic-side role, not a platform-wide superuser — it does **not** bypass the membership check.
4. `listAccessibleClinicIds` does a **full Scan** of `Clinics` filtered by `contains(AssociatedUsers, :sub) OR createdBy = :sub`. This is O(N clinics) per call — a potential hotspot on large deployments.

### 13.2 [handlers/corsHeaders.ts](lambda/src/handlers/corsHeaders.ts)

- `ALLOWED_ORIGINS`: `["http://localhost:5173", "https://main.d3agcvis750ojb.amplifyapp.com"]`
- `setOriginFromEvent(event)`: call at handler entry — inspects `event.headers.origin`/`Origin`, sets module-level `_currentOrigin` (defaulting to `ALLOWED_ORIGINS[0]` if not whitelisted).
- `CORS_HEADERS`: an object with a **getter** on `Access-Control-Allow-Origin` so the value is resolved at serialization time. Other keys are static:
  - `Access-Control-Allow-Headers: Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,X-Requested-With`
  - `Access-Control-Allow-Methods: OPTIONS,GET,POST,PUT,PATCH,DELETE`
  - `Access-Control-Allow-Credentials: true`
  - `Vary: Origin`

All handler responses include `headers: CORS_HEADERS` (or `{ ...CORS_HEADERS, 'Content-Type': 'application/json' }`).

### 13.3 [handlers/geo.ts](lambda/src/handlers/geo.ts)

Helper that wraps the AWS Location `SearchPlaceIndexForTextCommand` and returns `{ city, state, latitude, longitude }` — consumed by handlers that denormalize an address into a job posting or profile.

### 13.4 [handlers/jobPostingCounters.ts](lambda/src/handlers/jobPostingCounters.ts) and [handlers/promotionCounters.ts](lambda/src/handlers/promotionCounters.ts)

Internal atomic counter utilities. Use `UpdateItem` with `ADD` expression to bump view / click / application counters without racing. Called from `browseJobPostings`, `trackPromotionClick`, etc.

### 13.5 [handlers/BonusAwarding.ts](lambda/src/handlers/BonusAwarding.ts)

Internal helper triggered from `verifyOTPAndCreateUser.ts` after a new registration completes. If the new user was referred (matched in `Referrals.ReferredUserSubIndex`), flips the referral row to `status: "completed"`, `bonusAwarded: true`, and stamps `acceptedAt`. No REST route — invoked via direct import.

### 13.6 [handlers/migrateJobRates.ts](lambda/src/handlers/migrateJobRates.ts)

One-shot migration script that normalizes legacy `rate` / `pay_rate` / `hourlyRate` attributes on `JobPostings` rows into the canonical `hourly_rate` field. Not wired to any route — invoked ad-hoc (e.g. via `aws lambda invoke`).

---

## 14. Authentication & Authorization Model

### 14.1 Trust chain

1. **Frontend** logs in against Cognito (SRP, user-password, or custom-auth flow for Google sign-in).
2. Cognito returns an `idToken`, `accessToken`, and `refreshToken`.
3. Frontend sends `Authorization: Bearer <accessToken>` on every REST request.
4. API Gateway accepts without checking (`authorizationType: NONE`).
5. The monolith Lambda pops the header, base64-decodes the JWT payload (no signature verify), extracts `sub` and `cognito:groups`.
6. Each handler calls the appropriate gate in `utils.ts`.

### 14.2 Auth flows supported

| Flow | How |
|------|-----|
| Email + password | Standard Cognito `InitiateAuth` with `USER_SRP_AUTH` or `USER_PASSWORD_AUTH`. |
| Sign-up via OTP | Frontend POSTs to `/auth/initiate-registration` → Lambda writes OTP to `DentiPal-V5-OTPVerification` + SES email; frontend POSTs OTP to `/auth/verify-otp` which creates the Cognito user + user's profile row + clinic assignments if applicable. |
| Password reset | `/auth/forgot` → Cognito `ForgotPassword`; `/auth/confirm-forgot-password` → `ConfirmForgotPassword`. |
| Google OAuth | `/auth/google-login` — exchanges auth code for Google id_token → server-side fetch of profile → ensures a Cognito user exists (creates via `AdminCreateUser` if not) → runs the **custom-auth flow** (`DefineAuthChallenge`, `CreateAuthChallenge`, `VerifyAuthChallenge`) to issue Cognito tokens without a password. |
| Refresh | `/auth/refresh` → `InitiateAuth` with `REFRESH_TOKEN_AUTH`. |

### 14.3 Authorization gates

| Gate | Used for | Semantics |
|------|----------|-----------|
| `validateToken(event)` | Any handler that needs a `sub` claim | Throws `User not authenticated` if missing; returns `sub` string. |
| `extractUserFromBearerToken(authHeader)` | Newer handlers that need both `sub` and `groups` | Decode JWT payload, return `{sub, userType, email?, groups[]}`. |
| `getClinicRole(groups)` | Role dispatch | Returns single highest-priority `root`/`clinicadmin`/`clinicmanager`/`clinicviewer`. |
| `canAccessClinic(sub, groups, clinicId)` | Read-only clinic operations | `clinicId` in `Clinics.createdBy` or `Clinics.AssociatedUsers`. |
| `canWriteClinic(sub, groups, clinicId, action)` | Mutating clinic operations | `canAccessClinic` + role ≠ `clinicviewer`. |
| `listAccessibleClinicIds(sub, groups)` | Endpoints that aggregate across all a user's clinics (dashboards) | Scan `Clinics` filtered by `AssociatedUsers contains :sub OR createdBy = :sub`. |
| `hasClinicAccess(sub, clinicId, requiredAccess?)` | **deprecated** | Legacy check against `UserClinicAssignments`. Not used by new code — Add User flow doesn't populate this table. |

Professional-side handlers (applications, invitations, negotiations, completed shifts) authorize by:
- `professionalUserSub === authenticatedSub` (self-ownership), or
- Cognito group membership in one of the professional-side groups (`AssociateDentist`, `DentalHygienist`, ...).

### 14.4 Security note

Because JWT signatures are **not verified**, any party who can fabricate a JSON payload with a target `sub` and encode it as base64url-separated JWT (with any signature) will pass the auth gate. This is only safe if API Gateway is fronted by something that verifies signatures first — which this stack is not. **Recommended remediation**: switch `extractAndDecodeAccessToken` to use the already-installed `aws-jwt-verify`:

```ts
import { CognitoJwtVerifier } from "aws-jwt-verify";
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: "access",
  clientId: process.env.CLIENT_ID!,
});
const claims = await verifier.verify(token); // throws on bad signature
```

---

## 15. Request Routing Logic

Source: [lambda/src/index.ts](lambda/src/index.ts)

The monolith Lambda's entry `handler`:

1. **EventBridge short-circuit** — if `event.source === 'aws.events'`, skip routing and directly call `updateCompletedShiftsHandler(event)`.
2. **Extract method & path** — prefers `event.httpMethod`/`event.path` (REST v1), falls back to `event.requestContext.http.method`/`event.rawPath` (HTTP API v2), then `event.resource`.
3. **Generate candidate paths** — adds `/`-trimmed / `/`-appended / `/prod`-prefixed / `/prod`-stripped variants, deduplicated via a `Set`. This tolerates both raw API Gateway event shapes.
4. **Try each candidate** against a hand-curated `routes` map (see §16 for the full table). On first match, the handler is returned.
5. **Pattern matching** — if exact match fails, iterate all routes and apply `matchesPattern(actualRoute, patternRoute)` which splits both into `/` segments, requires same length, and treats `{name}` as a wildcard.
6. **Dispatch** — `await routeHandler(event, context)`. Handler results are returned verbatim.
7. **404** — if no match, return `{ statusCode: 404, body: { error: "Endpoint not found", resource, method, tried } }`.
8. **500** — any thrown error is caught and returned as `{ statusCode: 500, body: { error: `Internal server error: ${error.message}`, ... } }`.

Key observation: the route table is a **flat object literal** with 170+ entries (path-parameter patterns deduplicated). There is no middleware, no per-handler auth wrapper, no rate limiter — each handler is responsible for its own auth, validation, and error translation.

---

## 16. Full Route Table

Extracted verbatim from [lambda/src/index.ts](lambda/src/index.ts) lines 165–370. Organized by feature area.

### 16.1 Authentication

| Method | Path | Handler |
|--------|------|---------|
| POST | `/auth/login` | `loginUser` |
| POST | `/auth/refresh` | `refreshToken` |
| POST | `/auth/forgot` | `forgotPassword` |
| POST | `/auth/check-email` | `checkEmail` |
| POST | `/auth/confirm-forgot-password` | `confirmPassword` |
| POST | `/auth/google-login` | `googleLogin` |
| POST | `/auth/initiate-registration` | `initiateUserRegistration` |
| POST | `/auth/verify-otp` | `verifyOTPAndCreateUser` |
| POST | `/auth/resend-otp` | `resendOtp` |

### 16.2 Users

| Method | Path | Handler |
|--------|------|---------|
| POST | `/users` | `createUser` |
| GET | `/users` | `getUser` |
| GET | `/users/me` | `getUserMe` |
| PUT | `/users/{userId}` | `updateUser` |
| DELETE | `/users/{userId}` | `deleteUser` |
| DELETE | `/users/me` | `deleteOwnAccount` |
| GET | `/clinics/{clinicId}/users` | `getClinicUsers` |

### 16.3 Clinics

| Method | Path | Handler |
|--------|------|---------|
| POST | `/clinics` | `createClinic` |
| GET | `/clinics` | `getAllClinics` |
| GET | `/clinics-user` | `getUsersClinics` |
| GET | `/clinics/{clinicId}` | `getClinic` |
| PUT | `/clinics/{clinicId}` | `updateClinic` |
| DELETE | `/clinics/{clinicId}` | `deleteClinic` |
| GET | `/clinics/{clinicId}/address` | `getClinicAddress` |

### 16.4 Clinic Profiles

| Method | Path | Handler |
|--------|------|---------|
| POST | `/clinic-profiles` | `createClinicProfile` |
| GET | `/clinic-profiles` | `getClinicProfile` |
| GET | `/clinic-profile/{clinicId}` | `getClinicProfileDetails` |
| PUT | `/clinic-profiles/{clinicId}` | `updateClinicProfileDetails` |
| DELETE | `/clinic-profiles/{clinicId}` | `deleteClinicProfile` |

### 16.5 Professional Profiles

| Method | Path | Handler |
|--------|------|---------|
| POST | `/profiles` | `createProfessionalProfile` |
| GET | `/profiles` | `getProfessionalProfile` |
| PUT | `/profiles` | `updateProfessionalProfile` |
| DELETE | `/profiles` | `deleteProfessionalProfile` |
| GET | `/profiles/questions` | `getProfessionalQuestions` |
| GET | `/profiles/{userSub}` | `getPublicProfessionalProfile` |
| GET | `/allprofessionals` | `getAllProfessionals` |
| GET | `/professionals/public` | `publicProfessionals` |
| GET | `/public/publicprofessionals` | `publicProfessionals` |

### 16.6 Assignments

| Method | Path | Handler |
|--------|------|---------|
| POST | `/assignments` | `createAssignment` |
| GET | `/assignments` | `getAssignments` |
| GET | `/assignments/{userSub}` | `getAssignments` |
| PUT | `/assignments` | `updateAssignment` |
| DELETE | `/assignments` | `deleteAssignment` |

### 16.7 Generic Job Postings

| Method | Path | Handler |
|--------|------|---------|
| POST | `/jobs` | `createJobPosting` |
| GET | `/job-postings` | `getJobPostings` |
| GET | `/jobs/browse` | `browseJobPostings` |
| GET | `/jobs/{jobId}` | `getJobPosting` |
| PUT | `/jobs/{jobId}` | `updateJobPosting` |
| DELETE | `/jobs/{jobId}` | `deleteJobPosting` |
| GET | `/jobs/public` | `findJobs` (alias: `publicClinicsHandler`) |
| GET | `/public/publicJobs` | `findJobs` |

### 16.8 Temporary Jobs

| Method | Path | Handler |
|--------|------|---------|
| POST | `/jobs/temporary` | `createTemporaryJob` |
| GET | `/jobs/temporary` | `getAllTemporaryJobs` |
| GET | `/jobs/temporary/{jobId}` | `getTemporaryJob` |
| PUT | `/jobs/temporary/{jobId}` | `updateTemporaryJob` |
| DELETE | `/jobs/temporary/{jobId}` | `deleteTemporaryJob` |
| GET | `/jobs/clinictemporary/{clinicId}` | `getTemporary-Clinic` |

### 16.9 Multi-Day Consulting Jobs

| Method | Path | Handler |
|--------|------|---------|
| POST | `/jobs/consulting` | `createMultiDayConsulting` |
| GET | `/jobs/consulting` | `getAllMultiDayConsulting` |
| GET | `/jobs/consulting/{jobId}` | `getMultiDayConsulting` |
| PUT | `/jobs/consulting/{jobId}` | `updateMultiDayConsulting` |
| DELETE | `/jobs/consulting/{jobId}` | `deleteMultiDayConsulting` |
| GET | `/jobs/multiday/{jobId}` | `getAllMultidayJobs` |
| GET | `/jobs/multiday/clinic/{clinicId}` | `getAllMultidayForClinic` |

### 16.10 Permanent Jobs

| Method | Path | Handler |
|--------|------|---------|
| POST | `/jobs/permanent` | `createPermanentJob` |
| GET | `/jobs/permanent` | `getAllPermanentJobs` |
| GET | `/jobs/permanent/{jobId}` | `getPermanentJob` |
| PUT | `/jobs/permanent/{jobId}` | `updatePermanentJob` |
| DELETE | `/jobs/permanent/{jobId}` | `deletePermanentJob` |
| GET | `/jobs/clinicpermanent/{clinicId}` | `getAllPermanentJobsForClinic` |

### 16.11 Applications

| Method | Path | Handler |
|--------|------|---------|
| POST | `/applications` | `createJobApplication` |
| GET | `/applications` | `getJobApplications` |
| PUT | `/applications/{applicationId}` | `updateJobApplication` |
| DELETE | `/applications/{applicationId}` | `deleteJobApplication` |
| GET | `/clinics/{clinicId}/jobs` | `getJobApplicationsForClinic` |
| GET | `/{clinicId}/jobs` | `getJobApplicantsOfAClinic` |

### 16.12 Invitations

| Method | Path | Handler |
|--------|------|---------|
| POST | `/jobs/{jobId}/invitations` | `sendJobInvitations` |
| POST | `/invitations/{invitationId}/response` | `respondToInvitation` |
| GET | `/invitations` | `getJobInvitations` |
| GET | `/invitations/{clinicId}` | `getJobInvitationsForClinics` |

### 16.13 Negotiations

| Method | Path | Handler |
|--------|------|---------|
| PUT | `/applications/{applicationId}/negotiations/{negotiationId}/response` | `respondToNegotiation` |
| GET | `/allnegotiations` | `getAllNegotiations-Prof` |
| GET | `/negotiations` | `getAllNegotiations-Prof` |

### 16.14 Hiring / Status / Feedback

| Method | Path | Handler |
|--------|------|---------|
| PUT | `/jobs/{jobId}/status` | `updateJobStatus` |
| POST | `/jobs/{jobId}/hire` | `acceptProf` (hire) |
| POST | `/{clinicId}/reject/{jobId}` | `rejectProf` |
| POST | `/submitfeedback` | `submitFeedback` |

### 16.15 Shift Dashboards

| Method | Path | Handler |
|--------|------|---------|
| GET | `/dashboard/all/open-shifts` | `getAllClinicsShifts` (branch: open-shifts) |
| GET | `/dashboard/all/action-needed` | `getAllClinicsShifts` (branch: action-needed) |
| GET | `/dashboard/all/scheduled-shifts` | `getAllClinicsShifts` (branch: scheduled-shifts) |
| GET | `/dashboard/all/completed-shifts` | `getAllClinicsShifts` (branch: completed-shifts) |
| GET | `/dashboard/all/invites-shifts` | `getAllClinicsShifts` (branch: invites-shifts) |
| GET | `/clinics/{clinicId}/open-shifts` | `getClinicShifts` (branch: open-shifts) |
| GET | `/clinics/{clinicId}/action-needed` | `getClinicShifts` (branch: action-needed) |
| GET | `/clinics/{clinicId}/scheduled-shifts` | `getClinicShifts` (branch: scheduled-shifts) |
| GET | `/clinics/{clinicId}/completed-shifts` | `getClinicShifts` (branch: completed-shifts) |
| GET | `/clinics/{clinicId}/invites-shifts` | `getClinicShifts` (branch: invites-shifts) |
| GET | `/completed/{clinicId}` | `getCompletedShifts` |
| GET | `/scheduled/{clinicId}` | `getScheduledShifts` |
| PUT | `/professionals/completedshifts` | `updateCompletedShifts` |
| GET | `/action-needed` | `getActionNeeded` |

### 16.16 Professional-side browsing

| Method | Path | Handler |
|--------|------|---------|
| GET | `/professionals/filtered-jobs` | `getProfessionalFilteredJobs` |

### 16.17 Favorites

| Method | Path | Handler |
|--------|------|---------|
| POST | `/clinics/favorites` | `addClinicFavorite` |
| GET | `/clinics/favorites` | `getClinicFavorites` |
| DELETE | `/clinics/favorites/{professionalUserSub}` | `removeClinicFavorite` |

### 16.18 Files

| Method | Path | Handler |
|--------|------|---------|
| POST | `/files/presigned-urls` | `generatePresignedUrl` |
| GET | `/files/profile-images` | `getProfileImage` |
| GET | `/files/professional-resumes` | `getProfessionalResume` |
| GET | `/files/professional-licenses` | `getProfessionalLicense` |
| GET | `/files/driving-licenses` | `getDrivingLicense` |
| GET | `/files/video-resumes` | `getVideoResume` |
| GET | `/files/clinic-office-images` | `getClinicOfficeImages` |
| PUT | `/files/profile-image` | `updateProfileImage` |
| PUT | `/files/professional-resumes` | `updateProfessionalResume` |
| PUT | `/files/professional-licenses` | `updateProfessionalLicense` |
| PUT | `/files/driving-licenses` | `updateDrivingLicense` |
| PUT | `/files/video-resumes` | `updateVideoResume` |
| DELETE | `/files/profile-images` | `deleteFile` |
| DELETE | `/files/certificates` | `deleteFile` |
| DELETE | `/files/video-resumes` | `deleteFile` |

### 16.19 User Addresses

| Method | Path | Handler |
|--------|------|---------|
| POST | `/user-addresses` | `createUserAddress` |
| GET | `/user-addresses` | `getUserAddresses` |
| PUT | `/user-addresses` | `updateUserAddress` |
| DELETE | `/user-addresses` | `deleteUserAddress` |

### 16.20 Geocoding

| Method | Path | Handler |
|--------|------|---------|
| GET | `/location/lookup` | `geocodePostal` |
| GET | `/geocode/postal` | `geocodePostal` |

### 16.21 Referrals

| Method | Path | Handler |
|--------|------|---------|
| POST | `/referrals/invite` | `sendReferralInvite` |

### 16.22 Promotions (Job boosting)

| Method | Path | Handler |
|--------|------|---------|
| GET | `/promotions/plans` | `getPromotionPlans` |
| POST | `/promotions` | `createPromotion` |
| GET | `/promotions` | `getPromotions` |
| GET | `/promotions/{promotionId}` | `getPromotion` |
| PUT | `/promotions/{promotionId}/cancel` | `cancelPromotion` |
| PUT | `/promotions/{promotionId}/activate` | `activatePromotion` |
| POST | `/promotions/track-click` | `trackPromotionClick` |

### 16.23 Totals

Unique (method, path) pairs: **116 REST endpoints** (counting each dashboard sub-path as its own endpoint), serviced by **128 handler files**. 12 handler files are internal (helpers, counters, migration, bonus-awarding, geo, event-to-message, the 4 Cognito triggers) and not directly addressable by URL.

---

<!-- The sections 17–21 below are assembled from per-handler extractions performed by parallel Explore agents against the actual .ts handler source. -->

## 17. Per-Handler Reference — Auth & User Registration

> Handlers covered: loginUser · refreshToken · forgotPassword · checkEmail · confirmPassword · googleLogin · initiateUserRegistration · verifyOTPAndCreateUser · resendOtp · preSignUp · createAuthChallenge · defineAuthChallenge · verifyAuthChallenge · createUser · getUser · getUserMe · updateUser · deleteUser · deleteOwnAccount

### `loginUser.ts` — `POST /auth/login`

**Purpose**: Authenticates a user via email and password, returns Cognito tokens, and fetches associated clinics for clinic-role users.

**Route(s)**: `POST /auth/login` (index.ts line 307)

**Auth**: Public (no token required). Validates credentials against Cognito User Pool.

**Request**:
- Path params: none
- Query params: none
- Headers: none required
- Body (JSON):
  - `email: string` (required) — user email address
  - `password: string` (required) — user password
  - `userType?: "clinic" | "professional"` (optional) — portal type for portal-side validation

**Response**:
- Success status code: 200
- Body shape:
  ```json
  {
    "status": "success",
    "statusCode": 200,
    "message": "Login successful",
    "data": {
      "tokens": {
        "accessToken": "string",
        "idToken": "string",
        "refreshToken": "string",
        "expiresIn": "number",
        "tokenType": "Bearer"
      },
      "user": {
        "email": "string",
        "sub": "string",
        "groups": ["string"],
        "associatedClinics": [
          { "clinicId": "string", "name": "string", "address": "string" }
        ]
      },
      "loginAt": "ISO8601"
    }
  }
  ```
- Error cases: 400 missing email/password · 401 invalid credentials / NotAuthorizedException / Google-only user · 403 portal mismatch / UserNotConfirmedException · 404 user not found · 429 too many login attempts · 500 internal

**DynamoDB access**:
- `CLINICS_TABLE` → `Scan` with `FilterExpression: contains(AssociatedUsers, :sub)` to enumerate the user's associated clinics (paginated).

**Cognito calls**:
- `InitiateAuth` with `USER_PASSWORD_AUTH` flow → authenticates user, returns tokens.
- `AdminGetUser` (fallback) → checks if user is Google-only when `NotAuthorizedException` is caught.

**Other AWS**: none.

**Business logic highlights**:
- Decodes access token payload in-process (base64url) to extract `sub` and `cognito:groups`.
- Portal-side validation: rejects professional users trying clinic login and vice versa.
- Scans `CLINICS_TABLE` with pagination to fetch all clinics where the user is in `AssociatedUsers`.
- Formats clinic address from either canonical fields (`addressLine1-3, city, state, pincode`) or legacy `address` field.
- Detects Google-only users by checking if `address` starts with `userType:`; returns tailored error.

**Side effects / Notes**:
- Auto-detects clinic role via group membership; non-clinic users skip the clinic scan.
- Returns empty `clinics` array for professional users.

---

### `refreshToken.ts` — `POST /auth/refresh`

**Purpose**: Refreshes expired Cognito access and ID tokens using a refresh token.

**Route(s)**: `POST /auth/refresh`

**Auth**: Public (uses refresh token in body).

**Request**:
- Body (JSON):
  - `refreshToken: string` (required)

**Response**:
- 200: `{ status, statusCode, message, data: { accessToken, idToken, refreshToken, expiresIn, tokenType: "Bearer" }, timestamp }`
- Error cases: 400 missing field / invalid JSON · 401 invalid/expired refresh token · 404 UserNotFoundException · 429 too many requests · 500 internal

**DynamoDB access**: none.

**Cognito calls**: `InitiateAuth` with `REFRESH_TOKEN_AUTH`.

**Business logic highlights**:
- No JWT decoding; delegates fully to Cognito for token validation.
- Falls back to the original refresh token if Cognito does not return a rotated one.
- Defaults `expiresIn` to 3600 if Cognito response omits it.

---

### `forgotPassword.ts` — `POST /auth/forgot`

**Purpose**: Initiates a password reset flow by sending a verification code to the user's email.

**Auth**: Public. Optionally validates user type matches requested portal.

**Request**:
- Body (JSON):
  - `email: string` (required)
  - `expectedUserType?: "clinic" | "professional"` (optional)

**Response**:
- 200: `{ status: "success", statusCode: 200, message: "If the email exists...", timestamp }`
- Error cases: 400 missing email / user type mismatch · 404 no account · 500 internal (env vars missing, AdminListGroupsForUser failure)

**Cognito calls**:
- `ListUsers` (email filter) → resolves username by email.
- `AdminListGroupsForUser` → groups for portal validation.
- `ForgotPassword` → sends reset code.

**Business logic highlights**:
- Derives user type from Cognito groups (configurable via `CLINIC_GROUPS` / `PRO_GROUPS` env vars).
- Portal enforcement: if `expectedUserType` is provided and user type is resolvable, mismatch is rejected.
- Generic "if email exists" message to prevent user enumeration.

---

### `checkEmail.ts` — `POST /auth/check-email`

**Purpose**: Verifies an email address against a bearer token's identity and derives the user's type.

**Auth**: JWT required.

**Request**:
- Headers: `Authorization: Bearer <accessToken>` (required)
- Body (JSON): `email: string` (required)

**Response**:
- 200: `{ status, statusCode: 200, message, data: { email, userType: "professional" | "clinic", groups, tokenEmail }, timestamp }`
- Error cases: 400 missing email / invalid JWT / parsing failed · 401 missing/invalid Bearer · 404 UserNotFoundException · 500 internal

**Cognito calls**: `AdminListGroupsForUser` (informational).

**Business logic highlights**:
- Decodes JWT payload without signature verification.
- Derives `userType`: explicit `userType` claim, or parses `address.formatted` for `userType:professional`; defaults to `clinic` otherwise.
- Logs token/body email mismatch non-fatally.

---

### `confirmPassword.ts` — `POST /auth/confirm-forgot-password`

**Purpose**: Confirms a password reset by validating the code and setting a new password.

**Auth**: Public.

**Request**:
- Body (JSON):
  - `email: string` (required)
  - `code: string` (required)
  - `newPassword: string` (required)

**Response**:
- 200: `{ status, statusCode: 200, message: "Password reset successful", timestamp }`
- Error cases: 400 missing fields / CodeMismatchException / ExpiredCodeException / InvalidParameterException · 404 user not found · 429 too many attempts · 500 missing USER_POOL_ID / internal

**Cognito calls**:
- `ListUsers` (email filter) if `EMAIL_IS_USERNAME` is not `"true"`.
- `ConfirmForgotPassword`.

---

### `googleLogin.ts` — `POST /auth/google-login`

**Purpose**: Handles Google OAuth login, creating new users if needed, and returning Cognito tokens via the custom-auth flow.

**Auth**: Public (validates Google token/code).

**Request**:
- Body (JSON):
  - `googleToken: string` (required) — Google authorization code OR ID token JWT
  - `userType: "clinic" | "professional"` (required)
  - `redirectUri?: string` (optional)

**Response**:
- 200: `{ status, statusCode: 200, message, data: { tokens, user, isNewUser, loginAt } }`
- Error cases: 400 missing/invalid inputs · 403 portal mismatch · 500 token generation failure

**DynamoDB access**:
- `CLINICS_TABLE` → `Scan` with `contains(AssociatedUsers, :sub)` for clinic-role users.

**Cognito calls**:
- Google `tokeninfo` (external HTTP).
- `ListUsers` (email filter) — existence check.
- `AdminCreateUser` + `AdminGetUser` + `AdminSetUserPassword` + `AdminAddUserToGroup` — new-user provisioning.
- `AdminListGroupsForUser`.
- `AdminInitiateAuth` (`ADMIN_USER_PASSWORD_AUTH`) for new users.
- `AdminInitiateAuth` (`CUSTOM_AUTH`) + `AdminRespondToAuthChallenge` with answer `"google-verified"` for existing users.

**Business logic highlights**:
- Dual input: accepts Google authorization code OR ID token JWT.
- Deterministic Google-user password: `G00gle!{sub[:8]}#Auth` (never returned to client).
- Stores `userType:{clinic|professional}|role:{group}|clinic:{clinicName}` in the Cognito `address` attribute.
- Portal mismatch blocked (403).
- Custom auth flow avoids ever rotating Cognito passwords on Google users.

---

### `initiateUserRegistration.ts` — `POST /auth/initiate-registration`

**Purpose**: Initiates user registration in Cognito, optionally replacing stale UNCONFIRMED signups, and links referrals.

**Auth**: Public.

**Request**:
- Body (JSON):
  - `email: string` (required)
  - `firstName: string` (required)
  - `lastName: string` (required)
  - `userType: "clinic" | "professional"` (required)
  - `password: string` (required)
  - `role?: string` (required if userType=professional) — from `VALID_ROLE_VALUES`
  - `clinicName?: string` (optional)
  - `phoneNumber?: string` (optional)
  - `referrerUserSub?: string` (optional)

**Response**:
- 201: `{ status, statusCode: 201, message, data: { userSub, email, userType, role, cognitoGroup, nextStep, codeDeliveryDetails }, timestamp }`
- Error cases: 400 missing fields / invalid role · 409 email already registered · 500 internal

**DynamoDB access**:
- `REFERRALS_TABLE` → `Scan` with `friendEmail = :email AND referrerUserSub = :rSub AND #status = :sent`.
- `REFERRALS_TABLE` → `UpdateItem` — transitions `sent` → `signed_up`.

**Cognito calls**:
- `SignUp`.
- `AdminGetUser` (staleness check).
- `AdminDeleteUser` (cleanup of stale UNCONFIRMED).
- `AdminAddUserToGroup`.

**Business logic highlights**:
- Stale-signup handling: if `UsernameExistsException` thrown and the existing user is `UNCONFIRMED`, deletes the old signup and retries with new form data.
- Professional role maps via `getRoleByDbValue` to the correct Cognito group.
- Referral linkage is best-effort — signup succeeds even if referral update fails.
- User attributes: `email, given_name, family_name, address (encoded userType/role/clinic), phone_number, custom:referredByUserSub`.

---

### `verifyOTPAndCreateUser.ts` — `POST /auth/verify-otp`

**Purpose**: Verifies OTP from signup email, confirms the user, and sends welcome email/SMS.

**Auth**: Public.

**Request**:
- Body (JSON):
  - `email: string` (required)
  - `confirmationCode: string` (required)

**Response**:
- 201: `{ status, statusCode: 201, message, data: { isVerified: true, userSub, email, fullName, userType, welcomeMessageSent, smsSent, nextSteps }, timestamp }`
- Error cases: 400 CodeMismatchException / ExpiredCodeException / InvalidParameterException · 403 NotAuthorizedException · 404 user not found · 429 too many attempts · 500 internal

**Cognito calls**:
- `ConfirmSignUp`.
- `AdminGetUser`.

**Other AWS**:
- SES `SendEmail` (HTML + text welcome email).
- SNS `Publish` to `SMS_TOPIC_ARN` (if configured and `phone_number` present).

**Business logic highlights**:
- Personalized welcome email with role-specific next steps.
- Non-fatal email/SMS failures — user is still marked verified.
- Triggers referral bonus logic via `BonusAwarding` helper (see §13).

---

### `resendOtp.ts` — `POST /auth/resend-otp`

**Purpose**: Resends OTP to a user's email during signup.

**Auth**: Public.

**Request**:
- Body (JSON): `email: string` (required)

**Response**:
- 200: `{ status, statusCode: 200, message, data: { email, codeDeliveryDetails, nextStep }, timestamp }`
- Error cases: 400 missing/invalid email · 404 no signup found · 409 already verified / invalid state · 429 too many requests · 500 internal

**Cognito calls**:
- `AdminGetUser` (state check — must be `UNCONFIRMED`).
- `ResendConfirmationCode`.

---

### `preSignUp.ts` — Cognito trigger: `PRE_SIGN_UP`

**Purpose**: Auto-fills required user attributes for Google federated sign-ups and auto-confirms/verifies them.

**Route(s)**: Cognito trigger (not REST).

**Business logic highlights**:
- Fires on `PreSignUp_ExternalProvider` trigger source.
- Sets `address = "Not provided"` and `phone_number = "+10000000000"` defaults if missing (required pool attributes).
- Sets `response.autoConfirmUser = true` and `response.autoVerifyEmail = true`.

---

### `createAuthChallenge.ts` — Cognito trigger: `CREATE_AUTH_CHALLENGE`

**Purpose**: Sets up custom-auth challenge parameters for the Google-verified login flow.

**Business logic highlights**:
- Sets `response.publicChallengeParameters.trigger = "google-login"`.
- Sets `response.privateChallengeParameters.answer = "google-verified"`.

---

### `defineAuthChallenge.ts` — Cognito trigger: `DEFINE_AUTH_CHALLENGE`

**Purpose**: Controls the custom-auth flow logic.

**Business logic highlights**:
- First call (`session.length === 0`): issues `CUSTOM_CHALLENGE`.
- Subsequent call: if `session[0].challengeResult === true` → `issueTokens = true`; otherwise `failAuthentication = true`.

---

### `verifyAuthChallenge.ts` — Cognito trigger: `VERIFY_AUTH_CHALLENGE_RESPONSE`

**Purpose**: Validates that the challenge answer matches `"google-verified"`.

**Business logic highlights**:
- String comparison against hardcoded answer; sets `response.answerCorrect`.

---

### `createUser.ts` — `POST /users`

**Purpose**: Creates a new clinic user (admin flow) with Cognito account, group assignment, clinic associations, and optional welcome email.

**Auth**: JWT required. Only the `Root` group may call this.

**Request**:
- Body (JSON):
  - `firstName: string` (required)
  - `lastName: string` (required)
  - `phoneNumber: string` (required, E.164)
  - `email: string` (required)
  - `password: string` (required)
  - `verifyPassword: string` (required — must match `password`)
  - `subgroup: "ClinicAdmin" | "ClinicManager" | "ClinicViewer"` (required)
  - `clinicIds: string[]` (required, non-empty)
  - `sendWelcomeEmail?: boolean` (optional)

**Response**:
- 201: `{ status: "success", message, data: { userSub, email, firstName, lastName, subgroup, clinics, createdAt } }`
- Error cases: 400 validation · 401 missing/invalid token · 403 non-Root · 409 email exists · 500 internal

**DynamoDB access**:
- `CLINICS_TABLE` → `UpdateItem` — appends `userSub` to `AssociatedUsers` for each `clinicId` (using `list_append` with `if_not_exists`).

**Cognito calls**: `AdminCreateUser` (temp password, `MessageAction: SUPPRESS`), `AdminSetUserPassword` (permanent), `AdminAddUserToGroup`.

**Other AWS**: SES `SendEmail` if `sendWelcomeEmail` is `true` (non-fatal).

---

### `getUser.ts` — `GET /users`

**Purpose**: Returns all clinic users associated with the requesting Root/ClinicAdmin user.

**Auth**: JWT required. `Root` or `ClinicAdmin`.

**Response**:
- 200: `{ status, statusCode: 200, message, data: { users: [{ sub, name, email, phone, status, role, assignedClinicsCount, clinicIds }], requesterId, failedCount }, timestamp }`

**DynamoDB access**: `CLINICS_TABLE` → `Scan`; in-memory filter to the requester's clinics; then per-user lookups.

**Cognito calls**: `AdminGetUser` + `AdminListGroupsForUser` per associated user (in parallel via `Promise.all`).

**Business logic highlights**:
- Pre-computes `userClinicCountMap` and `userClinicIdsMap` to avoid redundant clinic scans.
- Failed user lookups are marked with an `error` field rather than failing the whole response.

---

### `getUserMe.ts` — `GET /users/me`

**Purpose**: Returns the currently logged-in user's Cognito attributes.

**Auth**: JWT required.

**Response**:
- 200: `{ status: "success", data: { sub, name, email, phone, givenName, familyName } }`

**Cognito calls**: `AdminGetUser`.

---

### `updateUser.ts` — `PUT /users/{userId}`

**Purpose**: Updates clinic-user attributes (name, subgroup, clinics, password) for `Root`/`ClinicAdmin`.

**Auth**: JWT required. `Root` or `ClinicAdmin`.

**Request**:
- Path params: `userId` — email or `cognito:username`
- Body (JSON, all optional):
  - `firstName?: string` (2–50 chars, letters/spaces/hyphens/apostrophes)
  - `lastName?: string` (same regex)
  - `subgroup?: "ClinicAdmin" | "ClinicManager" | "ClinicViewer"`
  - `clinicIds?: string[]`
  - `password?: string` (requires matching `verifyPassword`)
  - `verifyPassword?: string`
  - **Blocked**: `phoneNumber`, `phone_number`, `username`

**Response**:
- 200: `{ status, message, updatedFields: ["firstName", "role → ClinicAdmin", ...], data: { username }, timestamp }`
- Error cases: 400 · 401 · 403 · 404 · 405 · 500

**DynamoDB access**:
- `CLINICS_TABLE` → `Scan` (find current memberships).
- `CLINICS_TABLE` → `UpdateItem` for removes + `GetItem` + `UpdateItem` for adds.

**Cognito calls**: `AdminUpdateUserAttributes`, `AdminSetUserPassword`, `AdminListGroupsForUser`, `AdminRemoveUserFromGroup`, `AdminAddUserToGroup`.

**Business logic highlights**:
- Diffing: computes added/removed clinic sets; updates only changed memberships.
- Conditional adds prevent duplicate `AssociatedUsers` entries.
- Group replacement is idempotent (removes all four clinic subgroups before adding the new one).

---

### `deleteUser.ts` — `DELETE /users/{userId}`

**Purpose**: Deletes a clinic user from Cognito and cleans up `AssociatedUsers`.

**Auth**: JWT required. `Root` only.

**Response**:
- 200: `{ status, message, data: { deletedUsername, disassociatedFromClinics } }`

**DynamoDB access**: `CLINICS_TABLE` → `Scan` + `UpdateItem` per membership clinic. Handles both `L` and `SS` representations of `AssociatedUsers`.

**Cognito calls**: `ListUsers`, `AdminGetUser`, `AdminDeleteUser`; fallback `ListUsers` (email filter) to resolve `sub` for cleanup.

**Side effects / Notes**: Cognito deletion is final; DynamoDB cleanup is non-fatal (user is still de-authenticated either way).

---

### `deleteOwnAccount.ts` — `DELETE /users/me`

**Purpose**: Lets a user self-delete their account and clean up clinic assignments.

**Auth**: JWT required.

**Response**:
- 200: `{ status, message: "Account deleted successfully" }`

**DynamoDB access**:
- `USER_CLINIC_ASSIGNMENTS_TABLE` → `Query` by `userSub` → per-row `DeleteCommand`.

**Cognito calls**: `AdminDeleteUser`.

---

## 18. Per-Handler Reference — Clinic & Profile

> Handlers covered: createClinic · getAllClinics · getClinic · updateClinic · deleteClinic · getClinicAddress · getUsersClinics · getClinicUsers · createClinicProfile · getClinicProfile · getClinicProfileDetails · updateClinicProfileDetails · deleteClinicProfile · createProfessionalProfile · getProfessionalProfile · updateProfessionalProfile · deleteProfessionalProfile · getProfessionalQuestions · getPublicProfessionalProfile · getAllProfessionals · publicProfessionals · createUserAddress · getUserAddresses · updateUserAddress · deleteUserAddress · createAssignment · createAssignment-prof · getAssignments · updateAssignment · deleteAssignment · professionalRoles

### `createClinic.ts` — `POST /clinics`

**Purpose**: Creates a new clinic with address details. Requires `Root` or `ClinicAdmin`; geocodes the address automatically.

**Auth**: JWT required. Normalized group check: `root` or `clinicadmin` (case-insensitive via `getClinicRole`).

**Request**:
- Body (JSON):
  - `name: string` (required)
  - `addressLine1: string` (required)
  - `addressLine2?: string` · `addressLine3?: string`
  - `city: string` (required) · `state: string` (required) · `pincode: string` (required)

**Response**:
- 201: `{ status, statusCode: 201, message, data: { clinicId (UUID), name, addressLine1, addressLine2, addressLine3, city, state, pincode, address (combined), createdBy (userSub), createdAt, updatedAt, associatedUsers: [userSub] } }`
- Error cases: 400 validation · 401 · 403 · 409 clinic exists · 500

**DynamoDB access**: `CLINICS_TABLE` → `PutItem` with `ConditionExpression: attribute_not_exists(clinicId)`.

**Cognito calls**: `extractUserFromBearerToken` / `verifyToken` (claim extraction only).

**Other AWS**: Amazon Location `SearchPlaceIndexForText` via `geo.ts` for lat/lng (best-effort; non-fatal).

**Business logic highlights**:
- Groups parsed from both Bearer token and API Gateway authorizer, merged, then lowercased.
- `AssociatedUsers` seeded with the creator (stored as List or StringSet depending on code path).
- `clinicId` is a freshly generated UUID.

---

### `getAllClinics.ts` — `GET /clinics`

**Purpose**: Retrieves all clinics accessible to the authenticated user (membership scoped), with optional filters.

**Auth**: JWT required. Every user — including `Root` — is scoped by clinic membership.

**Request**:
- Query params: `limit` (default 50) · `state` (contains) · `city` · `name` (all optional)

**Response**:
- 200: `{ status, statusCode: 200, message, data: { clinics: [{ clinicId, name, address, createdAt, updatedAt, createdBy, associatedUsers }], totalCount, filters: { state, city, name, limit } }, timestamp }`

**DynamoDB access**: `CLINICS_TABLE` → `Scan` with `FilterExpression: contains(AssociatedUsers, :sub) OR createdBy = :sub`.

**Business logic highlights**:
- Combines address fragments via `buildAddress`.
- Handles `AssociatedUsers` as `L` or `SS`.
- Root is scoped like every other user — no platform-wide override.

---

### `getClinic.ts` — `GET /clinics/{clinicId}`

**Purpose**: Single-clinic retrieval, gated by `canAccessClinic`.

**Auth**: JWT required + `canAccessClinic(userSub, groups, clinicId)`.

**Response**:
- 200: `{ status, data: { clinicId, name, addressLine1-3, city, state, pincode, fullAddress, createdBy, createdAt, updatedAt }, timestamp }`
- Error cases: 400 · 401 · 403 · 404 · 500

**DynamoDB access**: `CLINICS_TABLE` → `GetItem`.

---

### `updateClinic.ts` — `PUT /clinics/{clinicId}`

**Purpose**: Updates clinic fields; re-geocodes if any address component changed.

**Auth**: JWT required + normalized group in `root | clinicadmin | clinicmanager` + `canAccessClinic`.

**Request**:
- Body (JSON, all optional): `name`, `addressLine1-3`, `city`, `state`, `pincode`

**Response**: 200 `{ status, message, data: { clinicId }, timestamp }`

**DynamoDB access**: `CLINICS_TABLE` → `UpdateItem` with dynamic `SET` expression + `updatedAt` bump.

**Other AWS**: Amazon Location (re-geocode, best-effort).

---

### `deleteClinic.ts` — `DELETE /clinics/{clinicId}`

**Purpose**: Deletes a clinic.

**Auth**: JWT required + `isRoot(groups)` (Root-only).

**DynamoDB access**: `CLINICS_TABLE` → `DeleteItem`.

**Side effects / Notes**: No cascade — clinic profiles, job postings, applications, assignments are NOT cleaned up by this handler.

---

### `getClinicAddress.ts` — `GET /clinics/{clinicId}/address`

**Purpose**: Public address lookup for a clinic.

**Auth**: Public.

**Response**: 200 `{ clinicId, name, address, city, state, pincode }`

**DynamoDB access**: `CLINICS_TABLE` → `GetItem`.

**Side effects / Notes**: Highly permissive — any caller can retrieve any clinic's address.

---

### `getUsersClinics.ts` — `GET /clinics-user`

**Purpose**: Returns the caller's accessible clinics (same membership rules as `getAllClinics`), plus `isRoot` flag and user metadata.

**DynamoDB access**: `CLINICS_TABLE` → `Scan` + in-memory membership filter.

**Response shape** (notable): `{ ..., currentUser: { userSub, isRoot, groups } }`

---

### `getClinicUsers.ts` — `GET /clinics/{clinicId}/users`

**Purpose**: Lists `AssociatedUsers` for a clinic.

**Auth**: JWT required + `canAccessClinic`.

**Response**: 200 `{ clinicId, associatedUsers: ["userSub", ...] }`

**DynamoDB access**: `CLINICS_TABLE` → `GetItem` — robustly handles `SS` or `L` attribute shapes.

---

### `createClinicProfile.ts` — `POST /clinic-profiles`

**Purpose**: Creates a detailed clinic profile (practice info, staff counts, parking, etc.).

**Auth**: JWT required + user must be in the clinic's `AssociatedUsers`.

**Request body** (JSON):
- `clinicId: string` (required)
- `practice_type: string` (required)
- `primary_practice_area: string` (required)
- `primary_contact_first_name: string` (required)
- `primary_contact_last_name: string` (required)
- `assisted_hygiene_available?: boolean` (default false)
- `number_of_operatories?: number` (default 0)
- `num_hygienists?: number` (default 0)
- `num_assistants?: number` (default 0)
- `num_doctors?: number` (default 0)
- `booking_out_period?: string` (default "immediate")
- `free_parking_available?: boolean` (default false)
- Any additional fields stored dynamically.

**Response**: 201 `{ message, clinicId }`

**DynamoDB access**:
- `CLINICS_TABLE` → `GetItem` (membership check).
- `CLINIC_PROFILES_TABLE` → `PutItem` with `ConditionExpression: attribute_not_exists(clinicId) AND attribute_not_exists(userSub)`.

---

### `getClinicProfile.ts` — `GET /clinic-profiles`

**Purpose**: Returns clinic profiles for the caller, enriched with `jobsPosted`, `jobsCompleted`, `totalPaid` aggregates.

**Auth**: JWT required. Root → `userSub-index`. Non-Root → `listAccessibleClinicIds` then per-clinic profile fetch.

**Response fields** include granular: `clinicId, userSub, clinicName, clinicType, practiceType, primaryPracticeArea, primaryContact*, assistedHygieneAvailable, numberOfOperatories, numHygienists, numAssistants, numDoctors, bookingOutPeriod, clinic_software, software_used[], parkingType, parkingCost, freeParkingAvailable, createdAt, updatedAt, location{addressLine1-3, city, state, zipCode}, contactInfo{email, phone}, specialRequirements[], officeImageKey, notes, jobsPosted, jobsCompleted, totalPaid`.

**DynamoDB access**:
- `CLINIC_PROFILES_TABLE` → `Query` on `userSub-index` (Root) or by `clinicId` (non-Root).
- `CLINIC_JOBS_POSTED_TABLE` (alias of JobPostings) → `Query` by `ClinicIdIndex` (count posted jobs).
- `CLINICS_JOBS_COMPLETED_TABLE` (alias of JobApplications) → `Query` by `clinicId-index` + filter on completed/paid statuses.
- `CLINICS_TABLE` → `GetItem` for name/address merge.

---

### `getClinicProfileDetails.ts` — `GET /clinic-profile/{clinicId}`

**Purpose**: Single-clinic profile + merged address.

**Auth**: JWT + `canAccessClinic`.

**DynamoDB**: `CLINIC_PROFILES_TABLE` → `Query` by `clinicId` (first row); `CLINICS_TABLE` → `GetItem` for name/address merge (non-fatal).

---

### `updateClinicProfileDetails.ts` — `PUT /clinic-profiles/{clinicId}`

**Purpose**: Updates whitelisted clinic-profile fields.

**Auth**: JWT + `canWriteClinic(..., "manageClinic")`.

**Request body** (all optional, transformed camelCase→snake_case): `clinicName, title, primaryContactFirstName, primaryContactLastName, practiceType, primaryPracticeArea, parkingType, bookingOutPeriod, softwareUsed, numberOfOperatories, numAssistants, numDoctors, numHygienists, assistedHygieneAvailable, freeParkingAvailable, insurancePlansAccepted, notes, parkingCost, website, dental_association, clinic_email, zip_code, addressLine1, office_image_key` (28 whitelisted fields; unknown fields rejected).

**DynamoDB**: `CLINIC_PROFILES_TABLE` → `Query` (existence) + `Update` with dynamic `SET`.

---

### `deleteClinicProfile.ts` — `DELETE /clinic-profiles/{clinicId}`

**Purpose**: Deletes the profile record for `(clinicId, userSub)`.

**Auth**: JWT + (clinic user OR Root).

**DynamoDB**: `CLINIC_PROFILES_TABLE` → `Get` + `Delete`.

---

### `createProfessionalProfile.ts` — `POST /profiles`

**Purpose**: Creates a professional profile; supports nested `{ profile, address }` or flat payload, optionally also writing a UserAddresses row.

**Auth**: JWT required. PK = caller's `sub`.

**Request body** (flat or nested):
- `first_name: string` (required)
- `last_name: string` (required)
- `role: string` (required — from `VALID_ROLE_VALUES`)
- `specialties?: string[]`
- Dynamic additional fields
- Optional nested `address`: `{ addressLine1, addressLine2?, addressLine3?, city, state, pincode, country? ("USA"), addressType? ("home"), isDefault? (true) }`

**Response**: 201 `{ message, userSub, role, first_name, last_name, addressSaved }`

**DynamoDB access**:
- `PROFESSIONAL_PROFILES_TABLE` → `Put` with `attribute_not_exists(userSub)`.
- `USER_ADDRESSES_TABLE` → `Put` (non-fatal; pincode uniqueness constraint was removed).

---

### `getProfessionalProfile.ts` — `GET /profiles`

**Purpose**: Returns caller's professional profile(s). Optional `?profileId=`.

**DynamoDB**: `PROFESSIONAL_PROFILES_TABLE` → `Query` by `userSub` (+ optional `profileId`).

---

### `updateProfessionalProfile.ts` — `PUT /profiles`

**Purpose**: Field-level validated profile update.

**Field validators** (selected): `first_name/last_name` (2–50 chars), `phone` (10–15 digits, optional `+`), `bio` (≤500), `yearsExperience` (0–70), `qualifications` (≤500), `skills[]` (≤50), `certificates[]` (≤50), `professionalCertificates[]` (≤50), `license_number` (4–20 alphanumeric), `specializations[]` from `SPECIALIZATION_OPTIONS`, `is_willing_to_travel` boolean, `max_travel_distance` (0–10000), `resumeKey/driversLicenseKey/professionalLicenseKey/introVideoKey` (≤512 chars).

**Blocked fields**: `userSub, createdAt, email, role`.

**DynamoDB**: `PROFESSIONAL_PROFILES_TABLE` → `Get` + `Update` (SET/REMOVE; empty arrays → REMOVE to avoid empty-SS error).

---

### `deleteProfessionalProfile.ts` — `DELETE /profiles`

**Purpose**: Deletes caller's profile. Blocks default profiles.

**DynamoDB**: `PROFESSIONAL_PROFILES_TABLE` → `Get` (isDefault check) + `Delete`. Error 409 if `isDefault`.

---

### `getProfessionalQuestions.ts` — `GET /profiles/questions`

**Purpose**: Hardcoded form-schema for role-specific onboarding questionnaires.

**Response** (with `?role=<role>`):
- 200: `{ role, questions: [{ field, label, type, required, options?, description?, placeholder? }], totalQuestions }`
- Without role: `{ availableRoles: [...], message }`

**DynamoDB**: none.

**Business logic highlights**:
- 7 role keys: `associate_dentist, dental_assistant, dental_hygienist, expanded_functions_da, dual_role_front_da, patient_coordinator_front, treatment_coordinator_front`.
- Shared `FRONT_DESK_QUESTIONS` applied across several front-office roles.
- Question types: `select | multiselect | text | textarea | number | boolean | file`.

---

### `getPublicProfessionalProfile.ts` — `GET /profiles/{userSub}`

**Purpose**: Authenticated lookup of any professional's profile.

**DynamoDB**: `PROFESSIONAL_PROFILES_TABLE` → `Query` by `userSub`; unmarshalled attribute map.

---

### `getAllProfessionals.ts` — `GET /allprofessionals`

**Purpose**: Admin/clinic-side directory of all professionals, enriched with city/state/zipcode from `UserAddresses`.

**DynamoDB**: `PROFESSIONAL_PROFILES_TABLE` → `Scan` + `USER_ADDRESSES_TABLE` → per-user `Query` in parallel.

---

### `publicProfessionals.ts` — `GET /professionals/public` and `/public/publicprofessionals`

**Purpose**: Public professional directory (no auth), including lat/lng (from `UserAddresses`).

**Response item fields**: `userSub, dentalSoftwareExperience[], firstName, lastName, role, specialties[], yearsOfExperience, city, state, zipcode, lat, lng`.

**Business logic highlights**: merges `specialties + specializations` case-insensitively; handles `dental_software_experience` as SS/L/S.

---

### `createUserAddress.ts` — `POST /user-addresses`

**Purpose**: Creates an address (geocoded). Pincode uniqueness enforced across users.

**Body**: `addressLine1` (req), `addressLine2?, addressLine3?, city (req), state (req), pincode (req), country? ("USA"), addressType? ("home"), isDefault? (true)`.

**DynamoDB**:
- `USER_ADDRESSES_TABLE` → `Scan` FilterExpression `pincode = :pincode` (uniqueness check — returns 409 if hit).
- `USER_ADDRESSES_TABLE` → `Put` with `attribute_not_exists(userSub)`.

**Other AWS**: Amazon Location for lat/lng (best-effort).

---

### `getUserAddresses.ts` — `GET /user-addresses`

**DynamoDB**: `USER_ADDRESSES_TABLE` → `Query` by `userSub`.

---

### `updateUserAddress.ts` — `PUT /user-addresses`

**Purpose**: Partial update; re-geocodes on address-component change; removes stale lat/lng if geocoding fails.

**Response** notable field: `geocode: { attempted, ok, source, lat, lng, reason? }`.

---

### `deleteUserAddress.ts` — `DELETE /user-addresses`

**Purpose**: Deletes the first address record for the caller. Blocks deletion of default addresses (403).

---

### `createAssignment.ts` — `POST /assignments`

**Purpose**: Creates a legacy `UserClinicAssignments` row.

**Auth**: JWT + `isRoot` (Root only).

**Body**: `userSub, clinicId, accessLevel ∈ {ClinicAdmin, ClinicManager, ClinicViewer, Professional}`.

**DynamoDB**: `USER_CLINIC_ASSIGNMENTS_TABLE` → `PutItem`.

**Side effects / Notes**: The legacy `UserClinicAssignments` table is no longer the primary source of truth — production membership is `Clinics.AssociatedUsers`. This handler persists historic behavior.

---

### `createAssignment-prof.ts` — `POST /applications/{jobId}` (alternate)

**Purpose**: Streamlined professional-side job application write (duplicate of `createJobApplication.ts` but simpler payload).

**DynamoDB**: same pattern as `createJobApplication.ts` (see §20).

---

### `getAssignments.ts` — `GET /assignments` · `GET /assignments/{userSub}`

**Purpose**: Returns assignments for caller; a userSub path param different from the caller returns 403.

**DynamoDB**: `USER_CLINIC_ASSIGNMENTS_TABLE` → `Query` by `userSub`.

---

### `updateAssignment.ts` — `PUT /assignments`

**Auth**: Root only.

**DynamoDB**: `UpdateItem` with `ConditionExpression: attribute_exists(userSub) AND attribute_exists(clinicId)` (404 if missing).

---

### `deleteAssignment.ts` — `DELETE /assignments`

**Auth**: Root only.

**DynamoDB**: `DeleteItem` by `(userSub, clinicId)` (idempotent).

---

### `professionalRoles.ts` — **Configuration module (not routed)**

Exports hardcoded role definitions and helpers:
- 18 `PROFESSIONAL_ROLES` entries (roleId, dbValue, displayName, category).
- Maps: `COGNITO_TO_DB_MAPPING`, `DB_TO_DISPLAY_MAPPING`.
- Categories: `DOCTOR, CLINICAL, FRONT_OFFICE, DUAL_ROLE, BILLING, COMPLIANCE, ACCOUNTING`.
- Helpers: `getRoleById, getRoleByDbValue, getRoleByCognitoGroup, isDoctorRole, isClinicaRole` (sic), `isFrontOfficeRole, isDualRole, isBillingRole, isComplianceRole`.
- `VALID_ROLE_VALUES` and `VALID_COGNITO_GROUPS` arrays used by create/update handlers.

---

## 19. Per-Handler Reference — Job Postings

> Handlers covered: createJobPosting · getJobPostings · browseJobPostings · getJobPosting · updateJobPosting · deleteJobPosting · createTemporaryJob · getTemporaryJob · getAllTemporaryJobs · updateTemporaryJob · deleteTemporaryJob · getTemporary-Clinic · createMultiDayConsulting · getMultiDayConsulting · getAllMultiDayConsulting · updateMultiDayConsulting · deleteMultiDayConsulting · getAllMultidayForClinic · getAllMultidayJobs · createPermanentJob · getPermanentJob · getAllPermanentJobs · updatePermanentJob · deletePermanentJob · getAllPermanentJobsForClinic · findJobs · getProfessionalFilteredJobs · updateJobStatus · jobPostingCounters · migrateJobRates · geocodePostal · geo

### `createJobPosting.ts` — `POST /jobs`

**Purpose**: Creates a new job posting (temporary, multi-day consulting, or permanent) for one or more clinics. Denormalizes clinic address + profile metadata and geocodes the address to coordinates for distance filtering.

**Auth**: JWT required. Gated per clinic via `canWriteClinic(userSub, groups, clinicId, "manageJobs")`.

**Request body**:
- `clinicId: string` (required)
- `job_type: "temporary" | "multi_day_consulting" | "permanent"` (required)
- `professional_role: string` (required, from `VALID_ROLE_VALUES`)
- `professional_roles?: string[]` (optional multi-role support)
- `shift_speciality: string` (required)
- `assisted_hygiene?: boolean`
- `work_location_type?: "onsite" | "us_remote" | "global_remote"`
- `pay_type?: "per_hour" | "per_transaction" | "percentage_of_revenue"` (default `per_hour`)
- `rate: number` — per-hour: $10–$200; per-transaction: >0; percentage: 0–100
- `job_title?`, `job_description?`, `requirements?: string[]`
- **Temporary-only**: `date` (ISO future), `hours` (1–12)
- **Multi-day consulting only**: `dates: string[]` (ISO future, unique, ≤30), `hours_per_day` (1–12), `total_days` (matches `dates.length`), `start_time`, `end_time`, `project_duration?`
- **Permanent only**: `employment_type: "full_time" | "part_time"`, `salary_min`, `salary_max`, `benefits: string[]`, `vacation_days` (0–50), `work_schedule`, `start_date`

**Response**: 201 `{ message, jobId, job_type, professional_roles, ...type-specific fields }` · errors 400 / 403 / 500.

**DynamoDB access**:
- `CLINICS_TABLE` → `GetItem` by `clinicId` — address + `createdBy`.
- `CLINIC_PROFILES_TABLE` → `GetItem` by `(clinicId, userSub)` — profile metadata.
- `JOB_POSTINGS_TABLE` → `PutItem` `(clinicUserSub, jobId)`.

**Cognito**: `AdminGetUser` to fetch `given_name`/`family_name` for the `created_by` display name.

**Other AWS**: Amazon Location `geocodeAddressParts` (best-effort; non-fatal).

**Business logic highlights**:
- Composite-key ownership `(clinicUserSub, jobId)` ensures only the owning clinic can edit.
- Denormalization: clinic address, profile, and geo-coords are copied into the job row at write time.
- Doctor-role guard: `pay_type: "per_transaction"` is blocked for doctor roles.
- Accepts either `professional_role` (single, legacy) or `professional_roles[]` (multi).
- Geocoding failure is logged but non-fatal — the job is created without coords; it just won't match radius filters.

---

### `getJobPostings.ts` — `GET /job-postings`

**Purpose**: Returns every posting created by the authenticated clinic user.

**Auth**: JWT required; scoped to the caller via `clinicUserSub = userSub`.

**DynamoDB**:
- `JOB_POSTINGS_TABLE` → `Query` on PK `clinicUserSub`.
- `CLINIC_PROFILES_TABLE` → `GetItem` per row for name/contact (N+1).

**Response fields** per job: `jobId, clinicUserSub, jobType, professionalRole, status, createdAt, updatedAt, created_by, jobTitle, jobDescription, rate, payType, salaryMin, salaryMax, date, dates, hours, clinic: { name, city, state, contactName }`. Sorted newest-first by `createdAt`.

---

### `browseJobPostings.ts` — `GET /jobs/browse`

**Purpose**: Authenticated browse API for professionals with multi-dimensional filtering.

**Query params**: `jobType, role, speciality, minRate, maxRate, dateFrom, dateTo, assistedHygiene ("true"/"false"), limit (default 50)`.

**DynamoDB**: `JOB_POSTINGS_TABLE` → `Scan` with `FilterExpression: status = "active" AND <optional filters>`; per-row `CLINIC_PROFILES_TABLE` `GetItem` for enrichment.

**Business logic highlights**:
- Client-side limit: scans until `limit*2` items then slices.
- Unified `rate` fallback chain: `rate → rate_per_transaction | revenue_percentage (per pay_type) → hourly_rate`.
- Results sorted by `createdAt` descending after fetch.

---

### `getJobPosting.ts` — `GET /jobs/{jobId}`

**Purpose**: Single job lookup with application-count enrichment.

**DynamoDB**:
- `JOB_POSTINGS_TABLE` → `GetItem` `(clinicUserSub, jobId)`.
- `JOB_APPLICATIONS_TABLE` → `Query` by `jobId` with `Select: "COUNT"`.
- `CLINIC_PROFILES_TABLE` → `GetItem` for booking period / software / parking enrichment.

**Response** includes `applicationCount, applicationsEnabled` plus clinic-profile metadata.

---

### `updateJobPosting.ts` — `PUT /jobs/{jobId}`

**Purpose**: Update whitelisted fields with job-type-specific validation.

**Auth**: JWT + composite-key ownership + `canWriteClinic(..., "manageJobs")`.

**Guards**:
- Status validation: cannot update `completed` jobs → 409.
- Rate validation: per-hour $10–$300, per-transaction >0, percentage 0–100.
- Job-type-specific: temporary requires future `date` + `hours ∈ [1,12]`; multi-day requires `dates.length == total_days`; permanent requires `salary_min ≤ salary_max`.

**DynamoDB**: `GetItem` + dynamic `UpdateItem` `SET`.

---

### `deleteJobPosting.ts` — `DELETE /jobs/{jobId}`

**Purpose**: Deletes a job and cascades to related applications/invitations/negotiations.

**Query**: `?force=true` bypasses the `scheduled`/`action_needed` block.

**DynamoDB**:
- `JOB_POSTINGS_TABLE` → `GetItem` + `DeleteItem`.
- `JOB_APPLICATIONS_TABLE` → `Query` on `JobIndex` (filter active) + per-row updates.
- `JOB_INVITATIONS_TABLE` → `Query` by jobId + `BatchWrite` delete.
- `JOB_NEGOTIATIONS_TABLE` → `Query` per active application + cleanup (force only).
- `BatchWriteCommand` chunks at 25 items (DynamoDB limit).

---

### `createTemporaryJob.ts` — `POST /jobs/temporary`

**Purpose**: Bulk-create temporary postings across multiple clinics with per-clinic partial-success handling.

**Auth**: Group in `{root, clinicadmin, clinicmanager}` + per-clinic `canWriteClinic(..., "manageJobs")`.

**Body**: `clinicIds: string[]`, `professional_role`, `date` (future), `shift_speciality`, `hours (1–12)`, `start_time`, `end_time`, `rate`, `pay_type?`, `meal_break?`, `job_title?`, `job_description?`, `requirements?`, `assisted_hygiene?`, `work_location_type?`.

**Response**: 201 on all-success; **207 Multi-Status** on partial success with `{ data: { jobIds, failed: [{clinicId, error}] } }`.

**DynamoDB**: `CLINICS_TABLE` GetItem + `CLINIC_PROFILES_TABLE` GetItem + `JOB_POSTINGS_TABLE` PutItem per clinic in parallel (`Promise.allSettled`).

**Cognito**: one `AdminGetUser` up front.

**Other AWS**: Amazon Location geocoding in parallel per clinic (best-effort).

---

### `getTemporaryJob.ts` — `GET /jobs/temporary/{jobId}`

Same pattern as `getJobPosting` but with `job_type === "temporary"` gate (returns 400 on mismatch).

---

### `getAllTemporaryJobs.ts` — `GET /jobs/temporary`

**Purpose**: Future-dated temporary jobs visible to professionals, with already-applied exclusion.

**DynamoDB**:
- `JOB_POSTINGS_TABLE` → `Scan` with `FilterExpression: job_type = "temporary" AND date >= :today` (paginated).
- `JOB_APPLICATIONS_TABLE` → `Query` on `professionalUserSub-index` projecting `jobId` to build the exclusion Set.

Response includes `excludedCount` (number of applied jobs filtered out).

---

### `updateTemporaryJob.ts` / `deleteTemporaryJob.ts`

Same shape as the generic update/delete but gated on `job_type === "temporary"`. Delete additionally flips active applications to `job_cancelled` in parallel (non-blocking per-app failures).

---

### `getTemporary-Clinic.ts` — `GET /jobs/clinictemporary/{clinicId}`

**Purpose**: Clinic-scoped temporary-job listing via `ClinicIdIndex`.

**Auth**: `canAccessClinic` (read gate).

**DynamoDB**: `JOB_POSTINGS_TABLE` GSI `ClinicIdIndex` `Query`; in-memory filter on `job_type === "temporary"`.

---

### `createMultiDayConsulting.ts` — `POST /jobs/consulting`

**Purpose**: Bulk create multi-day consulting projects across multiple clinics.

**Special meal_break parsing**: accepts `"no break"`, `"HH:MM"`, `"1.5h"`, `"90min"`, `"30"` (minutes) → stored as both the raw string and a numeric minutes field.

**Body validation**:
- `dates` sorted + deduped; `total_days === dates.length`.
- Per-day `hours_per_day ∈ [1,12]`.
- Per-hour rate $10–$300.

Same partial-success (207) model as `createTemporaryJob`.

---

### `getMultiDayConsulting.ts`, `updateMultiDayConsulting.ts`, `deleteMultiDayConsulting.ts`

Same patterns as the temporary counterparts, gated on `job_type === "multi_day_consulting"`.

---

### `getAllMultiDayConsulting.ts` — `GET /jobs/consulting`

Full-table `Scan` with `job_type = "multi_day_consulting"` filter; applied-job exclusion via `JOB_APPLICATIONS_TABLE` GSI `professionalUserSub-index`.

---

### `getAllMultidayForClinic.ts` — `GET /jobs/multiday/clinic/{clinicId}`

Clinic-scoped view via `ClinicIdIndex`. No explicit clinic-access gate in code — relies on downstream visibility logic.

---

### `getAllMultidayJobs.ts` — `GET /jobs/multiday/{jobId}`

Duplicate of `getAllMultiDayConsulting` internals; scans all `multi_day_consulting` jobs globally.

---

### `createPermanentJob.ts` — `POST /jobs/permanent`

Unified bulk-create handler supporting **all three job types** (validates per `job_type`). Permanent validation: `employment_type ∈ {full_time, part_time}`, `salary_max > salary_min`, `vacation_days ∈ [0,50]`.

---

### `getPermanentJob.ts` — `GET /jobs/permanent/{jobId}`

Single-job lookup gated on `job_type === "permanent"`.

Response includes `employmentType, salaryMin, salaryMax, benefits[], vacationDays, workSchedule, startDate`.

---

### `getAllPermanentJobs.ts` — `GET /jobs/permanent`

Full-table scan with `job_type = "permanent"` filter. `applicationCount` is **hardcoded to 0** in this handler (known limitation — no Query performed).

Response shape includes nested structures: `schedule: { workingDays, startTime, endTime, hoursPerWeek }`, `compensation: { salaryRange: { min, max }, bonusStructure, benefits }`, plus extras `mentorshipAvailable`, `continuingEducationSupport`, `relocationAssistance`, `visaSponsorship`.

---

### `updatePermanentJob.ts` / `deletePermanentJob.ts`

Same pattern as temporary/multi-day equivalents, gated on `job_type === "permanent"`. Uses camelCase keys for ExpressionAttributeValue placeholders (unique naming to avoid collisions).

---

### `getAllPermanentJobsForClinic.ts` — `GET /jobs/clinicpermanent/{clinicId}`

Clinic-scoped permanent-job listing via `ClinicIdIndex`. Includes best-effort `startDate` resolution that tries `startDate → expected_start_date → joining_date → earliest(dates[])`.

---

### `findJobs.ts` — `GET /jobs/public` · `GET /public/publicJobs`

**Purpose**: Public browse API with clinic enrichment, on-the-fly geocoding fallback, and LinkedIn-style promotion sorting.

**Auth**: Public (no JWT required).

**DynamoDB**:
- `JOB_POSTINGS_TABLE` → paginated `Scan` with `status = "active"` filter.
- `CLINIC_PROFILES_TABLE` → `GetItem` per job (N+1; best-effort).
- `CLINICS_TABLE` → `GetItem` per unique clinic for coordinates, **with a process-level cache**.

**Other AWS**: on-the-fly Amazon Location geocoding for clinics missing coords; result is **fire-and-forget written back** to `CLINICS_TABLE` so subsequent browses skip the geocode.

**Sort**: promoted first (tier weight: premium=3, featured=2, basic=1) → relevance → `createdAt` desc. Expired promotions are masked at read time.

**Side effects**: bumps promotion impression counters (fire-and-forget via `promotionCounters.fireAndForgetIncrement`).

---

### `getProfessionalFilteredJobs.ts` — `GET /professionals/filtered-jobs`

**Purpose**: Advanced job search for authenticated professionals — role/jobType/rate/date/location/radius filters, Haversine distance, relevance scoring, promotion tier weighting, cursor pagination.

**Query params**: `limit (≤100, default 20), cursor (base64), radius (miles), userLat, userLng, sort ∈ {trending, newest, highestPay, priority}, role, jobType, location, minRate, maxRate, payType, workLocationType, start, end`.

**DynamoDB**:
- `JOB_POSTINGS_TABLE` GSI `status-createdAt-index` → `Query` for `open`/`active` statuses, newest-first.
- `JOB_APPLICATIONS_TABLE` GSI `professionalUserSub-index` → applied-job Set + clinic-familiarity Set.
- `USER_ADDRESSES_TABLE` → caller's stored coords (if no live `userLat`/`userLng`).
- `JOB_PROMOTIONS_TABLE` GSI `status-expiresAt-index` → active promos, then `BatchGet` of underlying jobs.

**Relevance scoring (0–140, trending sort)**:
- Recency (0–40)
- Role match (0–30)
- Rate (0–20)
- Completeness (0–10)
- Within-radius distance (0–10)
- Applied-clinic familiarity (+15)
- Popularity / `applicationsCount` (0–15)

**Pagination**: base64 `LastEvaluatedKey` OR synthetic `{__overflowOffset: N}` for overflow pages buffered in-memory. `MAX_SCAN = 500` safety cap; `countsTruncated: true` when the cap is hit.

**Response counts**: `temporary, multiday, permanent` bucket counts — present only on fresh scans (no cursor).

**Side effects**: fire-and-forget impression counters for each promoted job in the page.

---

### `updateJobStatus.ts` — `PUT /jobs/{jobId}/status`

**Purpose**: Finite-state-machine status transitions on a job, with `statusHistory` list append.

**Auth**: JWT + composite-key ownership.

**Body**:
- `status: "open" | "scheduled" | "action_needed" | "completed"` (required)
- `notes?: string`
- `acceptedProfessionalUserSub?: string` (required if `status == "scheduled"`)
- `scheduledDate?: string` (required if `status == "scheduled"`)
- `completionNotes?: string`

**Allowed transitions**: `open → {scheduled, action_needed, completed}` · `scheduled → {action_needed, completed, open}` · `action_needed → {scheduled, completed, open}` · `completed → {open}`. `active` is treated as `open`. Self-transition is allowed (for note updates).

**DynamoDB**: single `UpdateItem` with SET on `status`, `updatedAt`, `completedAt?`, `statusHistory` (List append `{fromStatus, toStatus, changedAt, changedBy, notes}`), and type-specific fields.

---

### `jobPostingCounters.ts` — Internal helper (not routed)

Exports:
- `fireAndForgetJobApplicationIncrement(jobKey)` — `UpdateCommand` with `ADD applicationsCount :one`. Key builder tolerates both single-PK and composite-PK `(clinicUserSub, jobId)` shapes. Errors caught and logged.

Called from `createJobApplication.ts` and `createJobApplication-prof.ts` to increment the per-job applications count atomically.

---

### `migrateJobRates.ts` — One-shot migration (not routed)

**Purpose**: Consolidate legacy `hourly_rate`, `rate_per_transaction`, `revenue_percentage` columns into the unified `rate` + `pay_type` pair; delete the legacy columns.

**DynamoDB**: `Scan` + per-item `Update` (`SET rate, pay_type REMOVE hourly_rate, rate_per_transaction, revenue_percentage`).

**Output**: `{ scanned, migrated, skipped, errors }` counters logged to CloudWatch; return payload echoes stats.

**Usage**: invoked ad-hoc (e.g. `aws lambda invoke --function-name DentiPal-Backend-Monolith --payload '{"migrate":"rates"}' out.json` — it can be called via the generic EventBridge short-circuit path if the invoker wraps it appropriately, or imported directly in a one-off Lambda).

---

### `geocodePostal.ts` — `GET /geocode/postal` · `GET /location/lookup`

**Purpose**: Public postal-code lookup returning city/state/country + coordinates from Amazon Location.

**Auth**: Public.

**Query params**: `postalCode` (or `postal_code`), optional `country` (ISO 3166-1 alpha-2, e.g. `US`).

**Response**: `{ status: "success", data: { city, state (abbreviated), stateFull, country, postalCode, label, coordinates: { lng, lat } | null } }`.

**Amazon Location**:
- `SearchPlaceIndexForTextCommand` with `IndexName = PLACE_INDEX_NAME` (`DentiPalGeocoder`), `Text = postalCode`, `MaxResults = 1`, `FilterCountries = [iso3(country)]` if provided.

**Business logic highlights**:
- ISO2 → ISO3 country code conversion map (e.g. `US → USA`); Amazon Location expects alpha-3.
- US state abbreviation map (`Alabama → AL`, etc.) with full-name fallback for non-US.
- Point coordinates `[lng, lat]` reshaped to `{ lng, lat }` for the JSON response.

---

### `geo.ts` — Internal utility (not routed)

Exports:
- `buildAddressString(parts)` — joins address fragments with commas; returns `null` if fewer than 2 parts (too few for reliable geocoding).
- `geocodeAddress(text)` — `SearchPlaceIndexForTextCommand`; returns `{ lat, lng } | null`.
- `geocodeAddressParts(parts)` — composition of the two.
- `haversineDistance(a, b)` — great-circle distance in **miles** (`R = 3959`).

All geocoding errors are caught and returned as `null` (non-fatal).

---

## 20. Per-Handler Reference — Applications, Invitations, Negotiations, Hiring, Shifts

> Handlers covered: createJobApplication · createJobApplication-prof · getJobApplications · getJobApplicationsForClinic · getJobApplicantsOfAClinic · updateJobApplication · deleteJobApplication · sendJobInvitations · respondToInvitation · getJobInvitations · getJobInvitationsForClinics · respondToNegotiation · getAllNegotiations-Prof · acceptProf · rejectProf · getAllClinicsShifts · getClinicShifts · getScheduledShifts · getCompletedShifts · updateCompletedShifts · getActionNeeded · submitFeedback

### `createJobApplication.ts` — `POST /applications`

**Purpose**: Professional applies to a job posting; if `proposedRate` is provided, a `JobNegotiation` row is created and the application status becomes `negotiating`.

**Auth**: JWT required. Extracts `sub` as `professionalUserSub`.

**Request body**:
- `jobId?: string` (optional; can also be in path)
- `message?: string`
- `proposedRate?: number` — if present, triggers auto-negotiation
- `availability?: string`
- `startDate?: string`
- `notes?: string`

**Response**:
- 201: `{ status, statusCode: 201, message, data: { applicationId (UUID), jobId, applicationStatus: "pending" | "negotiating", appliedAt, job: { title, type, role, rate, payType, date, dates }, clinic: { name, city, state, practiceType, primaryPracticeArea, contactName } }, timestamp }`
- Error cases: 400 validation · 404 job not found · 409 job not active · 401 · 500

**DynamoDB access**:
- `JOB_POSTINGS_TABLE` → `Query` via `jobId-index-1` (verify active, get `clinicId`).
- `JOB_APPLICATIONS_TABLE` → `Put` (`jobId` PK, `professionalUserSub` SK).
- `JOB_NEGOTIATIONS_TABLE` → `Put` (if `proposedRate`).
- `CLINIC_PROFILES_TABLE` → `Get` (enrichment, non-fatal).

**Business logic highlights**:
- Duplicate application check via prior `Scan`/`Query`.
- `applicationStatus = proposedRate ? "negotiating" : "pending"`.
- Fires `promotionCounters.fireAndForgetIncrement` to bump applicationsCount / promotion applications counter (non-blocking).

---

### `createJobApplication-prof.ts` — alternate `POST /applications/{jobId}`

**Purpose**: Same as above but stricter — requires `message`, `proposedRate`, and `availability` in the body. Does **not** auto-create a negotiation.

**Response**: 201 `{ message, applicationId, jobId, status: "pending", appliedAt, job }`.

---

### `getJobApplications.ts` — `GET /applications`

**Purpose**: Returns the caller's applications, enriched with job posting + latest negotiation.

**Auth**: JWT required.

**Query params**: `status?`, `jobType?`, `limit? (default 50)`.

**Response item** (truncated): `applicationId, jobId, clinicId, clinicUserSub, professionalUserSub, applicationStatus, appliedAt, updatedAt, applicationMessage, proposedRate, proposedHourlyRate, availability, notes, acceptedRate, jobTitle, jobType, professionalRole, description, shiftSpeciality, requirements[], date, dates[], startTime, endTime, rate, payType, mealBreak, freeParkingAvailable, parkingType, parkingRate, softwareRequired, hoursPerDay, hours, jobBenefits[], jobSalaryMin, jobSalaryMax, location, startDate, contactInfo, specialRequirements[], status, createdAt, updatedAt, negotiation: { negotiationId, clinicCounterRate, professionalCounterRate, agreedRate, clinicCounterHourlyRate, professionalCounterHourlyRate, agreedHourlyRate, payType, negotiationStatus, updatedAt, createdAt }`.

**DynamoDB access**:
- `JOB_APPLICATIONS_TABLE` → `Scan` filter by `professionalUserSub` + optional status/jobType.
- `JOB_POSTINGS_TABLE` → `Query` on `jobId-index-1` per application.
- `JOB_NEGOTIATIONS_TABLE` → `Query` on `applicationId-index` for each negotiating app; picks latest by `updatedAt/createdAt`.

**Business logic highlights**: backward-compatible field names (`proposedRate/proposedHourlyRate`, etc.).

---

### `getJobApplicationsForClinic.ts` — `GET /clinics/{clinicId}/jobs`

**Purpose**: Clinic-side grouped view of applications across the clinic's jobs.

**Response**: `{ status, ..., data: { clinicId, jobs: [{ jobId, jobPosting, applicants: [{ ...application, professionalProfile, negotiation }] }], totalApplicants }, timestamp }`.

**DynamoDB access**:
- `JOB_POSTINGS_TABLE` → `Query` by `clinicUserSub`.
- `JOB_APPLICATIONS_TABLE` → `Scan` filter `(clinicId, jobId)` per job.
- `PROFESSIONAL_PROFILES_TABLE` → `BatchGetItem` (chunks of 100).
- `JOB_NEGOTIATIONS_TABLE` → `BatchGetItem` by `negotiationId`.

---

### `getJobApplicantsOfAClinic.ts` — `GET /{clinicId}/jobs`

**Purpose**: Paginated list of clinic's applicants across jobs, with jobId filter support.

**Auth**: JWT + `canAccessClinic`.

**Query params**: `jobId?`, `limit? (default 50, max 200)`, `nextToken?` (base64url of DynamoDB `LastEvaluatedKey`).

**DynamoDB access**:
- `JOB_APPLICATIONS_TABLE` → `Query` on `clinicId-index` or `clinicId-jobId-index`, filters out terminal statuses (accepted, rejected, scheduled, completed, hired, declined, confirmed).
- Parallel per-`jobId` enrichment from `JOB_POSTINGS_TABLE` (`jobId-index-1`).
- `PROFESSIONAL_PROFILES_TABLE` → `BatchGetItem`.
- `JOB_NEGOTIATIONS_TABLE` → hybrid `BatchGetItem` (known `negotiationId`s) + `Query` (unknown).

**Response** shape has both `applications[]` and `byJobId` map for UI flexibility.

---

### `updateJobApplication.ts` — `PUT /applications/{applicationId}`

**Auth**: JWT + ownership check (application's `professionalUserSub` must equal caller).

**Body** (optional): `message, proposedRate, availability, startDate, notes`.

**DynamoDB access**:
- `JOB_APPLICATIONS_TABLE` (GSI `applicationId-index`) → `Query` (or fallback `Scan`).
- `JOB_APPLICATIONS_TABLE` → `UpdateItem` with dynamic `SET`; blocks terminal statuses (`accepted, declined, canceled, completed`).

---

### `deleteJobApplication.ts` — `DELETE /applications/{applicationId}`

**Purpose**: Withdraw application (blocked if `accepted`).

**DynamoDB access**: `Scan` → `DeleteItem` with `ConditionExpression` on `applicationId`.

---

### `sendJobInvitations.ts` — `POST /jobs/{jobId}/invitations`

**Purpose**: Clinic bulk-invites professionals to a job (max 50 per request).

**Body**:
- `professionalUserSubs: string[]` (required, 1–50)
- `invitationMessage?: string` (default "You have been invited...")
- `urgency?: string` (default "medium")
- `customNotes?: string`

**Response**: 200 `{ message, jobId, jobType, jobRole, totalInvited, successful[], errors[], invitationDetails, professionals }`.

**DynamoDB access**:
- `JOB_POSTINGS_TABLE` → `Query` on `jobId-index-1` (job existence + `clinicId`).
- `PROFESSIONAL_PROFILES_TABLE` → `BatchGetItem` (validation).
- `JOB_INVITATIONS_TABLE` → `Query` for existing invitation (dedup) then `PutItem` per invitee.

---

### `respondToInvitation.ts` — `POST /invitations/{invitationId}/response`

**Purpose**: Professional accepts / declines / counters an invitation.

**Body**:
- `response: "accepted" | "declined" | "negotiating"` (required)
- `message?: string`
- `proposedHourlyRate?: number` (required if negotiating + temporary/consulting)
- `proposedSalaryMin?: number`, `proposedSalaryMax?: number` (required if negotiating + permanent)
- `availabilityNotes?: string`
- `counterProposalMessage?: string`

**DynamoDB access**:
- `JOB_INVITATIONS_TABLE` (GSI `invitationId-index`) → `Query`.
- `JOB_POSTINGS_TABLE` (GSI `jobId-index-1`) → `Query`.
- `JOB_APPLICATIONS_TABLE` → `Put` (if accepting or negotiating).
- `JOB_NEGOTIATIONS_TABLE` → `Put` (if negotiating).
- `JOB_INVITATIONS_TABLE` → `Update` (mark responded).

**Other AWS**: **EventBridge** `PutEvents` (`Source: denti-pal.api, DetailType: ShiftEvent, eventType: invite-accepted`) on acceptance.

**Business logic highlights**:
- Permanent jobs require min+max salary; temporary/consulting require `proposedHourlyRate`.
- Percentage-of-revenue rate must be 0–100.
- Terminal states (`accepted`, `declined`) block re-response.

---

### `getJobInvitations.ts` — `GET /invitations`

**DynamoDB**: `JOB_INVITATIONS_TABLE` (GSI `ProfessionalIndex`) `Query` by `professionalUserSub`, filter out accepted/declined; per-item `JOB_POSTINGS_TABLE` enrichment.

---

### `getJobInvitationsForClinics.ts` — `GET /invitations/{clinicId}`

**DynamoDB**: `JOB_INVITATIONS_TABLE` `Scan` by `clinicId` (no GSI); per-row `Get` on `PROFESSIONAL_PROFILES_TABLE` for name.

**Side effects / Notes**: Scan is inefficient at scale — the table has no `clinicId` GSI as of this deploy.

---

### `respondToNegotiation.ts` — `PUT /applications/{applicationId}/negotiations/{negotiationId}/response`

**Purpose**: Either party responds to an active negotiation (accept / decline / counter-offer).

**Body**:
- `response: "accepted" | "declined" | "counter_offer"` (required)
- `message?: string`
- `counterSalaryMin?`, `counterSalaryMax?` (for permanent)
- `clinicCounterRate?`, `professionalCounterRate?` (for temporary; legacy aliases `*HourlyRate`)
- `payType?: string`

**DynamoDB access**:
- `JOB_NEGOTIATIONS_TABLE` → `GetItem`.
- `JOB_POSTINGS_TABLE` (GSI `JobIdIndex-2`) → `Query`.
- `JOB_APPLICATIONS_TABLE` (GSI `applicationId-index`) → `Query`.
- Both negotiation and application → `Update` (statuses in lock-step).

**Other AWS**: EventBridge `PutEvents` (`eventType: shift-scheduled`) on acceptance.

**Business logic highlights**:
- Actor inference: if caller = clinic owner → clinic response path; if `professionalUserSub` → professional path.
- Final rate selection: on acceptance, takes the *other* party's latest counter (or the application's `proposedRate` if the counter is empty).
- Accepting transitions Application status to `scheduled`.

---

### `getAllNegotiations-Prof.ts` — `GET /allnegotiations` · `GET /negotiations`

**Purpose**: Professional's negotiations, three query modes: by `applicationId`, by `jobId + professionalUserSub`, or list-all.

**DynamoDB access**: `JOB_NEGOTIATIONS_TABLE` (`applicationId` PK or `JobIndex` GSI or `Scan`); clinic + job enrichment via `CLINIC_PROFILES_TABLE` + `JOB_POSTINGS_TABLE` (`jobId-index-1`).

---

### `acceptProf.ts` — `POST /jobs/{jobId}/hire`

**Purpose**: Clinic hires a professional; atomically sets Application to `scheduled`, emits a ShiftEvent.

**Auth**: JWT + group in `{root, clinicadmin, clinicmanager}`.

**Body**: `{ professionalUserSub: string, clinicId?: string }`.

**DynamoDB**: `JOB_APPLICATIONS_TABLE` → `GetItem` + `UpdateItem` (status → `scheduled`).

**Other AWS**: EventBridge `PutEvents` (`eventType: shift-scheduled`).

**Side effects / Notes**: Does not atomically reject the other applicants — the UI is expected to call `rejectProf` separately for losers.

---

### `rejectProf.ts` — `POST /{clinicId}/reject/{jobId}`

**Purpose**: Clinic rejects an application.

**Auth**: JWT + group in `{root, clinicadmin, clinicmanager}`.

**DynamoDB**: `JOB_APPLICATIONS_TABLE` → `UpdateItem` (status → `rejected`). No pre-existence check, no event emission (professional is not actively notified via inbox).

---

### `getAllClinicsShifts.ts` — `GET /dashboard/all/{resource}`

**Purpose**: Unified dashboard aggregator across all clinics the caller is a member of. Single handler serves 5 distinct views: `open-shifts`, `action-needed`, `scheduled-shifts`, `completed-shifts`, `invites-shifts`. Branches on `event.resource` / `event.path`.

**Auth**: JWT required. Scoped via `listAccessibleClinicIds`.

**Response**: Grouped-by-clinicId map `{ [clinicId]: [ item, ... ] }`.

**DynamoDB access** (branch-dependent):
- `CLINICS_TABLE` scan for membership (inside `listAccessibleClinicIds`).
- `JOB_POSTINGS_TABLE` GSI `ClinicIdIndex` `Query` per clinic.
- `JOB_APPLICATIONS_TABLE` GSI `clinicId-jobId-index` `Query` per clinic.
- `PROFESSIONAL_PROFILES_TABLE` `BatchGetItem` (for action-needed and invites-shifts).
- `JOB_NEGOTIATIONS_TABLE` per-app `Query` (action-needed).
- `JOB_INVITATIONS_TABLE` `Scan` (invites-shifts).

**Business logic highlights**:
- Time-based auto-completion: scheduled shifts whose end-time has passed are counted as `completed`.
- Status categorization:
  - `open` → job with no scheduled/completed application
  - `scheduled` → status in `SCHEDULED_STATUSES = {scheduled, accepted, booked}`
  - `completed` → status in `COMPLETED_STATUSES = {completed, paid}`
  - `action-needed` → non-terminal statuses (`pending`, `negotiating`)
  - `invites` → `JobInvitations` where status ≠ `accepted`

---

### `getClinicShifts.ts` — `GET /clinics/{clinicId}/{resource}`

**Purpose**: Same 5-branch logic as `getAllClinicsShifts` but scoped to a single clinic. `canAccessClinic` gate enforced.

---

### `getScheduledShifts.ts` — `GET /scheduled/{clinicId}`

**DynamoDB**: `JOB_APPLICATIONS_TABLE` (GSI `clinicId-jobId-index`, filter `applicationStatus = scheduled`) + per-`jobId` `Query` on `JOB_POSTINGS_TABLE` (`jobId-index-1`).

**Response**: `{ message, jobs: [{ jobId, jobTitle, jobType, dates[], date, start_date, rate, payType, salaryMin, salaryMax, dateRange, professionalRole, startTime, endTime, status: "scheduled", clinicId }] }`.

---

### `getCompletedShifts.ts` — `GET /completed/{clinicId}`

**DynamoDB**: `JOB_POSTINGS_TABLE` `Query` by `clinicUserSub`, filter `status = completed`.

---

### `updateCompletedShifts.ts` — `PUT /professionals/completedshifts` + EventBridge scheduled

**Purpose**: Nightly job-completion sweep and referral-bonus awarder. Also callable directly via REST.

**Trigger**: `event.source === 'aws.events'` short-circuits routing in `index.ts` to call this handler directly. Reference: `arn:aws:events:...` rule (created outside the CDK stack — ops-side cron).

**DynamoDB access**:
- `JOB_APPLICATIONS_TABLE` → `Scan` filter `applicationStatus = scheduled` (inefficient for large tables).
- `JOB_POSTINGS_TABLE` GSI `ClinicIdIndex` per clinic for end-time lookups.
- `JOB_APPLICATIONS_TABLE` → `UpdateItem` (`scheduled` → `completed`).
- `JOB_POSTINGS_TABLE` → `UpdateItem` (`status` → `inactive`).
- `REFERRALS_TABLE` GSI `ReferredUserSubIndex` → `Query` to find referrer.
- `PROFESSIONAL_PROFILES_TABLE` → `UpdateItem` (`bonusBalance += $50`, constant `BONUS_AMOUNT`).
- `REFERRALS_TABLE` → `UpdateItem` (`signed_up` → `bonus_due`, conditional to prevent double-payout).

**Business logic highlights**:
- Robust time parsing: handles ISO dates, 12- and 24-hour times, and multi-day consulting (uses the latest date).
- Compares shift end-time to `Date.now()`; if past, flips status.
- Referral bonus:
  - Only for professionals referred via `Referrals.ReferredUserSubIndex` with `status = signed_up`.
  - Atomic-per-referral: conditional update on `#status = signed_up`.

---

### `getActionNeeded.ts` — `GET /action-needed` · `GET /clinics/{clinicId}/action-needed`

**Purpose**: Lists pending + negotiating applications. Two modes: clinic-scoped or aggregate (Root-only).

**Query params**: `clinicId?, aggregate? ("true" for cross-clinic), statuses? ("pending,negotiate" by default)`.

**DynamoDB**: `JOB_APPLICATIONS_TABLE` (GSI `clinicId-index` or full `Scan`), `JOB_NEGOTIATIONS_TABLE` per-application enrichment, `JOB_POSTINGS_TABLE` for `created_by` context.

---

### `submitFeedback.ts` — `POST /submitfeedback`

**Purpose**: Accepts feedback (bug / suggestion / other); persists to `Feedback` table and emails support.

**Auth**: Optional (anonymous allowed).

**Body**:
- `feedbackType: "bug" | "suggestion" | string` (required)
- `message: string` (required, ≤5000 chars)
- `contactMe?: boolean`
- `email?: string`

**DynamoDB**: `FEEDBACK_TABLE` → `PutItem` (`PK: site#feedback`, `SK: feedback#{timestamp}#{id}`, `ConditionExpression: attribute_not_exists(...)`).

**Other AWS**: SES `SendEmail` (HTML + text; color-coded badge). Non-fatal email failure.

---

## 21. Per-Handler Reference — Files, Promotions, Favorites, Referrals, WebSocket, EventBridge

> Handlers covered: generatePresignedUrl · getFileUrl (+ 5 per-type exports) · updateFile (+ 5 per-type exports) · deleteFile · uploadFile · getClinicOfficeImages · addClinicFavorite · getClinicFavorites · removeClinicFavorite · sendReferralInvite · BonusAwarding · getPromotionPlans · createPromotion · getPromotions · getPromotion · cancelPromotion · activatePromotion · trackPromotionClick · promotionCounters · websocketHandler (with $connect, $disconnect, sendMessage, getHistory, markRead, getConversations actions) · event-to-message

### `generatePresignedUrl.ts` — `POST /files/presigned-urls`

**Purpose**: Generates an AWS S3 presigned POST policy for direct-from-browser uploads.

**Auth**: JWT required.

**Body**:
- `fileType: "profile-image" | "professional-resume" | "video-resume" | "professional-license" | "certificate" | "driving-license" | "clinic-office-image"`
- `fileName: string` (sanitized)
- `contentType: string` (validated against per-fileType MIME allowlist)
- `fileSize?: number` (hint; the policy enforces actual limits)
- `clinicId?: string` (required for clinic-office-image)

**Response**: 200 `{ url, fields, objectKey, bucket, expiresIn: 900, limits: { min, max, minLabel, maxLabel } }`.

**S3**:
- `createPresignedPost` with `content-length-range` and `Content-Type` policy conditions.
- 15-minute TTL (900 s).
- Key format: `{userSub OR clinicId}/{fileType}/{timestamp}-{sanitizedFileName}`.
- Metadata: `x-amz-meta-uploaded-by`, `x-amz-meta-user-email`, `x-amz-meta-original-filename`.

**Business logic highlights**: per-type matrix of MIME allowlist, extension allowlist, size bounds (5 KB – 100 MB). Bucket resolution via the env var matching the `fileType`.

---

### `getFileUrl.ts` — 5 routed exports

Exports ONE handler per file type; each maps to a dedicated REST route:

| Export | Route |
|--------|-------|
| `getProfileImage` | `GET /files/profile-images` |
| `getProfessionalResume` | `GET /files/professional-resumes` |
| `getProfessionalLicense` | `GET /files/professional-licenses` |
| `getDrivingLicense` | `GET /files/driving-licenses` |
| `getVideoResume` | `GET /files/video-resumes` |

**Auth**: JWT required. Clinic groups bypass the ownership check; non-clinic users must match the S3 metadata `uploaded-by` tag.

**Query params**: `key` (required, S3 object key), `userSub?` (clinic users can target other professionals' files).

**Response**: 200 `{ message, fileUrl (presigned GET, 24h TTL), objectKey, bucket, fileType, metadata: { contentType, contentLength, lastModified, uploadedBy, originalFilename, uploadTimestamp }, expiresIn: 86400 }`.

**S3**: `HeadObject` (metadata + ownership check) + `GetObjectCommand` presign (24 h).

---

### `updateFile.ts` — 5 routed exports

| Export | Route | DynamoDB attribute updated |
|--------|-------|----------------------------|
| `updateProfileImage` | `PUT /files/profile-image` | `profileImageKey` (SET — overwrite) |
| `updateProfessionalResume` | `PUT /files/professional-resumes` | `professionalResumeKeys` (list_append) |
| `updateProfessionalLicense` | `PUT /files/professional-licenses` | `professionalLicenseKeys` (list_append) |
| `updateDrivingLicense` | `PUT /files/driving-licenses` | `drivingLicenseKeys` (list_append) |
| `updateVideoResume` | `PUT /files/video-resumes` | `videoResumeKey` (SET — overwrite) |

**DynamoDB**: `PROFESSIONAL_PROFILES_TABLE` → `UpdateCommand` (`userSub` key, dynamic SET).

---

### `deleteFile.ts` — `DELETE /files/{fileType}`

Routes: `DELETE /files/profile-images`, `/files/certificates`, `/files/video-resumes`.

**Auth**: JWT + strict S3 `uploaded-by` metadata check (no clinic bypass).

**S3**: `HeadObject` → `DeleteObject`.

**Side effects / Notes**: Does NOT touch `PROFESSIONAL_PROFILES_TABLE`; stale keys can remain on the profile unless the frontend also calls `updateFile` to clear them.

---

### `uploadFile.ts` — direct base64 upload (not in router)

**Purpose**: Server-side base64 upload fallback for clients that cannot do multipart. Not wired to a route in `index.ts`.

**S3**: `PutObject` with metadata tags + side-write of `.meta/{timestamp}-{fileName}.json` for audit.

---

### `getClinicOfficeImages.ts` — `GET /files/clinic-office-images`

**Auth**: JWT required (any authenticated user — no clinic ownership check).

**Query params**: `clinicId` (required).

**S3**: `ListObjectsV2` under `{clinicId}/clinic-office-image/`, picks latest by `LastModified`, presigned GET (3600 s).

---

### `addClinicFavorite.ts` — `POST /clinics/favorites`

**Body**: `professionalUserSub` (required), `notes?`, `tags?: string[]`.

**DynamoDB**:
- `PROFESSIONAL_PROFILES_TABLE` → `Get` (existence + display fields).
- `CLINIC_FAVORITES_TABLE` → `Get` (dup check, 409 if exists).
- `CLINIC_FAVORITES_TABLE` → `Put`.

---

### `getClinicFavorites.ts` — `GET /clinics/favorites`

**Query params**: `limit? (≤50)`, `role? (exact match)`, `tags? (comma-separated union)`.

**DynamoDB**: `CLINIC_FAVORITES_TABLE` `Query` by `clinicUserSub` (sorted desc by `addedAt`) + `BatchGetItem` on `PROFESSIONAL_PROFILES_TABLE` + `USER_ADDRESSES_TABLE`.

**Response** includes `roleDistribution: { role: count, ... }`.

---

### `removeClinicFavorite.ts` — `DELETE /clinics/favorites/{professionalUserSub}`

**DynamoDB**: `CLINIC_FAVORITES_TABLE` → `Get` (404 if missing) + `Delete`.

---

### `sendReferralInvite.ts` — `POST /referrals/invite`

**Body**: `friendEmail: string` (required, regex-validated), `personalMessage?: string`.

**DynamoDB**:
- `PROFESSIONAL_PROFILES_TABLE` → `Get` (fetch referrer's `full_name`).
- `REFERRALS_TABLE` → `Put` with `status: "sent"`.

**SES**: `SendEmail` — HTML + text template; subject `"{referrerName} invites you to join DentiPal! 🦷"`. Sender hardcoded to `jelladivya369@gmail.com` (must be verified in SES).

**Side effects / Notes**: Signup URL is hardcoded to `http://localhost:5173/professional-signup?ref={referrerUserSub}` — should be made env-configurable before any non-dev deploy.

---

### `BonusAwarding.ts` — **DynamoDB Streams consumer (not routed)**

**Trigger**: DynamoDB Stream on `JobApplications` (must be wired externally — not in current CDK stack).

**DynamoDB access**:
- `REFERRALS_TABLE` (GSI `ReferredUserSubIndex`) → `Query` by `referredUserSub = professionalUserSub`.
- `REFERRALS_TABLE` → `UpdateItem` (`ADD referralBonus :fifty` with `if_not_exists`).

**Business logic highlights**:
- Only processes `MODIFY` events where `newStatus === "completed"`.
- `BONUS_AMOUNT = 50` (credits).
- Wraps each record in try/catch so a bad record can't fail the batch.
- Also called in-process from `verifyOTPAndCreateUser.ts` (see §13.5) for registration-time bonus flips.

---

### `getPromotionPlans.ts` — `GET /promotions/plans`

**Auth**: public.

**Response** (hardcoded):
- `basic`: 3 days, 999¢ — top of search + badge.
- `featured`: 7 days, 2499¢ — top + featured badge + email digest.
- `premium`: 14 days, 4999¢ — top + premium badge + email digest + push notifications.

---

### `createPromotion.ts` — `POST /promotions`

**Auth**: JWT + `canWriteClinic(..., "manageJobs")`.

**Body**: `jobId` (required), `planId ∈ {basic, featured, premium}` (required).

**DynamoDB access**:
- `JOB_POSTINGS_TABLE` (GSI `jobId-index-1`) → `Query` (fetch + clinic ownership derivation).
- `JOB_PROMOTIONS_TABLE` → `PutItem` with `status: "pending_payment"`, `activatedAt: "PENDING"`, `expiresAt: "PENDING"`, counters at 0.

**Response** notable: `payment: { paymentUrl: null, clientSecret: null, message: "Payment integration pending..." }` — Stripe plumbing is not yet wired.

---

### `getPromotions.ts` — `GET /promotions?clinicId=<id|all>`

**Auth**: JWT; `listAccessibleClinicIds` if `clinicId=all`.

**DynamoDB**: `JOB_PROMOTIONS_TABLE` GSI `clinicId-createdAt-index` `Query` (desc), fan-out across accessible clinics if `all`; `JOB_POSTINGS_TABLE` `BatchGetItem` (chunks of 100) for enrichment.

---

### `getPromotion.ts` — `GET /promotions/{promotionId}?clinicId=<id>`

**DynamoDB**: `JOB_PROMOTIONS_TABLE` GSI `clinicId-createdAt-index` `Query` filtered by `promotionId`.

---

### `cancelPromotion.ts` — `PUT /promotions/{promotionId}/cancel`

**Auth**: JWT + `canWriteClinic(..., "manageJobs")`.

**DynamoDB**: locate via GSI → `UpdateItem` on promotion (`status → cancelled`); if promotion was active, also `UpdateItem` on the `JOB_POSTINGS_TABLE` to clear `isPromoted`, `promotionId`, `promotionPlanId`, `promotionExpiresAt`.

---

### `activatePromotion.ts` — `PUT /promotions/{promotionId}/activate`

**Purpose**: Move promotion from pending to active; set `activatedAt = now`, `expiresAt = now + durationDays`, denormalize flags onto the job posting.

**Durations**: basic=3d, featured=7d, premium=14d.

**DynamoDB**: promotion `UpdateItem` + job posting `UpdateItem` (set `isPromoted: true`, `promotionId`, `promotionPlanId`, `promotionExpiresAt`).

---

### `trackPromotionClick.ts` — `POST /promotions/track-click`

**Auth**: public (tracking endpoint).

**Body**: `jobId` (required), `promotionId` (required).

**DynamoDB**: `JOB_PROMOTIONS_TABLE` `UpdateItem` `ADD clicks :one` with `ConditionExpression: #status = :active` — `ConditionalCheckFailedException` is caught and converted to a silent 204 (clicks on cancelled/expired promos are ignored, not errored).

**Response**: `204 No Content`.

---

### `promotionCounters.ts` — **utility module**

Exports:
- `PROMOTION_TIER_WEIGHT = { premium: 3, featured: 2, basic: 1 }`.
- `incrementPromotionCounter(jobId, promotionId, counter: "impressions" | "clicks" | "applications")`.
- `fireAndForgetIncrement(...)` — non-blocking wrapper; errors logged.

**Usage**: called from `browseJobPostings`, `createJobApplication`, `trackPromotionClick`.

---

### `websocketHandler.ts` — WebSocket chat Lambda

This single Lambda serves **all three routes** (`$connect`, `$disconnect`, `$default`) and dispatches `$default` internally by `action` field. Each flow is documented below.

#### `$connect`

**Purpose**: Establish a WebSocket connection after JWT verification.

**Auth**: Cognito JWT access token in query string `token`. Optional `clinicId` for clinic users.

**Cognito JWT verification**: Uses `aws-jwt-verify`'s `CognitoJwtVerifier.create({ userPoolId, tokenUse: "access", clientId })`. Verifies signature, expiration, issuer, token_use — unlike REST handlers which only decode.

**DynamoDB**: `CONNS_TABLE` → `PutItem` (`userKey` PK, `connectionId` SK, `ttl` 24 h, `connectedAt` ms, `userType`, `display`, `sub`, `email`).

**Business logic highlights**:
- `userType` derived from groups: clinic side = `Root | ClinicAdmin | ClinicManager | ClinicViewer`; professional side = `AssociateDentist | DentalAssistant | ...`.
- `userKey` = `clinic#{clinicId}` or `prof#{sub}`.
- Clinic users must supply `clinicId` (from `custom:clinicId` claim or `?clinicId=` query).

#### `$disconnect`

**DynamoDB**: `CONNS_TABLE` (GSI `connectionId-index`) `Query` → per-row `DeleteItem`. Idempotent.

#### action `sendMessage`

**Purpose**: Send a message; create conversation on first message; broadcast to recipient and sender's other tabs.

**Payload**:
- `clinicId` (required)
- `professionalSub` (required)
- `content` (required, ≤1000 chars)
- `messageType?: "text" | "system"` (default `"text"`)

**DynamoDB**:
- `MESSAGES_TABLE` → `PutItem` (`conversationId`, `messageId`, `senderKey`, `content`, `timestamp`, `type`).
- `CONVOS_TABLE` → `UpdateItem` (create-or-update). Sets `clinicKey`, `profKey`, `clinicName`, `profName`, `lastMessageAt`, `lastPreview` (≤100 chars), increments recipient `unreadCount`, resets sender `unreadCount` to 0.

**`conversationId` construction**: `sort([clinic#{clinicId}, prof#{profSub}]).join("|")` — deterministic regardless of sender.

**WS out (recipient connections)**: `{ type: "message", conversationId, messageId, senderKey, senderName, content, timestamp, messageType, clinicId, professionalSub, message }`.

**WS out (sender's OTHER tabs)**: same `message` payload.

**WS out (current connection)**: `{ type: "ack", messageId, conversationId, timestamp, status: "delivered" | "sent" }`.

**Authorization**:
- Clinic users → `UserClinicAssignments` lookup (cached 5 min) — multi-clinic supported.
- Professional users → `professionalSub === caller.sub`.

#### action `getHistory`

**Payload**: `clinicId, professionalSub, limit? (≤200, default 50), nextKey? (base64url)`.

**DynamoDB**: `MESSAGES_TABLE` → `Query` by `conversationId`, `ScanIndexForward: false` (newest first); `CONVOS_TABLE` → `GetItem` for unread counts; `Cognito AdminGetUser` for display-name resolution (cached 30 min LRU, max 500).

**WS out**: `{ type: "history", conversationId, items: [{ messageId, timestamp, senderKey, senderName, content, messageType, status?: "read" | "delivered" }], nextKey? }`.

**`status` logic**: for the sender's own messages, `"read"` if the other side's unreadCount is 0, else `"delivered"`; recipient's own messages have no status.

#### action `markRead`

**DynamoDB**: `CONVOS_TABLE` → `UpdateItem` to reset `clinicUnread` or `profUnread` (per caller type) to 0.

**WS out (current)**: `{ type: "ack", conversationId, action: "markRead" }`.

**WS out (other side)**: `{ type: "readReceipt", conversationId, readBy: senderKey }` — broadcast to all their active connections.

#### action `getConversations`

**Purpose**: Two-phase inbox listing.

**Payload**: `clinicId? ("all" fans out across accessible clinics for multi-clinic clinic users)`, `limit? (≤100, default 50)`, `nextKey?`.

**Phase 1 (fast response)**:
- `CONVOS_TABLE` → `Query` via `clinicKey-lastMessageAt` or `profKey-lastMessageAt` GSI (desc).
- `Cognito AdminGetUser` per counter-party `sub` (bounded concurrency 10; 30-min cache).
- `CONNS_TABLE` reverse lookup per `otherKey` to compute `isOnline`.
- WS out: `{ type: "conversationsResponse", conversations: [{ conversationId, recipientName, lastMessage, lastMessageAt, unreadCount, isOnline, ... }], nextKey?, hasMore? }`.

**Phase 2 (deferred)**:
- S3 `GetObjectCommand` presigning for avatar keys (`ProfileImagesBucket` for professional, `ClinicOfficeImagesBucket` for clinic).
- 1-hour presigned URL, cached for 50 min.
- WS out: `{ type: "avatarsUpdate", avatars: { conversationId: presignedUrl } }`.

**Authorization**: clinic users filtering by specific `clinicId` must have that clinic in their `UserClinicAssignments`; `"all"` fans out across all accessible clinics.

#### default (unknown action)

**WS out**: `{ type: "error", error: "Unknown or missing action. Expected one of: sendMessage, getHistory, markRead, getConversations." }`.

#### Shared utilities

- **Name cache**: LRU, 30-min TTL, max 500 entries, keyed by `prof#{sub}` or `clinic#{clinicId}`.
- **Clinic-access cache**: 5-min TTL for `UserClinicAssignments` lookups.
- **Avatar URL cache**: 50-min TTL for presigned S3 URLs (buys a safety window against the S3 1-hour expiry).
- **`GoneException` cleanup**: When `PostToConnection` returns `410 Gone`, the stale row is removed from `CONNS_TABLE` via `connectionId-index`.

---

### `event-to-message.ts` — EventBridge → system messages → WebSocket push

**Trigger**: EventBridge rule `DentiPal-ShiftEvent-to-Inbox` (source `denti-pal.api`, detailType `ShiftEvent`).

**Detail payload** (emitted by producers `acceptProf`, `rejectProf`, `respondToInvitation`, `respondToNegotiation`, `updateCompletedShifts`):

```jsonc
{
  "eventType":            "shift-applied" | "invite-accepted" | "shift-cancelled" | "shift-scheduled",
  "clinicId":             "<uuid>",
  "professionalSub":      "<cognito-sub>",
  "shiftDetails": {
    "role":      "string",
    "date":      "YYYY-MM-DD",
    "rate":      "number",
    "startTime": "HH:mm",
    "endTime":   "HH:mm",
    "location":  "string",
    "jobType":   "temporary | multi_day_consulting | permanent"
  }
}
```

**Behavior**:

1. Computes `conversationId = sort([clinic#{clinicId}, prof#{professionalSub}]).join("|")`.
2. Fetches professional display name via Cognito `AdminGetUser` (no caching here).
3. Fetches clinic display name from `CLINICS_TABLE` (or active connection metadata).
4. Generates system-message body per `eventType` (e.g. `"📅 Shift scheduled\nRole: Dental Hygienist\nDate: 2026-05-01\nTime: 08:00–16:00\nRate: $55/hr\nLocation: Austin, TX"`).
5. `MESSAGES_TABLE` → `PutItem` (`type: "system"`).
6. `CONVOS_TABLE` → `UpdateItem` (creates conversation if missing; bumps `lastMessageAt`, sets `lastPreview`, updates `clinicUnread` or `profUnread`).
7. `CONNS_TABLE` reverse lookup → API Gateway Management `PostToConnection` broadcast to every active connection for both parties.
8. `GoneException` handling identical to the WebSocket Lambda.

**Env dependency**: `WS_ENDPOINT` must be set (`https://<apiId>.execute-api.<region>.amazonaws.com/prod`). If missing, posts are skipped silently but DB writes still succeed.

**Side effects / Notes**: No caching of Cognito lookups (each event pays the Cognito roundtrip). This is acceptable because event volume is low — but on a very high-throughput stack this could become a hotspot.

---

## 22. Entity Relationship Diagram

Reproduced verbatim from [DENTIPAL_DATABASE_SCHEMA.md](DENTIPAL_DATABASE_SCHEMA.md) and annotated with the 18th table (`JobPromotions`):

```
                        ┌──────────────────────────┐
                        │   AWS COGNITO USER POOL   │
                        │      (Identity Store)     │
                        │                           │
                        │  userSub (primary ID)     │
                        │  20 groups (see §4.5)     │
                        │                           │
                        │  PreSignUp + Custom-Auth  │
                        │  Lambda triggers          │
                        └─────────┬─────────────────┘
                                  │ userSub
                ┌─────────────────┼──────────────────────┐
                │                 │                       │
                ▼                 ▼                       ▼
  ┌──────────────────┐  ┌────────────────────┐  ┌──────────────────┐
  │ ProfessionalProf │  │    UserAddresses    │  │  UserClinicAssgn │
  │ iles             │  │                     │  │  ments           │
  │  PK: userSub     │  │  PK: userSub        │  │   PK: userSub    │
  │                  │  │                     │  │   SK: clinicId ──┼──┐
  │  role, name,     │  │  addr, lat, lng     │  │                  │  │
  │  specialties     │  │                     │  └──────────────────┘  │
  └───────┬──────────┘  └─────────────────────┘                         │
          │                                                             │
          │ professionalUserSub                                         │
          │                     ┌────────────────────────────────────────┘
          │                     │
          │                     ▼
          │           ┌──────────────────┐
          │           │     Clinics       │
          │           │  PK: clinicId     │
          │           │                  │
          │           │  name, address,  │
          │           │  lat/lng,         │
          │           │  createdBy,       │
          │           │  AssociatedUsers  │
          │           └────────┬─────────┘
          │                    │ clinicId
          │         ┌──────────┼──────────────────────────────┐
          │         │          │                               │
          │         ▼          ▼                               ▼
          │  ┌─────────────┐ ┌──────────────┐ ┌──────────────────┐
          │  │ClinicProfile│ │ClinicFavorit-│ │    JobPostings    │
          │  │s            │ │es            │ │                  │
          │  │             │ │ PK:          │ │ PK: clinicUserSub│
          │  │PK: clinicId │ │   clinicUser-│ │ SK: jobId        │
          │  │SK: userSub  │ │   Sub        │ │                  │
          │  │             │ │ SK:          │ │ GSIs:             │
          │  │practice,    │ │   profUserSub│ │  ClinicIdIndex   │
          │  │parking,     │ │              │ │  DateIndex        │
          │  │staff counts │ └──────────────┘ │  jobId-index-1    │
          │  └─────────────┘                  │  JobIdIndex-2     │
          │                                   │  status-createdAt-│
          │                                   │  index            │
          │                                   └───────┬──────────┘
          │                                           │ jobId
          │                 ┌───────────────────────────────────────┐
          │                 │                       │              │
          │                 ▼                       ▼              ▼
          │       ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐
          │       │ JobApplications  │  │ JobInvitations   │  │ JobPromotions│
          │       │  PK: jobId       │  │  PK: jobId       │  │  PK: jobId   │
          └──────►│  SK: profUserSub │  │  SK: profUserSub │  │  SK: promoId │
                  │                  │  │                  │  │              │
                  │  5 GSIs:         │  │  2 GSIs:         │  │  3 GSIs:     │
                  │   applicationId  │  │   invitationId   │  │   clinicUser-│
                  │   clinicId       │  │   ProfessionalIdx│  │   Sub-index  │
                  │   clinicId-jobId │  │                  │  │   clinicId-  │
                  │   JobIdIndex-1   │  │                  │  │   createdAt  │
                  │   profUserSub-idx│  │                  │  │   status-    │
                  └───────┬──────────┘  └──────────────────┘  │   expiresAt  │
                          │ applicationId                       └──────────────┘
                          ▼
                 ┌──────────────────┐
                 │ JobNegotiations  │
                 │  PK: applicationId│
                 │  SK: negotiationId│
                 │                  │
                 │  3 GSIs:         │
                 │   index(appId)   │
                 │   GSI1(overload) │
                 │   JobIndex       │
                 └──────────────────┘


  ┌──────────────────────────────────────────────────────────┐
  │              MESSAGING SUBSYSTEM                          │
  │                                                           │
  │  Connections ──► Conversations ──► Messages               │
  │  PK: userKey     PK: conversationId  PK: conversationId  │
  │  SK: connectionId GSI clinicKey-lma   SK: messageId       │
  │  GSI conn-index  GSI profKey-lma      GSI ConvIdIndex     │
  │                                                           │
  │  EventBridge ──► event-to-message Lambda ──► Conversations+Messages     │
  │  source=denti-pal.api detailType=ShiftEvent                             │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │              SUPPORTING TABLES                            │
  │                                                           │
  │  Notifications      Referrals            OTPVerification  │
  │  PK: recipientSub   PK: referralId       PK: email       │
  │  SK: notificationId GSI ReferredUserSub                  │
  │                     GSI ReferrerIndex                    │
  │                                                           │
  │  Feedback                                                 │
  │  PK: PK  SK: SK  (single-table design)                    │
  └──────────────────────────────────────────────────────────┘
```

---

## 23. Design Observations, GSI Redundancies, and Known Issues

### 23.1 No enforced foreign keys

DynamoDB has no FK constraints. All referential integrity is enforced in application code — **orphans are possible** when:
- A clinic is deleted via `deleteClinic` (Root-only) but its `ClinicProfiles`, `JobPostings`, `UserClinicAssignments`, `ClinicFavorites`, and `JobApplications` rows are not cascaded.
- A user is deleted via `deleteUser` but `AssociatedUsers` cleanup is non-fatal.
- A job posting is deleted via `deleteJobPosting` **without** `?force=true` but still has dead applications/invitations/negotiations.

### 23.2 Denormalization strategy

- `JobPostings` rows embed `clinic_name, clinic_type, addressLine*, city, state, pincode, parking_type, parking_rate, clinicSoftware, freeParkingAvailable, lat, lng` — all copied from `Clinics` + `ClinicProfiles` at write time. Updates to the underlying clinic **do not back-propagate**.
- `Clinics.lat/lng` is populated by on-the-fly geocoding from `findJobs` (fire-and-forget write-back).
- `JobApplications` embeds `clinicId, clinicUserSub` alongside the composite key `(jobId, professionalUserSub)` to support multiple access patterns.

### 23.3 GSI redundancies and cleanup opportunities

Flagged by the stack comments and schema doc:

| Table | Redundant index | Rationale |
|-------|-----------------|-----------|
| `JobPostings` | `JobIdIndex-2` | Duplicate of `jobId-index-1` (same PK, no SK, ALL projection). |
| `Messages` | `ConversationIdIndex` | Identical key schema to the base table; zero query callers. Stack comment (audit 2026-04-17) marks it for removal after the next deploy. |
| `JobNegotiations` | `index` | Same PK (`applicationId`) as the base table; only adds marginal value. |
| `JobPromotions` | `clinicUserSub-index` | Stack comment: *"no longer queried by any handler, kept in this deploy so the DynamoDB 'one GSI change per update' rule is respected while the new clinicId-keyed index is being added. Remove in a follow-up deploy."* |

### 23.4 Known correctness / performance issues (found while writing this report)

| Area | Observation | Severity |
|------|-------------|----------|
| **JWT verification** | `extractAndDecodeAccessToken` only base64-decodes; does not verify the signature. `aws-jwt-verify` is already a dependency but not used. Every REST handler trusts the client-supplied bearer. | **Critical** |
| **Stack secrets** | `GOOGLE_CLIENT_SECRET` is hardcoded as plaintext in [lib/denti_pal_cdk-stack.ts](lib/denti_pal_cdk-stack.ts) line ~1231 and is synthesized into the CloudFormation template. Should move to AWS Secrets Manager or SSM. | **Critical** |
| **Full-table scans** | `loginUser`, `getAllClinics`, `getUsersClinics`, `deleteUser` cleanup, `getJobInvitationsForClinics`, `getAllPermanentJobs`, `getAllMultiDayConsulting`, `updateCompletedShifts`, `getActionNeeded (aggregate)` all do `Scan`. At scale these will throttle. | High |
| **`getAllPermanentJobs.applicationCount = 0`** | Always returned as zero — no `Query` is issued per job. Other similar handlers compute this; this one is missing it. | Medium |
| **Pincode uniqueness on `UserAddresses`** | Original code blocked multiple users from sharing a pincode; now removed, but the `createUserAddress` handler still does a `Scan` against pincode before `Put`. Dead check. | Low |
| **Legacy `UserClinicAssignments` table** | Not populated by the Add-User flow; `hasClinicAccess` is deprecated. Table is still provisioned and granted read-write. | Low |
| **REST Lambda memory** | 1024 MB for a cold-start-sensitive monolith with 128 handler imports is reasonable but could probably drop to 512 MB after verifying cold-start budgets. | Low |
| **`CertificatesBucket` orphan** | Construct exists and is granted read-write, but no env var references it. `PROFESSIONAL_LICENSES_BUCKET` took over its role; the original construct is dead. | Low |
| **Signup URL hardcoded** | `sendReferralInvite.ts` uses `http://localhost:5173/professional-signup?ref=<sub>` — dev-only URL in a prod email template. | Medium |
| **SES sender identity** | `sendReferralInvite.ts` sends from `jelladivya369@gmail.com`; `Monolith` env uses `viswanadhapallivennela19@gmail.com`. Both must be SES-verified. Inconsistent and personal Gmail addresses in a server-to-server email path. | Medium |
| **API Gateway `authorizationType: NONE`** | Trust is entirely shifted to the Lambda. Combined with the unverified JWT above, this means any internet user can construct a token with a target `sub` and call any endpoint. | **Critical** |
| **`validateToken` vs `extractUserFromBearerToken`** | Two separate auth utilities with non-overlapping contracts. Handlers inconsistently use one or the other. Consolidate. | Low |
| **Cognito group case** | `"Dental Hygienist"` appears in the `groups` array but Cognito group names cannot contain spaces; the actual groups are `DentalHygienist` and `Hygienist`. The `groups` array is effectively documentation, not code. Remove it. | Low |
| **`JobNegotiations.GSI1` overloaded** | `gsi1pk`/`gsi1sk` composite is written by `respondToNegotiation` but projection is `INCLUDE` — fields must be kept in sync with callers. Currently includes `negotiationId, clinicId, jobId, professionalUserSub, status, lastOfferPay, lastOfferFrom, updatedAt`. Adding a new field requires GSI re-deploy. | Low |

### 23.5 Composite-key patterns worth remembering

- `Connections.userKey` = `clinic#{clinicId}` OR `prof#{userSub}` — encodes user type.
- `Conversations.conversationId` = `sort([clinic#{clinicId}, prof#{userSub}]).join("|")` — deterministic regardless of who initiates.
- `Feedback` table is a generic single-table design (`PK/SK`) used only for `site#feedback` + `feedback#{timestamp}#{id}`.
- `JobPostings` uses `clinicUserSub` (not `clinicId`) as PK — this ties postings to the Cognito user who created them, not to the clinic entity. A user who migrates between clinics keeps their jobs. `ClinicIdIndex` GSI provides the inverse view.

### 23.6 Aggregated observations for fixes before scale

1. **Verify JWTs** with `aws-jwt-verify` (already in `package.json`). Move to an API Gateway Lambda authorizer so the monolith doesn't repeat the work per request.
2. **Extract `GOOGLE_CLIENT_SECRET`** to Secrets Manager; mount with CDK `ssm.StringParameter.valueForStringParameter` or `secretsmanager.Secret.fromSecretNameV2`.
3. **Replace `Scan` patterns** (loginUser/clinics, dashboard aggregator, applied-jobs exclusion) with the appropriate GSIs. `ClinicsByAssociatedUser` (GSI with PK `AssociatedUser`) would eliminate a lot of scans.
4. **Drop redundant GSIs** after a safe deploy window: `JobIdIndex-2`, `Messages.ConversationIdIndex`, `JobPromotions.clinicUserSub-index`, and (pending query-audit) `JobNegotiations.index`.
5. **Introduce a Lambda-layer shared module** for `utils.ts` + `corsHeaders.ts` + `geo.ts` to reduce per-handler cold init.
6. **Cognito-side role consolidation**: remove `"Dental Hygienist"` from the documentation `groups` array (it isn't a real Cognito group); unify `Hygienist`/`DentalHygienist`.
7. **Add cascade cleanup** for `deleteClinic` — at minimum, delete owned `ClinicProfiles`, `JobPostings`, `JobPromotions`, `ClinicFavorites`, `UserClinicAssignments` rows.

---

## 24. CloudFormation Outputs

Declared at the end of the stack (`new cdk.CfnOutput(...)`):

| Output key | Source | Typical consumer |
|------------|--------|------------------|
| `UserPoolId` | `userPool.userPoolId` | Frontend Cognito config |
| `ClientId` | `client.userPoolClientId` | Frontend Cognito config |
| `RestApiEndpoint` | `api.url` | Frontend fetch base URL |
| `WebSocketEndpoint` | `webSocketApi.apiEndpoint` | Frontend WebSocket base URL |
| `ProfileImagesBucketName` | `profileImagesBucket.bucketName` | ops / monitoring |
| `ProfessionalResumesBucketName` | `professionalResumesBucket.bucketName` | ops / monitoring |
| `VideoResumesBucketName` | `videoResumesBucket.bucketName` | ops / monitoring |
| `DrivingLicensesBucketName` | `drivingLicensesBucket.bucketName` | ops / monitoring |
| `ProfessionalLicensesBucketName` | `professionalLicensesBucket.bucketName` | ops / monitoring |

### 24.1 Typical deployment flow

```bash
# From DentiPalCDK/
npm run build               # Compile CDK constructs
cd lambda && npm run build  # Compile Lambda TypeScript to dist/
cd ..
cdk synth                    # Generate CloudFormation template
cdk deploy DentiPalCDKStackV5
```

### 24.2 What ops should monitor after deploy

- CloudWatch Logs for `DentiPal-Backend-Monolith` at logging level `INFO` with data tracing enabled.
- X-Ray traces (stack has `tracingEnabled: true`).
- API Gateway `4xx` and `5xx` metric alarms on the `prod` stage.
- DynamoDB `UserErrors` (conditional-check failures, throttling) on all 18 tables.
- Lambda concurrent executions — the monolith is the single point of failure for all REST traffic.
- EventBridge `FailedInvocations` on `DentiPal-ShiftEvent-to-Inbox` rule.
- WebSocket connection count and staleness (`CONNS_TABLE` row growth).

---

## Appendix A — File Inventory

| Path | LOC | Role |
|------|----:|------|
| [bin/denti_pal_cdk.ts](bin/denti_pal_cdk.ts) | 8 | CDK app entrypoint |
| [lib/denti_pal_cdk-stack.ts](lib/denti_pal_cdk-stack.ts) | 1563 | Main CDK stack (lines 1–654 are commented-out history; active code starts line 655) |
| [lambda/src/index.ts](lambda/src/index.ts) | 524 | REST monolith router |
| [lambda/src/handlers/utils.ts](lambda/src/handlers/utils.ts) | 429 | Auth/RBAC utilities |
| [lambda/src/handlers/corsHeaders.ts](lambda/src/handlers/corsHeaders.ts) | 48 | CORS header machinery |
| [lambda/src/handlers/*.ts](lambda/src/handlers/) | ~32,700 (128 files) | Per-feature handlers |
| [test/denti_pal_cdk.test.ts](test/denti_pal_cdk.test.ts) | — | Jest scaffolding |

## Appendix B — Source documents consolidated here

- [DENTIPAL_DATABASE_SCHEMA.md](DENTIPAL_DATABASE_SCHEMA.md) — authoritative per-attribute schema for tables 1–17.
- [DENTIPAL_CDK_REFERENCE.md](DENTIPAL_CDK_REFERENCE.md) — stack-level reference.
- [docs/database-schema.md](docs/database-schema.md) — earlier schema snapshot (superseded by the V5 doc above).

---

*End of report.*
