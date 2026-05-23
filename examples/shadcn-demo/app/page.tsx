import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/topbar";
import { StatCards } from "@/components/stat-cards";
import { RecentSales } from "@/components/recent-sales";
import { OrdersTable } from "@/components/orders-table";

export default function DashboardPage() {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <TopBar />
        <main className="flex-1 p-6 space-y-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Welcome back. Here&apos;s what&apos;s happening across Acme this week.
            </p>
          </div>

          <StatCards />

          <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
            <div className="xl:col-span-2">
              <RecentSales />
            </div>
            <div className="xl:col-span-3">
              <OrdersTable />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
