"use client";

import { Grid } from "@react-three/drei";

export default function GridFloor() {
  return (
    <Grid
      args={[40, 40]}
      position={[0, 0, 0]}
      cellSize={1.5}
      cellThickness={0.5}
      cellColor="#123a5c"
      sectionSize={6}
      sectionThickness={1.05}
      sectionColor="#1f4a80"
      infiniteGrid
      fadeDistance={70}
      fadeStrength={1.15}
      fadeFrom={1}
    />
  );
}
