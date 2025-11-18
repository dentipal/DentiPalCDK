"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamoClient = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
    try {
        const userSub = (0, utils_1.validateToken)(event);
        const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
        let clinicId = event.pathParameters?.proxy;
        console.log("Extracted clinicId:", clinicId);
        
        // Clean the clinicId if it starts with 'clinics/'
        if (clinicId.startsWith('clinics/')) {
            clinicId = clinicId.slice('clinics/'.length);
        }

        console.log("Cleaned clinicId:", clinicId);  // Log the cleaned clinicId

        if (!clinicId) {
            return { statusCode: 400, body: JSON.stringify({ error: "Clinic ID is required in path parameters" }) };
        }

        // Check access: Root users can access any clinic, others need specific access
        if (!(0, utils_1.isRoot)(groups) && !(await (0, utils_1.hasClinicAccess)(userSub, clinicId))) {
            return { statusCode: 403, body: JSON.stringify({ error: "Access denied to clinic" }) };
        }

        // Fetch the clinic details from DynamoDB
        const command = new client_dynamodb_1.GetItemCommand({
            TableName: process.env.CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
        });
        const response = await dynamoClient.send(command);

        console.log("DynamoDB response:", response);  

        // If clinic not found
        if (!response.Item) {
            return { statusCode: 404, body: JSON.stringify({ error: "Clinic not found" }) };
        }

        // Return the clinic details along with individual address fields
        return {
            statusCode: 200,
            body: JSON.stringify({
                status: "success",
                clinic: {
                    clinicId: response.Item.clinicId.S,
                    name: response.Item.name.S,
                    addressLine1: response.Item.addressLine1.S,
                    addressLine2: response.Item.addressLine2.S || '',
                    addressLine3: response.Item.addressLine3.S || '',
                    city: response.Item.city.S,
                    state: response.Item.state.S,
                    pincode: response.Item.pincode.S,
                    fullAddress: response.Item.address.S,
                    createdBy: response.Item.createdBy.S,
                    createdAt: response.Item.createdAt.S,
                    updatedAt: response.Item.updatedAt.S,
                },
            }),
        };
    }
    catch (error) {
        console.error("Error retrieving clinic:", error);
        return { statusCode: 400, body: JSON.stringify({ error: `Failed to retrieve clinic: ${error.message}` }) };
    }
};

exports.handler = handler;
