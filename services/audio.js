import axios from "axios";

export async function fetchTwilioMedia(url, accountSid, authToken) {
  // Twilio-hosted media requires basic auth with Account SID and Auth Token
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    auth: { username: accountSid, password: authToken }
  });
  return resp.data; // Buffer
}
