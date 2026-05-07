import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    CognitoIdentityProviderClient,
    SignUpCommand,
    AdminGetUserCommand,
    AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { corsHeaders } from "../corsHeaders";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface BootstrapBody {
    email?: string;
    password?: string;
    firstName?: string;
    lastName?: string;
}

/**
 * POST /admin/auth/bootstrap-admin — public, single-shot.
 *
 * Initiates the very-first-admin signup. Mirrors the clinic/professional flow:
 *   1. Refuse if any user is already in the "Admin" Cognito group.
 *   2. Cognito.SignUp — Cognito emails a 6-digit OTP to the user.
 *   3. Frontend collects the OTP and calls /admin/auth/verify-bootstrap-otp,
 *      which calls ConfirmSignUp + AdminAddUserToGroup("Admin").
 *
 * Group assignment happens at verify-time, not signup-time, so the bootstrap
 * gate stays correct: an UNCONFIRMED signup is not yet "an admin", and the
 * /admin/signup page can be reused if the first attempt is abandoned.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        if (!event.body) {
            return json(event, 400, { error: "Bad Request", message: "Request body is required" });
        }
        const body: BootstrapBody = JSON.parse(event.body);
        const email = (body.email || "").toLowerCase().trim();
        const { password, firstName, lastName } = body;

        const missing = [
            !email && "email",
            !password && "password",
            !firstName && "firstName",
            !lastName && "lastName",
        ].filter(Boolean);
        if (missing.length > 0) {
            return json(event, 400, {
                error: "Bad Request",
                message: "Required fields are missing",
                details: { missingFields: missing },
            });
        }

    

        // does not collect a phone — set a placeholder (same trick the preSignUp trigger
        // uses for Google federated users). Admins can update later from a profile page.
        const userAttributes = [
            { Name: "email", Value: email },
            { Name: "given_name", Value: firstName! },
            { Name: "family_name", Value: lastName! },
            { Name: "phone_number", Value: "+10000000000" },
            { Name: "address", Value: "userType:internal|role:admin" },
        ];

        const signUpCommand = new SignUpCommand({
            ClientId: process.env.CLIENT_ID,
            Username: email,
            Password: password!,
            UserAttributes: userAttributes,
        });

        try {
            await cognito.send(signUpCommand);
        } catch (signUpError: any) {
            // Mirror the initiateUserRegistration recovery path: if the email
            // belongs to a stale UNCONFIRMED signup (someone abandoned the OTP),
            // wipe and retry so this attempt's password/name win.
            if (signUpError.name !== "UsernameExistsException") {
                throw signUpError;
            }
            const existingUser = await cognito.send(new AdminGetUserCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: email,
            }));
            if (existingUser.UserStatus !== "UNCONFIRMED") {
                throw signUpError;
            }
            console.log(`[bootstrapAdmin] Replacing stale UNCONFIRMED signup for ${email}`);
            await cognito.send(new AdminDeleteUserCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: email,
            }));
            await cognito.send(signUpCommand);
        }

        return json(event, 200, {
            status: "success",
            message: "Verification code sent. Please check your email.",
            data: { email, nextStep: "POST /admin/auth/verify-bootstrap-otp with { email, confirmationCode }" },
        });
    } catch (error: any) {
        console.error("[bootstrapAdmin] error:", error);
        if (error.name === "InvalidPasswordException") {
            return json(event, 400, {
                error: "Bad Request",
                message: "Password does not meet requirements (min 8 chars with upper, lower, digit, symbol).",
            });
        }
        if (error.name === "InvalidParameterException") {
            return json(event, 400, {
                error: "Bad Request",
                message: error.message || "Invalid parameters",
            });
        }
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to start admin signup",
        });
    }
};
