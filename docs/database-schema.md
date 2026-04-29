> ⚠ **NOTE — 2026-04-28**: `DentiPal-V5-Notifications` and `DentiPal-V5-OTPVerification` tables and their `NOTIFICATIONS_TABLE` / `OTP_VERIFICATION_TABLE` env vars have been retired. References below to those tables are historical — they no longer exist in the deployed stack. Notifications were never read by any handler; OTPVerification duplicated Cognito's native flow.

# DentiPal Database Schema Documentation

**Database Engine:** Amazon DynamoDB (NoSQL)
**Billing Mode:** PAY\_PER\_REQUEST (all tables)
**Table Prefix:** `DentiPal-V5-`
**Total Tables:** 17
**Total GSIs:** 24
**Source:** `DentiPalCDK/lib/denti_pal_cdk-stack.ts` (lines 738-1006)

---

## 1. Tables Overview

| #  | Table Name            | Partition Key          | Sort Key                 | GSIs | Purpose                                   |
|----|-----------------------|------------------------|--------------------------|------|-------------------------------------------|
| 1  | Clinic-Profiles       | `clinicId` (S)         | `userSub` (S)            | 1    | Clinic configuration & practice details   |
| 2  | ClinicFavorites       | `clinicUserSub` (S)    | `professionalUserSub` (S)| 0    | Clinics' bookmarked professionals         |
| 3  | Clinics               | `clinicId` (S)         | —                        | 1    | Clinic entities (name, address)           |
| 4  | Connections           | `userKey` (S)          | `connectionId` (S)       | 1    | WebSocket connection tracking             |
| 5  | Conversations         | `conversationId` (S)   | —                        | 2    | Chat conversations metadata               |
| 6  | Feedback              | `PK` (S)               | `SK` (S)                 | 0    | User feedback submissions                 |
| 7  | JobApplications       | `jobId` (S)            | `professionalUserSub` (S)| 5    | Professional applications to jobs         |
| 8  | JobInvitations        | `jobId` (S)            | `professionalUserSub` (S)| 2    | Clinic invitations to professionals       |
| 9  | JobNegotiations       | `applicationId` (S)    | `negotiationId` (S)      | 3    | Rate/terms negotiation threads            |
| 10 | JobPostings           | `clinicUserSub` (S)    | `jobId` (S)              | 4    | Job listings (temp, multi-day, permanent) |
| 11 | Messages              | `conversationId` (S)   | `messageId` (S)          | 1    | Chat message storage                      |
| 12 | Notifications         | `recipientUserSub` (S) | `notificationId` (S)     | 0    | Push/in-app notifications                 |
| 13 | OTPVerification       | `email` (S)            | —                        | 0    | Email OTP codes for registration          |
| 14 | ProfessionalProfiles  | `userSub` (S)          | —                        | 0    | Dental professional profiles              |
| 15 | Referrals             | `referralId` (S)       | —                        | 2    | Referral invite tracking                  |
| 16 | UserAddresses         | `userSub` (S)          | —                        | 0    | User address records                      |
| 17 | UserClinicAssignments | `userSub` (S)          | `clinicId` (S)           | 0    | User-to-clinic role assignments           |

---

## 2. Detailed Table Definitions

### 2.1 — DentiPal-V5-Clinic-Profiles

**Purpose:** Stores clinic-specific configuration and practice details (operatories, staff counts, practice type).

| Field                        | Type    | Description                              |
|------------------------------|---------|------------------------------------------|
| `clinicId`                   | String  | **PK** — Clinic identifier               |
| `userSub`                    | String  | **SK** — Cognito user sub of clinic owner |
| `practice_type`              | String  | Type of dental practice                  |
| `primary_practice_area`      | String  | Main area of practice                    |
| `primary_contact_first_name` | String  | Primary contact first name               |
| `primary_contact_last_name`  | String  | Primary contact last name                |
| `assisted_hygiene_available` | Boolean | Whether assisted hygiene is offered      |
| `number_of_operatories`      | Number  | Number of operatories                    |
| `num_hygienists`             | Number  | Number of hygienists on staff            |
| `num_assistants`             | Number  | Number of dental assistants              |
| `num_doctors`                | Number  | Number of doctors                        |
| `booking_out_period`         | String  | Advance booking window                   |
| `free_parking_available`     | Boolean | Whether free parking is available        |

**GSIs:**

- `userSub-index` — PK: `userSub` — Look up all clinics for a given user

---

### 2.2 — DentiPal-V5-ClinicFavorites

**Purpose:** Tracks which professionals a clinic has bookmarked/favorited.

| Field                 | Type   | Description                              |
|-----------------------|--------|------------------------------------------|
| `clinicUserSub`       | String | **PK** — Clinic owner's user sub         |
| `professionalUserSub` | String | **SK** — Favorited professional's user sub |

**GSIs:** None

---

### 2.3 — DentiPal-V5-Clinics

**Purpose:** Core clinic entity storing name, address, and ownership.

| Field          | Type   | Description                       |
|----------------|--------|-----------------------------------|
| `clinicId`     | String | **PK** — Unique clinic identifier |
| `name`         | String | Clinic name                       |
| `addressLine1` | String | Street address line 1             |
| `addressLine2` | String | Street address line 2 (optional)  |
| `addressLine3` | String | Street address line 3 (optional)  |
| `city`         | String | City                              |
| `state`        | String | State                             |
| `pincode`      | String | Postal/ZIP code                   |
| `createdBy`    | String | Cognito user sub of creator       |

**GSIs:**

- `CreatedByIndex` — PK: `createdBy` — List all clinics created by a user

---

### 2.4 — DentiPal-V5-Connections

**Purpose:** Tracks active WebSocket connections for real-time messaging.

| Field          | Type   | Description                                    |
|----------------|--------|------------------------------------------------|
| `userKey`      | String | **PK** — User identifier                       |
| `connectionId` | String | **SK** — API Gateway WebSocket connection ID    |

**GSIs:**

- `connectionId-index` — PK: `connectionId`, SK: `userKey` — Reverse lookup by connection

---

### 2.5 — DentiPal-V5-Conversations

**Purpose:** Metadata for chat conversations between clinics and professionals.

| Field            | Type   | Description                            |
|------------------|--------|----------------------------------------|
| `conversationId` | String | **PK** — Unique conversation identifier |
| `clinicKey`      | String | Clinic participant key                 |
| `profKey`        | String | Professional participant key           |
| `lastMessageAt`  | Number | Timestamp of last message (epoch)      |

**GSIs:**

- `clinicKey-lastMessageAt` — PK: `clinicKey`, SK: `lastMessageAt` — Clinic's conversations sorted by recency
- `profKey-lastMessageAt` — PK: `profKey`, SK: `lastMessageAt` — Professional's conversations sorted by recency

---

### 2.6 — DentiPal-V5-Feedback

**Purpose:** Stores user-submitted feedback and feature requests.

| Field          | Type    | Description                                     |
|----------------|---------|-------------------------------------------------|
| `PK`           | String  | **PK** — Partition key (generic single-table pattern) |
| `SK`           | String  | **SK** — Sort key                               |
| `feedbackType` | String  | Category of feedback                            |
| `message`      | String  | Feedback content                                |
| `contactMe`    | Boolean | Whether user wants to be contacted              |
| `email`        | String  | Contact email                                   |

**GSIs:** None

---

### 2.7 — DentiPal-V5-JobApplications

**Purpose:** Tracks professional applications to job postings, including proposed rates and availability.

| Field                 | Type   | Description                              |
|-----------------------|--------|------------------------------------------|
| `jobId`               | String | **PK** — Job posting identifier          |
| `professionalUserSub` | String | **SK** — Applying professional's user sub |
| `applicationId`       | String | Unique application identifier            |
| `clinicId`            | String | Clinic that posted the job               |
| `message`             | String | Cover message                            |
| `proposedRate`        | Number | Professional's proposed hourly rate      |
| `availability`        | String | Availability details                     |
| `startDate`           | String | Proposed start date                      |
| `notes`               | String | Additional notes                         |

**GSIs:**

- `applicationId-index` — PK: `applicationId` — Direct application lookup
- `clinicId-index` — PK: `clinicId` — All applications for a clinic
- `clinicId-jobId-index` — PK: `clinicId`, SK: `jobId` — Applications per clinic per job
- `JobIdIndex-1` — PK: `jobId` — All applications for a job
- `professionalUserSub-index` — PK: `professionalUserSub`, SK: `jobId` — A professional's applications

---

### 2.8 — DentiPal-V5-JobInvitations

**Purpose:** Tracks invitations sent by clinics to specific professionals for jobs.

| Field                 | Type   | Description                                |
|-----------------------|--------|--------------------------------------------|
| `jobId`               | String | **PK** — Job posting identifier            |
| `professionalUserSub` | String | **SK** — Invited professional's user sub   |
| `invitationId`        | String | Unique invitation identifier               |

**GSIs:**

- `invitationId-index` — PK: `invitationId` — Direct invitation lookup
- `ProfessionalIndex` — PK: `professionalUserSub` — All invitations for a professional

---

### 2.9 — DentiPal-V5-JobNegotiations

**Purpose:** Stores negotiation rounds between clinics and professionals on job terms/rates.

| Field                 | Type   | Description                      |
|-----------------------|--------|----------------------------------|
| `applicationId`       | String | **PK** — Parent application ID   |
| `negotiationId`       | String | **SK** — Unique negotiation ID   |
| `clinicId`            | String | Clinic involved                  |
| `jobId`               | String | Job being negotiated             |
| `professionalUserSub` | String | Professional involved            |
| `status`              | String | Negotiation status               |
| `lastOfferPay`        | Number | Most recent offered rate         |
| `lastOfferFrom`       | String | Who made the last offer          |
| `gsi1pk`              | String | GSI1 partition key               |
| `gsi1sk`              | String | GSI1 sort key                    |
| `createdAt`           | String | Creation timestamp               |
| `updatedAt`           | String | Last update timestamp            |

**GSIs:**

- `index` — PK: `applicationId` — All negotiations for an application
- `GSI1` — PK: `gsi1pk`, SK: `gsi1sk` — Projected: `negotiationId`, `clinicId`, `jobId`, `professionalUserSub`, `status`, `lastOfferPay`, `lastOfferFrom`, `updatedAt`
- `JobIndex` — PK: `jobId`, SK: `createdAt` — Negotiations for a job sorted by time

---

### 2.10 — DentiPal-V5-JobPostings

**Purpose:** Core job listing table supporting three job types: temporary, multi-day consulting, and permanent positions.

| Field               | Type           | Description                                          |
|---------------------|----------------|------------------------------------------------------|
| `clinicUserSub`     | String         | **PK** — Clinic owner's user sub                     |
| `jobId`             | String         | **SK** — Unique job identifier                       |
| `clinicId`          | String         | Clinic identifier                                    |
| `job_type`          | String         | `temporary` / `multi_day_consulting` / `permanent`   |
| `professional_role` | String         | Required role (dentist, hygienist, etc.)              |
| `shift_speciality`  | String         | Shift specialization                                 |
| `status`            | String         | `active` / `inactive` / `filled`                     |
| `job_title`         | String         | Job title                                            |
| `job_description`   | String         | Full description                                     |
| `requirements`      | List\<String\> | Required qualifications                              |
| `date`              | String         | Shift date (temporary jobs)                          |
| `hours`             | Number         | Hours per shift (temporary)                          |
| `hourly_rate`       | Number         | Hourly rate (temp/multi-day)                         |
| `dates`             | List\<String\> | Multiple dates (multi-day)                           |
| `hours_per_day`     | Number         | Hours per day (multi-day)                            |
| `total_days`        | Number         | Total engagement days (multi-day)                    |
| `employment_type`   | String         | `full_time` / `part_time` (permanent)                |
| `salary_min`        | Number         | Minimum salary (permanent)                           |
| `salary_max`        | Number         | Maximum salary (permanent)                           |
| `benefits`          | List\<String\> | Benefits offered (permanent)                         |
| `start_time`        | String         | Shift start time                                     |
| `end_time`          | String         | Shift end time                                       |
| `meal_break`        | Boolean        | Whether meal break is provided                       |
| `assisted_hygiene`  | Boolean        | Assisted hygiene required                            |

**GSIs:**

- `ClinicIdIndex` — PK: `clinicId`, SK: `jobId` — Jobs by clinic
- `DateIndex` — PK: `date`, SK: `jobId` — Jobs by date (for searching available shifts)
- `jobId-index-1` — PK: `jobId` — Direct job lookup
- `JobIdIndex-2` — PK: `jobId` — Direct job lookup (alternate)

---

### 2.11 — DentiPal-V5-Messages

**Purpose:** Stores individual chat messages within conversations.

| Field            | Type   | Description                       |
|------------------|--------|-----------------------------------|
| `conversationId` | String | **PK** — Parent conversation      |
| `messageId`      | String | **SK** — Unique message identifier |

**GSIs:**

- `ConversationIdIndex` — PK: `conversationId`, SK: `messageId` — Messages in a conversation

---

### 2.12 — DentiPal-V5-Notifications

**Purpose:** Stores push/in-app notifications for users.

| Field              | Type   | Description                       |
|--------------------|--------|-----------------------------------|
| `recipientUserSub` | String | **PK** — Notification recipient   |
| `notificationId`   | String | **SK** — Unique notification ID   |

**GSIs:** None

---

### 2.13 — DentiPal-V5-OTPVerification

**Purpose:** Temporary storage for email OTP codes during user registration.

| Field   | Type   | Description                  |
|---------|--------|------------------------------|
| `email` | String | **PK** — Email being verified |

**GSIs:** None

---

### 2.14 — DentiPal-V5-ProfessionalProfiles

**Purpose:** Dental professional profile data (role, name, specialties).

| Field         | Type           | Description                                  |
|---------------|----------------|----------------------------------------------|
| `userSub`     | String         | **PK** — Cognito user sub                    |
| `role`        | String         | Professional role (dentist, hygienist, etc.)  |
| `first_name`  | String         | First name                                   |
| `last_name`   | String         | Last name                                    |
| `specialties` | List\<String\> | Areas of specialization                      |

**GSIs:** None

---

### 2.15 — DentiPal-V5-Referrals

**Purpose:** Tracks referral invitations sent by existing users to recruit new users.

| Field             | Type   | Description                                  |
|-------------------|--------|----------------------------------------------|
| `referralId`      | String | **PK** — Unique referral identifier          |
| `referrerUserSub` | String | User sub of the referrer                     |
| `referredUserSub` | String | User sub of referred user (after signup)     |
| `friendEmail`     | String | Invited friend's email                       |
| `personalMessage` | String | Custom invitation message                    |
| `sentAt`          | String | Timestamp when referral was sent             |

**GSIs:**

- `ReferredUserSubIndex` — PK: `referredUserSub` — Look up referral by referred user
- `ReferrerIndex` — PK: `referrerUserSub`, SK: `sentAt` — Referrals by referrer, sorted by time

---

### 2.16 — DentiPal-V5-UserAddresses

**Purpose:** Stores physical addresses for users (professionals or clinic owners).

| Field          | Type    | Description                       |
|----------------|---------|-----------------------------------|
| `userSub`      | String  | **PK** — Cognito user sub         |
| `addressLine1` | String  | Street address line 1             |
| `addressLine2` | String  | Street address line 2 (optional)  |
| `addressLine3` | String  | Street address line 3 (optional)  |
| `city`         | String  | City                              |
| `state`        | String  | State                             |
| `pincode`      | String  | Postal/ZIP code                   |
| `country`      | String  | Country (optional)                |
| `addressType`  | String  | Type of address (optional)        |
| `isDefault`    | Boolean | Default address flag              |

**GSIs:** None

---

### 2.17 — DentiPal-V5-UserClinicAssignments

**Purpose:** Maps users to clinics they belong to (multi-clinic support).

| Field      | Type   | Description                        |
|------------|--------|------------------------------------|
| `userSub`  | String | **PK** — Cognito user sub          |
| `clinicId` | String | **SK** — Assigned clinic identifier |

**GSIs:** None

---

## 3. Entity Relationships

Since DynamoDB is a NoSQL database, relationships are not enforced at the database level but are maintained at the application layer. Below is the logical relationship map:

```
Users (Cognito)
 |-- 1:1  --> ProfessionalProfiles       (userSub)
 |-- 1:1  --> UserAddresses              (userSub)
 |-- 1:N  --> UserClinicAssignments      (userSub -> clinicId)
 |-- 1:N  --> Notifications              (recipientUserSub)
 |-- 1:N  --> Connections                (userKey -- WebSocket)
 +-- 1:N  --> Referrals                  (referrerUserSub)

Clinics
 |-- 1:1  --> ClinicProfiles             (clinicId + userSub)
 |-- 1:N  --> JobPostings                (clinicUserSub -> jobId)
 |-- 1:N  --> ClinicFavorites            (clinicUserSub -> professionalUserSub)
 +-- N:M  --> Users via UserClinicAssignments

JobPostings
 |-- 1:N  --> JobApplications            (jobId -> professionalUserSub)
 |-- 1:N  --> JobInvitations             (jobId -> professionalUserSub)
 +-- 1:N  --> JobNegotiations            (via applicationId)

JobApplications
 +-- 1:N  --> JobNegotiations            (applicationId -> negotiationId)

Conversations (Clinic <-> Professional)
 +-- 1:N  --> Messages                   (conversationId -> messageId)
```

### Relationship Summary

| Relationship                       | Type         | Connected Via                          |
|------------------------------------|--------------|----------------------------------------|
| User -> ProfessionalProfile        | One-to-One   | `userSub`                              |
| User -> UserAddress                | One-to-One   | `userSub`                              |
| User -> Clinic                     | Many-to-Many | `UserClinicAssignments` (junction table) |
| Clinic -> ClinicProfile            | One-to-One   | `clinicId`                             |
| Clinic -> JobPostings              | One-to-Many  | `clinicId` / `clinicUserSub`           |
| Clinic -> ClinicFavorites          | One-to-Many  | `clinicUserSub`                        |
| JobPosting -> JobApplications      | One-to-Many  | `jobId`                                |
| JobPosting -> JobInvitations       | One-to-Many  | `jobId`                                |
| JobApplication -> JobNegotiations  | One-to-Many  | `applicationId`                        |
| Conversation -> Messages           | One-to-Many  | `conversationId`                       |
| User -> Notifications              | One-to-Many  | `recipientUserSub`                     |
| User -> Referrals (as referrer)    | One-to-Many  | `referrerUserSub`                      |

---

## 4. System Flow

```
Clinic Owner registers (Cognito + OTPVerification)
  -> Creates Clinic (Clinics table)
  -> Sets up ClinicProfile (practice details, staff counts)
  -> Assigned via UserClinicAssignments
  -> Posts jobs (JobPostings -- temp, multi-day, or permanent)
      -> Sends invitations to professionals (JobInvitations)

Professional registers (Cognito + OTPVerification)
  -> Creates ProfessionalProfile (role, specialties)
  -> Saves UserAddress
  -> Browses jobs -> Applies (JobApplications)
      -> Clinic and professional negotiate (JobNegotiations)

Clinic <-> Professional communicate
  -> Conversations created -> Messages exchanged (real-time via WebSocket Connections)

Cross-cutting:
  -> Notifications sent for job events, messages, invitations
  -> Clinics can favorite professionals (ClinicFavorites)
  -> Users can refer friends (Referrals)
  -> Users can submit feedback (Feedback)
```

---

## 5. Authentication

User identity is managed by **AWS Cognito** (external to DynamoDB). The `userSub` field across all tables is the Cognito User Pool subject identifier, serving as the universal user foreign key.

---

## 6. Environment Variable Mapping

| Environment Variable             | Table Name                       |
|----------------------------------|----------------------------------|
| `CLINIC_PROFILES_TABLE`          | DentiPal-V5-Clinic-Profiles      |
| `CLINIC_FAVORITES_TABLE`         | DentiPal-V5-ClinicFavorites      |
| `CLINICS_TABLE`                  | DentiPal-V5-Clinics              |
| `CONNECTIONS_TABLE`              | DentiPal-V5-Connections          |
| `CONVERSATIONS_TABLE`            | DentiPal-V5-Conversations        |
| `FEEDBACK_TABLE`                 | DentiPal-V5-Feedback             |
| `JOB_APPLICATIONS_TABLE`         | DentiPal-V5-JobApplications      |
| `JOB_INVITATIONS_TABLE`          | DentiPal-V5-JobInvitations       |
| `JOB_NEGOTIATIONS_TABLE`         | DentiPal-V5-JobNegotiations      |
| `JOB_POSTINGS_TABLE`             | DentiPal-V5-JobPostings          |
| `MESSAGES_TABLE`                 | DentiPal-V5-Messages             |
| `NOTIFICATIONS_TABLE`            | DentiPal-V5-Notifications        |
| `OTP_VERIFICATION_TABLE`         | DentiPal-V5-OTPVerification      |
| `PROFESSIONAL_PROFILES_TABLE`    | DentiPal-V5-ProfessionalProfiles |
| `REFERRALS_TABLE`                | DentiPal-V5-Referrals            |
| `USER_ADDRESSES_TABLE`           | DentiPal-V5-UserAddresses        |
| `USER_CLINIC_ASSIGNMENTS_TABLE`  | DentiPal-V5-UserClinicAssignments|

---

*Generated from source: `DentiPalCDK/lib/denti_pal_cdk-stack.ts` and Lambda handler interfaces in `DentiPalCDK/lambda/src/handlers/`*
