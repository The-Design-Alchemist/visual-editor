import { TrendingUp, DollarSign, Users, ShoppingCart, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { stats } from "@/lib/mock-data";

const iconByLabel: Record<string, typeof DollarSign> = {
  Revenue: DollarSign,
  Subscriptions: Users,
  Sales: ShoppingCart,
  "Active Now": Activity,
};

export function StatCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {stats.map((stat) => {
        const Icon = iconByLabel[stat.label] ?? DollarSign;
        return (
          <Card key={stat.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.label}
              </CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tracking-tight p-1">{stat.value}</div>
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-emerald-500" />
                <span className="font-medium text-emerald-600 dark:text-emerald-400">
                  {stat.delta}
                </span>
                <span>{stat.hint}</span>
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
