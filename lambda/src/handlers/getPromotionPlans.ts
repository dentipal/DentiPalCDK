import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { corsHeaders } from "./corsHeaders";

// Per-day promotion plans. Total price = perDayPriceCents * durationDays
// (user picks days in the popup, server recomputes total on create).
const PROMOTION_PLANS = [
  {
    planId: "basic",
    name: "Basic",
    description: "Your job appears at the top of search results with a Promoted badge.",
    perDayPriceCents: 100, // $1/day
    features: ["Top of search results", "Promoted badge"],
  },
  {
    planId: "email",
    name: "Email Boost",
    description: "Basic + email blast to matching professionals each day.",
    perDayPriceCents: 200, // $2/day
    features: [
      "Top of search results",
      "Promoted badge",
      "Email blast to matching professionals",
    ],
  },
  {
    planId: "sms",
    name: "SMS Boost",
    description: "Everything in Email + SMS blast to matching professionals.",
    perDayPriceCents: 300, // $3/day
    features: [
      "Top of search results",
      "Promoted badge",
      "Email blast to matching professionals",
      "SMS blast to matching professionals",
    ],
  },
];

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {

  try {
    return {
      statusCode: 200,
      headers: corsHeaders(event),
      body: JSON.stringify({
        status: "success",
        plans: PROMOTION_PLANS,
      }),
    };
  } catch (error: any) {
    console.error("Error fetching promotion plans:", error);
    return {
      statusCode: 500,
      headers: corsHeaders(event),
      body: JSON.stringify({ error: `Failed to fetch promotion plans: ${error.message || "unknown"}` }),
    };
  }
};
