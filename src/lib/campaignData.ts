export type Status = "Completed" | "Stopped" | "Active" | "Paused";
export type Group = string;

export interface Campaign {
  id: number;
  name: string;
  totalContacts: number;
  totalCalls: number;
  connectRate: string;
  connectCount: number;
  successRate: string;
  successCount: number;
  status: Status;
  group: Group;
}

export const initialCampaigns: Campaign[] = [
  {
    id: 1,
    name: "Lucky7even REACTIVATION offer to 300% deposit",
    totalContacts: 317,
    totalCalls: 2940,
    connectRate: "11.36%",
    connectCount: 36,
    successRate: "38.89%",
    successCount: 14,
    status: "Completed",
    group: "Reactivation",
  },
  {
    id: 2,
    name: "Lucky7even RND Calls v2 German",
    totalContacts: 1028,
    totalCalls: 54,
    connectRate: "0%",
    connectCount: 0,
    successRate: "0%",
    successCount: 0,
    status: "Stopped",
    group: "RND",
  },
  {
    id: 3,
    name: "Lucky7even RND Calls v2 Italian",
    totalContacts: 187,
    totalCalls: 531,
    connectRate: "19.79%",
    connectCount: 37,
    successRate: "18.92%",
    successCount: 7,
    status: "Stopped",
    group: "RND",
  },
  {
    id: 4,
    name: "Lucky7even RND Calls v2 (Sign Up Date)",
    totalContacts: 432,
    totalCalls: 4300,
    connectRate: "0.93%",
    connectCount: 4,
    successRate: "0%",
    successCount: 0,
    status: "Stopped",
    group: "RND",
  },
  {
    id: 5,
    name: "Lucky7even RND Calls v2 - Canada",
    totalContacts: 331,
    totalCalls: 2682,
    connectRate: "27.19%",
    connectCount: 90,
    successRate: "16.67%",
    successCount: 15,
    status: "Stopped",
    group: "Canada",
  },
  {
    id: 6,
    name: "Lucky7even RND Calls v2 - Canada (1-15)",
    totalContacts: 373,
    totalCalls: 2852,
    connectRate: "33.51%",
    connectCount: 125,
    successRate: "28.00%",
    successCount: 35,
    status: "Stopped",
    group: "Canada",
  },
  {
    id: 7,
    name: "Lucky7even RND Calls v2 - Canada (15-90)",
    totalContacts: 1294,
    totalCalls: 10112,
    connectRate: "26.04%",
    connectCount: 337,
    successRate: "31.45%",
    successCount: 106,
    status: "Stopped",
    group: "Canada",
  },
  {
    id: 8,
    name: "Lucky7even RND Calls v2 - Canada (17-23)",
    totalContacts: 209,
    totalCalls: 1545,
    connectRate: "27.27%",
    connectCount: 57,
    successRate: "42.11%",
    successCount: 24,
    status: "Stopped",
    group: "Canada",
  },
  {
    id: 9,
    name: "Lucky7even Legacy Promo - Q4",
    totalContacts: 512,
    totalCalls: 3210,
    connectRate: "21.50%",
    connectCount: 69,
    successRate: "14.49%",
    successCount: 10,
    status: "Paused",
    group: "Archived",
  },
  {
    id: 10,
    name: "Lucky7even Welcome Bonus v1",
    totalContacts: 391,
    totalCalls: 1699,
    connectRate: "15.24%",
    connectCount: 26,
    successRate: "11.54%",
    successCount: 3,
    status: "Paused",
    group: "Archived",
  },
];
