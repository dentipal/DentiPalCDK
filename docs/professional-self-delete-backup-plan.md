# Self-Delete Professional Account with Full Backup

## Context

When a professional deletes their Dentipal account today, [deleteOwnAccount.ts](../lambda/src/handlers/deleteOwnAccount.ts) only deletes `UserClinicAssignments` rows and calls Cognito `AdminDeleteUserCommand`. Everything else (profile, applications, invitations, negotiations, messages, feedback, favorites, referrals, bonuses, S3 files) is either orphaned or silently lost — no audit trail, no churn analytics, no GDPR proof-of-deletion.

This plan adds a **backup-then-wipe** flow on the self-service path. A single dedicated table — `DentiPal-V5-ProfessionalAccountBackups` — captures the complete professional snapshot in one row, structured to mirror the user-visible Profile page (Personal Information, Address, Professional Information, Documents & Media, Travel Settings) plus Completed Shifts, Referrals, and Bonuses. Media bytes are moved (S3 copy + delete) under a `backup/<userSub>/` prefix in the same buckets. **Only after the backup row write is durable** does the system automatically wipe every source table, every original-prefix S3 object, and the Cognito user.

Clinic accounts keep today's behaviour — this iteration is professionals-only.

### User decisions baked in

- **Retention**: indefinite, no TTL.
- **Sensitive fields**: back up everything except passwords / payment tokens (defensive denylist; nothing matching exists in DynamoDB today).
- **S3 files**: move under `backup/<userSub>/<originalKey>` in the same bucket.
- **Trigger**: user self-delete only. No admin route this iteration.
- **Wipe scope**: complete — every source table including `Messages`/`Conversations`, plus original-prefix S3 objects, plus Cognito user. Referrals where the deleted pro was the **referrer** are anonymised (not deleted) so the still-active referred user keeps their attribution and bonus linkage.

---

## 1. What the backup row contains

Backup table PK: `userSub`. Row body, structured to mirror the user-visible profile sections:

```jsonc
{
  "userSub": "<sub>",
  "backedUpAt": "<ISO>",
  "backupYearMonth": "YYYY-MM",        // GSI partition for monthly audit queries
  "backupReason": "user_self_delete",
  "schemaVersion": 1,
  "status": "snapshot_written" | "media_moved" | "wipe_completed",
  "wipedAt": "<ISO>",                  // set on completion

  // ─────────── Identity & headline stats (mirrors the profile header) ───────────
  "identity": {
    "firstName": "Banu",
    "lastName":  "SYEDA",
    "email":     "pbushrabanu@gmail.com",
    "phone":     "+919912725181",
    "role":      "dental_hygienist",
    "yearsOfExperience": 1,
    "bio":       "hhhhhhh",
    "cognitoUserSub": "<sub>",
    "cognitoGroups": ["DentalHygienist", ...]   // captured from the token at deletion time
  },
  "completedShiftsCount": 0,            // computed from JobApplications where status in (completed,paid)

  // ─────────── Personal Information ───────────
  // (matches the "Edit > Basic Information" panel on the profile page)
  "personalInformation": {
    "firstName": "Banu",
    "lastName":  "SYEDA",
    "email":     "pbushrabanu@gmail.com",
    "phone":     "+919912725181",
    "bio":       "hhhhhhh"
  },

  // ─────────── Address Information ───────────
  // (matches the "Address Information" panel)
  "addresses": [
    {
      "userSub":       "<sub>",
      "addressLine1":  "Manchippa",
      "addressLine2":  "Suite 110",
      "city":          "Nizamabad",
      "state":         "Telangana",
      "pincode":       "503230",
      "country":       "IND",
      "addressType":   "residential",
      "isDefault":     true,
      "createdAt":     "<ISO>",
      "updatedAt":     "<ISO>"
    }
  ],

  // ─────────── Professional Information ───────────
  // (matches "Professional Details", "Qualifications & Skills",
  //  "Certificates & Licenses", and "Specializations" panels)
  "professionalInformation": {
    "role":              "dental_hygienist",
    "yearsOfExperience": 1,
    "qualifications":    "bds",
    "skills":            ["cleaning", "root canals"],
    "certificates":      ["na"],
    "licenseNumber":     "na",
    "professionalCertificates": ["na"],
    "specializations": [
      "General Dentistry",
      "Cosmetic Dentistry",
      "Endodontics",
      "Oral Surgery",
      "Pediatric Dentistry",
      "Orthodontics"
    ]
  },

  // ─────────── Documents & Media ───────────
  // Manifest only — actual bytes are moved to backup/<userSub>/... in the same buckets.
  "documentsAndMedia": {
    "profileImage": {
      "bucket": "PROFILE_IMAGES_BUCKET",
      "oldKey": "<userSub>/profile-image/<file>",
      "newKey": "backup/<userSub>/profile-image/<file>",
      "size": 12345,
      "contentType": "image/png",
      "etag": "...",
      "lastModified": "<ISO>"
    },
    "professionalResume":  { /* same shape, e.g. Todays_Dental_Alexandria_Content.pdf */ },
    "drivingLicense":      { /* e.g. valentines-popup.png */ },
    "professionalLicense": { /* e.g. OSHA_Training.jpg */ },
    "introVideo":          { /* e.g. VID-20200804-WA0002.mp4 */ },
    "professionalCertificateFiles": []
  },

  // ─────────── Travel Settings ───────────
  "travelSettings": {
    "isWillingToTravel": true,
    "maxTravelDistance": 95
  },

  // ─────────── Completed Shifts (derived from JobApplications) ───────────
  "completedShifts": [
    {
      "applicationId":      "<id>",
      "jobId":              "<jobId>",
      "clinicId":           "<clinicId>",
      "completedAt":        "<ISO>",
      "hoursWorked":        8,
      "acceptedHourlyRate": 65,
      "totalEarnings":      520,
      "paidAt":             "<ISO>"
    }
  ],

  // ─────────── Activity history ───────────
  "applications":  [/* every JobApplications row for this pro */],
  "invitations":   [/* every JobInvitations row */],
  "negotiations":  [/* every JobNegotiations row tied to those applications */],

  // ─────────── Communications ───────────
  "messages":      [/* every Messages row this pro sent or received */],
  "conversations": [/* every Conversations row this pro participated in */],
  "connections":   [/* any active WebSocket Connections rows (usually small) */],

  // ─────────── Preferences & feedback ───────────
  "notificationPreferences": { /* their opt-in record */ },
  "feedback":        [/* every feedback submission they authored */],
  "clinicFavorites": [/* clinics that favorited them */],

  // ─────────── Referrals (BOTH sides) ───────────
  // - direction "sent":     pro was the referrer (source row gets ANONYMISED, not deleted)
  // - direction "received": pro was the referred party (source row gets DELETED)
  // Both captured in full here with original referrer/referred IDs.
  "referrals": [
    {
      "referralId":         "<id>",
      "direction":          "sent" | "received",
      "referrerUserSub":    "<sub>",
      "referrerName":       "Banu SYEDA",
      "referredUserSub":    "<sub or null>",
      "friendEmail":        "<email>",
      "status":             "sent" | "signed_up" | "bonus_due" | "paid",
      "sentAt":             "<ISO>",
      "signedUpAt":         "<ISO>",
      "firstShiftCompletedAt": "<ISO>",
      "updatedAt":          "<ISO>",
      "referralBonus":      50
    }
  ],

  // ─────────── Bonus details ───────────
  // Bonuses are persisted directly on the Referrals row (referralBonus numeric column,
  // accumulated by BonusAwarding.ts when the referred pro completes shifts). Derived
  // here into a summary for easy auditing — original numbers also remain inline above.
  "bonuses": {
    "referralBonuses": [
      {
        "referralId":      "<id>",
        "bonusType":       "referral",
        "recipientUserSub": "<sub>",
        "amount":          50,
        "currency":        "USD",
        "status":          "paid",
        "awardedAt":       "<ISO>",
        "paidAt":          "<ISO>"
      }
    ],
    "totalReferralBonusEarned": 50
  },

  "userClinicAssignments": [/* every UserClinicAssignments row for this user */],

  // ─────────── Spill manifest (only populated for outlier users) ───────────
  // If the inline row would exceed DynamoDB's 400 KB item limit, the largest array
  // sections (messages, conversations, applications) move to JSONL files under
  // backup/<userSub>/spill/<section>.jsonl and only the S3 key + row count stays inline.
  "spillManifest": [
    { "section": "messages", "key": "backup/<userSub>/spill/messages.jsonl", "count": 4123 }
  ]
}
```

**Item-size guard**: DynamoDB caps items at 400 KB. Typical user is ~50 KB. After collecting each section, measure the marshalled total. If projected > 350 KB, spill the largest array sections (`messages`, `conversations`, `applications`) to JSONL files at `backup/<userSub>/spill/<section>.jsonl` and store only the S3 key + row count in the row for those sections.

**Defensive denylist**: while marshalling, strip any field matching `/^(password|bankAccount|stripe|card)/i`. Nothing matches today but the filter is cheap insurance.

---

## 2. CDK changes — [lib/denti_pal_cdk-stack.ts](../lib/denti_pal_cdk-stack.ts)

Add inside the active stack block, right after `bansTable`:

```ts
const professionalBackupsTable = new dynamodb.Table(this, 'ProfessionalAccountBackupsTable', {
  tableName: 'DentiPal-V5-ProfessionalAccountBackups',
  partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: cdk.RemovalPolicy.RETAIN,         // overrides codebase default of DESTROY — this IS the audit trail
  pointInTimeRecovery: true,
});
professionalBackupsTable.addGlobalSecondaryIndex({
  indexName: 'backedUpAt-index',
  partitionKey: { name: 'backupYearMonth', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'backedUpAt',      type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.KEYS_ONLY,
});
```

Add `professionalBackupsTable` to the `allTables` array (~line 1205) — `allTables.forEach(t => t.grantReadWriteData(lambdaFunction))` automatically gives the monolith Lambda RW access.

Inject one env var on the monolith Lambda's `environment` block (~line 1312):

```ts
PROFESSIONAL_BACKUPS_TABLE: professionalBackupsTable.tableName,
```

The five S3 buckets already have `grantReadWrite(lambdaFunction)`, which covers `s3:CopyObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:GetObject`, `s3:PutObject`. No bucket IAM changes needed. Buckets keep `BlockPublicAccess: BLOCK_ALL`.

**CDK test**: add one assertion in [test/denti_pal_cdk.test.ts](../test/denti_pal_cdk.test.ts) that the new table exists with `RemovalPolicy.RETAIN` and PK `userSub`.

---

## 3. Handler refactor — [lambda/src/handlers/deleteOwnAccount.ts](../lambda/src/handlers/deleteOwnAccount.ts)

Branch on Cognito-derived user type at the top:

```
const userInfo = extractUserFromBearerToken(authHeader);
// utils.ts already exposes `userInfo.userType` ("professional" | "clinic" | "internal")
// and `userInfo.groups: string[]` — both already used elsewhere.

if (userInfo.userType !== "professional") {
  return existingDeleteFlow(...)         // clinic users unchanged
}
return backupThenWipe(userInfo.sub, userInfo.groups);
```

### `backupThenWipe(userSub, groups)` — sequential steps

If a step fails **before** the backup row is durable, abort and return 500 (user stays active). If a step fails **after** the backup row is durable, log and continue — the backup is the source of truth.

#### Step 1 — collect snapshot (parallel `Promise.all`)

| Backup section | Source table | How to read | GSI |
|---|---|---|---|
| `identity`, `personalInformation`, `professionalInformation`, `travelSettings`, `documentsAndMedia` keys | `ProfessionalProfiles` | `GetCommand({ Key: { userSub } })` | — |
| `addresses` | `UserAddresses` | `GetCommand({ Key: { userSub } })` (PK-only table, one row per user) | — |
| `applications` + derived `completedShifts` / `completedShiftsCount` | `JobApplications` | `Query(GSI=professionalUserSub-index, PK=professionalUserSub)`, paginate | confirmed at stack line ~930 |
| `invitations` | `JobInvitations` | `Query(GSI=ProfessionalIndex, PK=professionalUserSub)`, paginate | confirmed at stack line ~959 |
| `negotiations` | `JobNegotiations` | enumerate `applicationId`s from `applications` → `Query(PK=applicationId)` per app | base table is keyed by applicationId + negotiationId |
| `notificationPreferences` | `NotificationPreferences` | `GetCommand({ Key: { userSub } })` | — |
| `connections` | `Connections` | `Query(PK userKey=prof#<userSub>)`, paginate | — |
| `referrals` (received) | `Referrals` | `Query(GSI=ReferredUserSubIndex)` | confirmed at stack line ~1084 |
| `referrals` (sent) | `Referrals` | `Query(GSI=ReferrerIndex)` | confirmed at stack line ~1089 |
| `bonuses.*` | — | derived in-memory from the `referralBonus` numeric column on the Referrals rows above (no separate bonus table — confirmed by reading BonusAwarding.ts) | — |
| `clinicFavorites` | `ClinicFavorites` | `ScanCommand` + `FilterExpression(professionalUserSub = :s)`, paginate (no GSI on this column today) | — |
| `feedback` | `Feedback` | `ScanCommand` + `FilterExpression(UserSub = :s)`, paginate | — |
| `conversations` | `Conversations` | `Query(GSI=profKey-lastMessageAt, PK=profKey=prof#<userSub>)` | confirmed at stack line ~874 |
| `messages` | `Messages` | for each `conversationId` from `conversations`: `Query(PK=conversationId)`, paginate | — |
| `userClinicAssignments` | `UserClinicAssignments` | `Query(PK=userSub)`, paginate | — |

Derive `completedShifts` from `applications` where `applicationStatus IN ("completed", "paid")`. Derive `completedShiftsCount = completedShifts.length`.

Compose `documentsAndMedia.<slot>` from the S3 keys already on the `ProfessionalProfiles` row (`profileImageKey`, `resumeKey`, `professionalLicenseKey`, `driversLicenseKey`, `introVideoKey`).

Pre-marshal via `@aws-sdk/util-dynamodb` (already used in 141 places). Run each row through the denylist filter.

#### Step 2 — build S3 media manifest

For each of the five buckets in parallel: `ListObjectsV2({ Bucket, Prefix: \`${userSub}/\` })`, paginate. For each object build:

```
{ bucket, oldKey, newKey: `backup/${userSub}/${oldKey.substring(userSub.length + 1)}`,
  size, contentType, etag, lastModified }
```

Map each entry into the correct `documentsAndMedia.<slot>` by bucket name. Don't move bytes yet.

#### Step 3 — write the backup row (the durability point)

```
PutItem on DentiPal-V5-ProfessionalAccountBackups
ConditionExpression: 'attribute_not_exists(userSub)'
```

Mirrors the write-once pattern in [admin/banSubject.ts](../lambda/src/handlers/admin/banSubject.ts). On `ConditionalCheckFailedException` see §4 idempotency.

**This is the commit point.** From here on we automatically proceed to wipe.

#### Step 4 — move S3 bytes

Loop the manifest in chunks of ~10 in parallel:

1. `CopyObject({ Bucket, CopySource: \`${Bucket}/${oldKey}\`, Key: newKey })`
2. On success, `DeleteObject({ Bucket, Key: oldKey })`

Per-file failure → log `backup.s3_move_errors`, continue. Originals stay in place on copy failure so a retry is safe.

After the loop, `UpdateItem` on the backup row: `status = "media_moved"`, write `fileMoveErrors` if any.

#### Step 5 — wipe all source rows

Per-table sequential, chunks of 25 via `BatchWriteItemCommand`:

- `ProfessionalProfiles` (PK delete)
- `UserAddresses` (PK delete)
- `NotificationPreferences` (PK delete)
- `Connections` (all rows under `prof#<userSub>`)
- `ClinicFavorites` (all rows where the pro appears)
- `Feedback` (all rows authored by this pro)
- `JobApplications` (all rows for `professionalUserSub` — `jobId` + `professionalUserSub` is the composite key)
- `JobInvitations` (all rows for this pro)
- `JobNegotiations` (rows for the enumerated `applicationId`s)
- `UserClinicAssignments` (matches today's handler)
- `Messages` + `Conversations` — fully delete, including the clinic-side counterparty's view (deliberate per user's "complete wipe" intent).
- **`Referrals` — two different operations to preserve linkage:**
  - **Delete** rows where the deleted pro was the **referred** party (from `Query(GSI=ReferredUserSubIndex)`).
  - **Anonymise** rows where the deleted pro was the **referrer**: `UpdateItem` setting `referrerUserSub = "[deleted]"`, `referrerName = "[deleted user]"`. Every other field including `referralBonus` stays intact so the still-active referred user keeps their attribution and bonus accounting.

Per-table failure → log `backup.source_delete_errors`, continue.

#### Step 6 — Cognito (last)

`AdminDeleteUserCommand({ UserPoolId, Username: userSub })`. On failure log `backup.cognito_orphaned` and return success — an admin can clean up the dangling user later using the backup row.

On success, `UpdateItem` on the backup row: `status = "wipe_completed"`, `wipedAt: <ISO>`.

### Error model

| Step | Outcome on failure |
|---|---|
| 1 snapshot | abort, 500, user still active |
| 2 manifest | abort, 500 |
| 3 backup PutItem | abort, 500 |
| 4 S3 move | log, continue (backup is durable) |
| 5 source delete | log, continue |
| 6 Cognito delete | log, return success |

---

## 4. Idempotency

```
PutItem backup with attribute_not_exists(userSub)
  → succeeds → continue forward
  → ConditionalCheckFailedException → existing backup row present
      → GetItem backup
        → status === "snapshot_written":   resume from Step 4
        → status === "media_moved":        resume from Step 5
        → status === "wipe_completed":     check Cognito;
              if user still exists → retry Step 6 only;
              else return success — already done
```

**Never delete the backup row to retry** — that destroys the audit.

---

## 5. Observability

One-line structured logs (no SDK metric calls; CloudWatch Logs Insights can aggregate):

- `backup.started { userSub }`
- `backup.snapshot_written { userSub, sizeBytes, sectionsSpilledToS3 }`
- `backup.media_moved { userSub, fileCount, errorCount }`
- `backup.wipe_completed { userSub, durationMs }`
- `backup.failed { userSub, step, error }`
- `backup.s3_move_errors { userSub, count }`
- `backup.source_delete_errors { userSub, table, error }`
- `backup.cognito_orphaned { userSub }`

---

## 6. Frontend impact — [accountOverview.tsx](../../dentipal/src/components/ProfessionalProfile/accountOverview.tsx)

One copy change in the delete confirmation dialog:

> "Your account will be permanently deleted from DentiPal. For legal and compliance reasons, a backup copy of your profile, applications, referrals, bonuses, and uploaded files is retained internally. Once deletion completes, your data will no longer be visible to you or any clinic."

No API-shape change. Handler still returns `{ status: "success", message: "Account deleted successfully" }`. Logout flow unchanged.

---

## 7. Verification

End-to-end manual test:

1. Create a test professional. Fill in all profile sections (Personal Info, Address, Professional Info with skills/specializations, upload all four documents + profile image, set Travel Settings). Submit a job application, complete at least one shift. Favorite a clinic. Send a chat message. Send a referral invite to another email and have that recipient sign up and complete a shift so a bonus is awarded.
2. Call `POST /deleteOwnAccount` (or click "Delete Account" in the UI).
3. **Inspect the backup row**:
   ```
   aws dynamodb get-item \
     --table-name DentiPal-V5-ProfessionalAccountBackups \
     --key '{"userSub":{"S":"<sub>"}}'
   ```
   Verify every section in §1 is populated:
   - `identity`, `personalInformation`, `professionalInformation`, `travelSettings` mirror what the user saw on the profile page.
   - `documentsAndMedia` has manifest entries with `newKey` under `backup/<userSub>/`.
   - `completedShifts` lists the shift, `completedShiftsCount === 1`.
   - `applications`, `invitations`, `negotiations`, `messages`, `conversations`, `clinicFavorites`, `feedback`, `notificationPreferences`, `userClinicAssignments` all populated.
   - `referrals` has the sent invite with `direction: "sent"` and original `referrerName`/`referrerUserSub`.
   - `bonuses.referralBonuses` has the awarded bonus.
   - `status === "wipe_completed"`, `wipedAt` set.
4. **S3**: for each of the five buckets, `aws s3 ls s3://<bucket>/<userSub>/` returns empty; `aws s3 ls s3://<bucket>/backup/<userSub>/` lists the original files.
5. **Source tables**: query each by `userSub` — 0 rows everywhere except `Referrals`, where rows the pro **sent** still exist but with `referrerUserSub === "[deleted]"`.
6. **Cognito**: `aws cognito-idp admin-get-user --user-pool-id <pool> --username <sub>` returns `UserNotFoundException`.
7. **Idempotency**: call delete a second time with the still-valid access token. Handler returns a clean "already deleted" response.
8. **Spill-to-S3 path**: create a pro with >2000 messages, delete, confirm `spillManifest` is populated with a working JSONL file.
9. **CDK test**: `npm test` in `DentiPalCDK/` — the schema assertion passes.

---

## 8. Risks called out

1. **Scan cost on `Feedback` / `ClinicFavorites` for prolific users.** Bound with `Limit`, spill overflow to S3, monitor `backup.snapshot_written.sectionsSpilledToS3`. If a single user routinely takes >60s, **don't lift the Lambda timeout** — migrate to Step Functions (one state per section). v2 escape hatch.
2. **Backup table grows without bound** (per user decision). Per-user ~50 KB DynamoDB. 100k deletions → ~5 GB DynamoDB, well under $50/yr at PAY_PER_REQUEST.
3. **S3 move briefly doubles storage** between copy and delete. Negligible at expected scale.
4. **`ClinicFavorites` needs a Scan** today — no `professionalUserSub` GSI. Follow-up PR could add `professionalUserSub-clinicUserSub-index` (also enables a "clinics I've favorited" surface on the pro side). Out of scope for v1.
5. **Cognito access token outlives the user** by ~1h. After Cognito delete every backend route queries DDB by `sub` and finds nothing, so the stale token is harmless.
6. **The pro's name lingers in clinic-owned denormalised fields** (e.g. `professionalName` snapshots on clinic-side projections). Out of scope for this PR; flag for legal review.
7. **Backup files share the same buckets** under `backup/`. Buckets keep `BLOCK_ALL`. v2 follow-up: move the backup prefix to a dedicated `dentipal-professional-backups` bucket with S3 Object Lock for tamper-evident retention.

---

## Critical files

### Modify

- [DentiPalCDK/lib/denti_pal_cdk-stack.ts](../lib/denti_pal_cdk-stack.ts) — new backup table, env var, add to `allTables`.
- [DentiPalCDK/lambda/src/handlers/deleteOwnAccount.ts](../lambda/src/handlers/deleteOwnAccount.ts) — role branch + `backupThenWipe` flow.
- [DentiPalCDK/test/denti_pal_cdk.test.ts](../test/denti_pal_cdk.test.ts) — schema assertion for the new table.
- [dentipal/src/components/ProfessionalProfile/accountOverview.tsx](../../dentipal/src/components/ProfessionalProfile/accountOverview.tsx) — confirmation copy.

### Reference (no edit)

- [DentiPalCDK/lambda/src/handlers/utils.ts](../lambda/src/handlers/utils.ts) — `extractUserFromBearerToken` (returns `userType` + `groups`).
- [DentiPalCDK/lambda/src/handlers/admin/banSubject.ts](../lambda/src/handlers/admin/banSubject.ts) — `attribute_not_exists` write-once pattern to mirror.
- [DentiPalCDK/lambda/src/handlers/getJobApplications.ts](../lambda/src/handlers/getJobApplications.ts) — confirms `professionalUserSub-index` on JobApplications.
- [DentiPalCDK/lambda/src/handlers/BonusAwarding.ts](../lambda/src/handlers/BonusAwarding.ts) — confirms bonus is stored as `referralBonus` column on the Referrals row.
