export type ContactStatus =
  | "Unreached"
  | "Interested"
  | "Sent SMS"
  | "Declined Offer"
  | "Not interested"
  | "Do not call"
  | "Pending Retry";

export interface Contact {
  id: number;
  campaignId: number;
  name: string;
  phone: string;
  attempts: number;
  lastAttempt: string;
  callDuration: string;
  status: ContactStatus;
}

export const contacts: Contact[] = [
  // Campaign 1
  {
    id: 1,
    campaignId: 1,
    name: "Francis Brown",
    phone: "+1 709 325 5216",
    attempts: 11,
    lastAttempt: "Mar 2, 2026",
    callDuration: "-",
    status: "Unreached",
  },
  {
    id: 2,
    campaignId: 1,
    name: "Maxime Laferriere",
    phone: "+1 581 994 2074",
    attempts: 10,
    lastAttempt: "Mar 2, 2026",
    callDuration: "-",
    status: "Unreached",
  },
  {
    id: 3,
    campaignId: 1,
    name: "Veronique Picard",
    phone: "+1 819 269 2031",
    attempts: 10,
    lastAttempt: "Mar 2, 2026",
    callDuration: "-",
    status: "Unreached",
  },
  {
    id: 4,
    campaignId: 1,
    name: "Manel Labiod",
    phone: "+1 438 467 8112",
    attempts: 10,
    lastAttempt: "Mar 2, 2026",
    callDuration: "-",
    status: "Unreached",
  },
  {
    id: 5,
    campaignId: 1,
    name: "Roman Kotliakov",
    phone: "+1 604 404 8182",
    attempts: 6,
    lastAttempt: "Mar 2, 2026",
    callDuration: "-",
    status: "Unreached",
  },
  {
    id: 6,
    campaignId: 1,
    name: "Jeffery Bonnell",
    phone: "+1 506 555 1234",
    attempts: 10,
    lastAttempt: "Mar 2, 2026",
    callDuration: "-",
    status: "Unreached",
  },
  {
    id: 7,
    campaignId: 1,
    name: "Sophie Tremblay",
    phone: "+1 514 882 3301",
    attempts: 4,
    lastAttempt: "Mar 1, 2026",
    callDuration: "2m 14s",
    status: "Interested",
  },
  {
    id: 8,
    campaignId: 1,
    name: "Michel Ouellet",
    phone: "+1 418 774 9920",
    attempts: 3,
    lastAttempt: "Feb 28, 2026",
    callDuration: "1m 05s",
    status: "Sent SMS",
  },
  {
    id: 9,
    campaignId: 1,
    name: "Lisa Nguyen",
    phone: "+1 647 203 4411",
    attempts: 2,
    lastAttempt: "Feb 27, 2026",
    callDuration: "0m 42s",
    status: "Declined Offer",
  },
  {
    id: 10,
    campaignId: 1,
    name: "Carlos Reyes",
    phone: "+1 780 561 7743",
    attempts: 5,
    lastAttempt: "Mar 2, 2026",
    callDuration: "-",
    status: "Do not call",
  },

  // Campaign 2
  {
    id: 11,
    campaignId: 2,
    name: "Anna Schmidt",
    phone: "+49 151 234 5678",
    attempts: 3,
    lastAttempt: "Mar 1, 2026",
    callDuration: "-",
    status: "Unreached",
  },
  {
    id: 12,
    campaignId: 2,
    name: "Klaus Müller",
    phone: "+49 170 987 6543",
    attempts: 1,
    lastAttempt: "Feb 25, 2026",
    callDuration: "3m 10s",
    status: "Interested",
  },
  {
    id: 13,
    campaignId: 2,
    name: "Helga Bauer",
    phone: "+49 160 112 2334",
    attempts: 2,
    lastAttempt: "Feb 26, 2026",
    callDuration: "-",
    status: "Pending Retry",
  },
  {
    id: 14,
    campaignId: 2,
    name: "Dieter Wolf",
    phone: "+49 176 445 6677",
    attempts: 4,
    lastAttempt: "Mar 2, 2026",
    callDuration: "1m 22s",
    status: "Sent SMS",
  },
  {
    id: 15,
    campaignId: 2,
    name: "Erika Zimmermann",
    phone: "+49 152 998 8771",
    attempts: 2,
    lastAttempt: "Feb 28, 2026",
    callDuration: "-",
    status: "Not interested",
  },

  // Campaign 3
  {
    id: 16,
    campaignId: 3,
    name: "Marco Rossi",
    phone: "+39 347 123 4567",
    attempts: 5,
    lastAttempt: "Mar 2, 2026",
    callDuration: "2m 50s",
    status: "Interested",
  },
  {
    id: 17,
    campaignId: 3,
    name: "Giulia Ferrari",
    phone: "+39 333 876 5432",
    attempts: 3,
    lastAttempt: "Mar 1, 2026",
    callDuration: "-",
    status: "Unreached",
  },
  {
    id: 18,
    campaignId: 3,
    name: "Luca Bianchi",
    phone: "+39 348 654 3210",
    attempts: 7,
    lastAttempt: "Mar 2, 2026",
    callDuration: "1m 38s",
    status: "Declined Offer",
  },
  {
    id: 19,
    campaignId: 3,
    name: "Sofia Conti",
    phone: "+39 320 111 2233",
    attempts: 2,
    lastAttempt: "Feb 27, 2026",
    callDuration: "-",
    status: "Pending Retry",
  },
  {
    id: 20,
    campaignId: 3,
    name: "Davide Marino",
    phone: "+39 349 445 6671",
    attempts: 4,
    lastAttempt: "Mar 2, 2026",
    callDuration: "0m 55s",
    status: "Sent SMS",
  },

  // Campaign 4
  {
    id: 21,
    campaignId: 4,
    name: "James Carter",
    phone: "+1 416 201 3344",
    attempts: 8,
    lastAttempt: "Mar 2, 2026",
    callDuration: "-",
    status: "Unreached",
  },
  {
    id: 22,
    campaignId: 4,
    name: "Emily Thompson",
    phone: "+1 905 342 5566",
    attempts: 3,
    lastAttempt: "Feb 28, 2026",
    callDuration: "4m 02s",
    status: "Interested",
  },
  {
    id: 23,
    campaignId: 4,
    name: "Noah Williams",
    phone: "+1 778 234 1122",
    attempts: 5,
    lastAttempt: "Mar 1, 2026",
    callDuration: "-",
    status: "Not interested",
  },
  {
    id: 24,
    campaignId: 4,
    name: "Olivia Johnson",
    phone: "+1 613 987 4433",
    attempts: 2,
    lastAttempt: "Feb 26, 2026",
    callDuration: "1m 17s",
    status: "Sent SMS",
  },
  {
    id: 25,
    campaignId: 4,
    name: "Liam Brown",
    phone: "+1 204 556 7788",
    attempts: 9,
    lastAttempt: "Mar 2, 2026",
    callDuration: "-",
    status: "Do not call",
  },
];

export function getContactsByCampaignId(id: number): Contact[] {
  return contacts.filter((c) => c.campaignId === id);
}
