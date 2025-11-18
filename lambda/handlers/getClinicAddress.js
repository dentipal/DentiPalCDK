const AWS = require("aws-sdk");
const ddb = new AWS.DynamoDB();

const CLINICS_TABLE = process.env.CLINICS_TABLE;

exports.handler = async (event) => {
  console.log("getClinicAddress event:", JSON.stringify(event, null, 2));

  try {
    const path = event.path || "";
    const pathClinicId = event.pathParameters?.clinicId;
    const clinicId =
      pathClinicId ||
      path.split("/").filter(Boolean)[1]; // /clinics/{id}/address

    console.log("Resolved clinicId:", clinicId, "from path:", path);

    if (!clinicId) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
        },
        body: JSON.stringify({ error: "Missing clinicId" }),
      };
    }

    const res = await ddb
      .getItem({
        TableName: CLINICS_TABLE,
        Key: { clinicId: { S: clinicId } },
      })
      .promise();

    if (!res.Item) {
      return {
        statusCode: 404,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Credentials": true,
        },
        body: JSON.stringify({ error: "Clinic not found" }),
      };
    }

    const item = res.Item;

    const body = {
      clinicId,
      name: item.name?.S,
      address: item.address?.S,
      city: item.city?.S,
      state: item.state?.S,
      pincode: item.pincode?.S,
    };

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",          // 👈 important
        "Access-Control-Allow-Credentials": true,
      },
      body: JSON.stringify(body),
    };
  } catch (err) {
    console.error("getClinicAddress error:", err);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Credentials": true,
      },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};
