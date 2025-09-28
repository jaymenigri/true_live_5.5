import axios from "axios";
export async function fetchTwilioMedia(url, accountSid, authToken) {
  const resp = await axios.get(url, { responseType: "arraybuffer", auth: { username: accountSid, password: authToken } });
  return resp.data;
}
