import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { VALID_ROLE_VALUES } from "./professionalRoles";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

interface Question {
    field: string;
    label: string;
    type: string;
    required: boolean;
    options?: string[];
    description?: string;
    placeholder?: string;
}

type RoleQuestionsMap = Record<string, Question[]>;

// Common front desk questions for all professional roles
const FRONT_DESK_QUESTIONS: Question[] = [
    {
        field: 'dental_software_experience',
        label: 'Which dental software have you used?',
        type: 'multiselect',
        required: false,
        options: [
            'Ascend', 'CareStack', 'ClearDent', 'Cloud 9', 'Curve', 'DOX', 'Dental Vision', 'DentaPro',
            'Dentech', 'Denticon', 'Dentrix', 'Dexis', 'DrFirst', 'EagleSoft', 'Easy Dental', 'Epic',
            'EZ 2000 Dental', 'Gendex', 'iCoreConnect', 'Macpractice', 'Medisoft', 'Open Dental',
            'ORTOTRAC', 'Oryx Dental', 'Practice Works', 'QDV', 'QSI Dental', 'Quadra Dental', 'Sidexis',
            'SOFTDENT', 'SuzyDental', 'Tab32', 'Windent', 'Other', 'none'
        ],
        description: 'Select all dental software you have experience with'
    },
    {
        field: 'has_dental_office_experience',
        label: 'Do you have dental office experience?',
        type: 'boolean',
        required: true
    },
    {
        field: 'years_of_experience',
        label: 'How many years of experience do you have in dental offices?',
        type: 'number',
        required: true,
        placeholder: 'Enter total years of dental experience'
    },
    {
        field: 'knows_dental_insurance',
        label: 'Are you familiar with dental insurance processing?',
        type: 'boolean',
        required: false,
        description: 'Many dental professionals assist with insurance-related tasks'
    },
    {
        field: 'knows_billing',
        label: 'Do you have experience with dental billing?',
        type: 'boolean',
        required: false,
        description: 'Understanding billing helps in patient communication'
    },
    {
        field: 'knows_claims_processing',
        label: 'Are you experienced in insurance claims processing?',
        type: 'boolean',
        required: false,
        description: 'Claims knowledge is valuable for patient assistance'
    },
    {
        field: 'languages_known',
        label: 'What languages do you speak?',
        type: 'multiselect',
        required: false,
        options: ['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Chinese', 'Other'],
        description: 'Language skills help with diverse patient populations'
    }
];

const ROLE_QUESTIONS: RoleQuestionsMap = {
    associate_dentist: [
        // Front desk skills valuable for practice management and patient relations
        ...FRONT_DESK_QUESTIONS,
        // Dentist specific qualifications
        {
            field: 'dental_degree',
            label: 'What type of dental degree do you have?',
            type: 'select',
            required: true,
            options: ['DDS', 'DMD', 'BDS', 'Other'],
            description: 'Select your dental degree type'
        },
        {
            field: 'clinical_experience_dentist',
            label: 'Describe your clinical experience and specialties',
            type: 'text',
            required: true,
            placeholder: 'Include years of practice, specialties, and areas of expertise',
            description: 'Provide details about your dental practice experience'
        },
        {
            field: 'has_dentist_license',
            label: 'Do you have a current dental license?',
            type: 'boolean',
            required: true
        },
        {
            field: 'dentist_license_file',
            label: 'Upload your dental license',
            type: 'file',
            required: false
        },
        {
            field: 'has_board_certification',
            label: 'Do you have any board certifications?',
            type: 'boolean',
            required: false
        },
        {
            field: 'board_certification_file',
            label: 'Upload your board certification',
            type: 'file',
            required: false
        },
        {
            field: 'has_dea_registration',
            label: 'Do you have a DEA registration?',
            type: 'boolean',
            required: true
        },
        {
            field: 'ce_compliance',
            label: 'Are you current with continuing education requirements?',
            type: 'boolean',
            required: true
        }
    ],
    dental_assistant: [
        // Front desk skills that dental assistants often need
        ...FRONT_DESK_QUESTIONS,
        // Dental assistant specific qualifications
        {
            field: 'has_dental_assistant_diploma',
            label: 'Do you have a Dental Assistant diploma/certificate?',
            type: 'boolean',
            required: true
        },
        {
            field: 'dental_assistant_diploma_file',
            label: 'Upload your Dental Assistant diploma/certificate',
            type: 'file',
            required: false,
            description: 'Upload a copy of your dental assistant credentials'
        },
        {
            field: 'is_rda',
            label: 'Are you a Registered Dental Assistant (RDA)?',
            type: 'boolean',
            required: true
        },
        {
            field: 'rda_file',
            label: 'Upload your RDA certificate',
            type: 'file',
            required: false
        },
        {
            field: 'is_cda',
            label: 'Are you a Certified Dental Assistant (CDA)?',
            type: 'boolean',
            required: true
        },
        {
            field: 'cda_file',
            label: 'Upload your CDA certificate',
            type: 'file',
            required: false
        },
        {
            field: 'has_radiology_cert',
            label: 'Do you have a radiology certification?',
            type: 'boolean',
            required: true
        },
        {
            field: 'radiology_cert_file',
            label: 'Upload your radiology certificate',
            type: 'file',
            required: false
        },
        {
            field: 'has_cpr_cert',
            label: 'Do you have a current CPR certification?',
            type: 'boolean',
            required: true
        },
        {
            field: 'cpr_cert_file',
            label: 'Upload your CPR certificate',
            type: 'file',
            required: false
        }
    ],
    dental_hygienist: [
        // Front desk skills that hygienists often need in smaller practices
        ...FRONT_DESK_QUESTIONS,
        // Hygienist specific qualifications
        {
            field: 'dental_hygiene_degree',
            label: 'What type of dental hygiene degree do you have?',
            type: 'select',
            required: true,
            options: ['Associate Degree', 'Bachelor Degree', 'Master Degree', 'Certificate Program'],
            description: 'Select your highest dental hygiene education level'
        },
        {
            field: 'has_hygienist_license',
            label: 'Do you have a current dental hygienist license?',
            type: 'boolean',
            required: true
        },
        {
            field: 'hygienist_license_file',
            label: 'Upload your hygienist license',
            type: 'file',
            required: false
        },
        {
            field: 'has_cpr_hygienist',
            label: 'Do you have a current CPR certification?',
            type: 'boolean',
            required: true
        },
        {
            field: 'clinical_experience_hygienist',
            label: 'Describe your clinical experience',
            type: 'text',
            required: false,
            placeholder: 'Describe your clinical experience and specialties',
            description: 'Include years of experience and any specialized areas'
        },
        {
            field: 'knows_osha_hipaa',
            label: 'Are you familiar with OSHA and HIPAA regulations?',
            type: 'boolean',
            required: true
        }
    ],
    expanded_functions_da: [
        // Front desk skills that expanded function dental assistants often need
        ...FRONT_DESK_QUESTIONS,
        // Enhanced dental assistant qualifications
        {
            field: 'has_dental_assistant_diploma',
            label: 'Do you have a Dental Assistant diploma/certificate?',
            type: 'boolean',
            required: true
        },
        {
            field: 'dental_assistant_diploma_file',
            label: 'Upload your Dental Assistant diploma/certificate',
            type: 'file',
            required: false
        },
        {
            field: 'is_rda',
            label: 'Are you a Registered Dental Assistant (RDA)?',
            type: 'boolean',
            required: true
        },
        {
            field: 'rda_file',
            label: 'Upload your RDA certificate',
            type: 'file',
            required: false
        },
        {
            field: 'has_expanded_functions_cert',
            label: 'Do you have Expanded Functions certification?',
            type: 'boolean',
            required: true
        },
        {
            field: 'expanded_functions_cert_file',
            label: 'Upload your Expanded Functions certificate',
            type: 'file',
            required: false
        },
        {
            field: 'restorative_experience',
            label: 'Describe your restorative dentistry experience',
            type: 'textarea',
            required: true,
            placeholder: 'Include experience with fillings, crowns, and other restorative procedures',
            description: 'Detail your experience with expanded function procedures'
        },
        {
            field: 'has_radiology_cert',
            label: 'Do you have a radiology certification?',
            type: 'boolean',
            required: true
        },
        {
            field: 'has_cpr_cert',
            label: 'Do you have a current CPR certification?',
            type: 'boolean',
            required: true
        }
    ],
    dual_role_front_da: [
        // Front desk skills for the combined role
        ...FRONT_DESK_QUESTIONS,
        // Dental Assistant qualifications
        {
            field: 'has_dental_assistant_diploma',
            label: 'Do you have a dental assistant diploma/certificate?',
            type: 'boolean',
            required: true
        },
        {
            field: 'dental_assistant_diploma_file',
            label: 'Upload your dental assistant diploma/certificate',
            type: 'file',
            required: false
        },
        {
            field: 'is_rda',
            label: 'Are you a Registered Dental Assistant (RDA)?',
            type: 'boolean',
            required: false
        },
        {
            field: 'rda_file',
            label: 'Upload your RDA certification',
            type: 'file',
            required: false
        },
        {
            field: 'is_cda',
            label: 'Are you a Certified Dental Assistant (CDA)?',
            type: 'boolean',
            required: false
        },
        {
            field: 'cda_file',
            label: 'Upload your CDA certification',
            type: 'file',
            required: false
        },
        {
            field: 'has_radiology_cert',
            label: 'Do you have a radiology certification?',
            type: 'boolean',
            required: false
        },
        {
            field: 'radiology_cert_file',
            label: 'Upload your radiology certification',
            type: 'file',
            required: false
        },
        {
            field: 'has_cpr_cert',
            label: 'Do you have a current CPR certification?',
            type: 'boolean',
            required: true
        },
        {
            field: 'cpr_cert_file',
            label: 'Upload your CPR certification',
            type: 'file',
            required: false
        }
    ],
    patient_coordinator_front: [
        ...FRONT_DESK_QUESTIONS,
        {
            field: 'patient_coordination_experience',
            label: 'Describe your patient coordination experience',
            type: 'textarea',
            required: true,
            placeholder:
                'Include experience with scheduling, insurance coordination, patient communication',
            description: 'Detail your experience managing patient relationships and coordination'
        },
        {
            field: 'insurance_verification_experience',
            label: 'Do you have experience with insurance verification?',
            type: 'boolean',
            required: true
        },
        {
            field: 'patient_communication_skills',
            label: 'Rate your patient communication skills',
            type: 'text',
            required: true,
            placeholder: 'Describe your approach to patient communication',
            description: 'Patient coordinators need excellent communication skills'
        },
        {
            field: 'conflict_resolution_experience',
            label: 'Do you have experience handling patient concerns or complaints?',
            type: 'boolean',
            required: false,
            description: 'Experience resolving patient issues is valuable'
        }
    ],
    treatment_coordinator_front: [
        ...FRONT_DESK_QUESTIONS,
        {
            field: 'treatment_coordination_experience',
            label: 'Describe your treatment coordination experience',
            type: 'textarea',
            required: true,
            placeholder:
                'Include experience with treatment planning, case presentation, financial coordination',
            description:
                'Detail your experience coordinating treatment plans and presentations'
        },
        {
            field: 'case_presentation_experience',
            label: 'Do you have experience presenting treatment plans to patients?',
            type: 'boolean',
            required: true
        },
        {
            field: 'financial_coordination_skills',
            label: 'Do you have experience with treatment financing and payment plans?',
            type: 'boolean',
            required: true,
            description: 'Treatment coordinators often handle financial discussions'
        },
        {
            field: 'dental_terminology_knowledge',
            label: 'Rate your knowledge of dental terminology and procedures',
            type: 'text',
            required: true,
            placeholder:
                'Describe your familiarity with dental procedures and terminology',
            description:
                'Strong dental knowledge is essential for treatment coordination'
        },
        {
            field: 'sales_experience',
            label: 'Do you have any sales or customer service experience?',
            type: 'boolean',
            required: false,
            description: 'Sales skills can be beneficial in treatment coordination'
        }
    ]
};

export const handler = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    // CORS Preflight
    if (event.httpMethod === "OPTIONS") {
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: "",
        };
    }

    try {
        // Extract Bearer token from Authorization header to validate user
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        extractUserFromBearerToken(authHeader);

        const { role } = event.queryStringParameters || {};

        if (!role) {
            return json(200, {
                availableRoles: VALID_ROLE_VALUES,
                message: "Provide 'role' parameter to get specific questions"
            });
        }

        if (!VALID_ROLE_VALUES.includes(role)) {
            return json(400, {
                error: `Invalid role. Valid options: ${VALID_ROLE_VALUES.join(", ")}`,
                availableRoles: VALID_ROLE_VALUES
            });
        }

        const questions = ROLE_QUESTIONS[role] || [];

        return json(200, {
            role,
            questions: questions,
            totalQuestions: questions.length
        });
    } catch (error: any) {
        console.error("Error getting professional questions:", error);
        return json(500, { error: error.message });
    }
};