import { useState } from "react";
import { Card } from "./components/Card";
import { Button } from "./components/Button";

const plans = [
  { name: "Starter", price: "$0", blurb: "For side projects." },
  { name: "Team", price: "$12", blurb: "For small teams." },
  { name: "Scale", price: "$49", blurb: "For growing orgs." },
];

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="mx-auto max-w-3xl p-8">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-emerald-400">Vite + React demo</h1>
        <Button onClick={() => setCount((c) => c + 1)}>clicked {count}</Button>
      </header>
      <p className="mb-6 text-slate-400">
        Hover anything: the badge shows the source location. Click to select,
        drag the handles or press <kbd>]</kbd> / <kbd>[</kbd> to nudge padding.
      </p>
      <section className="grid grid-cols-3 gap-4">
        {plans.map((plan) => (
          <Card key={plan.name} className="p-4">
            <h2 className="text-lg font-semibold">{plan.name}</h2>
            <p className="mt-1 text-3xl font-bold">{plan.price}</p>
            <p className="mt-2 text-sm text-slate-400">{plan.blurb}</p>
          </Card>
        ))}
      </section>
      <img src="/favicon.svg" alt="vite" className="mt-8 h-16 w-16 rounded bg-white p-2" />
    </main>
  );
}
