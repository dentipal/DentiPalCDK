// Pre sign-up Lambda trigger for Cognito
// Auto-fills required attributes (address, phone_number) for Google federated sign-ups

export const handler = async (event: any) => {
  if (event.triggerSource === "PreSignUp_ExternalProvider") {
    // Google doesn't provide address or phone_number,
    // but our User Pool requires them — set defaults
    if (!event.request.userAttributes.address) {
      event.request.userAttributes.address = "Not provided";
    }
    if (!event.request.userAttributes.phone_number) {
      event.request.userAttributes.phone_number = "+10000000000";
    }

    // Auto-confirm and auto-verify the federated user
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
  }

  return event;
};
