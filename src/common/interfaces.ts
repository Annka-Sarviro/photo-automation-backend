export interface BookingData {
  id?: string; // SimplyBook booking ID
  balance: string;
  date: string;
  time: string;
  retouched: boolean;
  type: string;
  tariff: string;
  deposit: string;
  payment: string;
  source: string;
  alreadyBeen: string;
  photoCount: string;
  photographer: string;
  extraPhotographer: string;
  photographerPayment: string;
  publicationAllowed: string;
  paymentMethod: string;
  galleryLink: string;
  clientName: string;
  phone: string;
  email: string;
  city: string;
  status?: string;
  sendGallery?: boolean | string;
}
