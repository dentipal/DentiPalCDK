import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

// Placeholder promotion plans - pricing/duration to be finalized later
const PROMOTION_PLANS = [
  {
    planId: "basic",
    name: "Basic Boost",
    description: "Your job appears at the top of search results for 3 days.",
    durationDays: 3,
    priceCents: 999, // $9.99
    features: ["Top of search results", "Promoted badge"],
  },
  {
    planId: "featured",
    name: "Featured Listing",
    description: "Your job appears at the top of search results for 7 days with a Featured badge.",
    durationDays: 7,
    priceCents: 2499, // $24.99
    features: ["Top of search results", "Featured badge", "Email digest inclusion"],
  },
  {
    planId: "premium",
    name: "Premium Spotlight",
    description: "Maximum visibility for 14 days with premium placement and notifications.",
    durationDays: 14,
    priceCents: 4999, // $49.99
    features: ["Top of search results", "Premium badge", "Email digest inclusion", "Push notifications to matching professionals"],
  },
];

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  setOriginFromEvent(event);

  try {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        status: "success",
        plans: PROMOTION_PLANS,
      }),
    };
  } catch (error: any) {
    console.error("Error fetching promotion plans:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `Failed to fetch promotion plans: ${error.message || "unknown"}` }),
    };
  }
};
