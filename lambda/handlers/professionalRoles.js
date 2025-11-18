"use strict";
// Professional Roles Configuration for Cognito Groups
// Each role has an ID that corresponds to Cognito group configuration
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDualRole = exports.isFrontOfficeRole = exports.isClinicaRole = exports.ROLE_CATEGORIES = exports.VALID_COGNITO_GROUPS = exports.VALID_ROLE_VALUES = exports.DB_TO_DISPLAY_MAPPING = exports.COGNITO_TO_DB_MAPPING = exports.getRoleByCognitoGroup = exports.getRoleByDbValue = exports.getRoleById = exports.PROFESSIONAL_ROLES = void 0;
exports.PROFESSIONAL_ROLES = [
    {
        id: 1,
        name: "Associate Dentist",
        cognitoGroup: "AssociateDentist",
        dbValue: "associate_dentist",
        description: "Licensed dentist providing dental care services"
    },
    {
        id: 2,
        name: "Dental Hygienist",
        cognitoGroup: "DentalHygienist",
        dbValue: "dental_hygienist",
        description: "Licensed dental hygienist providing preventive care"
    },
    {
        id: 3,
        name: "Dental Assistant",
        cognitoGroup: "DentalAssistant",
        dbValue: "dental_assistant",
        description: "Dental assistant providing chairside assistance"
    },
    {
        id: 4,
        name: "Expanded Functions DA",
        cognitoGroup: "ExpandedFunctionsDA",
        dbValue: "expanded_functions_da",
        description: "Dental assistant with expanded functions certification"
    },
    {
        id: 5,
        name: "Dual Role (Front and DA)",
        cognitoGroup: "DualRoleFrontDA",
        dbValue: "dual_role_front_da",
        description: "Professional handling both front desk and dental assistant duties"
    },
    {
        id: 6,
        name: "Patient Coordinator (Front)",
        cognitoGroup: "PatientCoordinatorFront",
        dbValue: "patient_coordinator_front",
        description: "Front desk professional focused on patient coordination"
    },
    {
        id: 7,
        name: "Treatment Coordinator (Front)",
        cognitoGroup: "TreatmentCoordinatorFront",
        dbValue: "treatment_coordinator_front",
        description: "Front desk professional focused on treatment coordination"
    }
];
// Helper functions for role management
const getRoleById = (id) => {
    return exports.PROFESSIONAL_ROLES.find(role => role.id === id);
};
exports.getRoleById = getRoleById;
const getRoleByDbValue = (dbValue) => {
    return exports.PROFESSIONAL_ROLES.find(role => role.dbValue === dbValue);
};
exports.getRoleByDbValue = getRoleByDbValue;
const getRoleByCognitoGroup = (cognitoGroup) => {
    return exports.PROFESSIONAL_ROLES.find(role => role.cognitoGroup === cognitoGroup);
};
exports.getRoleByCognitoGroup = getRoleByCognitoGroup;
// Cognito group to database value mapping
exports.COGNITO_TO_DB_MAPPING = exports.PROFESSIONAL_ROLES.reduce((acc, role) => {
    acc[role.cognitoGroup] = role.dbValue;
    return acc;
}, {});
// Database value to display name mapping
exports.DB_TO_DISPLAY_MAPPING = exports.PROFESSIONAL_ROLES.reduce((acc, role) => {
    acc[role.dbValue] = role.name;
    return acc;
}, {});
// Valid database role values for validation
exports.VALID_ROLE_VALUES = exports.PROFESSIONAL_ROLES.map(role => role.dbValue);
// Valid Cognito group names
exports.VALID_COGNITO_GROUPS = exports.PROFESSIONAL_ROLES.map(role => role.cognitoGroup);
// Role categories for grouping similar roles
exports.ROLE_CATEGORIES = {
    CLINICAL: ['associate_dentist', 'dental_hygienist', 'dental_assistant', 'expanded_functions_da'],
    FRONT_OFFICE: ['patient_coordinator_front', 'treatment_coordinator_front'],
    DUAL_ROLE: ['dual_role_front_da']
};
// Check if role is clinical (needs clinical certifications)
const isClinicaRole = (roleDbValue) => {
    return exports.ROLE_CATEGORIES.CLINICAL.includes(roleDbValue);
};
exports.isClinicaRole = isClinicaRole;
// Check if role involves front office duties
const isFrontOfficeRole = (roleDbValue) => {
    return exports.ROLE_CATEGORIES.FRONT_OFFICE.includes(roleDbValue) ||
        exports.ROLE_CATEGORIES.DUAL_ROLE.includes(roleDbValue);
};
exports.isFrontOfficeRole = isFrontOfficeRole;
// Check if role is dual function
const isDualRole = (roleDbValue) => {
    return exports.ROLE_CATEGORIES.DUAL_ROLE.includes(roleDbValue);
};
exports.isDualRole = isDualRole;
