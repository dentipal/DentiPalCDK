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
    CLINICAL: ['associate_dentist', 'dental_hygienist', 'dental_assistant', 'expanded_functions_da'] as string[],
    FRONT_OFFICE: ['patient_coordinator_front', 'treatment_coordinator_front'] as string[],
    DUAL_ROLE: ['dual_role_front_da'] as string[],
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
  