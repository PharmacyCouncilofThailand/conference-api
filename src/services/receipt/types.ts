export interface ReceiptItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface Organization {
  name: string;
  address1: string;
  address2: string;
  phone: string;
  website: string;
  email: string;
  taxId: string;
}

export interface Recipient {
  name: string;
  idNumber: string;
  address: string;
}

export interface ReceiptViewData {
  receiptNo: string;
  date: string;
  organization: Organization;
  recipient: Recipient;
  items: ReceiptItem[];
  // Money summary (net = subtotal - discount + fee)
  subtotal: number;
  discount: number;
  promoCode?: string | null;
  fee: number;
  netTotal: number;
  // Payment info
  paymentMethod: string;
  paymentDate: string;
  paymentTime: string;
  footerNote: string;
}
