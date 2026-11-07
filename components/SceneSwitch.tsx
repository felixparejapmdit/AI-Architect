"use client";

import { Building2, Sofa } from "lucide-react";
import { setScene, useScene } from "@/lib/store";
import type { Scene } from "@/lib/types";
import { cx } from "./ui";

const SCENES: { id: Scene; label: string; icon: typeof Sofa }[] = [
  { id: "interior", label: "Interior", icon: Sofa },
  { id: "exterior", label: "Exterior", icon: Building2 },
];

/** Interior rooms or building exteriors: changes the layers, Auto-detect, materials, styles and costing. */
export function SceneSwitch({ className }: { className?: string }) {
  const scene = useScene();
  return (
    <div className={cx("grid grid-cols-2 gap-0.5 rounded-lg bg-paper p-0.5", className)} role="radiogroup" aria-label="Scene">
      {SCENES.map((s) => (
        <button
          key={s.id}
          role="radio"
          aria-checked={scene === s.id}
          onClick={() => setScene(s.id)}
          className={cx("flex h-7 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition", scene === s.id ? "bg-white text-ink shadow-sm" : "text-mute hover:text-ink")}
        >
          <s.icon size={13} /> {s.label}
        </button>
      ))}
    </div>
  );
}
