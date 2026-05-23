"use client";

import { useState } from "react";

export default function ClientWidget() {
  const [count, setCount] = useState(0);
  return (
    <div className="mt-8 rounded-lg border border-blue-500 p-4">
      <p className="text-blue-700">Client Component (count = {count})</p>
      <span className="text-xs text-blue-300">freshly added line</span>
      <button
        className="mt-2 rounded bg-blue-500 px-3 py-1 text-white"
        onClick={() => setCount((c) => c + 1)}
      >
        bump
      </button>
    </div>
  );
}
