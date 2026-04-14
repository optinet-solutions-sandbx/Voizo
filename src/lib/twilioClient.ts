import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const phoneNumber = process.env.TWILIO_PHONE_NUMBER;

if (!accountSid) throw new Error("FATAL: TWILIO_ACCOUNT_SID is not set");
if (!authToken) throw new Error("FATAL: TWILIO_AUTH_TOKEN is not set");
if (!phoneNumber) throw new Error("FATAL: TWILIO_PHONE_NUMBER is not set");

// After the guards above, these are guaranteed non-null strings.
const _authToken: string = authToken;

export const twilioClient = twilio(accountSid, _authToken);
export const twilioPhoneNumber: string = phoneNumber;

/**
 * Validate incoming Twilio webhook signature.
 * Manifesto §6: "Every Twilio webhook validates X-Twilio-Signature. No exceptions."
 */
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  return twilio.validateRequest(_authToken, signature, url, params);
}
