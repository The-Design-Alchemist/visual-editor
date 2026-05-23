import Link from "next/link";
import {
  LayoutDashboard,
  BarChart3,
  Users,
  Package,
  Settings,
  Sparkles,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

const navItems = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/", active: true },
  { label: "Analytics", icon: BarChart3, href: "#" },
  { label: "Customers", icon: Users, href: "#" },
  { label: "Products", icon: Package, href: "#" },
  { label: "Settings", icon: Settings, href: "#" },
];

export function Sidebar() {
  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-border bg-card">
      <div className="flex items-center gap-2 px-6 py-5 border-b border-border">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Sparkles className="h-4 w-4" />
        </div>
        <span className="font-semibold tracking-tight">Acme Inc.</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.label}
              href={item.href}
              className={
                item.active
                  ? "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium bg-secondary text-secondary-foreground"
                  : "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
              }
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-3">
        <div className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-secondary/60 transition-colors">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="text-xs bg-primary text-primary-foreground">
              AJ
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">Aaqil Jamal</p>
            <p className="text-xs text-muted-foreground truncate">
              aaqil@acme.co
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}
