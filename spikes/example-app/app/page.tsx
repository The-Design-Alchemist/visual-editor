import ClientWidget from "./components/ClientWidget";
import CssModuleCard from "./components/CssModuleCard";
import StyledCard from "./components/StyledCard";
import { cn } from "./lib/cn";

export default function Home() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold text-green-700">
        Server Component heading
      </h1>
      <p className="mt-2">This paragraph is server-rendered.</p>
      <ClientWidget />
      <div className="mt-8 w-32 h-16 p-4 m-4 bg-amber-300 border border-amber-600 rounded flex items-center justify-center text-amber-900 text-sm font-medium">
        drag or nudge
      </div>
      <ul className="mt-6 flex gap-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <li
            key={n}
            className="w-12 h-12 p-2 bg-sky-200 border border-sky-500 rounded flex items-center justify-center text-sky-900 text-sm font-semibold"
          >
            {n}
          </li>
        ))}
      </ul>
      <div
        className={cn(
          "mt-6 w-40 h-20 p-4 bg-rose-200 border border-rose-500",
          "rounded flex items-center justify-center text-rose-900 text-sm font-medium",
        )}
      >
        cn-wrapped
      </div>
      <img
        src="/next.svg"
        alt="next logo"
        className="mt-6 w-32 h-32 bg-white p-4 rounded"
      />
      <CssModuleCard />
      <StyledCard />
    </main>
  );
}
