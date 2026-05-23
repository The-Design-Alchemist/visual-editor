export type Stat = {
  label: string;
  value: string;
  delta: string;
  trend: "up" | "down";
  hint: string;
};

export const stats: Stat[] = [
  {
    label: "Revenue",
    value: "$45,231.89",
    delta: "+20.1%",
    trend: "up",
    hint: "vs last month",
  },
  {
    label: "Subscriptions",
    value: "+2,350",
    delta: "+180.1%",
    trend: "up",
    hint: "vs last month",
  },
  {
    label: "Sales",
    value: "+12,234",
    delta: "+19%",
    trend: "up",
    hint: "vs last month",
  },
  {
    label: "Active Now",
    value: "+573",
    delta: "+201",
    trend: "up",
    hint: "since last hour",
  },
];

export type RecentSale = {
  name: string;
  email: string;
  amount: string;
  initials: string;
};

export const recentSales: RecentSale[] = [
  {
    name: "Olivia Martin",
    email: "olivia.martin@email.com",
    amount: "+$1,999.00",
    initials: "OM",
  },
  {
    name: "Jackson Lee",
    email: "jackson.lee@email.com",
    amount: "+$39.00",
    initials: "JL",
  },
  {
    name: "Isabella Nguyen",
    email: "isabella.nguyen@email.com",
    amount: "+$299.00",
    initials: "IN",
  },
  {
    name: "William Kim",
    email: "will@email.com",
    amount: "+$99.00",
    initials: "WK",
  },
  {
    name: "Sofia Davis",
    email: "sofia.davis@email.com",
    amount: "+$39.00",
    initials: "SD",
  },
];

export type Order = {
  id: string;
  customer: string;
  email: string;
  status: "Paid" | "Pending" | "Refunded";
  amount: string;
  date: string;
};

export const orders: Order[] = [
  {
    id: "ORD-2046",
    customer: "Liam Brennan",
    email: "liam@brennan.co",
    status: "Paid",
    amount: "$324.00",
    date: "2026-05-23",
  },
  {
    id: "ORD-2045",
    customer: "Ava Patel",
    email: "ava@patel.dev",
    status: "Pending",
    amount: "$1,210.00",
    date: "2026-05-23",
  },
  {
    id: "ORD-2044",
    customer: "Noah Tanaka",
    email: "noah@tanaka.io",
    status: "Paid",
    amount: "$58.00",
    date: "2026-05-22",
  },
  {
    id: "ORD-2043",
    customer: "Mia Rodriguez",
    email: "mia@rod.co",
    status: "Refunded",
    amount: "$420.00",
    date: "2026-05-22",
  },
  {
    id: "ORD-2042",
    customer: "Ethan Walker",
    email: "ethan@walker.studio",
    status: "Paid",
    amount: "$76.50",
    date: "2026-05-21",
  },
  {
    id: "ORD-2041",
    customer: "Zoe Sullivan",
    email: "zoe@sullivan.work",
    status: "Paid",
    amount: "$899.00",
    date: "2026-05-21",
  },
];
