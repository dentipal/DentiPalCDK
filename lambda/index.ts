import { handler as createUser } from "./handlers/createUser";
import { handler as getUser } from "./handlers/getUser";
import { handler as updateUser } from "./handlers/updateUser";
import { handler as deleteUser } from "./handlers/deleteUser";
import { handler as deleteOwnAccount } from "./handlers/deleteOwnAccount";
import { handler as createClinic } from "./handlers/createClinic";
import { handler as getClinic } from "./handlers/getClinic";
import { handler as updateClinic } from "./handlers/updateClinic";
import { handler as deleteClinic } from "./handlers/deleteClinic";
import { handler as createAssignment } from "./handlers/createAssignment";
import { handler as getAssignments } from "./handlers/getAssignments";
import { handler as updateAssignment } from "./handlers/updateAssignment";
import { handler as deleteAssignment } from "./handlers/deleteAssignment";
import { handler as getJobPostings } from "./handlers/getJobPostings";

interface LambdaResponse {
  statusCode: number;
  body: string;
}

const handlers: { [key: string]: (event: any) => Promise<LambdaResponse> } = {
  "/create-user": createUser,
  "/get-user": getUser,
  "/update-user": updateUser,
  "/delete-user": deleteUser,
  "/delete-own-account": deleteOwnAccount,
  "/create-clinic": createClinic,
  "/get-clinic": getClinic,
  "/update-clinic": updateClinic,
  "/delete-clinic": deleteClinic,
  "/create-assignment": createAssignment,
  "/get-assignments": getAssignments,
  "/update-assignment": updateAssignment,
  "/delete-assignment": deleteAssignment,
  "/get-job-postings": getJobPostings,
};

export const handler = async (event: any): Promise<LambdaResponse> => {
  const path = event.resource;
  const handler = handlers[path];

  if (!handler) {
    return { statusCode: 404, body: JSON.stringify({ error: "Invalid endpoint" }) };
  }

  try {
    return await handler(event);
  } catch (error: any) {
    console.error(`Error processing ${path}:`, error);
    return { statusCode: 400, body: JSON.stringify({ error: `Operation failed: ${error.message}` }) };
  }
};