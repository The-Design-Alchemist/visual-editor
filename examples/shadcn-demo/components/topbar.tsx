import { Search, Bell } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export function TopBar() {
  return (
    <header className="flex h-16 items-center gap-4 border-b border-border bg-card/40 px-6 backdrop-blur">
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search orders, customers, products..."
          className="pl-10"
        />
      </div>
      <button
        type="button"
        className="relative flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card hover:bg-secondary/60 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        <span className="absolute top-1.5 right-2 h-2 w-2 rounded-full bg-primary" />
      </button>
      <Avatar className="h-9 w-9">
        <AvatarFallback className="text-xs bg-primary text-primary-foreground">
          AJ
        </AvatarFallback>
      </Avatar>
    </header>
  );
}
