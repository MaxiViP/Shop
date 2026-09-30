export type OtpDeliveryMode = 'DEMO' | 'SMS' | 'DEV' | 'INVALID';

export function otpDeliveryMode(): OtpDeliveryMode {
  const configured = process.env.OTP_DELIVERY_MODE;
  if (configured === 'DEMO' || configured === 'SMS') return configured;
  if (!configured) return process.env.NODE_ENV === 'production' ? 'SMS' : 'DEV';
  if (configured === 'DEV' && process.env.NODE_ENV !== 'production') return 'DEV';
  return 'INVALID';
}
