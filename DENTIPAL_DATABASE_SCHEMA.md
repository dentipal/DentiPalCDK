# DentiPal V5 - Complete DynamoDB Schema Reference


---

## Quick Reference - All Tables

| # | Table Name | Partition Key | Sort Key | GSIs |
|---|-----------|--------------|----------|------|
| 1 | DentiPal-V5-Clinic-Profiles | `clinicId` (S) | `userSub` (S) | 1 |
| 2 | DentiPal-V5-ClinicFavorites | `clinicUserSub` (S) | `professionalUserSub` (S) | 0 |
| 3 | DentiPal-V5-Clinics | `clinicId` (S) | -- | 1 |
| 4 | DentiPal-V5-Connections | `userKey` (S) | `connectionId` (S) | 1 |
| 5 | DentiPal-V5-Conversations | `conversationId` (S) | -- | 2 |
| 6 | DentiPal-V5-Feedback | `PK` (S) | `SK` (S) | 0 |
| 7 | DentiPal-V5-JobApplications | `jobId` (S) | `professionalUserSub` (S) | 5 |
| 8 | DentiPal-V5-JobInvitations | `jobId` (S) | `professionalUserSub` (S) | 2 |
| 9 | DentiPal-V5-JobNegotiations | `applicationId` (S) | `negotiationId` (S) | 3 |
| 10 | DentiPal-V5-JobPostings | `clinicUserSub` (S) | `jobId` (S) | 4 |
| 11 | DentiPal-V5-Messages | `conversationId` (S) | `messageId` (S) | 1 |
| 12 | ~~DentiPal-V5-Notifications~~ | RETIRED 2026-04-28 | -- | -- |
| 13 | ~~DentiPal-V5-OTPVerification~~ | RETIRED 2026-04-28 | -- | -- |
| 14 | DentiPal-V5-ProfessionalProfiles | `userSub` (S) | -- | 0 |
| 15 | DentiPal-V5-Referrals | `referralId` (S) | -- | 2 |
| 16 | DentiPal-V5-UserAddresses | `userSub` (S) | -- | 0 |
| 17 | DentiPal-V5-UserClinicAssignments | `userSub` (S) | `clinicId` (S) | 0 |

> **(S) = STRING, (N) = NUMBER**

---

## Detailed Table Schemas

---

### 1. DentiPal-V5-Clinic-Profiles

**Purpose**: Stores detailed clinic profile information (practice details, software, parking, operatories, etc.)

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `clinicId` | STRING |
| **Sort Key** | `userSub` | STRING |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `clinicId` | S | Clinic identifier (PK) |
| `userSub` | S | Cognito user ID of clinic admin (SK) |
| `clinic_name` | S | Display name of the clinic |
| `clinic_type` | S | Type of dental clinic |
| `practice_type` | S | General/specialty practice |
| `primary_practice_area` | S | Main area of practice |
| `primary_contact_first_name` | S | Contact first name |
| `primary_contact_last_name` | S | Contact last name |
| `assisted_hygiene_available` | BOOL | Whether assisted hygiene is offered |
| `number_of_operatories` | N | Number of operatory rooms |
| `num_hygienists` | N | Count of hygienists |
| `num_assistants` | N | Count of assistants |
| `num_doctors` | N | Count of doctors |
| `booking_out_period` | S | Scheduling lead time |
| `clinic_software` | S | Primary software used |
| `software_used` | L (list) | All software tools used |
| `parking_type` | S | Type of parking available |
| `parking_cost` | N | Cost of parking |
| `free_parking_available` | BOOL | Whether free parking exists |
| `addressLine1` | S | Street address line 1 |
| `addressLine2` | S | Street address line 2 |
| `addressLine3` | S | Street address line 3 |
| `city` | S | City |
| `state` | S | State |
| `zipCode` | S | ZIP/postal code |
| `contact_email` | S | Contact email address |
| `contact_phone` | S | Contact phone number |
| `special_requirements` | L (list) | Special job requirements |
| `office_image_key` | S | S3 key for office photo |
| `notes` | S | Additional notes |
| `description` | S | Clinic description |
| `createdAt` | S | ISO timestamp |
| `updatedAt` | S | ISO timestamp |

**GSIs (1)**:
| GSI Name | Partition Key | Sort Key | Projection | Why It Exists |
|----------|--------------|----------|------------|---------------|
| `userSub-index` | `userSub` (S) | -- | ALL | **Lookup clinic profiles by user**: When a clinic admin logs in, we need to find all clinic profiles they own. The base table is keyed by `clinicId`, so this GSI enables reverse lookup by the user's Cognito sub. |

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `clinicId` | DentiPal-V5-Clinics | `clinicId` (PK) |
| `userSub` | AWS Cognito User Pool | User Sub |

---

### 2. DentiPal-V5-ClinicFavorites

**Purpose**: Junction table tracking which professionals a clinic has favorited for quick access.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `clinicUserSub` | STRING |
| **Sort Key** | `professionalUserSub` | STRING |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `clinicUserSub` | S | Clinic admin's Cognito user sub (PK) |
| `professionalUserSub` | S | Professional's Cognito user sub (SK) |
| `favoriteAddedAt` | S | ISO timestamp when favorited |

**GSIs**: None

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `clinicUserSub` | AWS Cognito User Pool | User Sub |
| `professionalUserSub` | DentiPal-V5-ProfessionalProfiles | `userSub` (PK) |

---

### 3. DentiPal-V5-Clinics

**Purpose**: Master clinic records - the core clinic entity with name, address, and owner information.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `clinicId` | STRING |
| **Sort Key** | -- | -- |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `clinicId` | S | UUID clinic identifier (PK) |
| `name` | S | Clinic name |
| `addressLine1` | S | Street address line 1 |
| `addressLine2` | S | Street address line 2 |
| `addressLine3` | S | Street address line 3 |
| `city` | S | City |
| `state` | S | State |
| `pincode` | S | ZIP/postal code |
| `createdBy` | S | Cognito userSub of clinic creator |
| `AssociatedUsers` | SS / L | Set of userSub values for staff members |
| `createdAt` | S | ISO timestamp |
| `updatedAt` | S | ISO timestamp |

**GSIs (1)**:
| GSI Name | Partition Key | Sort Key | Projection | Why It Exists |
|----------|--------------|----------|------------|---------------|
| `CreatedByIndex` | `createdBy` (S) | -- | ALL | **Find clinics by owner**: When a user logs in, find all clinics they created. The base table is keyed by `clinicId` (UUID), so without this GSI you'd need a full table scan to find a user's clinics. |

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `createdBy` | AWS Cognito User Pool | User Sub |

---

### 4. DentiPal-V5-Connections

**Purpose**: WebSocket connection tracking - maps users to their active API Gateway WebSocket connection IDs.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `userKey` | STRING |
| **Sort Key** | `connectionId` | STRING |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `userKey` | S | Composite key: `clinic#{clinicId}` or `prof#{userSub}` (PK) |
| `connectionId` | S | API Gateway WebSocket connection ID (SK) |
| `connectedAt` | N | Connection timestamp (milliseconds) |
| `display` | S | Display name for the connected user |
| `userType` | S | `"Clinic"` or `"Professional"` |

**GSIs (1)**:
| GSI Name | Partition Key | Sort Key | Projection | Why It Exists |
|----------|--------------|----------|------------|---------------|
| `connectionId-index` | `connectionId` (S) | `userKey` (S) | ALL | **Reverse lookup on disconnect**: When a WebSocket disconnects, API Gateway provides the `connectionId` but not the `userKey`. This GSI enables finding which user a connection belongs to so the record can be cleaned up. Also used when routing messages to find the recipient's connection. |

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `userKey` (contains clinicId) | DentiPal-V5-Clinics | `clinicId` (PK) |
| `userKey` (contains userSub) | AWS Cognito User Pool | User Sub |

---

### 5. DentiPal-V5-Conversations

**Purpose**: Chat conversation metadata between a clinic and a professional, tracking the last message for inbox ordering.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `conversationId` | STRING |
| **Sort Key** | -- | -- |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `conversationId` | S | Composite: sorted concat of `clinic#{clinicId}` and `prof#{userSub}` (PK) |
| `clinicKey` | S | `clinic#{clinicId}` |
| `profKey` | S | `prof#{userSub}` |
| `lastMessageAt` | N | Timestamp of last message (milliseconds) |
| `lastMessage` | S | Preview text of last message |
| `participants` | L | List of participant identifiers |

**GSIs (2)**:
| GSI Name | Partition Key | Sort Key | Projection | Why It Exists |
|----------|--------------|----------|------------|---------------|
| `clinicKey-lastMessageAt` | `clinicKey` (S) | `lastMessageAt` (N) | ALL | **Clinic inbox sorted by recency**: Lists all conversations for a clinic, sorted by most recent message first. Powers the clinic's chat inbox UI. |
| `profKey-lastMessageAt` | `profKey` (S) | `lastMessageAt` (N) | ALL | **Professional inbox sorted by recency**: Same as above but for the professional's side. Lists all their conversations sorted by most recent message. |

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `clinicKey` (contains clinicId) | DentiPal-V5-Clinics | `clinicId` (PK) |
| `profKey` (contains userSub) | DentiPal-V5-ProfessionalProfiles | `userSub` (PK) |

---

### 6. DentiPal-V5-Feedback

**Purpose**: Generic feedback collection using single-table design (PK/SK pattern).

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `PK` | STRING |
| **Sort Key** | `SK` | STRING |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `PK` | S | Generic partition key (e.g., `feedback#{feedbackId}`) |
| `SK` | S | Generic sort key (e.g., timestamp or status) |
| `feedbackId` | S | UUID feedback identifier |
| `userId` | S | Submitting user's sub |
| `feedback` | S | Feedback text content |
| `rating` | N | Numeric rating |
| `type` | S | Feedback category/type |
| `createdAt` | S | ISO timestamp |

**GSIs**: None

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `userId` | AWS Cognito User Pool | User Sub |

---

### 7. DentiPal-V5-JobApplications

**Purpose**: Tracks professional applications to job postings, including status, proposed rates, and negotiation links. This is one of the most heavily indexed tables.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `jobId` | STRING |
| **Sort Key** | `professionalUserSub` | STRING |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `jobId` | S | Job posting identifier (PK) |
| `professionalUserSub` | S | Applying professional's Cognito sub (SK) |
| `applicationId` | S | UUID for this application |
| `clinicId` | S | Clinic that owns the job |
| `clinicUserSub` | S | Clinic admin's Cognito sub |
| `applicationStatus` | S | `pending` / `negotiating` / `accepted` / `rejected` |
| `appliedAt` | S | ISO timestamp of application |
| `updatedAt` | S | ISO timestamp of last update |
| `applicationMessage` | S | Cover message from professional |
| `availability` | S | Professional's availability |
| `startDate` | S | Proposed start date |
| `notes` | S | Additional notes |
| `proposedRate` | N | Professional's proposed rate |
| `proposedHourlyRate` | N | Professional's proposed hourly rate |
| `acceptedRate` | N | Final accepted rate |
| `negotiationId` | S | Links to JobNegotiations table |

**GSIs (5)**:
| GSI Name | Partition Key | Sort Key | Projection | Why It Exists |
|----------|--------------|----------|------------|---------------|
| `applicationId-index` | `applicationId` (S) | -- | ALL | **Direct application lookup**: When navigating to a specific application (e.g., from a notification link), look it up by its UUID without knowing the jobId+professionalUserSub composite key. |
| `clinicId-index` | `clinicId` (S) | -- | ALL | **All applications for a clinic**: Powers the clinic dashboard showing all incoming applications across all their job postings. Used in `getActionNeeded` handler. |
| `clinicId-jobId-index` | `clinicId` (S) | `jobId` (S) | ALL | **Applications per clinic per job**: Efficiently query applications for a specific clinic's specific job. Used in shift dashboard views (`getAllClinicsShifts`, `getScheduledShifts`). |
| `JobIdIndex-1` | `jobId` (S) | -- | ALL | **Query by jobId only**: Enables querying applications by jobId without needing the sort key. Used when enriching job data with application counts. |
| `professionalUserSub-index` | `professionalUserSub` (S) | `jobId` (S) | ALL | **Professional's application history**: Lists all jobs a professional has applied to. Powers the professional's "My Applications" dashboard view. |

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `jobId` | DentiPal-V5-JobPostings | `jobId` (SK of base table, PK of GSI) |
| `clinicId` | DentiPal-V5-Clinics | `clinicId` (PK) |
| `professionalUserSub` | DentiPal-V5-ProfessionalProfiles | `userSub` (PK) |
| `clinicUserSub` | AWS Cognito User Pool | User Sub |
| `negotiationId` | DentiPal-V5-JobNegotiations | `negotiationId` (SK) |

---

### 8. DentiPal-V5-JobInvitations

**Purpose**: Tracks clinic-initiated invitations to professionals for specific jobs.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `jobId` | STRING |
| **Sort Key** | `professionalUserSub` | STRING |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `jobId` | S | Job posting identifier (PK) |
| `professionalUserSub` | S | Invited professional's Cognito sub (SK) |
| `invitationId` | S | UUID for this invitation |
| `clinicId` | S | Clinic sending the invitation |
| `clinicUserSub` | S | Clinic admin's Cognito sub |
| `invitationStatus` | S | `pending` / `accepted` / `rejected` |
| `invitationMessage` | S | Message from clinic to professional |
| `sentAt` | S | ISO timestamp when sent |
| `respondedAt` | S | ISO timestamp of response |
| `response` | S | Professional's response text |

**GSIs (2)**:
| GSI Name | Partition Key | Sort Key | Projection | Why It Exists |
|----------|--------------|----------|------------|---------------|
| `invitationId-index` | `invitationId` (S) | -- | ALL | **Direct invitation lookup**: Access a specific invitation by its UUID (e.g., from a notification deep link) without needing the composite key. |
| `ProfessionalIndex` | `professionalUserSub` (S) | -- | ALL | **Professional's invitation inbox**: Lists all job invitations received by a professional. Powers the "My Invitations" view so professionals can see and respond to clinic invites. |

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `jobId` | DentiPal-V5-JobPostings | `jobId` (SK / GSI PK) |
| `professionalUserSub` | DentiPal-V5-ProfessionalProfiles | `userSub` (PK) |
| `clinicId` | DentiPal-V5-Clinics | `clinicId` (PK) |
| `clinicUserSub` | AWS Cognito User Pool | User Sub |

---

### 9. DentiPal-V5-JobNegotiations

**Purpose**: Tracks pay rate negotiations between clinics and professionals for a specific application. Supports back-and-forth counter-offers.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `applicationId` | STRING |
| **Sort Key** | `negotiationId` | STRING |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `applicationId` | S | Links to the parent application (PK) |
| `negotiationId` | S | UUID for this negotiation round (SK) |
| `jobId` | S | Associated job posting |
| `clinicId` | S | Clinic involved in negotiation |
| `professionalUserSub` | S | Professional involved |
| `negotiationStatus` | S | `pending` / `accepted` / `rejected` |
| `proposedHourlyRate` | N | Current proposed hourly rate |
| `lastOfferPay` | N | Most recent offer amount |
| `lastOfferFrom` | S | Who made the last offer: `clinic` or `professional` |
| `message` | S | Negotiation message |
| `status` | S | Overall negotiation status |
| `gsi1pk` | S | Custom GSI1 partition key |
| `gsi1sk` | S | Custom GSI1 sort key |
| `createdAt` | S | ISO timestamp |
| `updatedAt` | S | ISO timestamp |

**GSIs (3)**:
| GSI Name | Partition Key | Sort Key | Projection | Why It Exists |
|----------|--------------|----------|------------|---------------|
| `index` | `applicationId` (S) | -- | ALL | **Negotiations by application**: Query all negotiation rounds for a given application. Used when displaying the negotiation history/thread for an application. |
| `GSI1` | `gsi1pk` (S) | `gsi1sk` (S) | INCLUDE (`negotiationId`, `clinicId`, `jobId`, `professionalUserSub`, `status`, `lastOfferPay`, `lastOfferFrom`, `updatedAt`) | **Flexible composite queries**: Generic overloaded GSI for complex access patterns. Uses INCLUDE projection (not ALL) to reduce storage costs - only projects the fields needed for negotiation summary views. |
| `JobIndex` | `jobId` (S) | `createdAt` (S) | ALL | **Negotiations by job over time**: Lists all negotiations for a specific job sorted chronologically. Used to see all negotiation activity across all applicants for a given job posting. |

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `applicationId` | DentiPal-V5-JobApplications | `applicationId` (GSI PK) |
| `jobId` | DentiPal-V5-JobPostings | `jobId` (SK / GSI PK) |
| `clinicId` | DentiPal-V5-Clinics | `clinicId` (PK) |
| `professionalUserSub` | DentiPal-V5-ProfessionalProfiles | `userSub` (PK) |

---

### 10. DentiPal-V5-JobPostings

**Purpose**: All job postings (temporary shifts, permanent positions, multi-day consulting) created by clinics.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `clinicUserSub` | STRING |
| **Sort Key** | `jobId` | STRING |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `clinicUserSub` | S | Clinic admin's Cognito sub (PK) |
| `jobId` | S | UUID job identifier (SK) |
| `clinicId` | S | Associated clinic ID |
| `job_type` | S | `temporary` / `multi_day_consulting` / `permanent` |
| `professional_role` | S | Required role (e.g., DentalHygienist) |
| `shift_speciality` | S | Dental specialty required |
| `status` | S | `active` / `inactive` / `filled` |
| `job_title` | S | Job title |
| `job_description` | S | Full description |
| `requirements` | SS | Set of requirements |
| `date` | S | Shift date (temporary jobs) |
| `hours` | N | Total hours |
| `hourly_rate` | N | Pay rate per hour |
| `meal_break` | BOOL | Whether meal break is included |
| `start_time` | S | Shift start time |
| `end_time` | S | Shift end time |
| `dates` | L | Array of dates (multi-day consulting) |
| `hours_per_day` | N | Hours per day (multi-day) |
| `total_days` | N | Total number of days |
| `project_duration` | S | Project duration description |
| `employment_type` | S | `full_time` / `part_time` (permanent) |
| `salary_min` | N | Minimum salary (permanent) |
| `salary_max` | N | Maximum salary (permanent) |
| `benefits` | SS | Set of benefits (permanent) |
| `vacation_days` | N | Number of vacation days |
| `work_schedule` | S | Schedule description |
| `start_date` | S | Position start date |
| `addressLine1` | S | Job location address |
| `addressLine2` | S | Address line 2 |
| `addressLine3` | S | Address line 3 |
| `city` | S | City |
| `state` | S | State |
| `pincode` | S | ZIP/postal code |
| `clinic_name` | S | Denormalized clinic name |
| `clinic_type` | S | Denormalized clinic type |
| `parking_type` | S | Parking info |
| `parking_rate` | N | Parking cost |
| `clinicSoftware` | S | Software used at clinic |
| `freeParkingAvailable` | BOOL | Free parking flag |
| `assisted_hygiene` | BOOL | Assisted hygiene available |
| `createdAt` | S | ISO timestamp |
| `updatedAt` | S | ISO timestamp |

**GSIs (4)**:
| GSI Name | Partition Key | Sort Key | Projection | Why It Exists |
|----------|--------------|----------|------------|---------------|
| `ClinicIdIndex` | `clinicId` (S) | `jobId` (S) | ALL | **Jobs by clinic ID**: The base table uses `clinicUserSub` as PK, but many operations need to find jobs by `clinicId` instead (e.g., when an application references a clinicId). Used in dashboard views (`getAllClinicsShifts`, `getScheduledShifts`). |
| `DateIndex` | `date` (S) | `jobId` (S) | ALL | **Browse jobs by date**: Enables professionals to find available shifts on a specific date. Powers the job browsing/filtering UI where users pick a date to see available work. |
| `jobId-index-1` | `jobId` (S) | -- | ALL | **Direct job lookup by ID**: The most frequently used GSI - enables looking up a job by its UUID without knowing the `clinicUserSub`. Used extensively when enriching applications, invitations, and negotiations with job details. |
| `JobIdIndex-2` | `jobId` (S) | -- | ALL | **Redundant job lookup**: Duplicate of `jobId-index-1`. Likely exists from historical development. Candidate for consolidation. |

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `clinicUserSub` | AWS Cognito User Pool | User Sub |
| `clinicId` | DentiPal-V5-Clinics | `clinicId` (PK) |

---

### 11. DentiPal-V5-Messages

**Purpose**: Individual chat messages within a conversation.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `conversationId` | STRING |
| **Sort Key** | `messageId` | STRING |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `conversationId` | S | Parent conversation (PK) |
| `messageId` | S | UUID message identifier (SK) |
| `senderKey` | S | `clinic#{clinicId}` or `prof#{userSub}` |
| `senderDisplay` | S | Display name of sender |
| `messageBody` | S | Message text content |
| `timestamp` | N | Message timestamp (milliseconds) |
| `messageType` | S | `text`, `system`, etc. |

**GSIs (1)**:
| GSI Name | Partition Key | Sort Key | Projection | Why It Exists |
|----------|--------------|----------|------------|---------------|
| `ConversationIdIndex` | `conversationId` (S) | `messageId` (S) | ALL | **Query messages by conversation**: Note - this GSI mirrors the base table keys exactly. Likely exists as a historical artifact or for a specific query pattern that required an index scan vs. a table query. Candidate for removal. |

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `conversationId` | DentiPal-V5-Conversations | `conversationId` (PK) |

---

### 12. DentiPal-V5-Notifications — RETIRED 2026-04-28

This table was provisioned but never read by any handler. The UI rendered
notification-like data from other tables (JobInvitations, JobApplications,
JobNegotiations) instead. Removed from CDK; physical table to be manually
deleted via the AWS Console after the deploy grace period.

---

### 13. DentiPal-V5-OTPVerification — RETIRED 2026-04-28

This table duplicated Cognito's native OTP / `ConfirmSignUp` flow and was
never read by any handler. Cognito handles OTP issuance, expiry, and attempt
throttling natively. Removed from CDK; physical table to be manually deleted
via the AWS Console after the deploy grace period.

---

### 14. DentiPal-V5-ProfessionalProfiles

**Purpose**: Dental professional profiles - role, name, specialties, and extended profile data.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `userSub` | STRING |
| **Sort Key** | -- | -- |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `userSub` | S | Cognito user ID (PK) |
| `role` | S | Professional role (see valid values below) |
| `first_name` | S | First name |
| `last_name` | S | Last name |
| `specialties` | SS | Set of dental specialties |
| `createdAt` | S | ISO timestamp |
| `updatedAt` | S | ISO timestamp |
| *(dynamic fields)* | * | Additional profile fields added via update |

**Valid Roles**: `AssociateDentist`, `DentalAssistant`, `DentalHygienist`, `FrontDesk`, `Dentist`, `DualRoleFrontDA`

**GSIs**: None

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `userSub` | AWS Cognito User Pool | User Sub |

---

### 15. DentiPal-V5-Referrals

**Purpose**: Tracks professional-to-professional referral invitations and bonus awards.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `referralId` | STRING |
| **Sort Key** | -- | -- |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `referralId` | S | UUID referral identifier (PK) |
| `referrerUserSub` | S | User who sent the referral |
| `referredUserSub` | S | User being referred |
| `referredEmail` | S | Referred person's email |
| `referredName` | S | Referred person's name |
| `status` | S | `pending` / `accepted` / `completed` |
| `sentAt` | S | ISO timestamp when sent |
| `acceptedAt` | S | ISO timestamp when accepted |
| `bonusAwarded` | BOOL | Whether referral bonus was given |
| `bonusAmount` | N | Bonus amount in dollars |

**GSIs (2)**:
| GSI Name | Partition Key | Sort Key | Projection | Why It Exists |
|----------|--------------|----------|------------|---------------|
| `ReferredUserSubIndex` | `referredUserSub` (S) | -- | ALL | **Check if user was referred**: During registration or bonus processing, check if a new user was referred by someone. Enables deduplication (prevent double referral rewards). |
| `ReferrerIndex` | `referrerUserSub` (S) | `sentAt` (S) | ALL | **Referral history for a user**: Lists all referrals sent by a user, sorted by date. Powers the "My Referrals" dashboard where users track their referral status and earnings. |

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `referrerUserSub` | DentiPal-V5-ProfessionalProfiles | `userSub` (PK) |
| `referredUserSub` | DentiPal-V5-ProfessionalProfiles | `userSub` (PK) |

---

### 16. DentiPal-V5-UserAddresses

**Purpose**: Stores user addresses (home, work) for professionals and clinic staff.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `userSub` | STRING |
| **Sort Key** | -- | -- |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `userSub` | S | Cognito user ID (PK) |
| `addressLine1` | S | Street address line 1 |
| `addressLine2` | S | Street address line 2 |
| `addressLine3` | S | Street address line 3 |
| `city` | S | City |
| `state` | S | State |
| `pincode` | S | ZIP/postal code |
| `country` | S | Country (defaults to "USA") |
| `addressType` | S | `home`, `work`, etc. |
| `isDefault` | BOOL | Whether this is the default address |
| `createdAt` | S | ISO timestamp |
| `updatedAt` | S | ISO timestamp |

**GSIs**: None

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `userSub` | AWS Cognito User Pool | User Sub |

---

### 17. DentiPal-V5-UserClinicAssignments

**Purpose**: Junction table mapping users (staff) to clinics they work at, with their role at that clinic.

| Key Type | Attribute | Type |
|----------|-----------|------|
| **Partition Key** | `userSub` | STRING |
| **Sort Key** | `clinicId` | STRING |

**Attributes**:
| Attribute | Type | Description |
|-----------|------|-------------|
| `userSub` | S | Staff member's Cognito sub (PK) |
| `clinicId` | S | Clinic they're assigned to (SK) |
| `role` | S | Role at this clinic |
| `assignedAt` | S | ISO timestamp of assignment |
| `assignedBy` | S | Admin who made the assignment |

**GSIs**: None

**Foreign Key References**:
| Attribute | References Table | Referenced Key |
|-----------|-----------------|----------------|
| `userSub` | AWS Cognito User Pool | User Sub |
| `clinicId` | DentiPal-V5-Clinics | `clinicId` (PK) |
| `assignedBy` | AWS Cognito User Pool | User Sub |

---

## Complete GSI Summary Matrix

| # | Table | GSI Name | PK | SK | Projection | Access Pattern |
|---|-------|----------|----|----|------------|----------------|
| 1 | Clinic-Profiles | `userSub-index` | `userSub` | -- | ALL | Find clinic profiles by admin user |
| 2 | Clinics | `CreatedByIndex` | `createdBy` | -- | ALL | Find clinics by owner |
| 3 | Connections | `connectionId-index` | `connectionId` | `userKey` | ALL | Reverse lookup: user by WebSocket connection |
| 4 | Conversations | `clinicKey-lastMessageAt` | `clinicKey` | `lastMessageAt` (N) | ALL | Clinic chat inbox sorted by recency |
| 5 | Conversations | `profKey-lastMessageAt` | `profKey` | `lastMessageAt` (N) | ALL | Professional chat inbox sorted by recency |
| 6 | JobApplications | `applicationId-index` | `applicationId` | -- | ALL | Direct application lookup by UUID |
| 7 | JobApplications | `clinicId-index` | `clinicId` | -- | ALL | All applications for a clinic |
| 8 | JobApplications | `clinicId-jobId-index` | `clinicId` | `jobId` | ALL | Applications per clinic per job |
| 9 | JobApplications | `JobIdIndex-1` | `jobId` | -- | ALL | Applications by job ID |
| 10 | JobApplications | `professionalUserSub-index` | `professionalUserSub` | `jobId` | ALL | Professional's application history |
| 11 | JobInvitations | `invitationId-index` | `invitationId` | -- | ALL | Direct invitation lookup by UUID |
| 12 | JobInvitations | `ProfessionalIndex` | `professionalUserSub` | -- | ALL | Professional's invitation inbox |
| 13 | JobNegotiations | `index` | `applicationId` | -- | ALL | Negotiation rounds by application |
| 14 | JobNegotiations | `GSI1` | `gsi1pk` | `gsi1sk` | INCLUDE | Flexible overloaded composite queries |
| 15 | JobNegotiations | `JobIndex` | `jobId` | `createdAt` | ALL | Negotiations by job, chronological |
| 16 | JobPostings | `ClinicIdIndex` | `clinicId` | `jobId` | ALL | Jobs by clinic ID |
| 17 | JobPostings | `DateIndex` | `date` | `jobId` | ALL | Browse available shifts by date |
| 18 | JobPostings | `jobId-index-1` | `jobId` | -- | ALL | Direct job lookup by UUID |
| 19 | JobPostings | `JobIdIndex-2` | `jobId` | -- | ALL | Redundant duplicate of #18 |
| 20 | Messages | `ConversationIdIndex` | `conversationId` | `messageId` | ALL | Mirrors base table (candidate for removal) |
| 21 | Referrals | `ReferredUserSubIndex` | `referredUserSub` | -- | ALL | Check if user was referred |
| 22 | Referrals | `ReferrerIndex` | `referrerUserSub` | `sentAt` | ALL | Referral history by sender |

---

## Entity Relationship Diagram

```
                        ┌──────────────────────────┐
                        │   AWS COGNITO USER POOL   │
                        │      (Identity Store)     │
                        │                           │
                        │  userSub (primary ID)     │
                        │  groups: Root,            │
                        │    ClinicAdmin,            │
                        │    ClinicManager,           │
                        │    DentalHygienist,         │
                        │    AssociateDentist, ...    │
                        └─────────┬────────────────┘
                                  │ userSub
                ┌─────────────────┼──────────────────────┐
                │                 │                       │
                ▼                 ▼                       ▼
  ┌──────────────────┐  ┌────────────────────┐  ┌──────────────────┐
  │ ProfessionalPro- │  │    UserAddresses    │  │  UserClinicAssign│
  │ files            │  │                     │  │  ments           │
  │                  │  │ PK: userSub         │  │                  │
  │ PK: userSub      │  └────────────────────┘  │ PK: userSub      │
  │                  │                           │ SK: clinicId ─────┼──┐
  │ role, first_name,│                           └──────────────────┘  │
  │ last_name,       │                                                  │
  │ specialties      │                                                  │
  └───────┬──────────┘                                                  │
          │                                                             │
          │ professionalUserSub                                         │
          │                     ┌────────────────────────────────────────┘
          │                     │
          │                     ▼
          │           ┌──────────────────┐
          │           │     Clinics       │
          │           │                  │
          │           │ PK: clinicId     │
          │           │                  │
          │           │ name, address,   │
          │           │ createdBy ───────┼──► Cognito
          │           │ AssociatedUsers  │
          │           └────────┬─────────┘
          │                    │ clinicId
          │         ┌──────────┼──────────────────┐
          │         │          │                   │
          │         ▼          ▼                   ▼
          │  ┌─────────────┐ ┌──────────────┐ ┌──────────────────┐
          │  │ClinicProfile│ │ClinicFavorit-│ │   JobPostings    │
          │  │s            │ │es            │ │                  │
          │  │             │ │              │ │ PK: clinicUserSub│
          │  │PK: clinicId │ │PK:clinicUser-│ │ SK: jobId        │
          │  │SK: userSub  │ │Sub           │ │                  │
          │  └─────────────┘ │SK:profession-│ │ clinicId, date,  │
          │                  │alUserSub     │ │ job_type, rate   │
          │                  └──────────────┘ └───────┬──────────┘
          │                                           │ jobId
          │                    ┌───────────────────────┼──────────────┐
          │                    │                       │              │
          │                    ▼                       ▼              ▼
          │         ┌──────────────────┐  ┌──────────────────┐ ┌──────────┐
          │         │ JobApplications  │  │ JobInvitations   │ │  (GSI    │
          │         │                  │  │                  │ │ queries) │
          └────────►│ PK: jobId        │  │ PK: jobId        │ └──────────┘
                    │ SK: professional-│  │ SK: professional-│
                    │     UserSub      │  │     UserSub      │
                    │                  │  │                  │
                    │ applicationId,   │  │ invitationId,    │
                    │ clinicId, status │  │ clinicId, status │
                    └───────┬──────────┘  └──────────────────┘
                            │ applicationId
                            ▼
                   ┌──────────────────┐
                   │ JobNegotiations  │
                   │                  │
                   │ PK: applicationId│
                   │ SK: negotiationId│
                   │                  │
                   │ jobId, clinicId, │
                   │ professionalUser-│
                   │ Sub, lastOffer   │
                   └──────────────────┘


  ┌──────────────────────────────────────────────────────────┐
  │              MESSAGING SUBSYSTEM                          │
  │                                                           │
  │  Connections ──► Conversations ──► Messages               │
  │  PK: userKey     PK: conversationId  PK: conversationId  │
  │  SK: connectionId                     SK: messageId       │
  │                  clinicKey ──► Clinics                     │
  │                  profKey  ──► ProfessionalProfiles         │
  └──────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────┐
  │              SUPPORTING TABLES                            │
  │                                                           │
  │  Notifications     Referrals        OTPVerification       │
  │  PK: recipientSub  PK: referralId   PK: email            │
  │  SK: notificationId referrerSub ──►                       │
  │                     referredSub ──► ProfessionalProfiles  │
  │                                                           │
  │  Feedback                                                 │
  │  PK: PK  SK: SK  (single-table design)                   │
  └──────────────────────────────────────────────────────────┘
```

---

## Key Design Observations

### 1. No Enforced Foreign Keys
DynamoDB does not support foreign key constraints. All referential integrity is maintained at the **application level** in Lambda handler code. If a referenced entity is deleted, orphaned references may remain.

### 2. Denormalization Strategy
Data like `clinic_name`, `clinic_type`, and address fields are **copied into JobPostings** from the Clinics/ClinicProfiles tables. This avoids cross-table lookups when browsing jobs but means updates to clinic info don't automatically propagate to existing job postings.

### 3. GSI Redundancies (Cleanup Opportunities)
- **JobPostings**: `jobId-index-1` and `JobIdIndex-2` are identical (same PK, no SK, ALL projection). One can be removed.
- **Messages**: `ConversationIdIndex` mirrors the base table's exact key schema. Can likely be removed.
- **JobNegotiations**: `index` GSI has the same PK (`applicationId`) as the base table. May be redundant depending on query patterns.

### 4. Cognito as User Store
There is **no Users table** in DynamoDB. User identity, authentication, and group membership are managed entirely by **AWS Cognito User Pool**. The `userSub` value from Cognito is the universal user identifier used across all tables.

### 5. Composite Key Patterns
- **Connections.userKey**: `clinic#{clinicId}` or `prof#{userSub}` - encodes user type in the key
- **Conversations.conversationId**: Sorted concatenation of clinic and professional keys - ensures one unique conversation per pair

### 6. Environment Variable Mappings
Lambda handlers reference tables via environment variables:
| Env Variable | Table |
|-------------|-------|
| `CLINIC_PROFILES_TABLE` | DentiPal-V5-Clinic-Profiles |
| `CLINIC_FAVORITES_TABLE` | DentiPal-V5-ClinicFavorites |
| `CLINICS_TABLE` | DentiPal-V5-Clinics |
| `CONNECTIONS_TABLE` | DentiPal-V5-Connections |
| `CONVERSATIONS_TABLE` | DentiPal-V5-Conversations |
| `FEEDBACK_TABLE` | DentiPal-V5-Feedback |
| `JOB_APPLICATIONS_TABLE` | DentiPal-V5-JobApplications |
| `JOB_INVITATIONS_TABLE` | DentiPal-V5-JobInvitations |
| `JOB_NEGOTIATIONS_TABLE` | DentiPal-V5-JobNegotiations |
| `JOB_POSTINGS_TABLE` | DentiPal-V5-JobPostings |
| `MESSAGES_TABLE` | DentiPal-V5-Messages |
| `PROFESSIONAL_PROFILES_TABLE` | DentiPal-V5-ProfessionalProfiles |
| `REFERRALS_TABLE` | DentiPal-V5-Referrals |
| `USER_ADDRESSES_TABLE` | DentiPal-V5-UserAddresses |
| `USER_CLINIC_ASSIGNMENTS_TABLE` | DentiPal-V5-UserClinicAssignments |
