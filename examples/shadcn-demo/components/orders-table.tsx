import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { orders, type Order } from "@/lib/mock-data";

function statusVariant(status: Order["status"]): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "Paid":
      return "default";
    case "Pending":
      return "secondary";
    case "Refunded":
      return "destructive";
  }
}

export function OrdersTable() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Orders</CardTitle>
        <CardDescription>
          The latest transactions across the platform.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((order) => (
              <TableRow key={order.id}>
                <TableCell className="font-medium font-mono text-xs">
                  {order.id}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="text-sm">{order.customer}</span>
                    <span className="text-xs text-muted-foreground">
                      {order.email}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(order.status)}>
                    {order.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {order.amount}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {order.date}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
