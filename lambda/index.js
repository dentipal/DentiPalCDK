"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const createUser_1 = require("./handlers/createUser");
const getUser_1 = require("./handlers/getUser");
const updateUser_1 = require("./handlers/updateUser");
const deleteUser_1 = require("./handlers/deleteUser");
const deleteOwnAccount_1 = require("./handlers/deleteOwnAccount");
const createClinic_1 = require("./handlers/createClinic");
const getAllClinics_1 = require("./handlers/getAllClinics");
const getClinic_1 = require("./handlers/getClinic");
const updateClinic_1 = require("./handlers/updateClinic");
const deleteClinic_1 = require("./handlers/deleteClinic");
const createAssignment_1 = require("./handlers/createAssignment"); 
const createApplication_JobProf = require("./handlers/createJobApplication-prof");
const getAssignments_1 = require("./handlers/getAssignments");
const updateAssignment_1 = require("./handlers/updateAssignment");
const deleteAssignment_1 = require("./handlers/deleteAssignment");
const getJobPostings_1 = require("./handlers/getJobPostings");
const createProfessionalProfile_1 = require("./handlers/createProfessionalProfile");
const getProfessionalProfile_1 = require("./handlers/getProfessionalProfile");
const updateProfessionalProfile_1 = require("./handlers/updateProfessionalProfile");
const deleteProfessionalProfile_1 = require("./handlers/deleteProfessionalProfile");
const getProfessionalQuestions_1 = require("./handlers/getProfessionalQuestions");
const createClinicProfile_1 = require("./handlers/createClinicProfile");
const getClinicProfile_1 = require("./handlers/getClinicProfile");
// const { profileImageHandler, certificateHandler, videoResumeHandler } = require("./handlers/updatefile");
// const getClinicProfileDetails=require("./handlers/getClinicUser");
const getClinicProfileDetails=require('./handlers/getClinicProfileDetails')
const updateClinicProfile_1 = require("./handlers/updateClinicProfile");
const deleteClinicProfile_1 = require("./handlers/deleteClinicProfile");
const createJobPosting_1 = require("./handlers/createJobPosting");
const createTemporaryJob_1 = require("./handlers/createTemporaryJob");
const getTemporaryJob_Clinic = require("./handlers/getTemporary-Clinic");
const createMultiDayConsulting_1 = require("./handlers/createMultiDayConsulting");
const createPermanentJob_1 = require("./handlers/createPermanentJob");
const createUserAddress_1 = require("./handlers/createUserAddress");
const getUserAddresses_1 = require("./handlers/getUserAddresses");
const updateUserAddress_1 = require("./handlers/updateUserAddress");
const deleteUserAddress_1 = require("./handlers/deleteUserAddress");
// Clinic favorites handlers
const addClinicFavorite_1 = require("./handlers/addClinicFavorite");
const getClinicFavorites_1 = require("./handlers/getClinicFavorites");
const removeClinicFavorite_1 = require("./handlers/removeClinicFavorite");
// Job status management
const updateJobStatus_1 = require("./handlers/updateJobStatus");
// Job invitations
const sendJobInvitations_1 = require("./handlers/sendJobInvitations");
const respondToInvitation_1 = require("./handlers/respondToInvitation");
const getJobInvitations_1 = require("./handlers/getJobInvitations");
const getJobInvitationForClinics_1 = require("./handlers/getJobInvitationsForClinics");
// Negotiations
const respondToNegotiation_1 = require("./handlers/respondToNegotiation");
const getAllNegotiationsProf_1=require("./handlers/getAllNegotiations-Prof");
// OTP verification and user registration
const initiateUserRegistration_1 = require("./handlers/initiateUserRegistration");
const verifyOTPAndCreateUser_1 = require("./handlers/verifyOTPAndCreateUser");
// Authentication handlers
const loginUser_1 = require("./handlers/loginUser");
const refreshToken_1 = require("./handlers/refreshToken"); 
const forgotPassword  = require("./handlers/forgotPassword");
const checkEmail = require("./handlers/checkEmail"); 
const confirmPassword = require("./handlers/confirmPassword");
// Job application handlers
const createJobApplication_1 = require("./handlers/createJobApplication");
const getJobApplications_1 = require("./handlers/getJobApplications");
const getJobApplicationsForClinic_1 = require("./handlers/getJobApplicationsForClinic");
const updateJobApplication_1 = require("./handlers/updateJobApplication");
const deleteJobApplication_1 = require("./handlers/deleteJobApplication");
const browseJobPostings_1 = require("./handlers/browseJobPostings"); 
// Referral system
const sendReferralInvite_1 = require("./handlers/sendReferralInvite");
// File management handlers
const generatePresignedUrl_1 = require("./handlers/generatePresignedUrl");
const getFileUrl_1 = require("./handlers/getFileUrl");
const deleteFile_1 = require("./handlers/deleteFile");
const updateFile_1=require("./handlers/updatefile");

// Job CRUD handlers
const getJobPosting_1 = require("./handlers/getJobPosting");
const updateJobPosting_1 = require("./handlers/updateJobPosting");
const deleteJobPosting_1 = require("./handlers/deleteJobPosting");
// Specific job type CRUD handlers
const getTemporaryJob_1 = require("./handlers/getTemporaryJob");
const getAllTemporaryJobs_1 = require("./handlers/getAllTemporaryJobs"); 

const updateTemporaryJob_1 = require("./handlers/updateTemporaryJob");
const deleteTemporaryJob_1 = require("./handlers/deleteTemporaryJob");
const getMultiDayConsulting_1 = require("./handlers/getMultiDayConsulting");
const updateMultiDayConsulting_1 = require("./handlers/updateMultiDayConsulting");
const deleteMultiDayConsulting_1 = require("./handlers/deleteMultiDayConsulting");
const getPermanentJob_1 = require("./handlers/getPermanentJob");
const getAllMultidayForClinic_1=require("./handlers/getAllMultidayForClinic");
const getAllPermanentJobsForClinic_1=require("./handlers/getAllPermanentJobsForClinic");
const getAllMultiDayConsulting_1 = require("./handlers/getAllMultiDayConsulting");
const getAllPermanentJobs_1 = require("./handlers/getAllPermanentJobs");
const getAllMultidayJobs_1 = require("./handlers/getAllMultidayJobs");
const updatePermanentJob_1 = require("./handlers/updatePermanentJob");
const deletePermanentJob_1 = require("./handlers/deletePermanentJob"); 
const hireProf = require("./handlers/acceptProf"); 
const rejectProf = require("./handlers/rejectProf");
const getAllProfessionals_1=require("./handlers/getAllProfessionals");
const getJobApplicantsOfAClinic = require("./handlers/getJobApplicantsOfAClinic");
const submitFeedback=require("./handlers/submitFeedback");
//public routes
const updateCompletedShifts = require("./handlers/updateCompletedShifts");
const publicProfessionals_1=require("./handlers/publicProfessionals"); 
const publicClinics_1=require("./handlers/findJobs");
const getUsersClinics = require("./handlers/getUsersClinics"); 
const getScheduledShifts_1 = require("./handlers/getScheduledShifts"); 
const getCompletedShifts = require("./handlers/getCompletedShifts");
const getClinicUsers = require("./handlers/getClinicUsers");
const getPublicProfessionalProfile = require("./handlers/getPublicProfessionalProfile");
const getClinicAddress = require("./handlers/getClinicAddress");

const updateClinicProfileDetailsPage=require("./handlers/updateClinicProfileDetails");

// RESTful routing based on resource path and HTTP method
const getRouteHandler = (resource, httpMethod) => {
    const routeKey = `${httpMethod}:${resource}`;
    const routes = {
        // User management routes
        "POST:/users": createUser_1.handler,
        "GET:/users": getUser_1.handler,
        "GET:/clinics/{clinicId}/users": getClinicUsers.handler,
        "PUT:/users/{userId}": updateUser_1.handler,
        "DELETE:/users/{userId}": deleteUser_1.handler,
        "DELETE:/users/me": deleteOwnAccount_1.handler,
        // Clinic management routes
        "POST:/clinics": createClinic_1.handler,
        "GET:/clinics-user":getUsersClinics.handler,
        "GET:/clinics": getAllClinics_1.handler,
        "GET:/clinics/{clinicId}": getClinic_1.handler,
        "PUT:/clinics/{clinicId}": updateClinic_1.handler,
        "DELETE:/clinics/{clinicId}": deleteClinic_1.handler,
        // Assignment management routes
        "POST:/assignments": createAssignment_1.handler,
        "GET:/assignments": getAssignments_1.handler,
        "PUT:/assignments": updateAssignment_1.handler,
        "DELETE:/assignments": deleteAssignment_1.handler,
        // Job postings routes (for clinics to manage their postings)
        "GET:/job-postings": getJobPostings_1.handler,
        // Job browsing routes (for professionals to find jobs)
        "GET:/jobs/browse": browseJobPostings_1.handler,
        // Job application routes (for professionals)
        "POST:/applications": createJobApplication_1.handler,
       // "POST:/applications/{jobId}":createApplication_JobProf.handler,
        "GET:/applications": getJobApplications_1.handler,
        "PUT:/applications/{applicationId}": updateJobApplication_1.handler,
        "DELETE:/applications/{applicationId}": deleteJobApplication_1.handler,
        // Professional profiles routes
        "POST:/profiles": createProfessionalProfile_1.handler,
        "GET:/profiles": getProfessionalProfile_1.handler,
        "PUT:/profiles": updateProfessionalProfile_1.handler,
        "DELETE:/profiles": deleteProfessionalProfile_1.handler,
        // Professional profile questions routes
        "GET:/profiles/questions": getProfessionalQuestions_1.handler,
        // Clinic profiles routes
        "POST:/clinic-profiles": createClinicProfile_1.handler,
        "GET:/clinic-profiles": getClinicProfile_1.handler,
        "GET:/clinic-profile/{clinicId}" : getClinicProfileDetails.handler,
        // "GET:/clinic-profiles/{clinicId}": getClinicProfileDetails.handler,
        // "PUT:/clinic-profiles/{clinicId}": updateClinicProfile_1.handler,
        "PUT:/clinic-profiles/{clinicId}":updateClinicProfileDetailsPage.handler,
        "DELETE:/clinic-profiles/{clinicId}": deleteClinicProfile_1.handler,
        // get all professionals
        "GET:/allprofessionals": getAllProfessionals_1.handler, 
        
        // Job postings routes - Generic endpoint
        "POST:/jobs": createJobPosting_1.handler,
        "GET:/jobs/{jobId}": getJobPosting_1.handler,
        "PUT:/jobs/{jobId}": updateJobPosting_1.handler,
        "DELETE:/jobs/{jobId}": deleteJobPosting_1.handler,
        // Job applications for clinics (view applications for their jobs)
        "GET:/clinics/{clinicId}/jobs/": getJobApplicationsForClinic_1.handler, 
        //Job applications for a clinic id of a logged in user 
        "GET:{clinicId}/jobs":getJobApplicantsOfAClinic.handler,
        // Specific job type endpoints - Complete CRUD
        "POST:/jobs/temporary": createTemporaryJob_1.handler,
        "GET:/jobs/temporary/{jobId}": getTemporaryJob_1.handler,
        "PUT:/jobs/temporary/{jobId}": updateTemporaryJob_1.handler, 
        "GET:/jobs/clinictemporary/{clinicId}": getTemporaryJob_Clinic.handler,
        "GET:/jobs/temporary": getAllTemporaryJobs_1.handler,  
        "DELETE:/jobs/temporary/{jobId}": deleteTemporaryJob_1.handler,
        "POST:/jobs/consulting": createMultiDayConsulting_1.handler,
        "GET:/jobs/consulting/{jobId}": getMultiDayConsulting_1.handler,
        "GET:/jobs/consulting": getAllMultiDayConsulting_1.handler,
        "PUT:/jobs/consulting/{jobId}": updateMultiDayConsulting_1.handler,
        "DELETE:/jobs/consulting/{jobId}": deleteMultiDayConsulting_1.handler,
        "POST:/jobs/permanent": createPermanentJob_1.handler,
        "GET:/jobs/permanent/{jobId}": getPermanentJob_1.handler,
        "GET:/jobs/permanent": getAllPermanentJobs_1.handler, 
        "PUT:/jobs/permanent/{jobId}": updatePermanentJob_1.handler,
        "DELETE:/jobs/permanent/{jobId}": deletePermanentJob_1.handler, 
        "GET:/jobs/multiday/{jobId}":getAllMultidayJobs_1.handler,
        "GET:/jobs/multiday/clinic/{clinicId}":getAllMultidayForClinic_1.handler,
        "GET:/jobs/clinicpermanent/{clinicId}":getAllPermanentJobsForClinic_1.handler,
        "GET:/jobs/public":publicClinics_1.handler,
        "GET:/professionals/public":publicProfessionals_1.handler,
        "PUT:/professionals/completedshifts":updateCompletedShifts.handler, 
        "GET:/completed/{clinicId}": getCompletedShifts.handler, 
        "GET:/profiles/{userSub}":getPublicProfessionalProfile.handler,
        // Job status management
        "PUT:/jobs/{jobId}/status": updateJobStatus_1.handler, 
        //Job Acceptance 
        "POST:/jobs/{jobId}/hire":hireProf.handler,
        // Job invitations
        "POST:/jobs/{jobId}/invitations": sendJobInvitations_1.handler,
        "POST:/invitations/{invitationId}/response": respondToInvitation_1.handler,
        "GET:/invitations": getJobInvitations_1.handler,
        "GET:/invitations/{clinicId}": getJobInvitationForClinics_1.handler,
        // Negotiations
        "PUT:/applications/{applicationId}/negotiations/{negotiationId}/response": respondToNegotiation_1.handler,
        "GET:/allnegotiations":getAllNegotiationsProf_1.handler,

        // add these two:
"GET:/negotiations": getAllNegotiationsProf_1.handler,          // non-stage path
"GET:/prod/negotiations": getAllNegotiationsProf_1.handler,
"POST:/submitfeedback":submitFeedback.handler,
        // --- Stage-prefixed duplicates (for API Gateway stage = prod) ---
  "GET:/prod/allnegotiations": getAllNegotiationsProf_1.handler,
  "PUT:/prod/applications/{applicationId}/negotiations/{negotiationId}/response": respondToNegotiation_1.handler,
        // Clinic favorites
        "POST:/clinics/favorites": addClinicFavorite_1.handler,
        "GET:/clinics/favorites": getClinicFavorites_1.handler,
        "DELETE:/clinics/favorites/{professionalUserSub}": removeClinicFavorite_1.handler, 
        //reject a professional  
        "POST:{clinicId}/reject/{jobId}": rejectProf.handler, 
        //scheduled shifts of a clinic 
        "GET:/scheduled/{clinicId}":getScheduledShifts_1.handler,
        // Authentication routes
        "POST:/auth/login": loginUser_1.handler,
        "POST:/auth/refresh": refreshToken_1.handler, 
        "POST:/auth/forgot": forgotPassword.handler,
        "POST:/auth/check-email": checkEmail.handler, 
        "POST:/auth/confirm-forgot-password":confirmPassword.handler,
        // OTP verification and user registration
        "POST:/auth/initiate-registration": initiateUserRegistration_1.handler,
        "POST:/auth/verify-otp": verifyOTPAndCreateUser_1.handler,
        // Referral system
        "POST:/referrals/invite": sendReferralInvite_1.handler,
        // File management routes
        "POST:/files/presigned-urls": generatePresignedUrl_1.handler,
        "GET:/files/profile-images": getFileUrl_1.handler,
        "GET:/files/certificates": getFileUrl_1.handler,
        "GET:/files/video-resumes": getFileUrl_1.handler,
        "PUT:/files/profile-images": updateFile_1.handler,//
        "PUT /files/profile-image": updateFile_1.handler,
        "PUT:/files/certificates": updateFile_1.handler,
        "PUT:/files/video-resumes": updateFile_1.handler,//
//         "PUT /files/profile-image": profileImageHandler,
//   "PUT /files/certificates": certificateHandler,
//   "PUT /files/video-resumes": videoResumeHandler,
        "DELETE:/files/profile-images": deleteFile_1.handler,
        "DELETE:/files/certificates": deleteFile_1.handler,
        "DELETE:/files/video-resumes": deleteFile_1.handler,
        // User addresses routes (moved from Cognito to DynamoDB)
        "POST:/user-addresses": createUserAddress_1.handler,
        "GET:/user-addresses": getUserAddresses_1.handler,
        "PUT:/user-addresses": updateUserAddress_1.handler,
        "DELETE:/user-addresses": deleteUserAddress_1.handler,
        //public routes
        "GET:public/publicprofessionals":publicProfessionals_1.handler,
        "GET:public/publicJobs":publicClinics_1.handler,
        "GET:/clinics/{clinicId}/address": getClinicAddress.handler,
    };
    // First try exact match
    if (routes[routeKey]) {
        return routes[routeKey];
    }
    // Then try pattern matching for routes with path parameters
    for (const [pattern, handler] of Object.entries(routes)) {
        if (matchesPattern(routeKey, pattern)) {
            return handler;
        }
    }
    return null;
};
// Helper function to match route patterns with path parameters
const matchesPattern = (actualRoute, patternRoute) => {
    const actualParts = actualRoute.split(':');
    const patternParts = patternRoute.split(':');
    if (actualParts.length !== 2 || patternParts.length !== 2) {
        return false;
    }
    const [actualMethod, actualPath] = actualParts;
    const [patternMethod, patternPath] = patternParts;
    // Method must match exactly
    if (actualMethod !== patternMethod) {
        return false;
    }
    // Split paths into segments
    const actualSegments = actualPath.split('/').filter(s => s);
    const patternSegments = patternPath.split('/').filter(s => s);
    // Must have same number of segments
    if (actualSegments.length !== patternSegments.length) {
        return false;
    }
    // Check each segment
    for (let i = 0; i < patternSegments.length; i++) {
        const patternSegment = patternSegments[i];
        const actualSegment = actualSegments[i];
        // If pattern segment is a parameter (enclosed in {}), it matches any value
        if (patternSegment.startsWith('{') && patternSegment.endsWith('}')) {
            continue;
        }
        // Otherwise, segments must match exactly
        if (patternSegment !== actualSegment) {
            return false;
        }
    }
    return true;
};
const handler = async (event) => {

    console.log("--- START: FULL INCOMING EVENT ---");
    console.log(JSON.stringify(event, null, 2));
    console.log("--- END: FULL INCOMING EVENT ---");

    // --- STEP 2: CHECK THE EVENT SOURCE ---
    if (event.source === 'aws.events') {
        console.log("✅ SUCCESS: EventBridge trigger DETECTED. Routing to shift completion handler.");
        try {
            return await updateCompletedShifts.handler(event);
        } catch (error) {
            console.error("❌ ERROR inside scheduled task (updateCompletedShifts):", error);
            throw error;
        }
    } else {
        console.log("⚠️ WARNING: This was NOT an EventBridge event. Proceeding with API Gateway router logic.");
    }
    // Use event.path for actual request path, not event.resource which contains template
let resource = event.path || event.resource || "";
const httpMethod = event.httpMethod;

console.log(`Processing ${httpMethod} ${resource}`);
console.log(`Event resource: ${event.resource}, Event path: ${event.path}`);

// Normalize a couple of common variants (stage prefix, trailing slash)
const candidates = new Set([resource]);

// add/remove trailing slash variants
if (resource.endsWith("/")) candidates.add(resource.replace(/\/+$/, ""));
else candidates.add(resource + "/");

// add a version without stage prefix
if (resource.startsWith("/prod/")) candidates.add(resource.replace(/^\/prod/, ""));
// add a version with stage prefix
if (!resource.startsWith("/prod/")) candidates.add("/prod" + (resource.startsWith("/") ? "" : "/") + resource);

// Try all candidates against route table
let routeHandler = null;
for (const c of candidates) {
  const key = `${httpMethod}:${c}`;
  console.log("Trying routeKey:", key);
  routeHandler = getRouteHandler(c, httpMethod);
  if (routeHandler) {
    resource = c; // lock in the matched resource for logging
    break;
  }
}

if (!routeHandler) {
  console.warn("No route matched. Tried:", Array.from(candidates));
  return {
    statusCode: 404,
    body: JSON.stringify({
      error: "Endpoint not found",
      resource,
      method: httpMethod,
      // optional: include tried candidates for debugging
      tried: Array.from(candidates),
      // keep your existing list:
      restApiRoutes: [
                    "POST /users", "GET /users", "PUT /users", "DELETE /users", "DELETE /users/me",
                    "POST /user-addresses", "GET /user-addresses", "PUT /user-addresses", "DELETE /user-addresses",
                    "POST /clinics", "GET /clinics", "GET /clinics/{clinicId}", "PUT /clinics/{clinicId}", "DELETE /clinics/{clinicId}",
                    "POST /assignments", "GET /assignments", "PUT /assignments", "DELETE /assignments",
                    "POST /profiles", "GET /profiles", "PUT /profiles", "DELETE /profiles",
                    "GET /profiles/questions",
                    "POST /clinic-profiles", "GET /clinic-profiles", "PUT /clinic-profiles", "DELETE /clinic-profiles/{clinicId}",
                    "POST /jobs", "GET /jobs", "PUT /jobs", "DELETE /jobs", "GET /jobs/{jobId}/applications",
                    "POST /applications/{jobId}",
                    "POST /jobs/temporary", "GET /jobs/temporary/{jobId}", "PUT /jobs/temporary/{jobId}", "DELETE /jobs/temporary/{jobId}",
                    "POST /jobs/consulting", "GET /jobs/consulting/{jobId}", "PUT /jobs/consulting/{jobId}", "DELETE /jobs/consulting/{jobId}",
                    "POST /jobs/permanent", "GET /jobs/permanent/{jobId}", "PUT /jobs/permanent/{jobId}", "DELETE /jobs/permanent/{jobId}",
                    "PUT /jobs/{jobId}/status",
                    "POST /jobs/{jobId}/invitations", "POST /invitations/{invitationId}/response","GET /invitations","GET /invitations/{clinicId}",
                    "PUT /applications/{applicationId}/negotiations/{negotiationId}/response",
                    "POST /clinics/favorites", "GET /clinics/favorites", "DELETE /clinics/favorites/{professionalUserSub}",
                    "POST /auth/login", "POST /auth/refresh", "POST /auth/initiate-registration", "POST /auth/verify-otp",
                    "POST /referrals/invite",
                    "GET /jobs/temporary",
                    "GET /jobs/permanent",
                    "GET /jobs/consulting",
                    "GET /allprofessionals",
                    "GET /allnegotiations",
                    "GET /jobs/browse", "POST /applications", "GET /applications", "PUT /applications/{applicationId}", "DELETE /applications/{applicationId}",
                    "GET /publicprofessionals"
                ],
                webSocketApiRoutes: [
                    "$connect", "$disconnect", "$default",
                    "sendMessage", "sendNotification",
                    "getMessages", "markMessageRead",
                    "getNotifications", "markNotificationRead"
                ],
                note: "Messages and notifications are handled via dedicated WebSocket API Gateway for real-time functionality"
            })
        };
    }
    try {
        return await routeHandler(event);
    }
    catch (error) {
        console.error(`Error processing ${httpMethod} ${resource}:`, error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: `Internal server error: ${error.message}`,
                resource,
                method: httpMethod
            })
        };
    }
};
exports.handler = handler;
