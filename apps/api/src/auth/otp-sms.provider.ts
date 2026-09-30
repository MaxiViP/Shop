import { Injectable } from '@nestjs/common';

// Install a provider-specific adapter before enabling OTP_DELIVERY_MODE=SMS.
export abstract class OtpSmsProvider {
  abstract readonly available: boolean;
  abstract send(phone: string, text: string): Promise<void>;
}

@Injectable()
export class DisabledOtpSms extends OtpSmsProvider {
  readonly available = false;

  async send(): Promise<void> {
    throw new Error('OTP_SMS_UNCONFIGURED');
  }
}
