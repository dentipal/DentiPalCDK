// Create Auth Challenge Lambda trigger
// Sets up the challenge for Google-verified login
export const handler = async (event: any) => {
  event.response.publicChallengeParameters = { trigger: "google-login" };
  event.response.privateChallengeParameters = { answer: "google-verified" };
  return event;
};
