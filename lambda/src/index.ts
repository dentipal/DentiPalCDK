import { APIGatewayProxyEvent, APIGatewayProxyResult, Context, Handler } from 'aws-lambda';
import { extractUserFromBearerToken, checkSessionNotInvalidated, SessionInvalidatedError } from "./handlers/utils";

import { handler as createUserHandler } from "./handlers/createUser";
import { handler as getUserHandler } from "./handlers/getUser";
import { handler as updateUserHandler } from "./handlers/updateUser";
import { handler as deleteUserHandler } from "./handlers/deleteUser";
import { handler as deleteOwnAccountHandler } from "./handlers/deleteOwnAccount";
import { handler as getClinicUsersHandler } from "./handlers/getClinicUsers";
import { handler as getUsersClinicsHandler } from "./handlers/getUsersClinics";
import { handler as getAllClinicsShiftsHandler } from "./handlers/getAllClinicsShifts";
import { handler as getClinicShiftsHandler } from "./handlers/getClinicShifts";

import { handler as createClinicHandler } from "./handlers/createClinic";
import { handler as getAllClinicsHandler } from "./handlers/getAllClinics";
import { handler as getClinicHandler } from "./handlers/getClinic";
import { handler as updateClinicHandler } from "./handlers/updateClinic";
import { handler as deleteClinicHandler } from "./handlers/deleteClinic";
import { handler as getClinicAddressHandler } from "./handlers/getClinicAddress";

import { handler as createAssignmentHandler } from "./handlers/createAssignment";
import { handler as getAssignmentsHandler } from "./handlers/getAssignments";
import { handler as updateAssignmentHandler } from "./handlers/updateAssignment";
import { handler as deleteAssignmentHandler } from "./handlers/deleteAssignment";

import { handler as createProfessionalProfileHandler } from "./handlers/createProfessionalProfile";
import { handler as getProfessionalProfileHandler } from "./handlers/getProfessionalProfile";
import { handler as updateProfessionalProfileHandler } from "./handlers/updateProfessionalProfile";
import { handler as deleteProfessionalProfileHandler } from "./handlers/deleteProfessionalProfile";
import { handler as deleteProfessionalAccountHandler } from "./handlers/backup/deleteProfessionalAccount";
import { handler as requestPasswordChangeHandler } from "./handlers/professional/requestPasswordChange";
import { handler as verifyPasswordOtpHandler } from "./handlers/professional/verifyPasswordOtp";
import { handler as confirmPasswordChangeHandler } from "./handlers/professional/confirmPasswordChange";
import { handler as getProfessionalQuestionsHandler } from "./handlers/getProfessionalQuestions";
import { handler as createClinicProfileHandler } from "./handlers/createClinicProfile";
import { handler as getClinicProfileHandler } from "./handlers/getClinicProfile";
import { handler as getClinicProfileDetailsHandler } from './handlers/getClinicProfileDetails';
import { handler as updateClinicProfileDetailsPageHandler } from "./handlers/updateClinicProfileDetails";
import { handler as deleteClinicProfileHandler } from "./handlers/deleteClinicProfile";
import { handler as getAllProfessionalsHandler } from "./handlers/getAllProfessionals";
import { handler as getPublicProfessionalProfileHandler } from "./handlers/getPublicProfessionalProfile";

import { handler as createJobPostingHandler } from "./handlers/createJobPosting";
import { handler as getJobPostingsHandler } from "./handlers/getJobPostings";
import { handler as browseJobPostingsHandler } from "./handlers/browseJobPostings";
import { handler as getJobPostingHandler } from "./handlers/getJobPosting";
import { handler as updateJobPostingHandler } from "./handlers/updateJobPosting";
import { handler as deleteJobPostingHandler } from "./handlers/deleteJobPosting";

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

// Shift confirmation & no-show — clinic-driven post-shift attestation.
import { handler as confirmShiftCompletionHandler } from "./handlers/confirmShiftCompletion";
import { handler as reportNoShowHandler } from "./handlers/reportNoShow";
import { handler as listNoShowReportsHandler } from "./handlers/listNoShowReports";
import { handler as reviewNoShowReportHandler } from "./handlers/reviewNoShowReport";

// updateCompletedShifts.ts is deprecated — kept on disk for one release as rollback safety,
// but no longer wired into the router or the scheduled-task path.
import { handler as getScheduledShiftsHandler } from "./handlers/getScheduledShifts";
import { handler as getCompletedShiftsHandler } from "./handlers/getCompletedShifts";
import { handler as submitFeedbackHandler } from "./handlers/submitFeedback";

import { handler as createUserAddressHandler } from "./handlers/createUserAddress";
import { handler as getUserAddressesHandler } from "./handlers/getUserAddresses";
import { handler as updateUserAddressHandler } from "./handlers/updateUserAddress";
import { handler as deleteUserAddressHandler } from "./handlers/deleteUserAddress";

import { handler as addClinicFavoriteHandler } from "./handlers/addClinicFavorite";
import { handler as getClinicFavoritesHandler } from "./handlers/getClinicFavorites";
import { handler as removeClinicFavoriteHandler } from "./handlers/removeClinicFavorite";
import { handler as getWorkedProfessionalsHandler } from "./handlers/getWorkedProfessionals";

import { handler as initiateUserRegistrationHandler } from "./handlers/initiateUserRegistration";
import { handler as verifyOTPAndCreateUserHandler } from "./handlers/verifyOTPAndCreateUser";
import { handler as resendOtpHandler } from "./handlers/resendOtp";
import { handler as loginUserHandler } from "./handlers/loginUser";
import { handler as refreshTokenHandler } from "./handlers/refreshToken";
import { handler as forgotPasswordHandler } from "./handlers/forgotPassword";
import { handler as checkEmailHandler } from "./handlers/checkEmail";
import { handler as confirmPasswordHandler } from "./handlers/confirmPassword";
import { handler as googleLoginHandler } from "./handlers/googleLogin";

import { handler as sendReferralInviteHandler } from "./handlers/sendReferralInvite";

import { handler as generatePresignedUrlHandler } from "./handlers/generatePresignedUrl";
import { handler as getClinicOfficeImagesHandler } from "./handlers/getClinicOfficeImages";
import { handler as getUserMeHandler } from "./handlers/getUserMe";

import { handler as getActionNeededHandler } from "./handlers/getActionNeeded";
import {
    handler as getFileUrlHandler,
    getProfileImage,
    getProfessionalResume,
    getProfessionalLicense,
    getDrivingLicense,
    getVideoResume,
} from "./handlers/getFileUrl";
import { handler as deleteFileHandler } from "./handlers/deleteFile";
// Ensure this file is saved in lambda/handlers/updateFile.ts
import {
    handler as updateFileHandler,
    updateProfileImage,
    updateProfessionalResume,
    updateProfessionalLicense,
    updateDrivingLicense,
    updateVideoResume,
} from "./handlers/updateFile";


import { handler as publicProfessionalsHandler } from "./handlers/publicProfessionals";
import { handler as publicClinicsHandler } from "./handlers/findJobs";
import { handler as getProfessionalFilteredJobsHandler } from "./handlers/getProfessionalFilteredJobs";

// Geocoding (AWS Location Service)
import { handler as geocodePostalHandler } from "./handlers/geocodePostal";

// Job Promotions
import { handler as getPromotionPlansHandler } from "./handlers/getPromotionPlans";
import { handler as createPromotionHandler } from "./handlers/createPromotion";
import { handler as getPromotionsHandler } from "./handlers/getPromotions";
import { handler as getPromotionHandler } from "./handlers/getPromotion";
import { handler as cancelPromotionHandler } from "./handlers/cancelPromotion";
import { handler as activatePromotionHandler } from "./handlers/activatePromotion";
import { handler as trackPromotionClickHandler } from "./handlers/trackPromotionClick";

// Internal admin portal — bootstrap public auth + team management.
import { handler as bootstrapStatusHandler } from "./handlers/admin/bootstrapStatus";
import { handler as bootstrapAdminHandler } from "./handlers/admin/bootstrapAdmin";
import { handler as verifyAdminBootstrapHandler } from "./handlers/admin/verifyAdminBootstrap";
import { handler as resendAdminBootstrapOtpHandler } from "./handlers/admin/resendAdminBootstrapOtp";
import { handler as inviteTeamMemberHandler } from "./handlers/admin/inviteTeamMember";
import { handler as listTeamHandler } from "./handlers/admin/listTeam";
import { handler as removeTeamMemberHandler } from "./handlers/admin/removeTeamMember";

// Internal admin portal — leads (sales pipeline).
import { handler as createLeadHandler } from "./handlers/admin/createLead";
import { handler as listLeadsHandler } from "./handlers/admin/listLeads";
import { handler as getLeadHandler } from "./handlers/admin/getLead";
import { handler as updateLeadHandler } from "./handlers/admin/updateLead";
import { handler as updateLeadStatusHandler } from "./handlers/admin/updateLeadStatus";
import { handler as deleteLeadHandler } from "./handlers/admin/deleteLead";
import { handler as listLeadActivityHandler } from "./handlers/admin/listLeadActivity";
import { handler as addLeadActivityHandler } from "./handlers/admin/addLeadActivity";
import { handler as bulkUploadLeadsHandler } from "./handlers/admin/bulkUploadLeads";

// Internal admin portal — user directory (professionals + clinics) and bans.
import { handler as listAdminProfessionalsHandler } from "./handlers/admin/listAdminProfessionals";
import { handler as listAdminClinicsHandler } from "./handlers/admin/listAdminClinics";
import { handler as banSubjectHandler } from "./handlers/admin/banSubject";
import { handler as unbanSubjectHandler } from "./handlers/admin/unbanSubject";

// Shared auth — completes the NEW_PASSWORD_REQUIRED challenge that loginUser
// forwards on first login for invited users (clinic team + internal team).
import { handler as respondToNewPasswordHandler } from "./handlers/respondToNewPassword";

// Notification preferences (smart-notifications feature).
import { handler as getNotificationPreferencesHandler } from "./handlers/getNotificationPreferences";
import { handler as updateNotificationPreferencesHandler } from "./handlers/updateNotificationPreferences";

// In-app notification feed (bell icon / notifications page).
import { handler as listNotificationsHandler } from "./handlers/listNotifications";
import { handler as markNotificationsReadHandler } from "./handlers/markNotificationsRead";
import { handler as deleteNotificationsHandler } from "./handlers/deleteNotifications";

import { corsHeaders } from "./handlers/corsHeaders";

// Inline handler — the frontend calls GET /jobs/user-clinics from useHeaderData,
// but the backend has no implementation. Without an explicit route, the request
// pattern-matched /jobs/{jobId} and crashed inside getJobPostingHandler with
// "user-clinics" as a fake jobId, returning 500. Returning a clean 404 here
// preserves frontend behavior (it already treats any !res.ok as failure and
// uses fallback data) while eliminating the CloudWatch 500 noise.
const userClinicsJobsNotImplemented = async (event: any) => ({
    statusCode: 404,
    headers: corsHeaders(event),
    body: JSON.stringify({
        error: "Not Found",
        message: "Endpoint /jobs/user-clinics is not implemented",
    }),
});

// --- TYPE DEFINITIONS ---

// FIX: Use 'any' for RouteHandler to prevent TypeScript errors when mixing
// handlers with different signatures (V1 vs V2, varying argument counts).
// This acts as a flexible container for all imported handlers.
type RouteHandler = any;

interface Routes {
    [key: string]: RouteHandler;
}

// RESTful routing based on resource path and HTTP method
const getRouteHandler = (resource: string, httpMethod: string): RouteHandler | null => {
    const routeKey = `${httpMethod}:${resource}`;

    const routes: Routes = {
        // User management routes
        "POST:/users": createUserHandler,
        "GET:/users/me": getUserMeHandler,
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
        "GET:/assignments/{userSub}": getAssignmentsHandler,
        "PUT:/assignments": updateAssignmentHandler,
        "DELETE:/assignments": deleteAssignmentHandler,

        // Job postings routes
        "GET:/job-postings": getJobPostingsHandler,
        "GET:/jobs/browse": browseJobPostingsHandler,

        // Job application routes
        "POST:/applications": createJobApplicationHandler,
        "GET:/applications": getJobApplicationsHandler,
        "PUT:/applications/{applicationId}": updateJobApplicationHandler,
        "DELETE:/applications/{applicationId}": deleteJobApplicationHandler,

        // Professional profiles routes
        "POST:/profiles": createProfessionalProfileHandler,
        "GET:/profiles": getProfessionalProfileHandler,
        "PUT:/profiles": updateProfessionalProfileHandler,
        "DELETE:/profiles": deleteProfessionalProfileHandler,
        "DELETE:/professionals/me/account": deleteProfessionalAccountHandler,
        "POST:/professionals/me/password/request": requestPasswordChangeHandler,
        "POST:/professionals/me/password/verify": verifyPasswordOtpHandler,
        "POST:/professionals/me/password/confirm": confirmPasswordChangeHandler,
        "GET:/profiles/questions": getProfessionalQuestionsHandler,
        "GET:/profiles/{userSub}": getPublicProfessionalProfileHandler,

        // Clinic profiles routes
        "POST:/clinic-profiles": createClinicProfileHandler,
        "GET:/clinic-profiles": getClinicProfileHandler,
        "GET:/clinic-profile/{clinicId}": getClinicProfileDetailsHandler,
        "PUT:/clinic-profiles/{clinicId}": updateClinicProfileDetailsPageHandler,
        "DELETE:/clinic-profiles/{clinicId}": deleteClinicProfileHandler,

        // --- ALL CLINICS DASHBOARD ROUTES ---
        "GET:/dashboard/all/open-shifts": getAllClinicsShiftsHandler,
        "GET:/dashboard/all/action-needed": getAllClinicsShiftsHandler,
        "GET:/dashboard/all/scheduled-shifts": getAllClinicsShiftsHandler,
        "GET:/dashboard/all/completed-shifts": getAllClinicsShiftsHandler,
        "GET:/dashboard/all/invites-shifts": getAllClinicsShiftsHandler,

        // --- SPECIFIC CLINIC DASHBOARD ROUTES ---
        "GET:/clinics/{clinicId}/open-shifts": getClinicShiftsHandler,
        "GET:/clinics/{clinicId}/action-needed": getClinicShiftsHandler,
        "GET:/clinics/{clinicId}/scheduled-shifts": getClinicShiftsHandler,
        "GET:/clinics/{clinicId}/completed-shifts": getClinicShiftsHandler,
        "GET:/clinics/{clinicId}/invites-shifts": getClinicShiftsHandler,
        "GET:/clinics/{clinicId}/worked-professionals": getWorkedProfessionalsHandler,


        // Get all professionals
        "GET:/allprofessionals": getAllProfessionalsHandler,

        // Job postings routes - Generic endpoint
        "POST:/jobs": createJobPostingHandler,
        // Reserve "/jobs/user-clinics" as an exact match BEFORE the {jobId}
        // pattern so it doesn't accidentally route to getJobPostingHandler
        // with "user-clinics" as a fake jobId (which previously caused 500s).
        "GET:/jobs/user-clinics": userClinicsJobsNotImplemented,
        "GET:/jobs/{jobId}": getJobPostingHandler,
        "PUT:/jobs/{jobId}": updateJobPostingHandler,
        "DELETE:/jobs/{jobId}": deleteJobPostingHandler,

        // Job applications for clinics
        "GET:/clinics/{clinicId}/jobs": getJobApplicationsForClinicHandler,
        "GET:/{clinicId}/jobs": getJobApplicantsOfAClinicHandler,

        // Specific job type endpoints
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


        // Action needed/pending applications
        "GET:/action-needed": getActionNeededHandler,

        // Professional job filtering by role
        "GET:/professionals/filtered-jobs": getProfessionalFilteredJobsHandler,


        "POST:/jobs/permanent": createPermanentJobHandler,
        "GET:/jobs/permanent/{jobId}": getPermanentJobHandler,
        "GET:/jobs/permanent": getAllPermanentJobsHandler,
        "PUT:/jobs/permanent/{jobId}": updatePermanentJobHandler,
        "DELETE:/jobs/permanent/{jobId}": deletePermanentJobHandler,

        "GET:/jobs/multiday/{jobId}": getAllMultidayJobsHandler,
        "GET:/jobs/multiday/clinic/{clinicId}": getAllMultidayForClinicHandler,
        "GET:/jobs/clinicpermanent/{clinicId}": getAllPermanentJobsForClinicHandler,

        // Public Job/Professional browsing
        "GET:/jobs/public": publicClinicsHandler,
        "GET:/professionals/public": publicProfessionalsHandler,

        // Shift Management
        // PUT:/professionals/completedshifts removed: time-based auto-completion is
        // deprecated in favor of clinic-driven /jobs/{jobId}/confirm-completion below.
        "GET:/completed/{clinicId}": getCompletedShiftsHandler,
        "GET:/scheduled/{clinicId}": getScheduledShiftsHandler,

        // Shift confirmation (clinic-driven post-shift attestation).
        "POST:/jobs/{jobId}/confirm-completion": confirmShiftCompletionHandler,
        "POST:/jobs/{jobId}/no-show": reportNoShowHandler,

        // Admin no-show review queue.
        "GET:/admin/no-show-reports": listNoShowReportsHandler,
        "PATCH:/admin/no-show-reports/{jobId}/{professionalUserSub}": reviewNoShowReportHandler,

        // Job status management & Hiring
        "PUT:/jobs/{jobId}/status": updateJobStatusHandler,
        "POST:/jobs/{jobId}/hire": hireProfHandler,
        "POST:/{clinicId}/reject/{jobId}": rejectProfHandler,
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
        "POST:/auth/google-login": googleLoginHandler,

        // OTP verification and user registration
        "POST:/auth/initiate-registration": initiateUserRegistrationHandler,
        "POST:/auth/verify-otp": verifyOTPAndCreateUserHandler,
        "POST:/auth/resend-otp": resendOtpHandler,
        "POST:/auth/respond-new-password": respondToNewPasswordHandler,

        // Referral system
        "POST:/referrals/invite": sendReferralInviteHandler,

        // File management routes
        "POST:/files/presigned-urls": generatePresignedUrlHandler,
        // Dedicated endpoints per file type
        "GET:/files/profile-images": getProfileImage,
        "GET:/files/professional-resumes": getProfessionalResume,
        "GET:/files/professional-licenses": getProfessionalLicense,
        "GET:/files/driving-licenses": getDrivingLicense,
        "GET:/files/video-resumes": getVideoResume,
        "GET:/files/clinic-office-images": getClinicOfficeImagesHandler,
        // Backwards-compatible legacy route
        // "GET:/files/certificates": getFileUrlHandler,
        // "PUT:/files/profile-images": updateProfileImage,
        "PUT:/files/profile-image": updateProfileImage,
        "PUT:/files/professional-resumes": updateProfessionalResume,
        "PUT:/files/professional-licenses": updateProfessionalLicense,
        "PUT:/files/driving-licenses": updateDrivingLicense,
        "PUT:/files/video-resumes": updateVideoResume,
        "DELETE:/files/profile-images": deleteFileHandler,
        "DELETE:/files/certificates": deleteFileHandler,
        "DELETE:/files/video-resumes": deleteFileHandler,

        // Geocoding (AWS Location Service) — postal-code lookup used by the
        // Create Professional Profile form for address auto-fill.
        "GET:/location/lookup": geocodePostalHandler,

        // User addresses routes
        "POST:/user-addresses": createUserAddressHandler,
        "GET:/user-addresses": getUserAddressesHandler,
        "PUT:/user-addresses": updateUserAddressHandler,
        "DELETE:/user-addresses": deleteUserAddressHandler,

        // Public routes (Duplicates for explicit public path)
        "GET:/public/publicprofessionals": publicProfessionalsHandler,
        "GET:/public/publicJobs": publicClinicsHandler,
        "GET:/clinics/{clinicId}/address": getClinicAddressHandler,

        // Geocoding — postal code → city/state (Amazon Location Service)
        "GET:/geocode/postal": geocodePostalHandler,

        // ----------------- INTERNAL ADMIN PORTAL -----------------
        // Bootstrap routes are PUBLIC. bootstrap-admin is single-shot — it
        // refuses once any user is in the "Admin" group. All other /admin/*
        // routes (added in later phases) gate on internal Cognito groups
        // inside the handler via requireInternalGroup().
        "GET:/admin/auth/bootstrap-status": bootstrapStatusHandler,
        "POST:/admin/auth/bootstrap-admin": bootstrapAdminHandler,
        "POST:/admin/auth/verify-bootstrap-otp": verifyAdminBootstrapHandler,
        "POST:/admin/auth/resend-bootstrap-otp": resendAdminBootstrapOtpHandler,

        // Team management — Admin role only.
        "GET:/admin/team": listTeamHandler,
        "POST:/admin/team": inviteTeamMemberHandler,
        "DELETE:/admin/team/{userSub}": removeTeamMemberHandler,

        // Leads (sales pipeline). Each handler enforces role gates internally.
        "GET:/admin/leads": listLeadsHandler,
        "POST:/admin/leads": createLeadHandler,
        "POST:/admin/leads/bulk": bulkUploadLeadsHandler,
        "GET:/admin/leads/{leadId}": getLeadHandler,
        "PATCH:/admin/leads/{leadId}": updateLeadHandler,
        "PATCH:/admin/leads/{leadId}/status": updateLeadStatusHandler,
        "DELETE:/admin/leads/{leadId}": deleteLeadHandler,
        "GET:/admin/leads/{leadId}/activity": listLeadActivityHandler,
        "POST:/admin/leads/{leadId}/activity": addLeadActivityHandler,

        // User directory + bans (Admin role only — enforced in each handler).
        "GET:/admin/professionals": listAdminProfessionalsHandler,
        "GET:/admin/clinics": listAdminClinicsHandler,
        "POST:/admin/bans": banSubjectHandler,
        "DELETE:/admin/bans/{subjectType}/{subjectId}": unbanSubjectHandler,

        // Job Promotions
        "GET:/promotions/plans": getPromotionPlansHandler,
        "POST:/promotions": createPromotionHandler,
        "GET:/promotions": getPromotionsHandler,
        "GET:/promotions/{promotionId}": getPromotionHandler,
        "PUT:/promotions/{promotionId}/cancel": cancelPromotionHandler,
        "PUT:/promotions/{promotionId}/activate": activatePromotionHandler,
        "POST:/promotions/track-click": trackPromotionClickHandler,

        // Notification preferences
        "GET:/notifications/preferences": getNotificationPreferencesHandler,
        "PUT:/notifications/preferences": updateNotificationPreferencesHandler,

        // In-app notification feed
        "GET:/notifications": listNotificationsHandler,
        "POST:/notifications/read": markNotificationsReadHandler,
        "POST:/notifications/delete": deleteNotificationsHandler,

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
export const handler: Handler<APIGatewayProxyEvent | any, APIGatewayProxyResult> = async (event: APIGatewayProxyEvent | any, context: Context): Promise<APIGatewayProxyResult> => {

    const logMethod = event.httpMethod || event.requestContext?.http?.method || "";
    const logPath = event.path || event.rawPath || event.resource || "";
    console.log(`[Router] ${logMethod} ${logPath}`);

    // --- STEP 1: EventBridge Scheduled Task Check ---
    // Deprecated: time-based auto-completion has been replaced by clinic-driven
    // post-shift confirmation (see confirmShiftCompletion / reportNoShow handlers).
    // We swallow any lingering EventBridge schedule firings as a no-op so the
    // monolith doesn't auto-flip 'scheduled' -> 'completed' anymore.
    if (event.source === 'aws.events') {
        console.log("[deprecated] aws.events tick received; updateCompletedShifts is disabled — no-op.");
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'noop', reason: 'updateCompletedShifts deprecated' }),
        };
    }

    // --- STEP 2: API Gateway Routing Logic ---
    let resource = event.path || event.rawPath || event.resource || "";
    const httpMethod = event.httpMethod || event.requestContext?.http?.method || "";

    console.log(`Processing ${httpMethod} ${resource}`);

    // Normalize and generate path candidates
    const candidates = new Set<string>([resource]);

    if (resource.endsWith("/")) candidates.add(resource.replace(/\/+$/, ""));
    else candidates.add(resource + "/");

    if (resource.startsWith("/prod/")) candidates.add(resource.replace(/^\/prod/, ""));
    if (!resource.startsWith("/prod/") && resource.startsWith("/")) candidates.add("/prod" + resource);
    if (!resource.startsWith("/") && resource.length > 0) candidates.add("/" + resource);


    // Try all candidates against route table
    let routeHandler: RouteHandler | null = null;
    let matchedResource: string = resource;

    for (const c of candidates) {
        const key = `${httpMethod}:${c}`;
        console.log("Trying routeKey:", key);
        routeHandler = getRouteHandler(c, httpMethod);
        if (routeHandler) {
            matchedResource = c;
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
                tried: Array.from(candidates)
            })
        };
    }

    // --- STEP 3.5: Session-invalidation denylist check ---
    // If the user's password was changed (or session otherwise force-revoked)
    // AFTER this access token was issued, reject the request with 401 so the
    // frontend redirects to login. We skip the check for unauthenticated /
    // OPTIONS / auth-flow routes — those don't carry a JWT yet.
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (authHeader && httpMethod !== "OPTIONS") {
        try {
            const userInfo = extractUserFromBearerToken(authHeader);
            await checkSessionNotInvalidated(userInfo);
        } catch (err: any) {
            if (err instanceof SessionInvalidatedError) {
                return {
                    statusCode: 401,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        error: "Unauthorized",
                        code: "SESSION_INVALIDATED",
                        message: "Your session is no longer valid. Please sign in again.",
                    }),
                };
            }
            // Any other JWT-decode error: let the downstream handler do
            // its own auth check / return its own error. We don't want
            // to short-circuit unauthenticated public endpoints.
        }
    }

    // --- STEP 4: Execute Handler ---
    try {
        console.log(`✅ SUCCESS: Routing to handler for ${httpMethod}:${matchedResource}`);
        console.log(`🎯 Handler type: ${routeHandler.name || 'anonymous'}`);
        console.log(`🎯 Calling handler with event path: ${event.path}`);
        // Call the handler. Since RouteHandler is 'any', this bypasses strict TS checks.
        // We pass 'context' as well, which is standard for Lambda handlers.
        const result = await routeHandler(event, context);
        console.log(`✅ Handler completed successfully. Status: ${result.statusCode}`);
        return result;
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

export { getRouteHandler, matchesPattern };