import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { EnrichedSelection, Pin } from "./types.ts";

/**
 * Pins are selections the user annotated for their agent ("the gap here
 * is too tight"). They outlive the current selection, survive dev-server
 * restarts (persisted next to history.json), and carry a status the agent
 * flips to "resolved" when it has handled them.
 */
export class PinStore {
  private pins: Pin[] = [];
  private filePath: string | null = null;

  constructor(private readonly maxSize = 100) {}

  async load(filePath: string): Promise<void> {
    this.filePath = filePath;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as { pins?: Pin[] };
      if (Array.isArray(parsed.pins)) {
        this.pins = parsed.pins.filter(isPin).slice(-this.maxSize);
      }
    } catch {
      /* missing / unreadable → start empty */
    }
  }

  list(): readonly Pin[] {
    return this.pins;
  }

  get(id: string): Pin | null {
    return this.pins.find((p) => p.id === id) ?? null;
  }

  add(selection: EnrichedSelection, note: string): Pin {
    const pin: Pin = {
      id: randomBytes(4).toString("hex"),
      createdAt: Date.now(),
      status: "open",
      note,
      selection,
    };
    this.pins.push(pin);
    if (this.pins.length > this.maxSize) this.pins.shift();
    void this.persistNow();
    return pin;
  }

  resolve(id: string, resolution?: string): Pin | null {
    const pin = this.get(id);
    if (!pin) return null;
    pin.status = "resolved";
    pin.resolvedAt = Date.now();
    if (resolution) pin.resolution = resolution;
    void this.persistNow();
    return pin;
  }

  remove(id: string): boolean {
    const idx = this.pins.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.pins.splice(idx, 1);
    void this.persistNow();
    return true;
  }

  clear(onlyResolved = false): number {
    const before = this.pins.length;
    this.pins = onlyResolved ? this.pins.filter((p) => p.status !== "resolved") : [];
    void this.persistNow();
    return before - this.pins.length;
  }

  async persistNow(): Promise<void> {
    if (!this.filePath) return;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(
        this.filePath,
        JSON.stringify({ pins: this.pins, savedAt: Date.now() }, null, 2),
        "utf8",
      );
    } catch {
      /* best-effort persistence */
    }
  }
}

function isPin(x: unknown): x is Pin {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.createdAt === "number" &&
    (o.status === "open" || o.status === "resolved") &&
    typeof o.note === "string" &&
    !!o.selection &&
    typeof o.selection === "object"
  );
}
