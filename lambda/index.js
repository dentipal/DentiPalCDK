// index.ts

import { APIGatewayProxyEvent, APIGatewayProxyResult, Context, Handler } from 'aws-lambda';

// --- HANDLER IMPORTS ---
// NOTE: In a real project, you would ensure these imported files are also TypeScript (.ts)
// and have correct handler signatures (e.g., const handler: Handler<APIGatewayProxyEvent, APIGatewayProxyResult> = async (event) => {...})

// User Management
import { handler as createUserHandler } from "./handlers/createUser";
import { handler as getUserHandler } from "./handlers/getUser";
import { handler as updateUserHandler } from "./handlers/updateUser";
import { handler as deleteUserHandler } from "./handlers/deleteUser";
import { handler as deleteOwnAccountHandler } from "./handlers/deleteOwnAccount";
import { handler as getClinicUsersHandler } from "./handlers/getClinicUsers";
import { handler as getUsersClinicsHandler } from "./handlers/getUsersClinics";

// Clinic Management
import { handler as createClinicHandler } from "./handlers/createClinic";
import { handler as getAllClinicsHandler } from "./handlers/getAllClinics";
import { handler as getClinicHandler } from "./handlers/getClinic";
import { handler as updateClinicHandler } from "./handlers/updateClinic";
import { handler as deleteClinicHandler } from "./handlers/deleteClinic";
import { handler as getClinicAddressHandler } from "./handlers/getClinicAddress";

// Assignment Management
import { handler as createAssignmentHandler } from "./handlers/createAssignment";
import { handler as getAssignmentsHandler } from "./handlers/getAssignments";
import { handler as updateAssignmentHandler } from "./handlers/updateAssignment";
import { handler as deleteAssignmentHandler } from "./handlers/deleteAssignment";

// Profile Management
import { handler as createProfessionalProfileHandler } from "./handlers/createProfessionalProfile";
import { handler as getProfessionalProfileHandler } from "./handlers/getProfessionalProfile";
import { handler as updateProfessionalProfileHandler } from "./handlers/updateProfessionalProfile";
import { handler as deleteProfessionalProfileHandler } from "./handlers/deleteProfessionalProfile";
import { handler as getProfessionalQuestionsHandler } from "./handlers/getProfessionalQuestions";
import { handler as createClinicProfileHandler } from "./handlers/createClinicProfile";
import { handler as getClinicProfileHandler } from "./handlers/getClinicProfile";
import { handler as getClinicProfileDetailsHandler } from './handlers/getClinicProfileDetails';
import { handler as updateClinicProfileDetailsPageHandler } from "./handlers/updateClinicProfileDetails";
import { handler as deleteClinicProfileHandler } from "./handlers/deleteClinicProfile";
import { handler as getAllProfessionalsHandler } from "./handlers/getAllProfessionals";
import { handler as getPublicProfessionalProfileHandler } from "./handlers/getPublicProfessionalProfile";

// Job Management (Posting/CRUD/Browse)
import { handler as createJobPostingHandler } from "./handlers/createJobPosting";
import { handler as getJobPostingsHandler } from "./handlers/getJobPostings";
import { handler as browseJobPostingsHandler } from "./handlers/browseJobPostings";
import { handler as getJobPostingHandler } from "./handlers/getJobPosting";
import { handler as updateJobPostingHandler } from "./handlers/updateJobPosting";
import { handler as deleteJobPostingHandler } from "./handlers/deleteJobPosting";

// Specific Job Types
import { handler as createTemporaryJobHandler } from "./handlers/createTemporaryJob";
import { handler as getTemporaryJobHandler } from "./handlers/getTemporaryJob";
import { handler as getAllTemporaryJobsHandler } from "./handlers/getAllTemporaryJobs";
import { handler as updateTemporaryJobHandler } from "./handlers/updateTemporaryJob";
import { handler as deleteTemporaryJobHandler } from "./handlers/deleteTemporaryJob";
import { handler as getTemporaryJobClinicHandler } from "./handlers/getTemporary-Clinic";

import { handler as createMultiDayConsultingHandler } from "./handlers/createMultiDayConsulting";
import { handler as getMultiDayConsultingHandler } from "./handlers/getMultiDayConsulting";
import { handler as getAllMultiDayConsultingHandler } from "./handlers/getAllMultiDayConsulting";
import { handler as updateMultiDayConsultingHandler } from "./handlers/updateMultiDayConsulting";
import { handler as deleteMultiDayConsultingHandler } from "./handlers/deleteMultiDayConsulting";
import { handler as getAllMultidayForClinicHandler } from "./handlers/getAllMultidayForClinic";
import { handler as getAllMultidayJobsHandler } from "./handlers/getAllMultidayJobs";

import { handler as createPermanentJobHandler } from "./handlers/createPermanentJob";
import { handler as getPermanentJobHandler } from "./handlers/getPermanentJob";
import { handler as getAllPermanentJobsHandler } from "./handlers/getAllPermanentJobs";
import { handler as updatePermanentJobHandler } from "./handlers/updatePermanentJob";
import { handler as deletePermanentJobHandler } from "./handlers/deletePermanentJob";
import { handler as getAllPermanentJobsForClinicHandler } from "./handlers/getAllPermanentJobsForClinic";

// Job Application, Status, Invitations, Negotiation
import { handler as createJobApplicationHandler } from "./handlers/createJobApplication";
import { handler as getJobApplicationsHandler } from "./handlers/getJobApplications";
import { handler as getJobApplicationsForClinicHandler } from "./handlers/getJobApplicationsForClinic";
import { handler as getJobApplicantsOfAClinicHandler } from "./handlers/getJobApplicantsOfAClinic";
import { handler as updateJobApplicationHandler } from "./handlers/updateJobApplication";
import { handler as deleteJobApplicationHandler } from "./handlers/deleteJobApplication";
import { handler as updateJobStatusHandler } from "./handlers/updateJobStatus";
import { handler as sendJobInvitationsHandler } from "./handlers/sendJobInvitations";
import { handler as respondToInvitationHandler } from "./handlers/respondToInvitation";
import { handler as getJobInvitationsHandler } from "./handlers/getJobInvitations";
import { handler as getJobInvitationForClinicsHandler } from "./handlers/getJobInvitationsForClinics";
import { handler as respondToNegotiationHandler } from "./handlers/respondToNegotiation";
import { handler as getAllNegotiationsProfHandler } from "./handlers/getAllNegotiations-Prof";
import { handler as hireProfHandler } from "./handlers/acceptProf";
import { handler as rejectProfHandler } from "./handlers/rejectProf";

// Job Shifts
import { handler as updateCompletedShiftsHandler } from "./handlers/updateCompletedShifts";
import { handler as getScheduledShiftsHandler } from "./handlers/getScheduledShifts";
import { handler as getCompletedShiftsHandler } from "./handlers/getCompletedShifts";
import { handler as submitFeedbackHandler } from "./handlers/submitFeedback";

// Address Management
import { handler as createUserAddressHandler } from "./handlers/createUserAddress";
import { handler as getUserAddressesHandler } from "./handlers/getUserAddresses";
import { handler as updateUserAddressHandler } from "./handlers/updateUserAddress";
import { handler as deleteUserAddressHandler } from "./handlers/deleteUserAddress";

// Clinic Favorites
import { handler as addClinicFavoriteHandler } from "./handlers/addClinicFavorite";
import { handler as getClinicFavoritesHandler } from "./handlers/getClinicFavorites";
import { handler as removeClinicFavoriteHandler } from "./handlers/removeClinicFavorite";

// Authentication & Registration
import { handler as initiateUserRegistrationHandler } from "./handlers/initiateUserRegistration";
import { handler as verifyOTPAndCreateUserHandler } from "./handlers/verifyOTPAndCreateUser";
import { handler as loginUserHandler } from "./handlers/loginUser";
import { handler as refreshTokenHandler } from "./handlers/refreshToken";
import { handler as forgotPasswordHandler } from "./handlers/forgotPassword";
import { handler as checkEmailHandler } from "./handlers/checkEmail";
import { handler as confirmPasswordHandler } from "./handlers/confirmPassword";

// Referral System
import { handler as sendReferralInviteHandler } from "./handlers/sendReferralInvite";

// File Management
import { handler as generatePresignedUrlHandler } from "./handlers/generatePresignedUrl";
import { handler as getFileUrlHandler } from "./handlers/getFileUrl";
import { handler as deleteFileHandler } from "./handlers/deleteFile";
import { handler as updateFileHandler } from "./handlers/updatefile";

// Public Routes
import { handler as publicProfessionalsHandler } from "./handlers/publicProfessionals";
import { handler as publicClinicsHandler } from "./handlers/findJobs";

// Define the shape of a Route Handler
type RouteHandler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

// Define the structure of the routes object
interface Routes {
    [key: string]: RouteHandler;
}

// RESTful routing based on resource path and HTTP method
const getRouteHandler = (resource: string, httpMethod: string): RouteHandler | null => {
    const routeKey = `${httpMethod}:${resource}`;
    
    // Type assertion to ensure the object structure aligns with the Routes interface
    const routes: Routes = {
        // User management routes
        "POST:/users": createUserHandler,
        "GET:/users": getUserHandler,
        "GET:/clinics/{clinicId}/users": getClinicUsersHandler,
        "PUT:/users/{userId}": updateUserHandler,
        "DELETE:/users/{userId}": deleteUserHandler,
        "DELETE:/users/me": deleteOwnAccountHandler,

        // Clinic management routes
        "POST:/clinics": createClinicHandler,
        "GET:/clinics-user": getUsersClinicsHandler,
        "GET:/clinics": getAllClinicsHandler,
        "GET:/clinics/{clinicId}": getClinicHandler,
        "PUT:/clinics/{clinicId}": updateClinicHandler,
        "DELETE:/clinics/{clinicId}": deleteClinicHandler,

        // Assignment management routes
        "POST:/assignments": createAssignmentHandler,
        "GET:/assignments": getAssignmentsHandler,
        "PUT:/assignments": updateAssignmentHandler,
        "DELETE:/assignments": deleteAssignmentHandler,

        // Job postings routes (for clinics to manage their postings)
        "GET:/job-postings": getJobPostingsHandler,
        // Job browsing routes (for professionals to find jobs)
        "GET:/jobs/browse": browseJobPostingsHandler,

        // Job application routes (for professionals)
        "POST:/applications": createJobApplicationHandler,
        "GET:/applications": getJobApplicationsHandler,
        "PUT:/applications/{applicationId}": updateJobApplicationHandler,
        "DELETE:/applications/{applicationId}": deleteJobApplicationHandler,

        // Professional profiles routes
        "POST:/profiles": createProfessionalProfileHandler,
        "GET:/profiles": getProfessionalProfileHandler,
        "PUT:/profiles": updateProfessionalProfileHandler,
        "DELETE:/profiles": deleteProfessionalProfileHandler,
        // Professional profile questions routes
        "GET:/profiles/questions": getProfessionalQuestionsHandler,
        "GET:/profiles/{userSub}": getPublicProfessionalProfileHandler,

        // Clinic profiles routes
        "POST:/clinic-profiles": createClinicProfileHandler,
        "GET:/clinic-profiles": getClinicProfileHandler,
        "GET:/clinic-profile/{clinicId}": getClinicProfileDetailsHandler,
        "PUT:/clinic-profiles/{clinicId}": updateClinicProfileDetailsPageHandler,
        "DELETE:/clinic-profiles/{clinicId}": deleteClinicProfileHandler,

        // Get all professionals
        "GET:/allprofessionals": getAllProfessionalsHandler,

        // Job postings routes - Generic endpoint
        "POST:/jobs": createJobPostingHandler,
        "GET:/jobs/{jobId}": getJobPostingHandler,
        "PUT:/jobs/{jobId}": updateJobPostingHandler,
        "DELETE:/jobs/{jobId}": deleteJobPostingHandler,

        // Job applications for clinics
        "GET:/clinics/{clinicId}/jobs/": getJobApplicationsForClinicHandler,
        "GET:{clinicId}/jobs": getJobApplicantsOfAClinicHandler, // This route looks malformed, consider fixing in API Gateway

        // Specific job type endpoints - Complete CRUD
        "POST:/jobs/temporary": createTemporaryJobHandler,
        "GET:/jobs/temporary/{jobId}": getTemporaryJobHandler,
        "PUT:/jobs/temporary/{jobId}": updateTemporaryJobHandler,
        "GET:/jobs/clinictemporary/{clinicId}": getTemporaryJobClinicHandler,
        "GET:/jobs/temporary": getAllTemporaryJobsHandler,
        "DELETE:/jobs/temporary/{jobId}": deleteTemporaryJobHandler,

        "POST:/jobs/consulting": createMultiDayConsultingHandler,
        "GET:/jobs/consulting/{jobId}": getMultiDayConsultingHandler,
        "GET:/jobs/consulting": getAllMultiDayConsultingHandler,
        "PUT:/jobs/consulting/{jobId}": updateMultiDayConsultingHandler,
        "DELETE:/jobs/consulting/{jobId}": deleteMultiDayConsultingHandler,

        "POST:/jobs/permanent": createPermanentJobHandler,
        "GET:/jobs/permanent/{jobId}": getPermanentJobHandler,
        "GET:/jobs/permanent": getAllPermanentJobsHandler,
        "PUT:/jobs/permanent/{jobId}": updatePermanentJobHandler,
        "DELETE:/jobs/permanent/{jobId}": deletePermanentJobHandler,

        // Aggregate/Clinic-specific job list endpoints
        "GET:/jobs/multiday/{jobId}": getAllMultidayJobsHandler, // This route parameter looks like it might be unnecessary based on the original JS
        "GET:/jobs/multiday/clinic/{clinicId}": getAllMultidayForClinicHandler,
        "GET:/jobs/clinicpermanent/{clinicId}": getAllPermanentJobsForClinicHandler,

        // Public Job/Professional browsing
        "GET:/jobs/public": publicClinicsHandler, // Corresponds to findJobs.handler
        "GET:/professionals/public": publicProfessionalsHandler,

        // Shift Management
        "PUT:/professionals/completedshifts": updateCompletedShiftsHandler,
        "GET:/completed/{clinicId}": getCompletedShiftsHandler,
        "GET:/scheduled/{clinicId}": getScheduledShiftsHandler,

        // Job status management & Hiring
        "PUT:/jobs/{jobId}/status": updateJobStatusHandler,
        "POST:/jobs/{jobId}/hire": hireProfHandler,
        "POST:{clinicId}/reject/{jobId}": rejectProfHandler, // This route looks malformed, consider fixing in API Gateway
        "POST:/submitfeedback": submitFeedbackHandler,

        // Job invitations
        "POST:/jobs/{jobId}/invitations": sendJobInvitationsHandler,
        "POST:/invitations/{invitationId}/response": respondToInvitationHandler,
        "GET:/invitations": getJobInvitationsHandler,
        "GET:/invitations/{clinicId}": getJobInvitationForClinicsHandler,

        // Negotiations
        "PUT:/applications/{applicationId}/negotiations/{negotiationId}/response": respondToNegotiationHandler,
        "GET:/allnegotiations": getAllNegotiationsProfHandler,
        "GET:/negotiations": getAllNegotiationsProfHandler,

        // Clinic favorites
        "POST:/clinics/favorites": addClinicFavoriteHandler,
        "GET:/clinics/favorites": getClinicFavoritesHandler,
        "DELETE:/clinics/favorites/{professionalUserSub}": removeClinicFavoriteHandler,

        // Authentication routes
        "POST:/auth/login": loginUserHandler,
        "POST:/auth/refresh": refreshTokenHandler,
        "POST:/auth/forgot": forgotPasswordHandler,
        "POST:/auth/check-email": checkEmailHandler,
        "POST:/auth/confirm-forgot-password": confirmPasswordHandler,

        // OTP verification and user registration
        "POST:/auth/initiate-registration": initiateUserRegistrationHandler,
        "POST:/auth/verify-otp": verifyOTPAndCreateUserHandler,

        // Referral system
        "POST:/referrals/invite": sendReferralInviteHandler,

        // File management routes
        "POST:/files/presigned-urls": generatePresignedUrlHandler,
        "GET:/files/profile-images": getFileUrlHandler,
        "GET:/files/certificates": getFileUrlHandler,
        "GET:/files/video-resumes": getFileUrlHandler,
        "PUT:/files/profile-images": updateFileHandler,
        "PUT /files/profile-image": updateFileHandler, // Note: Extra space in method here, though usually handled by API Gateway normalize
        "PUT:/files/certificates": updateFileHandler,
        "PUT:/files/video-resumes": updateFileHandler,
        "DELETE:/files/profile-images": deleteFileHandler,
        "DELETE:/files/certificates": deleteFileHandler,
        "DELETE:/files/video-resumes": deleteFileHandler,

        // User addresses routes
        "POST:/user-addresses": createUserAddressHandler,
        "GET:/user-addresses": getUserAddressesHandler,
        "PUT:/user-addresses": updateUserAddressHandler,
        "DELETE:/user-addresses": deleteUserAddressHandler,

        // Public routes (Duplicates for explicit public path)
        "GET:public/publicprofessionals": publicProfessionalsHandler,
        "GET:public/publicJobs": publicClinicsHandler,
        "GET:/clinics/{clinicId}/address": getClinicAddressHandler,
        
        // --- Stage-prefixed duplicates (for API Gateway stage = prod) ---
        "GET:/prod/negotiations": getAllNegotiationsProfHandler,
        "GET:/prod/allnegotiations": getAllNegotiationsProfHandler,
        "PUT:/prod/applications/{applicationId}/negotiations/{negotiationId}/response": respondToNegotiationHandler,
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
const matchesPattern = (actualRoute: string, patternRoute: string): boolean => {
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

// Main Lambda Handler
export const handler: Handler<APIGatewayProxyEvent | any, APIGatewayProxyResult> = async (event: APIGatewayProxyEvent | any): Promise<APIGatewayProxyResult> => {

    console.log("--- START: FULL INCOMING EVENT ---");
    console.log(JSON.stringify(event, null, 2));
    console.log("--- END: FULL INCOMING EVENT ---");

    // --- STEP 1: EventBridge Scheduled Task Check ---
    if (event.source === 'aws.events') {
        console.log("✅ SUCCESS: EventBridge trigger DETECTED. Routing to shift completion handler.");
        try {
            // Note: updateCompletedShiftsHandler is the imported handler from the module
            return await updateCompletedShiftsHandler(event);
        } catch (error) {
            console.error("❌ ERROR inside scheduled task (updateCompletedShifts):", error);
            // Re-throw the error for AWS Lambda/EventBridge to handle
            throw error;
        }
    } else {
        console.log("⚠️ WARNING: This was NOT an EventBridge event. Proceeding with API Gateway router logic.");
    }

    // --- STEP 2: API Gateway Routing Logic ---
    // Use event.path for actual request path, not event.resource which contains template
    let resource = event.path || event.resource || "";
    const httpMethod = event.httpMethod as string;

    console.log(`Processing ${httpMethod} ${resource}`);
    console.log(`Event resource: ${event.resource}, Event path: ${event.path}`);

    // Normalize and generate path candidates (e.g., /jobs/123, /jobs/123/, /prod/jobs/123)
    const candidates = new Set<string>([resource]);

    // add/remove trailing slash variants
    if (resource.endsWith("/")) candidates.add(resource.replace(/\/+$/, ""));
    else candidates.add(resource + "/");

    // add a version without stage prefix
    if (resource.startsWith("/prod/")) candidates.add(resource.replace(/^\/prod/, ""));
    // add a version with stage prefix
    if (!resource.startsWith("/prod/") && resource.startsWith("/")) candidates.add("/prod" + resource);
    
    // Fallback for paths without leading slash (though API Gateway usually prefixes it)
    if (!resource.startsWith("/") && resource.length > 0) candidates.add("/" + resource);


    // Try all candidates against route table
    let routeHandler: RouteHandler | null = null;
    let matchedResource: string = resource;

    for (const c of candidates) {
        const key = `${httpMethod}:${c}`;
        console.log("Trying routeKey:", key);
        routeHandler = getRouteHandler(c, httpMethod);
        if (routeHandler) {
            matchedResource = c; // lock in the matched resource for logging
            break;
        }
    }

    // --- STEP 3: Handle 404 Not Found ---
    if (!routeHandler) {
        console.warn("No route matched. Tried:", Array.from(candidates));
        return {
            statusCode: 404,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: "Endpoint not found",
                resource: matchedResource,
                method: httpMethod,
                tried: Array.from(candidates),
                restApiRoutes: [
                    "POST /users", "GET /users", "PUT /users/{userId}", "DELETE /users/{userId}", "DELETE /users/me",
                    // ... (Include a comprehensive list of paths for debugging as in the original JS)
                ],
                note: "Messages and notifications are handled via dedicated WebSocket API Gateway for real-time functionality"
            })
        };
    }

    // --- STEP 4: Execute Handler ---
    try {
        console.log(`✅ SUCCESS: Routing to handler for ${httpMethod}:${matchedResource}`);
        return await routeHandler(event as APIGatewayProxyEvent);
    }
    catch (error: any) {
        console.error(`❌ ERROR processing ${httpMethod} ${matchedResource}:`, error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: `Internal server error: ${error.message || 'Unknown error'}`,
                resource: matchedResource,
                method: httpMethod
            })
        };
    }
};

// Exporting handler for AWS Lambda
// Note: The original JS used module.exports = { handler: handler } via commonjs, 
// which TypeScript simplifies with an export statement in an ES module environment.
export { getRouteHandler, matchesPattern }; // Exporting for potential unit testing