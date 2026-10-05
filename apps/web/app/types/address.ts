export interface Address {
  id: number;
  label: string;
  city: string;
  street: string;
  house: string;
  buildingPart?: string | null;
  flat: string | null;
  entrance: string | null;
  floor: string | null;
  intercom: string | null;
  comment: string | null;

  lat: number | null;
  lng: number | null;
  fiasId: string | null;

  isDefault: boolean;

  createdAt: string;
  updatedAt: string;
}
