m the existing models, entities, migrations, or schema definitions in the code, extract the database structure and generate a documentation report.

The documentation should include:

1. List of all database tables or collections.
2. For each table:

   * Table name
   * Purpose/description of the table
   * All columns/fields with their data types
   * Primary key(s)
   * Foreign key relationships (referenced table and column)
   * Unique constraints or indexes if present
3. Relationships between tables (one-to-one, one-to-many, many-to-many).
4. A simple explanation of how the tables are connected in the system (for example: clinic → patients → appointments → claims).
5. Present the output in a clean documentation format that can be shared with the technical lead.

Important:

* Only analyze the code and extract schema information.
* Do not change, refactor, or edit any existing code files.
* The output should be documentation only.
Agent:Explore DentiPal database schema
IN
Very thoroughly explore the DentiPal project at c:\Users\today\OneDrive\Dentipal to find ALL database schema definitions. This is a dental clinic management app likely using DynamoDB (AWS CDK + Lambda backend).

Search for:
1. DynamoDB table definitions in CDK stacks (look for `new dynamodb.Table`, `Table`, `TableV2`, `aws_dynamodb`)
2. Entity/model definitions in Lambda code
3. Any TypeScript interfaces or types that define database record shapes
4. Any migration files or schema definitions
5. GSI (Global Secondary Index) definitions
6. Sort key / partition key definitions

Search across ALL directories: DentiPalCDK/, and any other directories. Check CDK stack files, lambda source files, shared types, etc.

For each finding, report:
- The exact file path and line numbers
- The table name
- Partition key and sort key with types
- All GSIs with their key schemas
- Any attributes defined
- Any interfaces/types that describe the items stored in each table

Be extremely thorough - check every .ts file in the CDK and lambda directories.
Bash
IN
find /c/Users/today/OneDrive/Dentipal -type f -name "*.ts" -o -name "*.js" | head -50

OUT
/c/Users/today/OneDrive/Dentipal/dentipal/eslint.config.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/@fullcalendar_daygrid.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/@fullcalendar_interaction.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/@fullcalendar_react.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/@fullcalendar_timegrid.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/@hookform_resolvers_zod.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/@tanstack_react-query.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/axios.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/bootstrap.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/buffer.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/chunk-C4KFTZQU.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/chunk-EVEIILV5.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/chunk-FYMKL3VZ.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/chunk-JFPFMKIB.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/chunk-MIEWXLXB.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/chunk-OJLPBJYM.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/chunk-RF6U4KUC.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/chunk-SS2ORZSQ.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/chunk-U5XW73HS.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/chunk-V4OQ3NZ2.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/emoji-picker-react.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/jotai.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/jwt-decode.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/lucide-react.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-bootstrap.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-bootstrap_Dropdown.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-dom_client.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-hook-form.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-icons_bs.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-icons_fa.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-icons_fc.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-icons_fi.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-icons_md.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-multi-date-picker.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-phone-input-2.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-router-dom.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react-toastify.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/react_jsx-dev-runtime.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/.vite/deps/zod.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@aws/lambda-invoke-store/dist-cjs/invoke-store.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@aws/lambda-invoke-store/dist-es/invoke-store.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@aws/lambda-invoke-store/dist-types/invoke-store.benchmark.d.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@aws/lambda-invoke-store/dist-types/invoke-store.d.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@aws-crypto/crc32/build/main/aws_crc32.d.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@aws-crypto/crc32/build/main/aws_crc32.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@aws-crypto/crc32/build/main/index.d.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@aws-crypto/crc32/build/main/index.js
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@aws-crypto/crc32/build/module/aws_crc32.d.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@aws-crypto/crc32/build/module/aws_crc32.js
Bash
IN
ls -la /c/Users/today/OneDrive/Dentipal

OUT
total 24
drwxr-xr-x 1 today 197609 0 Apr  9 16:05 .
drwxr-xr-x 1 today 197609 0 Apr  9 15:45 ..
drwxr-xr-x 1 today 197609 0 Apr  9 16:05 DentiPalCDK
drwxr-xr-x 1 today 197609 0 Apr 10 11:02 dentipal
Bash
IN
find /c/Users/today/OneDrive/Dentipal/DentiPalCDK -type f \( -name "*.ts" -o -name "*.js" \) -not -path "*/node_modules/*" | head -100

OUT
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/bin/denti_pal_cdk.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/jest.config.js
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/acceptProf.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/addClinicFavorite.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/browseJobPostings.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/checkEmail.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/confirmPassword.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/corsHeaders.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createAssignment-prof.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createAssignment.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createClinicProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobApplication-prof.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobApplication.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobPosting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createMultiDayConsulting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createPermanentJob.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createProfessionalProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createTemporaryJob.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createUser.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createUserAddress.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteAssignment.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteClinicProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteFile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteJobApplication.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteJobPosting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteMultiDayConsulting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteOwnAccount.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deletePermanentJob.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteProfessionalProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteTemporaryJob.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteUser.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteUserAddress.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/event-to-message.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/findJobs.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/forgotPassword.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/generatePresignedUrl.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getActionNeeded.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllClinics.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllClinicsShifts.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllMultiDayConsulting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllMultidayForClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllMultidayJobs.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllNegotiations-Prof.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllPermanentJobs.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllPermanentJobsForClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllProfessionals.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllTemporaryJobs.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAssignments.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getClinicAddress.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getClinicFavorites.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getClinicOfficeImages.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getClinicProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getClinicProfileDetails.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getClinicShifts.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getClinicUsers.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getCompletedShifts.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getFileUrl.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getJobApplicantsOfAClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getJobApplications.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getJobApplicationsForClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getJobInvitations.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getJobInvitationsForClinics.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getJobPosting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getJobPostings.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getMultiDayConsulting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getPermanentJob.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getProfessionalFilteredJobs.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getProfessionalProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getProfessionalQuestions.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getPublicProfessionalProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getScheduledShifts.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getTemporary-Clinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getTemporaryJob.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getUser.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getUserAddresses.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getUserMe.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getUsersClinics.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/initiateUserRegistration.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/loginUser.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/professionalRoles.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/publicProfessionals.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/refreshToken.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/rejectProf.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/removeClinicFavorite.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/respondToInvitation.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/respondToNegotiation.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendJobInvitations.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/updateAssignment.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/updateClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/updateClinicProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/updateClinicProfileDetails.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/updateCompletedShifts.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/updateFile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/updateJobApplication.ts
Bash
IN
find /c/Users/today/OneDrive/Dentipal/DentiPalCDK -type f -name "*.ts" -not -path "*/node_modules/*" | grep -E "(stack|types|models|entity)" | head -50

OUT
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lib/denti_pal_cdk-stack.ts
Bash
IN
find /c/Users/today/OneDrive/Dentipal/DentiPalCDK/lib -type f -name "*.ts" | head -100

OUT
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lib/denti_pal_cdk-stack.ts
Grep "new dynamodb\.|new Table|TableV2|aws_dynamodb|DynamoDBTable" (in /c/Users/today/OneDrive/Dentipal/DentiPalCDK)
2 lines of output
Bash
IN
find /c/Users/today/OneDrive/Dentipal/DentiPalCDK -type f -name "*.ts" -not -path "*/node_modules/*" | xargs grep -l "interface\|type.*=\|export" | head -50

OUT
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/acceptProf.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/addClinicFavorite.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/browseJobPostings.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/checkEmail.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/confirmPassword.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/corsHeaders.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createAssignment-prof.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createAssignment.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createClinicProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobApplication-prof.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobApplication.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobPosting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createMultiDayConsulting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createPermanentJob.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createProfessionalProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createTemporaryJob.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createUser.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createUserAddress.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteAssignment.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteClinicProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteFile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteJobApplication.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteJobPosting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteMultiDayConsulting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteOwnAccount.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deletePermanentJob.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteProfessionalProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteTemporaryJob.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteUser.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteUserAddress.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/event-to-message.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/findJobs.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/forgotPassword.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/generatePresignedUrl.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getActionNeeded.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllClinics.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllClinicsShifts.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllMultiDayConsulting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllMultidayForClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllMultidayJobs.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllNegotiations-Prof.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllPermanentJobs.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllPermanentJobsForClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllProfessionals.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllTemporaryJobs.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAssignments.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getClinic.ts
Bash
IN
find /c/Users/today/OneDrive/Dentipal/DentiPalCDK -type d \( -name "types" -o -name "models" -o -name "shared" -o -name "utils" \)

OUT
(Bash completed with no output)
Bash
IN
ls -la /c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/

OUT
total 80
drwxr-xr-x 1 today 197609     0 Apr  9 16:05 .
drwxr-xr-x 1 today 197609     0 Apr 10 11:05 ..
drwxr-xr-x 1 today 197609     0 Apr 10 10:53 handlers
-rw-r--r-- 1 today 197609 25039 Apr  9 16:05 index.ts
Read index.ts
Read denti_pal_cdk-stack.ts
Grep "new dynamodb\.Table|new Table|\.partitionKey|\.sortKey|\.gsi|GlobalSecondaryIndexProps|new Table|TableV2" (in /c/Users/today/OneDrive/Dentipal/DentiPalCDK/lib/denti_pal_cdk-stack.ts)
34 lines of output
Read denti_pal_cdk-stack.ts (lines 731-1230)
Read denti_pal_cdk-stack.ts (lines 2-101)
Bash
IN
find /c/Users/today/OneDrive/Dentipal -name "types.ts" -o -name "models.ts" -o -name "interfaces.ts" 2>/dev/null

OUT
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@emotion/cache/src/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@emotion/react/src/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@emotion/utils/src/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@eslint/config-array/dist/esm/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@eslint/config-helpers/dist/esm/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@eslint/object-schema/dist/esm/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@eslint/plugin-kit/dist/esm/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@hookform/resolvers/ajv/src/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@hookform/resolvers/joi/src/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@hookform/resolvers/nope/src/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@hookform/resolvers/vest/src/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@jridgewell/gen-mapping/src/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@jridgewell/trace-mapping/src/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@tanstack/query-core/src/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/@tanstack/react-query/src/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/node_modules/zod/src/v3/types.ts
/c/Users/today/OneDrive/Dentipal/dentipal/src/interfaces/types.ts
Bash
IN
find /c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src -type f -name "*.ts" | xargs grep -l "interface\|export type" | head -20

OUT
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/acceptProf.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/addClinicFavorite.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/browseJobPostings.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/checkEmail.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/confirmPassword.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createAssignment-prof.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createAssignment.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createClinic.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createClinicProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobApplication-prof.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobApplication.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobPosting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createMultiDayConsulting.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createPermanentJob.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createProfessionalProfile.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createTemporaryJob.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createUser.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createUserAddress.ts
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteAssignment.ts
Bash
IN
grep -r "interface\|export type" /c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/ | head -50

OUT
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/acceptProf.ts:interface RequestBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/addClinicFavorite.ts:interface FavoriteRequestBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts:interface ReferralProcessingRecord {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/browseJobPostings.ts:interface JobPosting {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/browseJobPostings.ts:                // Map DynamoDB item to JobPosting interface structure
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/checkEmail.ts:// Define interfaces for the parts of the JWT payload we care about
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/checkEmail.ts:interface AddressPayload {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/checkEmail.ts:interface JwtPayload {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/confirmPassword.ts:interface RequestBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createAssignment-prof.ts:interface ApplicationRequestBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createAssignment-prof.ts:interface JobInfo {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createAssignment-prof.ts:interface ClinicInfo {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createAssignment.ts:interface AssignClinicRequestBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createClinic.ts:interface ClinicRequestBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createClinicProfile.ts:interface ClinicProfileData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobApplication-prof.ts:interface ApplyJobBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobApplication.ts:interface ApplyJobBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobPosting.ts:interface BaseJobData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobPosting.ts:interface TemporaryJobData extends BaseJobData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobPosting.ts:interface MultiDayConsultingJobData extends BaseJobData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobPosting.ts:interface PermanentJobData extends BaseJobData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobPosting.ts:interface ClinicAddress {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobPosting.ts:interface ClinicProfileDetails {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createMultiDayConsulting.ts:interface JobData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createMultiDayConsulting.ts:interface ClinicAddress {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createMultiDayConsulting.ts:interface ProfileData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createPermanentJob.ts:interface JobData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createPermanentJob.ts:interface ProfileData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createProfessionalProfile.ts:interface ProfessionalProfileData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createProfessionalProfile.ts:interface AddressData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createTemporaryJob.ts:interface MultiJobData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createTemporaryJob.ts:interface ClinicAddress {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createTemporaryJob.ts:interface ProfileData {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createUser.ts:interface RequestBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createUserAddress.ts:interface AddressRequestBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteAssignment.ts:interface DeleteAssignmentRequestBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteFile.ts:interface BucketMap {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteJobApplication.ts:interface ApplicationItem {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteJobPosting.ts:interface DeleteItem {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteOwnAccount.ts:interface UserClinicAssignmentItem {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/deleteUser.ts:interface ResolvedUser {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/event-to-message.ts:interface WsPayload {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/event-to-message.ts:interface ShiftDetails {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/event-to-message.ts:interface EventDetail {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/event-to-message.ts:interface EventBridgeEvent {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/findJobs.ts:interface ClinicInfo {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/findJobs.ts:interface JobPosting {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/forgotPassword.ts:interface ForgotPasswordRequestBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/generatePresignedUrl.ts:interface RequestBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/getAllClinics.ts:interface ClinicResponseItem {
Read createJobPosting.ts
Bash
IN
grep -A 30 "interface ApplyJobBody" /c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createJobApplication.ts

OUT
interface ApplyJobBody {
    jobId?: string; // Can be in body or path
    message?: string;
    proposedRate?: number;
    availability?: string;
    startDate?: string;
    notes?: string;
    [key: string]: any;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "POST";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 2. Authentication (Access Token)
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        console.log("User authenticated:", userSub);

        // 3. Parse Body
        if (!event.body) {
            return json(400, { error: "Request body is required" });
        }
        
        let applicationData: ApplyJobBody;
Bash
IN
grep -A 20 "interface AddressRequestBody" /c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/createUserAddress.ts

OUT
interface AddressRequestBody {
    addressLine1: string;
    addressLine2?: string;
    addressLine3?: string;
    city: string;
    state: string;
    pincode: string;
    country?: string;
    addressType?: string;
    isDefault?: boolean;
}

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
    const method =
        (event.requestContext as any)?.http?.method || event.httpMethod || "POST";

    // --- CORS preflight ---
    if (method === "OPTIONS") {
Bash
IN
find /c/Users/today/OneDrive/Dentipal -name "*migration*" -o -name "*seed*" -o -name "*schema*" 2>/dev/null | grep -v node_modules

OUT
/c/Users/today/OneDrive/Dentipal/dentipal/src/components/clinic-header/schema
/c/Users/today/OneDrive/Dentipal/dentipal/src/components/clinic-header/schema/header.schema.ts
/c/Users/today/OneDrive/Dentipal/dentipal/src/features/inbox/schema
/c/Users/today/OneDrive/Dentipal/dentipal/src/schemas
/c/Users/today/OneDrive/Dentipal/dentipal/src/schemas/feedback.schema.ts
/c/Users/today/OneDrive/Dentipal/dentipal/src/schemas/findProfessionals/professionals.schema.ts
/c/Users/today/OneDrive/Dentipal/dentipal/src/schemas/jobFilters.schema.ts
/c/Users/today/OneDrive/Dentipal/dentipal/src/schemas/talentMarketplace/job.schema.ts
/c/Users/today/OneDrive/Dentipal/dentipal/src/schemas/talentMarketplace/professional.schema.ts
Bash
IN
grep -A 30 "interface.*Feedback\|interface.*Notification\|interface.*Referral\|interface.*Message\|interface.*Conversation" /c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/*.ts 2>/dev/null | head -100

OUT
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts:interface ReferralProcessingRecord {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-    eventName: 'INSERT' | 'MODIFY' | 'REMOVE';
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-    dynamodb: {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-        NewImage?: {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-            applicationStatus: { S: string };
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-            professionalUserSub: { S: string };
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-            [key: string]: AttributeValue;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-        };
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-        Keys: {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-            jobId: { S: string };
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-            [key: string]: AttributeValue;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-        };
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-        [key: string]: any;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-    };
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-    [key: string]: any;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-}
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent): Promise<void> => {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-    console.log("Received event:", JSON.stringify(event, null, 2));
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-    try {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-        if (!event || !event.Records) {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-            console.log("No records found in event");
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-            return; 
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-        }
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-        // Cast event.Records to our custom type
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-        const records = event.Records as unknown as ReferralProcessingRecord[];
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-        // Loop through ALL records. 
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/BonusAwarding.ts-        // We do not 'return' inside the loop, ensuring the whole batch is processed.
--
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts:interface ReferralPayload {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-    friendEmail: string;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-    personalMessage?: string;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-}
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-/** Defines the expected structure of a professional profile item for the referrer. */
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-interface ProfileItem extends DynamoDBItem {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-    userSub?: AttributeValue;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-    full_name?: AttributeValue;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-}
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-/** Defines the return structure for the email template function. */
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-interface EmailTemplate {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-    subject: string;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-    htmlBody: string;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-    textBody: string;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-}
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-// --- Initialization ---
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-// Use non-null assertion (!) as we expect these environment variables to be set.
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-const REGION: string = process.env.REGION!;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-const SES_REGION: string = process.env.SES_REGION!;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-const PROFESSIONAL_PROFILES_TABLE: string = process.env.PROFESSIONAL_PROFILES_TABLE!;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-const REFERRALS_TABLE: string = process.env.REFERRALS_TABLE!;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-const dynamodb = new DynamoDBClient({ region: REGION } as DynamoDBClientConfig);
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-const ses = new SESClient({ region: SES_REGION } as SESClientConfig);
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-// Get CORS Origin from environment variable or default to localhost
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/sendReferralInvite.ts-
--
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts:interface FeedbackBody {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-  feedbackType?: string;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-  message?: string;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-  contactMe?: boolean;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-  email?: string;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-}
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-// ==== ENV ====
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-const REGION: string = process.env.REGION || "us-east-1";
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-const FEEDBACK_TABLE: string = process.env.FEEDBACK_TABLE || "DentiPal-Feedback";
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-const SES_FROM: string | undefined = process.env.SES_FROM; // verified email OR address at a verified domain
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-const SES_TO: string | undefined = process.env.SES_TO; // comma-separated list, e.g. "support@...,ops@..."
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-const ddb = new DynamoDBClient({ region: REGION });
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-const ses = new SESClient({ region: REGION });
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-// Helper to build JSON responses with shared CORS
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-  statusCode,
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-  headers: CORS_HEADERS,
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-  body: JSON.stringify(bodyObj)
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-});
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-const getMethod = (e: APIGatewayProxyEvent): string =>
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-  // FIX: Cast requestContext to 'any' to access 'http' (HTTP API v2 property) safely
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-  e?.httpMethod || (e?.requestContext as any)?.http?.method || "GET";
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-const parseBody = (e: APIGatewayProxyEvent): FeedbackBody => {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-  if (!e?.body) return {};
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-  if (typeof e.body === "string") {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/submitFeedback.ts-    try {
--
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/updateCompletedShifts.ts:interface ReferralRecord {
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/updateCompletedShifts.ts-  referralId: string;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/updateCompletedShifts.ts-  referrerUserSub: string;
/c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/updateCompletedShifts.ts-  referredUserSub: string;
Bash
IN
ls /c/Users/today/OneDrive/Dentipal/DentiPalCDK/lambda/src/handlers/ | wc -l

OUT
110
Here is the complete database schema documentation for the DentiPal project.

DentiPal Database Schema Documentation
Database Engine: Amazon DynamoDB (NoSQL)
Billing Mode: PAY_PER_REQUEST (all tables)
Table Prefix: DentiPal-V5-
Total Tables: 17
Total GSIs: 24
Source: denti_pal_cdk-stack.ts (lines 738–1006)

1. Tables Overview
#	Table Name	Partition Key	Sort Key	GSIs	Purpose
1	Clinic-Profiles	clinicId (S)	userSub (S)	1	Clinic configuration & practice details
2	ClinicFavorites	clinicUserSub (S)	professionalUserSub (S)	0	Clinics' bookmarked professionals
3	Clinics	clinicId (S)	—	1	Clinic entities (name, address)
4	Connections	userKey (S)	connectionId (S)	1	WebSocket connection tracking
5	Conversations	conversationId (S)	—	2	Chat conversations metadata
6	Feedback	PK (S)	SK (S)	0	User feedback submissions
7	JobApplications	jobId (S)	professionalUserSub (S)	5	Professional applications to jobs
8	JobInvitations	jobId (S)	professionalUserSub (S)	2	Clinic invitations to professionals
9	JobNegotiations	applicationId (S)	negotiationId (S)	3	Rate/terms negotiation threads
10	JobPostings	clinicUserSub (S)	jobId (S)	4	Job listings (temp, multi-day, permanent)
11	Messages	conversationId (S)	messageId (S)	1	Chat message storage
12	Notifications	recipientUserSub (S)	notificationId (S)	0	Push/in-app notifications
13	OTPVerification	email (S)	—	0	Email OTP codes for registration
14	ProfessionalProfiles	userSub (S)	—	0	Dental professional profiles
15	Referrals	referralId (S)	—	2	Referral invite tracking
16	UserAddresses	userSub (S)	—	0	User address records
17	UserClinicAssignments	userSub (S)	clinicId (S)	0	User-to-clinic role assignments
2. Detailed Table Definitions
2.1 — DentiPal-V5-Clinic-Profiles
Purpose: Stores clinic-specific configuration and practice details (operatories, staff counts, practice type).

Field	Type	Description
clinicId	String	PK — Clinic identifier
userSub	String	SK — Cognito user sub of the clinic owner
practice_type	String	Type of dental practice
primary_practice_area	String	Main area of practice
primary_contact_first_name	String	Primary contact first name
primary_contact_last_name	String	Primary contact last name
assisted_hygiene_available	Boolean	Whether assisted hygiene is offered
number_of_operatories	Number	Number of operatories
num_hygienists	Number	Number of hygienists on staff
num_assistants	Number	Number of dental assistants
num_doctors	Number	Number of doctors
booking_out_period	String	Advance booking window
free_parking_available	Boolean	Whether free parking is available
GSIs:

userSub-index — PK: userSub → Look up all clinics for a given user
2.2 — DentiPal-V5-ClinicFavorites
Purpose: Tracks which professionals a clinic has bookmarked/favorited.

Field	Type	Description
clinicUserSub	String	PK — Clinic owner's user sub
professionalUserSub	String	SK — Favorited professional's user sub
GSIs: None

2.3 — DentiPal-V5-Clinics
Purpose: Core clinic entity storing name, address, and ownership.

Field	Type	Description
clinicId	String	PK — Unique clinic identifier
name	String	Clinic name
addressLine1	String	Street address line 1
addressLine2	String	Street address line 2 (optional)
addressLine3	String	Street address line 3 (optional)
city	String	City
state	String	State
pincode	String	Postal/ZIP code
createdBy	String	Cognito user sub of creator
GSIs:

CreatedByIndex — PK: createdBy → List all clinics created by a user
2.4 — DentiPal-V5-Connections
Purpose: Tracks active WebSocket connections for real-time messaging.

Field	Type	Description
userKey	String	PK — User identifier
connectionId	String	SK — API Gateway WebSocket connection ID
GSIs:

connectionId-index — PK: connectionId, SK: userKey → Reverse lookup by connection
2.5 — DentiPal-V5-Conversations
Purpose: Metadata for chat conversations between clinics and professionals.

Field	Type	Description
conversationId	String	PK — Unique conversation identifier
clinicKey	String	Clinic participant key
profKey	String	Professional participant key
lastMessageAt	Number	Timestamp of last message (epoch)
GSIs:

clinicKey-lastMessageAt — PK: clinicKey, SK: lastMessageAt → Clinic's conversations sorted by recency
profKey-lastMessageAt — PK: profKey, SK: lastMessageAt → Professional's conversations sorted by recency
2.6 — DentiPal-V5-Feedback
Purpose: Stores user-submitted feedback and feature requests.

Field	Type	Description
PK	String	PK — Partition key (generic single-table pattern)
SK	String	SK — Sort key
feedbackType	String	Category of feedback
message	String	Feedback content
contactMe	Boolean	Whether user wants to be contacted
email	String	Contact email
GSIs: None

2.7 — DentiPal-V5-JobApplications
Purpose: Tracks professional applications to job postings, including proposed rates and availability.

Field	Type	Description
jobId	String	PK — Job posting identifier
professionalUserSub	String	SK — Applying professional's user sub
applicationId	String	Unique application identifier
clinicId	String	Clinic that posted the job
message	String	Cover message
proposedRate	Number	Professional's proposed hourly rate
availability	String	Availability details
startDate	String	Proposed start date
notes	String	Additional notes
GSIs:

applicationId-index — PK: applicationId → Direct application lookup
clinicId-index — PK: clinicId → All applications for a clinic
clinicId-jobId-index — PK: clinicId, SK: jobId → Applications per clinic per job
JobIdIndex-1 — PK: jobId → All applications for a job
professionalUserSub-index — PK: professionalUserSub, SK: jobId → A professional's applications
2.8 — DentiPal-V5-JobInvitations
Purpose: Tracks invitations sent by clinics to specific professionals for jobs.

Field	Type	Description
jobId	String	PK — Job posting identifier
professionalUserSub	String	SK — Invited professional's user sub
invitationId	String	Unique invitation identifier
GSIs:

invitationId-index — PK: invitationId → Direct invitation lookup
ProfessionalIndex — PK: professionalUserSub → All invitations for a professional
2.9 — DentiPal-V5-JobNegotiations
Purpose: Stores negotiation rounds between clinics and professionals on job terms/rates.

Field	Type	Description
applicationId	String	PK — Parent application identifier
negotiationId	String	SK — Unique negotiation round ID
clinicId	String	Clinic involved
jobId	String	Job being negotiated
professionalUserSub	String	Professional involved
status	String	Negotiation status
lastOfferPay	Number	Most recent offered rate
lastOfferFrom	String	Who made the last offer
gsi1pk	String	GSI1 partition key
gsi1sk	String	GSI1 sort key
createdAt	String	Creation timestamp
updatedAt	String	Last update timestamp
GSIs:

index — PK: applicationId → All negotiations for an application
GSI1 — PK: gsi1pk, SK: gsi1sk → Projected attributes: negotiationId, clinicId, jobId, professionalUserSub, status, lastOfferPay, lastOfferFrom, updatedAt
JobIndex — PK: jobId, SK: createdAt → Negotiations for a job sorted by time
2.10 — DentiPal-V5-JobPostings
Purpose: Core job listing table supporting three job types: temporary, multi-day consulting, and permanent positions.

Field	Type	Description
clinicUserSub	String	PK — Clinic owner's user sub
jobId	String	SK — Unique job identifier
clinicId	String	Clinic identifier
job_type	String	temporary / multi_day_consulting / permanent
professional_role	String	Required role (dentist, hygienist, etc.)
shift_speciality	String	Shift specialization
status	String	active / inactive / filled
job_title	String	Job title
job_description	String	Full description
requirements	List<String>	Required qualifications
date	String	Shift date (temporary jobs)
hours	Number	Hours per shift (temporary)
hourly_rate	Number	Hourly rate (temp/multi-day)
dates	List<String>	Multiple dates (multi-day)
hours_per_day	Number	Hours per day (multi-day)
total_days	Number	Total engagement days (multi-day)
employment_type	String	full_time / part_time (permanent)
salary_min	Number	Minimum salary (permanent)
salary_max	Number	Maximum salary (permanent)
benefits	List<String>	Benefits offered (permanent)
start_time	String	Shift start time
end_time	String	Shift end time
meal_break	Boolean	Whether meal break is provided
assisted_hygiene	Boolean	Assisted hygiene required
GSIs:

ClinicIdIndex — PK: clinicId, SK: jobId → Jobs by clinic
DateIndex — PK: date, SK: jobId → Jobs by date (for searching available shifts)
jobId-index-1 — PK: jobId → Direct job lookup
JobIdIndex-2 — PK: jobId → Direct job lookup (alternate)
2.11 — DentiPal-V5-Messages
Purpose: Stores individual chat messages within conversations.

Field	Type	Description
conversationId	String	PK — Parent conversation
messageId	String	SK — Unique message identifier
GSIs:

ConversationIdIndex — PK: conversationId, SK: messageId → Messages in a conversation
2.12 — DentiPal-V5-Notifications
Purpose: Stores push/in-app notifications for users.

Field	Type	Description
recipientUserSub	String	PK — Notification recipient
notificationId	String	SK — Unique notification ID
GSIs: None

2.13 — DentiPal-V5-OTPVerification
Purpose: Temporary storage for email OTP codes during user registration.

Field	Type	Description
email	String	PK — Email being verified
GSIs: None

2.14 — DentiPal-V5-ProfessionalProfiles
Purpose: Dental professional profile data (role, name, specialties).

Field	Type	Description
userSub	String	PK — Cognito user sub
role	String	Professional role (dentist, hygienist, etc.)
first_name	String	First name
last_name	String	Last name
specialties	List<String>	Areas of specialization
GSIs: None

2.15 — DentiPal-V5-Referrals
Purpose: Tracks referral invitations sent by existing users to recruit new users.

Field	Type	Description
referralId	String	PK — Unique referral identifier
referrerUserSub	String	User sub of the referrer
referredUserSub	String	User sub of referred user (after signup)
friendEmail	String	Invited friend's email
personalMessage	String	Custom invitation message
sentAt	String	Timestamp when referral was sent
GSIs:

ReferredUserSubIndex — PK: referredUserSub → Look up referral by referred user
ReferrerIndex — PK: referrerUserSub, SK: sentAt → Referrals by referrer, sorted by time
2.16 — DentiPal-V5-UserAddresses
Purpose: Stores physical addresses for users (professionals or clinic owners).

Field	Type	Description
userSub	String	PK — Cognito user sub
addressLine1	String	Street address line 1
addressLine2	String	Street address line 2 (optional)
addressLine3	String	Street address line 3 (optional)
city	String	City
state	String	State
pincode	String	Postal/ZIP code
country	String	Country (optional)
addressType	String	Type of address (optional)
isDefault	Boolean	Default address flag
GSIs: None

2.17 — DentiPal-V5-UserClinicAssignments
Purpose: Maps users to clinics they belong to (multi-clinic support).

Field	Type	Description
userSub	String	PK — Cognito user sub
clinicId	String	SK — Assigned clinic identifier
GSIs: None

3. Entity Relationships
Since DynamoDB is a NoSQL database, relationships are not enforced at the database level but are maintained at the application layer. Here is the logical relationship map:


Users (Cognito)
 ├── 1:1  → ProfessionalProfiles       (userSub)
 ├── 1:1  → UserAddresses              (userSub)
 ├── 1:N  → UserClinicAssignments      (userSub → clinicId)
 ├── 1:N  → Notifications              (recipientUserSub)
 ├── 1:N  → Connections                (userKey — WebSocket)
 └── 1:N  → Referrals                  (referrerUserSub)

Clinics
 ├── 1:1  → ClinicProfiles             (clinicId + userSub)
 ├── 1:N  → JobPostings                (clinicUserSub → jobId)
 ├── 1:N  → ClinicFavorites            (clinicUserSub → professionalUserSub)
 └── N:M  → Users via UserClinicAssignments

JobPostings
 ├── 1:N  → JobApplications            (jobId → professionalUserSub)
 ├── 1:N  → JobInvitations             (jobId → professionalUserSub)
 └── 1:N  → JobNegotiations            (via applicationId)

JobApplications
 └── 1:N  → JobNegotiations            (applicationId → negotiationId)

Conversations (Clinic ↔ Professional)
 └── 1:N  → Messages                   (conversationId → messageId)
Relationship Summary
Relationship	Type	Connected Via
User → ProfessionalProfile	One-to-One	userSub
User → UserAddress	One-to-One	userSub
User → Clinic	Many-to-Many	UserClinicAssignments (junction table)
Clinic → ClinicProfile	One-to-One	clinicId
Clinic → JobPostings	One-to-Many	clinicId / clinicUserSub
Clinic → ClinicFavorites	One-to-Many	clinicUserSub
JobPosting → JobApplications	One-to-Many	jobId
JobPosting → JobInvitations	One-to-Many	jobId
JobApplication → JobNegotiations	One-to-Many	applicationId
Conversation → Messages	One-to-Many	conversationId
User → Notifications	One-to-Many	recipientUserSub
User → Referrals (as referrer)	One-to-Many	referrerUserSub
4. System Flow

Clinic Owner registers (Cognito + OTPVerification)
  → Creates Clinic (Clinics table)
  → Sets up ClinicProfile (practice details, staff counts)
  → Assigned via UserClinicAssignments
  → Posts jobs (JobPostings — temp, multi-day, or permanent)
      → Sends invitations to professionals (JobInvitations)

Professional registers (Cognito + OTPVerification)
  → Creates ProfessionalProfile (role, specialties)
  → Saves UserAddress
  → Browses jobs → Applies (JobApplications)
      → Clinic and professional negotiate (JobNegotiations)

Clinic ↔ Professional communicate
  → Conversations created → Messages exchanged (real-time via WebSocket Connections)

Cross-cutting:
  → Notifications sent for job events, messages, invitations
  → Clinics can favorite professionals (ClinicFavorites)
  → Users can refer friends (Referrals)
  → Users can submit feedback (Feedback)
5. Authentication
User identity is managed by AWS Cognito (external to DynamoDB). The userSub field across all tables is the Cognito User Pool subject identifier, serving as the universal user foreign key.