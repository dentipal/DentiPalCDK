import { DynamoDBClient, QueryCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { isRoot } from "./utils";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

interface JobPosting {
  clinicId: string;
  postingId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

async function getAllClinicIds(): Promise<string[]> {
  const command = new ScanCommand({
    TableName: process.env.CLINICS_TABLE,
    ProjectionExpression: "clinicId",
  });
  const response = await dynamoClient.send(command);
  return (response.Items || []).map(item => item.clinicId.S!);
}

export const handler = async (event: any): Promise<LambdaResponse> => {
  try {
    const userSub = event.requestContext.authorizer.claims.sub;
    const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];

    const assignmentCommand = new QueryCommand({
      TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
      KeyConditionExpression: "userSub = :userSub",
      ExpressionAttributeValues: { ":userSub": { S: userSub } },
    });
    const assignmentResponse = await dynamoClient.send(assignmentCommand);
    const clinicIds = (assignmentResponse.Items || []).map(item => item.clinicId.S!);

    if (clinicIds.length === 0 && !isRoot(groups)) {
      return { statusCode: 403, body: JSON.stringify({ error: "No clinics assigned" }) };
    }

    const jobPostings: JobPosting[] = [];
    for (const clinicId of isRoot(groups) ? await getAllClinicIds() : clinicIds) {
      const postingsCommand = new QueryCommand({
        TableName: process.env.JOB_POSTINGS_TABLE,
        KeyConditionExpression: "clinicId = :clinicId",
        ExpressionAttributeValues: { ":clinicId": { S: clinicId } },
      });
      const postingsResponse = await dynamoClient.send(postingsCommand);
      jobPostings.push(...(postingsResponse.Items || []).map(item => ({
        clinicId: item.clinicId.S!,
        postingId: item.postingId.S!,
        title: item.title.S!,
        description: item.description.S!,
        createdAt: item.createdAt.S!,
        updatedAt: item.updatedAt.S!,
      })));
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", jobPostings }),
    };
  } catch (error: any) {
    console.error("Error retrieving job postings:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to retrieve job postings: ${error.message}` }) };
  }
};