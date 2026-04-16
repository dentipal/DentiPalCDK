// Verify Auth Challenge Lambda trigger
// Checks the challenge answer matches the expected value
export const handler = async (event: any) => {
  event.response.answerCorrect =
    event.request.challengeAnswer === "google-verified";
  return event;
};
