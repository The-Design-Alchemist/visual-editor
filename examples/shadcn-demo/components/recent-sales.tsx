import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { recentSales } from "@/lib/mock-data";

export function RecentSales() {
  return (
    <Card className="col-span-1 xl:col-span-3">
      <CardHeader>
        <CardTitle>Recent Sales</CardTitle>
        <CardDescription>You made 265 sales this month.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {recentSales.map((sale) => (
          <div key={sale.email} className="flex items-center gap-4">
            <Avatar className="h-9 w-9">
              <AvatarFallback className="text-xs bg-secondary text-secondary-foreground">
                {sale.initials}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium leading-none truncate">
                {sale.name}
              </p>
              <p className="text-sm text-muted-foreground truncate mt-1">
                {sale.email}
              </p>
            </div>
            <div className="text-sm font-medium tabular-nums">
              {sale.amount}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
