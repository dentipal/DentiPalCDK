import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

interface AddressInput {
  addressLine1: string;
  addressLine2?: string;
  addressLine3?: string;
  city: string;
  state: string;
  pincode: string;
}

export const buildAddress = ({ addressLine1, addressLine2, addressLine3, city, state, pincode }: AddressInput): string => {
  const parts = [addressLine1];
  if (addressLine2) parts.push(addressLine2);
  if (addressLine3) parts.push(addressLine3);
  parts.push(city, `${state} ${pincode}`);
  return parts.join(", ");
};

export const isRoot = (groups: string[]): boolean => groups.includes('Root');

export const hasClinicAccess = async (userSub: string, clinicId: string, requiredAccess: string | null = null): Promise<boolean> => {
  if (isRoot([])) return true; // Check global root access
  const command = new GetItemCommand({
    TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
    Key: { userSub: { S: userSub }, clinicId: { S: clinicId } },
  });
  const response = await dynamoClient.send(command);
  return !!response.Item && (!requiredAccess || response.Item.accessLevel?.S === requiredAccess);
};