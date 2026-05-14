import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    CognitoIdentityProviderClient,
    ListUsersCommand,
    AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
    DynamoDBClient,
    PutItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { corsHeaders } from "../../corsHeaders";
import {
    extractUserFromBearerToken,
    requireInternalGroup,
    buildAddress,
} from "../../utils";
import { getPathSegmentAfter } from "../leadShared";
import { geocodeAddressParts } from "../../geo";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface AddClinicBody {
    name?: string;
    addressLine1?: string;
    addressLine2?: string;
    addressLine3?: string;
    city?: string;
    state?: string;
    pincode?: string;
    country?: string;
    practice_type?: string;
    primary_practice_area?: string;
    primary_contact_title?: string;
    number_of_operatories?: number;
    num_hygienists?: number;
    num_assistants?: number;
    num_doctors?: number;
    dental_association?: string;
    software_used?: string[];
    parking_type?: string;
    free_parking_available?: boolean;
    parking_cost?: number;
    notes?: string;
    website?: string;
}

/**
 * POST /admin/onboarding/clinics/{ownerSub}/additional — Admin only.
 *
 * Adds another clinic for an already-onboarded clinic owner. The owner must
 * exist in Cognito AND be in the Root group (the group clinic owners join via
 * the existing self-signup + initial admin onboarding flows). This guard
 * prevents the admin from accidentally tying a clinic to a professional or
 * an internal-team user.
 *
 * Companion to onboardClinic.ts:
 *   - onboardClinic creates owner Cognito user + first clinic in one call.
 *   - This handler skips the Cognito work and just writes a Clinics row
 *     (and optional Clinic-Profiles row) for the supplied ownerSub.
 *
 * Matches what a clinic owner could do for themselves today by clicking
 * "+ Add New Clinic" in the clinic selector dropdown.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const caller = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
        if (!requireInternalGroup(caller.groups, ["Admin", "HR"])) {
            return json(event, 403, { error: "Forbidden", message: "Admin or HR role required." });
        }

        // The monolith uses an APIGW {proxy+} catch-all, so event.pathParameters
        // contains { proxy: "admin/onboarding/clinics/<sub>/additional" }, never
        // the typed `ownerSub` we'd expect from a fully-resourced route. Parse
        // the path segment after "clinics/" ourselves — same pattern the lead
        // handlers use.
        const ownerSub = getPathSegmentAfter(event, "clinics");
        if (!ownerSub || ownerSub === "additional") {
            return json(event, 400, { error: "Bad Request", message: "ownerSub path parameter is required" });
        }

        if (!event.body) {
            return json(event, 400, { error: "Bad Request", message: "Request body is required" });
        }
        const clinic: AddClinicBody = JSON.parse(event.body);

        const missing = [
            !clinic.name && "name",
            !clinic.addressLine1 && "addressLine1",
            !clinic.city && "city",
            !clinic.state && "state",
            !clinic.pincode && "pincode",
        ].filter(Boolean);
        if (missing.length > 0) {
            return json(event, 400, {
                error: "Bad Request",
                message: "Required clinic fields are missing",
                details: { missingFields: missing },
            });
        }

        // Resolve the owner by sub via ListUsers (Cognito doesn't expose
        // AdminGetUser-by-sub directly — Username is required, and sub != Username
        // for non-Username-aliased pools).
        const userPoolId = process.env.USER_POOL_ID!;
        const ownerResp = await cognito.send(new ListUsersCommand({
            UserPoolId: userPoolId,
            Filter: `sub = "${ownerSub}"`,
            Limit: 1,
        }));
        const ownerUser = ownerResp.Users?.[0];
        if (!ownerUser?.Username) {
            return json(event, 404, {
                error: "Not Found",
                message: "Owner not found in Cognito",
                details: { ownerSub },
            });
        }

        // Verify the owner is actually a clinic owner (Root group). Without
        // this guard, an admin could accidentally bind a clinic to a Dentist
        // or to themselves.
        const groupsResp = await cognito.send(new AdminListGroupsForUserCommand({
            UserPoolId: userPoolId,
            Username: ownerUser.Username,
        }));
        const ownerGroups = (groupsResp.Groups || []).map(g => g.GroupName || "");
        const isRoot = ownerGroups.some(g => g.toLowerCase() === "root");
        if (!isRoot) {
            return json(event, 400, {
                error: "Bad Request",
                message: "Owner is not a clinic owner (not in Root group). Use onboardClinic for new owners.",
                details: { ownerSub, ownerGroups },
            });
        }

        const ownerEmail = ownerUser.Attributes?.find(a => a.Name === "email")?.Value;
        const ownerFirstName = ownerUser.Attributes?.find(a => a.Name === "given_name")?.Value || "";
        const ownerLastName = ownerUser.Attributes?.find(a => a.Name === "family_name")?.Value || "";

        const clinicId = uuidv4();
        const timestamp = new Date().toISOString();
        const address = buildAddress({
            addressLine1: clinic.addressLine1!,
            addressLine2: clinic.addressLine2,
            addressLine3: clinic.addressLine3,
            city: clinic.city!,
            state: clinic.state!,
            pincode: clinic.pincode!,
        });

        let coords: { lat: number; lng: number } | null = null;
        try {
            coords = await geocodeAddressParts({
                addressLine1: clinic.addressLine1!,
                city: clinic.city!,
                state: clinic.state!,
                pincode: clinic.pincode!,
            });
        } catch (geoErr) {
            console.warn("[addClinicForOwner] geocode failed (non-fatal):", geoErr);
        }

        const assocType = (process.env.ASSOCIATED_USERS_TYPE || "L").toUpperCase();
        const AssociatedUsers: AttributeValue = assocType === "SS"
            ? { SS: [ownerSub] }
            : { L: [{ S: ownerSub }] };

        const clinicItem: Record<string, AttributeValue> = {
            clinicId:     { S: clinicId },
            name:         { S: clinic.name! },
            addressLine1: { S: clinic.addressLine1! },
            addressLine2: { S: clinic.addressLine2 || "" },
            addressLine3: { S: clinic.addressLine3 || "" },
            city:         { S: clinic.city!.trim() },
            state:        { S: clinic.state!.trim() },
            pincode:      { S: clinic.pincode!.trim() },
            address:      { S: address },
            createdBy:    { S: ownerSub },
            createdAt:    { S: timestamp },
            updatedAt:    { S: timestamp },
            AssociatedUsers,
        };
        if (coords) {
            clinicItem.lat = { N: String(coords.lat) };
            clinicItem.lng = { N: String(coords.lng) };
        }

        await dynamodb.send(new PutItemCommand({
            TableName: process.env.CLINICS_TABLE,
            Item: clinicItem,
            ConditionExpression: "attribute_not_exists(clinicId)",
        }));

        // Optional Clinic-Profiles row — mirrors onboardClinic.ts shape.
        const hasProfileFields =
            clinic.practice_type || clinic.primary_practice_area ||
            clinic.number_of_operatories !== undefined ||
            clinic.num_hygienists !== undefined ||
            clinic.num_assistants !== undefined ||
            clinic.num_doctors !== undefined ||
            clinic.software_used?.length ||
            clinic.parking_type || clinic.free_parking_available !== undefined ||
            clinic.parking_cost !== undefined ||
            clinic.dental_association || clinic.notes || clinic.website;

        let clinicProfileCreated = false;
        if (hasProfileFields && process.env.CLINIC_PROFILES_TABLE) {
            try {
                const profileItem: Record<string, AttributeValue> = {
                    clinicId:                    { S: clinicId },
                    userSub:                     { S: ownerSub },
                    clinic_name:                 { S: clinic.name! },
                    practice_type:               { S: clinic.practice_type || "general" },
                    primary_practice_area:       { S: clinic.primary_practice_area || "General Dentistry" },
                    primary_contact_first_name:  { S: ownerFirstName },
                    primary_contact_last_name:   { S: ownerLastName },
                    createdAt:                   { S: timestamp },
                    updatedAt:                   { S: timestamp },
                };
                if (clinic.primary_contact_title) profileItem.title = { S: clinic.primary_contact_title };
                if (clinic.number_of_operatories !== undefined) profileItem.number_of_operatories = { N: String(clinic.number_of_operatories) };
                if (clinic.num_hygienists !== undefined)        profileItem.num_hygienists        = { N: String(clinic.num_hygienists) };
                if (clinic.num_assistants !== undefined)        profileItem.num_assistants        = { N: String(clinic.num_assistants) };
                if (clinic.num_doctors !== undefined)           profileItem.num_doctors           = { N: String(clinic.num_doctors) };
                if (clinic.dental_association)                  profileItem.dental_association    = { S: clinic.dental_association };
                if (clinic.software_used?.length)               profileItem.software_used         = { SS: clinic.software_used };
                if (clinic.parking_type)                        profileItem.parking_type          = { S: clinic.parking_type };
                if (clinic.free_parking_available !== undefined) profileItem.free_parking_available = { BOOL: clinic.free_parking_available };
                if (clinic.parking_cost !== undefined)          profileItem.parking_cost          = { N: String(clinic.parking_cost) };
                if (clinic.notes)                               profileItem.notes                 = { S: clinic.notes };
                if (clinic.website)                             profileItem.website               = { S: clinic.website };
                profileItem.addressLine1 = { S: clinic.addressLine1! };
                profileItem.city         = { S: clinic.city! };
                profileItem.state        = { S: clinic.state! };
                profileItem.zip_code     = { S: clinic.pincode! };

                await dynamodb.send(new PutItemCommand({
                    TableName: process.env.CLINIC_PROFILES_TABLE,
                    Item: profileItem,
                }));
                clinicProfileCreated = true;
            } catch (profileErr) {
                console.error("[addClinicForOwner] clinic profile write failed (non-fatal):", profileErr);
            }
        }

        return json(event, 200, {
            status: "success",
            message: `Clinic added for ${ownerEmail || ownerSub}`,
            data: {
                clinicId,
                ownerSub,
                ownerEmail,
                clinicCreated: true,
                clinicProfileCreated,
            },
        });
    } catch (error: any) {
        console.error("[addClinicForOwner] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to add clinic for owner",
        });
    }
};
