# DentiPal CDK — Complete Reference

Stack: `DentiPalCDKStackV5` | Region: `us-east-1` | Stage: `prod`

---

## 1. DynamoDB Tables (17 Tables)

All tables: Billing = PAY_PER_REQUEST | Removal = DESTROY

### User & Clinic Management

| # | Table Name | PK | SK | GSIs |
|---|---|---|---|---|
| 1 | `DentiPal-V5-Clinic-Profiles` | `clinicId` (S) | `userSub` (S) | `userSub-index` (PK: userSub) |
| 2 | `DentiPal-V5-ClinicFavorites` | `clinicUserSub` (S) | `professionalUserSub` (S) | — |
| 3 | `DentiPal-V5-Clinics` | `clinicId` (S) | — | `CreatedByIndex` (PK: createdBy) |
| 4 | `DentiPal-V5-UserAddresses` | `userSub` (S) | — | — |
| 5 | `DentiPal-V5-UserClinicAssignments` | `userSub` (S) | `clinicId` (S) | — |

### Jobs

| # | Table Name | PK | SK | GSIs |
|---|---|---|---|---|
| 6 | `DentiPal-V5-JobPostings` | `clinicUserSub` (S) | `jobId` (S) | `ClinicIdIndex` (PK: clinicId, SK: jobId) · `DateIndex` (PK: date, SK: jobId) · `jobId-index-1` (PK: jobId) · `JobIdIndex-2` (PK: jobId) |
| 7 | `DentiPal-V5-JobApplications` | `jobId` (S) | `professionalUserSub` (S) | `applicationId-index` (PK: applicationId) · `clinicId-index` (PK: clinicId) · `clinicId-jobId-index` (PK: clinicId, SK: jobId) · `JobIdIndex-1` (PK: jobId) · `professionalUserSub-index` (PK: professionalUserSub, SK: jobId) |
| 8 | `DentiPal-V5-JobInvitations` | `jobId` (S) | `professionalUserSub` (S) | `invitationId-index` (PK: invitationId) · `ProfessionalIndex` (PK: professionalUserSub) |
| 9 | `DentiPal-V5-JobNegotiations` | `applicationId` (S) | `negotiationId` (S) | `index` (PK: applicationId) · `GSI1` (PK: gsi1pk, SK: gsi1sk — projects: negotiationId, clinicId, jobId, professionalUserSub, status, lastOfferPay, lastOfferFrom, updatedAt) · `JobIndex` (PK: jobId, SK: createdAt) |

### Messaging (WebSocket)

| # | Table Name | PK | SK | GSIs |
|---|---|---|---|---|
| 10 | `DentiPal-V5-Connections` | `userKey` (S) | `connectionId` (S) | `connectionId-index` (PK: connectionId, SK: userKey) |
| 11 | `DentiPal-V5-Conversations` | `conversationId` (S) | — | `clinicKey-lastMessageAt` (PK: clinicKey, SK: lastMessageAt N) · `profKey-lastMessageAt` (PK: profKey, SK: lastMessageAt N) |
| 12 | `DentiPal-V5-Messages` | `conversationId` (S) | `messageId` (S) | `ConversationIdIndex` (PK: conversationId, SK: messageId) |

### Professionals

| # | Table Name | PK | SK | GSIs |
|---|---|---|---|---|
| 13 | `DentiPal-V5-ProfessionalProfiles` | `userSub` (S) | — | — |

### Notifications & Other

| # | Table Name | PK | SK | GSIs |
|---|---|---|---|---|
| 14 | `DentiPal-V5-Notifications` | `recipientUserSub` (S) | `notificationId` (S) | — |
| 15 | `DentiPal-V5-Feedback` | `PK` (S) | `SK` (S) | — |
| 16 | `DentiPal-V5-OTPVerification` | `email` (S) | — | — |
| 17 | `DentiPal-V5-Referrals` | `referralId` (S) | — | `ReferredUserSubIndex` (PK: referredUserSub) · `ReferrerIndex` (PK: referrerUserSub, SK: sentAt) |

---

## 2. S3 Buckets (6 Buckets)

All buckets: Encryption = S3_MANAGED | Public Access = BLOCK_ALL | Removal = RETAIN

| Bucket Construct | Env Var | Purpose |
|---|---|---|
| `ProfileImagesBucket` | `PROFILE_IMAGES_BUCKET` | User profile photos |
| `CertificatesBucket` | _(internal only)_ | Legacy certificates bucket |
| `VideoResumesBucket` | `VIDEO_RESUMES_BUCKET` | Video resume files |
| `ProfessionalResumesBucket` | `PROFESSIONAL_RESUMES_BUCKET` | PDF/doc resumes |
| `DrivingLicensesBucket` | `DRIVING_LICENSES_BUCKET` | Driving license documents |
| `ProfessionalLicensesBucket` | `CERTIFICATES_BUCKET` / `PROFESSIONAL_LICENSES_BUCKET` | Dental/professional licenses |

---

## 3. Cognito User Pool

**Pool:** `ClinicUserPoolV5`
**Client:** `ClinicAppClientV5` — Auth flows: UserPassword + UserSRP, preventUserExistenceErrors: true
**Sign-in:** Email alias | Self-signup enabled | Email auto-verified
**Password:** min 8 chars, requires digits + lower + upper + symbols

### Groups (10)

| Group Name | Role |
|---|---|
| `Root` | Super admin |
| `ClinicAdmin` | Clinic administrator |
| `ClinicManager` | Clinic manager |
| `ClinicViewer` | Read-only clinic user |
| `Dentist` | Dentist professional |
| `AssociateDentist` | Associate dentist |
| `DentalHygienist` | Dental hygienist |
| `DentalAssistant` | Dental assistant |
| `FrontDesk` | Front desk staff |
| `DualRoleFrontDA` | Front desk + dental assistant |

---

## 4. Lambda Functions (2)

### 4a. REST Monolith — `DentiPal-Backend-Monolith`

| Property | Value |
|---|---|
| Runtime | Node.js 18.x |
| Handler | `dist/index.handler` |
| Timeout | 60 seconds |
| Memory | 256 MB |
| Trigger | REST API Gateway (`/prod/{proxy+}`) |

**Environment Variables:**

| Env Var | Value |
|---|---|
| `REGION` | us-east-1 |
| `CLIENT_ID` | Cognito App Client ID |
| `USER_POOL_ID` | Cognito User Pool ID |
| `SES_FROM` | sreevidya.alluri@gmail.com |
| `SES_REGION` | us-east-1 |
| `SES_TO` | shashitest2004@gmail.com |
| `SMS_TOPIC_ARN` | arn:aws:sns:us-east-1:{account}:DentiPal-SMS-Notifications |
| `FRONTEND_ORIGIN` | http://localhost:5173 |
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
| `NOTIFICATIONS_TABLE` | DentiPal-V5-Notifications |
| `OTP_VERIFICATION_TABLE` | DentiPal-V5-OTPVerification |
| `PROFESSIONAL_PROFILES_TABLE` | DentiPal-V5-ProfessionalProfiles |
| `REFERRALS_TABLE` | DentiPal-V5-Referrals |
| `USER_ADDRESSES_TABLE` | DentiPal-V5-UserAddresses |
| `USER_CLINIC_ASSIGNMENTS_TABLE` | DentiPal-V5-UserClinicAssignments |
| `CLINIC_JOBS_POSTED_TABLE` | DentiPal-V5-JobPostings (alias) |
| `CLINICS_JOBS_COMPLETED_TABLE` | DentiPal-V5-JobApplications (alias) |
| `PROFILE_IMAGES_BUCKET` | ProfileImagesBucket name |
| `CERTIFICATES_BUCKET` | ProfessionalLicensesBucket name |
| `VIDEO_RESUMES_BUCKET` | VideoResumesBucket name |
| `PROFESSIONAL_RESUMES_BUCKET` | ProfessionalResumesBucket name |
| `DRIVING_LICENSES_BUCKET` | DrivingLicensesBucket name |
| `PROFESSIONAL_LICENSES_BUCKET` | ProfessionalLicensesBucket name |

**IAM Permissions:**

| Service | Actions |
|---|---|
| DynamoDB | ReadWriteData on all 17 tables + `dynamodb:Scan` on JobPostings |
| Cognito | SignUp, ConfirmSignUp, AdminAddUserToGroup, AdminGetUser, AdminCreateUser, AdminSetUserPassword, AdminUpdateUserAttributes, AdminDeleteUser, DeleteUser, AdminRemoveUserFromGroup, ListUsers, AdminListGroupsForUser |
| SES | SendEmail, SendRawEmail |
| SNS | Publish |
| EventBridge | PutEvents |
| S3 | ReadWrite on all 6 buckets |

---

### 4b. WebSocket Chat — `DentiPal-Chat-WebSocket`

| Property | Value |
|---|---|
| Runtime | Node.js 18.x |
| Handler | `dist/handlers/websocketHandler.handler` |
| Timeout | 30 seconds |
| Memory | 256 MB |
| Trigger | WebSocket API Gateway (`$connect`, `$disconnect`, `$default`) |

**Environment Variables:**

| Env Var | Value |
|---|---|
| `REGION` | us-east-1 |
| `USER_POOL_ID` | Cognito User Pool ID |
| `MESSAGES_TABLE` | DentiPal-V5-Messages |
| `CONNS_TABLE` | DentiPal-V5-Connections |
| `CONVOS_TABLE` | DentiPal-V5-Conversations |

**IAM Permissions:**

| Service | Actions |
|---|---|
| DynamoDB | ReadWriteData on Connections, Conversations, Messages, Clinics |
| Cognito | AdminGetUser |
| API Gateway | execute-api:ManageConnections (for push messages to clients) |

---

## 5. WebSocket API Gateway — `DentiPal-Chat-API`

**Type:** API Gateway v2 (WebSocket) | **Stage:** `prod` (auto-deploy: true)
**Endpoint:** `wss://ehfga71svb.execute-api.us-east-1.amazonaws.com/prod`

### Routes

| Route | Integration | Description |
|---|---|---|
| `$connect` | DentiPal-Chat-WebSocket | Client connects — stores connectionId in Connections table |
| `$disconnect` | DentiPal-Chat-WebSocket | Client disconnects — removes connectionId from Connections table |
| `$default` | DentiPal-Chat-WebSocket | All messages routed here; dispatched by `action` field in body |

### Message Actions (dispatched inside `$default`)

| action | Description |
|---|---|
| `sendMessage` | Send a chat message between clinic and professional |
| `getHistory` | Fetch message history for a conversation |
| `getConnections` | Get active connections for a user |

### WebSocket Message Format
```json
{
  "action": "sendMessage",
  "conversationId": "...",
  "message": "..."
}
```

---

## 6. REST API Gateway — `DentiPal API`

**Type:** API Gateway v1 | **Stage:** `prod`
**Endpoint:** `https://o21cxsun3k.execute-api.us-east-1.amazonaws.com/prod`
**Routing:** Catch-all proxy `/{proxy+}` → Monolith Lambda

**Settings:** CloudWatch logging (INFO), data tracing enabled, metrics enabled
**CORS:** All origins, all methods | **Binary types:** `multipart/form-data`

### All REST Endpoints

#### Authentication
| Method | Path | Handler |
|---|---|---|
| POST | `/auth/login` | loginUser |
| POST | `/auth/refresh` | refreshToken |
| POST | `/auth/forgot` | forgotPassword |
| POST | `/auth/check-email` | checkEmail |
| POST | `/auth/confirm-forgot-password` | confirmPassword |
| POST | `/auth/initiate-registration` | initiateUserRegistration |
| POST | `/auth/verify-otp` | verifyOTPAndCreateUser |

#### User Management
| Method | Path | Handler |
|---|---|---|
| POST | `/users` | createUser |
| GET | `/users` | getUser |
| PUT | `/users/{userId}` | updateUser |
| DELETE | `/users/{userId}` | deleteUser |
| DELETE | `/users/me` | deleteOwnAccount |
| GET | `/clinics/{clinicId}/users` | getClinicUsers |

#### Clinic Management
| Method | Path | Handler |
|---|---|---|
| POST | `/clinics` | createClinic |
| GET | `/clinics` | getAllClinics |
| GET | `/clinics-user` | getUsersClinics |
| GET | `/clinics/{clinicId}` | getClinic |
| PUT | `/clinics/{clinicId}` | updateClinic |
| DELETE | `/clinics/{clinicId}` | deleteClinic |
| GET | `/clinics/{clinicId}/address` | getClinicAddress |

#### Clinic Profiles
| Method | Path | Handler |
|---|---|---|
| POST | `/clinic-profiles` | createClinicProfile |
| GET | `/clinic-profiles` | getClinicProfile |
| GET | `/clinic-profile/{clinicId}` | getClinicProfileDetails |
| PUT | `/clinic-profiles/{clinicId}` | updateClinicProfileDetails |
| DELETE | `/clinic-profiles/{clinicId}` | deleteClinicProfile |

#### Professional Profiles
| Method | Path | Handler |
|---|---|---|
| POST | `/profiles` | createProfessionalProfile |
| GET | `/profiles` | getProfessionalProfile |
| PUT | `/profiles` | updateProfessionalProfile |
| DELETE | `/profiles` | deleteProfessionalProfile |
| GET | `/profiles/questions` | getProfessionalQuestions |
| GET | `/profiles/{userSub}` | getPublicProfessionalProfile |
| GET | `/allprofessionals` | getAllProfessionals |

#### Job Postings (Generic)
| Method | Path | Handler |
|---|---|---|
| POST | `/jobs` | createJobPosting |
| GET | `/job-postings` | getJobPostings |
| GET | `/jobs/browse` | browseJobPostings |
| GET | `/jobs/{jobId}` | getJobPosting |
| PUT | `/jobs/{jobId}` | updateJobPosting |
| DELETE | `/jobs/{jobId}` | deleteJobPosting |

#### Temporary Jobs
| Method | Path | Handler |
|---|---|---|
| POST | `/jobs/temporary` | createTemporaryJob |
| GET | `/jobs/temporary` | getAllTemporaryJobs |
| GET | `/jobs/temporary/{jobId}` | getTemporaryJob |
| PUT | `/jobs/temporary/{jobId}` | updateTemporaryJob |
| DELETE | `/jobs/temporary/{jobId}` | deleteTemporaryJob |
| GET | `/jobs/clinictemporary/{clinicId}` | getTemporary-Clinic |

#### Permanent Jobs
| Method | Path | Handler |
|---|---|---|
| POST | `/jobs/permanent` | createPermanentJob |
| GET | `/jobs/permanent` | getAllPermanentJobs |
| GET | `/jobs/permanent/{jobId}` | getPermanentJob |
| PUT | `/jobs/permanent/{jobId}` | updatePermanentJob |
| DELETE | `/jobs/permanent/{jobId}` | deletePermanentJob |
| GET | `/jobs/clinicpermanent/{clinicId}` | getAllPermanentJobsForClinic |

#### Multi-Day Consulting Jobs
| Method | Path | Handler |
|---|---|---|
| POST | `/jobs/consulting` | createMultiDayConsulting |
| GET | `/jobs/consulting` | getAllMultiDayConsulting |
| GET | `/jobs/consulting/{jobId}` | getMultiDayConsulting |
| PUT | `/jobs/consulting/{jobId}` | updateMultiDayConsulting |
| DELETE | `/jobs/consulting/{jobId}` | deleteMultiDayConsulting |
| GET | `/jobs/multiday/{jobId}` | getAllMultidayJobs |
| GET | `/jobs/multiday/clinic/{clinicId}` | getAllMultidayForClinic |

#### Job Applications
| Method | Path | Handler |
|---|---|---|
| POST | `/applications` | createJobApplication |
| GET | `/applications` | getJobApplications |
| PUT | `/applications/{applicationId}` | updateJobApplication |
| DELETE | `/applications/{applicationId}` | deleteJobApplication |
| GET | `/clinics/{clinicId}/jobs/` | getJobApplicationsForClinic |
| GET | `/{clinicId}/jobs` | getJobApplicantsOfAClinic |

#### Job Invitations
| Method | Path | Handler |
|---|---|---|
| POST | `/jobs/{jobId}/invitations` | sendJobInvitations |
| POST | `/invitations/{invitationId}/response` | respondToInvitation |
| GET | `/invitations` | getJobInvitations |
| GET | `/invitations/{clinicId}` | getJobInvitationsForClinics |

#### Hiring & Status
| Method | Path | Handler |
|---|---|---|
| PUT | `/jobs/{jobId}/status` | updateJobStatus |
| POST | `/jobs/{jobId}/hire` | acceptProf (hire) |
| POST | `/{clinicId}/reject/{jobId}` | rejectProf |

#### Negotiations
| Method | Path | Handler |
|---|---|---|
| PUT | `/applications/{applicationId}/negotiations/{negotiationId}/response` | respondToNegotiation |
| GET | `/allnegotiations` | getAllNegotiations-Prof |
| GET | `/negotiations` | getAllNegotiations-Prof |

#### Shifts & Dashboard
| Method | Path | Handler |
|---|---|---|
| GET | `/dashboard/all/open-shifts` | getAllClinicsShifts |
| GET | `/dashboard/all/action-needed` | getAllClinicsShifts |
| GET | `/dashboard/all/scheduled-shifts` | getAllClinicsShifts |
| GET | `/dashboard/all/completed-shifts` | getAllClinicsShifts |
| GET | `/dashboard/all/invites-shifts` | getAllClinicsShifts |
| GET | `/scheduled/{clinicId}` | getScheduledShifts |
| GET | `/completed/{clinicId}` | getCompletedShifts |
| PUT | `/professionals/completedshifts` | updateCompletedShifts |
| GET | `/action-needed` | getActionNeeded |
| GET | `/clinics/{clinicId}/action-needed` | getActionNeeded |

#### Assignments
| Method | Path | Handler |
|---|---|---|
| POST | `/assignments` | createAssignment |
| GET | `/assignments` | getAssignments |
| GET | `/assignments/{userSub}` | getAssignments |
| PUT | `/assignments` | updateAssignment |
| DELETE | `/assignments` | deleteAssignment |

#### Clinic Favorites
| Method | Path | Handler |
|---|---|---|
| POST | `/clinics/favorites` | addClinicFavorite |
| GET | `/clinics/favorites` | getClinicFavorites |
| DELETE | `/clinics/favorites/{professionalUserSub}` | removeClinicFavorite |

#### File Management
| Method | Path | Handler |
|---|---|---|
| POST | `/files/presigned-urls` | generatePresignedUrl |
| GET | `/files/profile-images` | getProfileImage |
| GET | `/files/professional-resumes` | getProfessionalResume |
| GET | `/files/professional-licenses` | getProfessionalLicense |
| GET | `/files/driving-licenses` | getDrivingLicense |
| GET | `/files/video-resumes` | getVideoResume |
| PUT | `/files/profile-image` | updateProfileImage |
| PUT | `/files/professional-resumes` | updateProfessionalResume |
| PUT | `/files/professional-licenses` | updateProfessionalLicense |
| PUT | `/files/driving-licenses` | updateDrivingLicense |
| PUT | `/files/video-resumes` | updateVideoResume |
| DELETE | `/files/profile-images` | deleteFile |
| DELETE | `/files/certificates` | deleteFile |
| DELETE | `/files/video-resumes` | deleteFile |

#### User Addresses
| Method | Path | Handler |
|---|---|---|
| POST | `/user-addresses` | createUserAddress |
| GET | `/user-addresses` | getUserAddresses |
| PUT | `/user-addresses` | updateUserAddress |
| DELETE | `/user-addresses` | deleteUserAddress |

#### Public / Browse
| Method | Path | Handler |
|---|---|---|
| GET | `/jobs/public` | findJobs (public) |
| GET | `/professionals/public` | publicProfessionals |
| GET | `/professionals/filtered-jobs` | getProfessionalFilteredJobs |

#### Feedback & Referrals
| Method | Path | Handler |
|---|---|---|
| POST | `/submitfeedback` | submitFeedback |
| POST | `/referrals/invite` | sendReferralInvite |

#### Stage-Prefixed Aliases (for prod prefix handling)
| Method | Path | Handler |
|---|---|---|
| GET | `/prod/negotiations` | getAllNegotiations-Prof |
| GET | `/prod/allnegotiations` | getAllNegotiations-Prof |
| PUT | `/prod/applications/{applicationId}/negotiations/{negotiationId}/response` | respondToNegotiation |

---

## 7. CloudFormation Outputs

| Output Key | Value |
|---|---|
| `UserPoolId` | Cognito User Pool ID |
| `ClientId` | Cognito App Client ID |
| `RestApiEndpoint` | REST API Gateway URL |
| `WebSocketEndpoint` | WebSocket API Gateway URL |
| `ProfileImagesBucketName` | S3 bucket name |
| `ProfessionalResumesBucketName` | S3 bucket name |
| `VideoResumesBucketName` | S3 bucket name |
| `DrivingLicensesBucketName` | S3 bucket name |
| `ProfessionalLicensesBucketName` | S3 bucket name |

---

## 8. EventBridge (Scheduled Task)

When `event.source === 'aws.events'`, the monolith Lambda skips API routing and directly invokes `updateCompletedShifts` handler — used to automatically mark shifts as completed on a schedule.

---

## 9. Endpoint Count Summary

| Category | Count |
|---|---|
| Authentication | 7 |
| Users | 6 |
| Clinics | 7 |
| Clinic Profiles | 5 |
| Professional Profiles | 7 |
| Job Postings (generic) | 6 |
| Temporary Jobs | 6 |
| Permanent Jobs | 6 |
| Multi-Day Consulting | 7 |
| Job Applications | 6 |
| Job Invitations | 4 |
| Hiring & Status | 3 |
| Negotiations | 3 |
| Shifts & Dashboard | 10 |
| Assignments | 5 |
| Clinic Favorites | 3 |
| File Management | 14 |
| User Addresses | 4 |
| Public / Browse | 3 |
| Feedback & Referrals | 2 |
| Stage-Prefixed Aliases | 3 |
| **TOTAL** | **116** |
