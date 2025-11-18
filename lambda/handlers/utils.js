"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyToken = exports.validateToken = exports.hasClinicAccess = exports.isRoot = exports.buildAddress = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const dynamoClient = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });
const buildAddress = ({ addressLine1, addressLine2, addressLine3, city, state, pincode }) => {
    const parts = [addressLine1];
    if (addressLine2)
        parts.push(addressLine2);
    if (addressLine3)
        parts.push(addressLine3);
    parts.push(city, `${state} ${pincode}`);
    return parts.join(", ");
};
exports.buildAddress = buildAddress;
const isRoot = (groups) => groups.includes('Root');
exports.isRoot = isRoot;
const hasClinicAccess = async (userSub, clinicId, requiredAccess = null) => {
    if ((0, exports.isRoot)([]))
        return true; // Check global root access
    const command = new client_dynamodb_1.GetItemCommand({
        TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
        Key: { userSub: { S: userSub }, clinicId: { S: clinicId } },
    });
    const response = await dynamoClient.send(command);
    return !!response.Item && (!requiredAccess || response.Item.accessLevel?.S === requiredAccess);
};
exports.hasClinicAccess = hasClinicAccess;
const validateToken = (event) => {
    const userSub = event.requestContext.authorizer?.claims?.sub;
    if (!userSub) {
        throw new Error("User not authenticated or token invalid");
    }
    return userSub;
};
exports.validateToken = validateToken;
const verifyToken = async (event) => {
    const claims = event.requestContext.authorizer?.claims;
    if (!claims || !claims.sub) {
        return null;
    }
    return {
        sub: claims.sub,
        userType: claims['custom:user_type'] || 'professional',
        email: claims.email,
        groups: claims['cognito:groups']?.split(',') || []
    };
};
exports.verifyToken = verifyToken;
