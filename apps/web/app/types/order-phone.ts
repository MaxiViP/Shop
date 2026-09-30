export interface OrderPhone {
  id: number | null;
  manualId?: number;
  phone: string;
  source: "ACCOUNT" | "TELEGRAM" | "MANUAL";
}

export interface OrderPhoneSnapshot {
  phones: OrderPhone[];
  manualCount: number;
  primaryPhone: string | null;
}
