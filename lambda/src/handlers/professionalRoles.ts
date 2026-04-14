// Professional Roles Configuration for Cognito Groups
// Each role has an ID that corresponds to Cognito group configuration

export interface ProfessionalRole {
    id: number;
    name: string;
    cognitoGroup: string;
    dbValue: string;
    description: string;
}

export const PROFESSIONAL_ROLES: ProfessionalRole[] = [
    {
        id: 1,
        name: "Associate Dentist",
        cognitoGroup: "AssociateDentist",
        dbValue: "associate_dentist",
        description: "Licensed dentist providing dental care services",
    },
    {
        id: 2,
        name: "Dental Hygienist",
        cognitoGroup: "DentalHygienist",
        dbValue: "dental_hygienist",
        description: "Licensed dental hygienist providing preventive care",
    },
    {
        id: 3,
        name: "Dental Assistant",
        cognitoGroup: "DentalAssistant",
        dbValue: "dental_assistant",
        description: "Dental assistant providing chairside assistance",
    },
    {
        id: 4,
        name: "Expanded Functions DA",
        cognitoGroup: "ExpandedFunctionsDA",
        dbValue: "expanded_functions_da",
        description: "Dental assistant with expanded functions certification",
    },
    {
        id: 5,
        name: "Dual Role (Front and DA)",
        cognitoGroup: "DualRoleFrontDA",
        dbValue: "dual_role_front_da",
        description: "Professional handling both front desk and dental assistant duties",
    },
    {
        id: 6,
        name: "Patient Coordinator (Front)",
        cognitoGroup: "PatientCoordinatorFront",
        dbValue: "patient_coordinator_front",
        description: "Front desk professional focused on patient coordination",
    },
    {
        id: 7,
        name: "Treatment Coordinator (Front)",
        cognitoGroup: "TreatmentCoordinatorFront",
        dbValue: "treatment_coordinator_front",
        description: "Front desk professional focused on treatment coordination",
    },
    {
        id: 8,
        name: "Dentist",
        cognitoGroup: "Dentist",
        dbValue: "dentist",
        description: "Licensed dentist providing comprehensive dental care",
    },
    {
        id: 9,
        name: "Hygienist",
        cognitoGroup: "Hygienist",
        dbValue: "hygienist",
        description: "Licensed hygienist providing preventive and periodontal care",
    },
    {
        id: 10,
        name: "DH + TC + PC",
        cognitoGroup: "DHComboRole",
        dbValue: "dh_tc_pc",
        description: "Dental Hygienist combined with Treatment Coordinator and Patient Coordinator duties",
    },
    {
        id: 11,
        name: "Billing Coordinator",
        cognitoGroup: "BillingCoordinator",
        dbValue: "billing_coordinator",
        description: "Professional managing dental billing and financial coordination",
    },
    {
        id: 12,
        name: "Insurance Verification",
        cognitoGroup: "InsuranceVerification",
        dbValue: "insurance_verification",
        description: "Professional handling insurance eligibility and benefits verification",
    },
    {
        id: 13,
        name: "Payment Posting",
        cognitoGroup: "PaymentPosting",
        dbValue: "payment_posting",
        description: "Professional responsible for posting payments and adjustments",
    },
    {
        id: 14,
        name: "Claims Sending",
        cognitoGroup: "ClaimsSending",
        dbValue: "claims_sending",
        description: "Professional handling submission of insurance claims",
    },
    {
        id: 15,
        name: "Claims Resolution",
        cognitoGroup: "ClaimsResolution",
        dbValue: "claims_resolution",
        description: "Professional managing denied or unpaid insurance claims",
    },
    {
        id: 16,
        name: "HIPAA Trainee",
        cognitoGroup: "HIPAATrainee",
        dbValue: "hipaa_trainee",
        description: "Trainee undergoing HIPAA compliance certification",
    },
    {
        id: 17,
        name: "OSHA Trainee",
        cognitoGroup: "OSHATrainee",
        dbValue: "osha_trainee",
        description: "Trainee undergoing OSHA safety compliance certification",
    },
    {
        id: 18,
        name: "Accounting",
        cognitoGroup: "Accounting",
        dbValue: "accounting",
        description: "Professional managing financial accounting and bookkeeping",
    },
];

// Helper functions for role management

export const getRoleById = (id: number): ProfessionalRole | undefined => {
    return PROFESSIONAL_ROLES.find((role) => role.id === id);
};

export const getRoleByDbValue = (dbValue: string): ProfessionalRole | undefined => {
    return PROFESSIONAL_ROLES.find((role) => role.dbValue === dbValue);
};

export const getRoleByCognitoGroup = (cognitoGroup: string): ProfessionalRole | undefined => {
    return PROFESSIONAL_ROLES.find((role) => role.cognitoGroup === cognitoGroup);
};

// Cognito group to database value mapping
export const COGNITO_TO_DB_MAPPING: Record<string, string> = PROFESSIONAL_ROLES.reduce((acc, role) => {
    acc[role.cognitoGroup] = role.dbValue;
    return acc;
}, {} as Record<string, string>);

// Database value to display name mapping
export const DB_TO_DISPLAY_MAPPING: Record<string, string> = PROFESSIONAL_ROLES.reduce((acc, role) => {
    acc[role.dbValue] = role.name;
    return acc;
}, {} as Record<string, string>);

// Valid database role values for validation
export const VALID_ROLE_VALUES: string[] = PROFESSIONAL_ROLES.map((role) => role.dbValue);

// Valid Cognito group names
export const VALID_COGNITO_GROUPS: string[] = PROFESSIONAL_ROLES.map((role) => role.cognitoGroup);

// Role categories for grouping similar roles
export const ROLE_CATEGORIES = {
    DOCTOR: ['dentist', 'associate_dentist'] as string[],
    CLINICAL: ['dental_hygienist', 'hygienist', 'dental_assistant', 'expanded_functions_da'] as string[],
    FRONT_OFFICE: ['patient_coordinator_front', 'treatment_coordinator_front'] as string[],
    DUAL_ROLE: ['dual_role_front_da', 'dh_tc_pc'] as string[],
    BILLING: ['billing_coordinator', 'insurance_verification', 'payment_posting', 'claims_sending', 'claims_resolution'] as string[],
    COMPLIANCE: ['hipaa_trainee', 'osha_trainee'] as string[],
    ACCOUNTING: ['accounting'] as string[],
};

// Check if role is a doctor role (used for pay type validation)
export const isDoctorRole = (roleDbValue: string): boolean => {
    return ROLE_CATEGORIES.DOCTOR.includes(roleDbValue);
};

// Check if role is clinical (needs clinical certifications)
export const isClinicaRole = (roleDbValue: string): boolean => {
    return ROLE_CATEGORIES.CLINICAL.includes(roleDbValue);
};

// Check if role involves front office duties
export const isFrontOfficeRole = (roleDbValue: string): boolean => {
    return ROLE_CATEGORIES.FRONT_OFFICE.includes(roleDbValue) || ROLE_CATEGORIES.DUAL_ROLE.includes(roleDbValue);
};

// Check if role is dual function
export const isDualRole = (roleDbValue: string): boolean => {
    return ROLE_CATEGORIES.DUAL_ROLE.includes(roleDbValue);
};

// Check if role is billing/revenue cycle
export const isBillingRole = (roleDbValue: string): boolean => {
    return ROLE_CATEGORIES.BILLING.includes(roleDbValue);
};

// Check if role is compliance/trainee
export const isComplianceRole = (roleDbValue: string): boolean => {
    return ROLE_CATEGORIES.COMPLIANCE.includes(roleDbValue);
};