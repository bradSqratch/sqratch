"use client";

import { useTheme } from "next-themes";
import { useReducedMotion } from "framer-motion";

const cubes = [
  { asset: "pearl", position: "large", transform: "scale(1.1) rotate(8deg)" },
  { asset: "opal", position: "small", transform: "scale(.48) scaleX(-1) rotate(-16deg)" },
  { asset: "opal", position: "lower", transform: "scale(.75) rotate(14deg)" },
  { asset: "pearl", position: "right-mid", transform: "scale(.3) scaleX(-1) rotate(22deg)" },
  { asset: "opal", position: "right-low", transform: "scale(.23) rotate(-24deg)" },
  { asset: "pearl", position: "bottom", transform: "scale(.2) scaleY(-1) rotate(12deg)" },
  { asset: "opal", position: "left-mid", transform: "scale(.22) rotate(-12deg)" },
];

export function LightHeroCubes() {
  const { resolvedTheme } = useTheme();
  const reducedMotion = useReducedMotion();
  if (resolvedTheme !== "light") return null;

  return (
    <div className="light-hero-cubes" aria-hidden="true">
      {cubes.map(({ asset, position, transform }) => (
        <div key={position} className={`light-hero-cube light-hero-cube-${position}`} style={{ transform }}>
          {reducedMotion ? (
            // Decorative generated artwork; keep the transparent poster still.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/assets/homepage/light-cube-${asset}.png`} alt="" />
          ) : (
            <video autoPlay loop muted playsInline poster={`/assets/homepage/light-cube-${asset}.png`}>
              <source src={`/assets/homepage/light-cube-${asset}.webm`} type="video/webm" />
            </video>
          )}
        </div>
      ))}
    </div>
  );
}
