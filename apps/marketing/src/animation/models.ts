type Point = [number, number, number];

const TAU = Math.PI * 2;

function line(points: Point[], start: Point, end: Point, density = 48) {
  const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
  const steps = Math.max(2, Math.ceil(length * density));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push([
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t,
      start[2] + (end[2] - start[2]) * t,
    ]);
  }
}

function frame(points: Point[], center: Point, width: number, height: number) {
  const [x, y, z] = center;
  const corners: Point[] = [
    [x - width / 2, y - height / 2, z],
    [x + width / 2, y - height / 2, z],
    [x + width / 2, y + height / 2, z],
    [x - width / 2, y + height / 2, z],
  ];
  corners.forEach((corner, i) => {
    line(points, corner, corners[(i + 1) % 4]);
  });
}

function tube(points: Point[], start: Point, end: Point, radius: number, endRadius = radius) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const dz = end[2] - start[2];
  const length = Math.hypot(dx, dy, dz);
  const axis: Point = [dx / length, dy / length, dz / length];
  const normalLength = Math.hypot(axis[0], axis[1]);
  const u: Point =
    normalLength > 0.001 ? [-axis[1] / normalLength, axis[0] / normalLength, 0] : [1, 0, 0];
  const v: Point = [
    axis[1] * u[2] - axis[2] * u[1],
    axis[2] * u[0] - axis[0] * u[2],
    axis[0] * u[1] - axis[1] * u[0],
  ];
  const rings = Math.max(2, Math.ceil(length * 15));
  const around = Math.max(32, Math.ceil(Math.max(radius, endRadius) * 180));
  for (let ring = 0; ring <= rings; ring++) {
    const t = ring / rings;
    const r = radius + (endRadius - radius) * t;
    for (let i = 0; i < around; i++) {
      const a = (i / around) * TAU;
      const c = Math.cos(a) * r;
      const s = Math.sin(a) * r;
      points.push([
        start[0] + dx * t + u[0] * c + v[0] * s,
        start[1] + dy * t + u[1] * c + v[1] * s,
        start[2] + dz * t + u[2] * c + v[2] * s,
      ]);
    }
  }
}

function code(points: Point[], origin: Point, width: number, rows: number, scale = 1) {
  const [x, y, z] = origin;
  for (let row = 0; row < rows; row++) {
    const indent = ((row * 7) % 4) * 0.21 * scale;
    const tokens = 3 + ((row * 13) % 5);
    let cursor = x + indent;
    for (let token = 0; token < tokens; token++) {
      const tokenWidth = (0.15 + ((row * 7 + token * 3) % 8) * 0.065) * scale;
      if (cursor + tokenWidth > x + width) break;
      line(
        points,
        [cursor, y - row * 0.19 * scale, z],
        [cursor + tokenWidth, y - row * 0.19 * scale, z],
        36,
      );
      if ((row + token) % 3 === 0) {
        line(
          points,
          [cursor, y - row * 0.19 * scale, z],
          [cursor, y - row * 0.19 * scale + 0.065 * scale, z],
          30,
        );
      }
      cursor += tokenWidth + 0.13 * scale;
    }
  }
}

function monitor(points: Point[], origin: Point, scale = 1) {
  const [x, y, z] = origin;
  for (const depth of [0, -0.18]) {
    frame(points, [x, y + 0.6 * scale, z + depth * scale], 5.3 * scale, 3.3 * scale);
    frame(points, [x, y + 0.65 * scale, z + depth * scale], 5 * scale, 2.92 * scale);
  }
  line(points, [x - 2.5 * scale, y + 1.68 * scale, z], [x + 2.5 * scale, y + 1.68 * scale, z]);
  code(points, [x - 2.2 * scale, y + 1.4 * scale, z], 4.4 * scale, 12, scale);
  tube(points, [x, y - 1.05 * scale, z - 0.12 * scale], [x, y - 2 * scale, z], 0.12 * scale);
  for (let i = 0; i < 5; i++)
    frame(points, [x, y - 2 * scale + i * 0.02, z + i * 0.05], 1.9 * scale, 0.15 * scale);
  for (let row = 0; row < 5; row++) {
    for (let key = 0; key < 14; key++) {
      const kx = x + (key - 6.5) * 0.31 * scale;
      const kz = z + (1.3 + row * 0.21) * scale;
      const ky = y - 2.3 * scale;
      const size = 0.12 * scale;
      line(points, [kx - size, ky, kz - size], [kx + size, ky, kz - size]);
      line(points, [kx + size, ky, kz - size], [kx + size, ky, kz + size]);
      line(points, [kx + size, ky, kz + size], [kx - size, ky, kz + size]);
      line(points, [kx - size, ky, kz + size], [kx - size, ky, kz - size]);
    }
  }
  for (let ring = 0; ring < 12; ring++) {
    const a = ((ring / 12) * Math.PI) / 2;
    for (let i = 0; i < 90; i++) {
      const t = (i / 90) * TAU;
      points.push([
        x + (3.1 + Math.cos(t) * Math.cos(a) * 0.35) * scale,
        y + (-2.3 + Math.sin(a) * 0.28) * scale,
        z + (1.7 + Math.sin(t) * Math.cos(a) * 0.62) * scale,
      ]);
    }
  }
}

function codeScene() {
  const points: Point[] = [];
  for (let plane = 0; plane < 7; plane++) {
    const x = -7.2 + (plane % 3) * 5;
    const y = 3.9 - Math.floor(plane / 3) * 3.1;
    const z = -3 + (plane % 4) * 1.45;
    code(points, [x, y, z], 4.3, 14, 1.2);
    frame(points, [x + 2.1, y - 1.5, z], 4.6, 3.6);
  }
  return points;
}

function telescopeScene() {
  const points: Point[] = [];
  tube(points, [-2.9, 0.4, 0], [2.4, 2.2, 0], 0.47, 0.94);
  tube(points, [2.15, 2.11, 0], [2.65, 2.28, 0], 1.04);
  tube(points, [-3.6, 0.16, 0], [-2.8, 0.43, 0], 0.3);
  tube(points, [-3.8, 0.1, 0], [-3.55, 0.18, 0], 0.4);
  for (const t of [0.22, 0.49, 0.73]) {
    const x = -2.9 + 5.3 * t;
    const y = 0.4 + 1.8 * t;
    tube(points, [x, y, 0], [x + 0.12, y + 0.04, 0], 0.5 + 0.47 * t);
  }
  tube(points, [-0.4, 0.95, 0], [-0.4, -0.8, 0], 0.2);
  for (const end of [
    [-2.5, -3.5, 1.1],
    [1.8, -3.5, 1.1],
    [-0.3, -3.1, -1.8],
  ] satisfies Point[]) {
    tube(points, [-0.4, -0.65, 0], end, 0.065);
  }
  return points;
}

function councilScene() {
  const points: Point[] = [];
  tube(points, [-0.5, -1.1, 0], [1.4, 1.75, 0], 0.19, 0.25);
  tube(points, [0.55, 2.3, 0], [2.55, 0.97, 0], 0.65);
  tube(points, [0.35, 2.44, 0], [0.75, 2.17, 0], 0.78);
  tube(points, [2.36, 1.1, 0], [2.76, 0.83, 0], 0.78);
  tube(points, [-0.9, -2.7, 0], [-0.9, -2.25, 0], 1.55);
  tube(points, [-0.9, -2.77, 0], [-0.9, -2.62, 0], 1.72);
  for (let r = 0.05; r < 1.55; r += 0.08) tube(points, [-0.9, -2.25, 0], [-0.9, -2.24, 0], r);
  for (const side of [-1, 1]) {
    for (let strand = 0; strand < 4; strand++) {
      for (let i = 0; i < 520; i++) {
        const a = -1.1 + (i / 520) * 2.2;
        const r = 4.1 + strand * 0.13;
        points.push([side * Math.cos(a) * r, Math.sin(a) * 3.5, -1.8 + strand * 0.1]);
      }
    }
  }
  return points;
}

function networkScene() {
  const points: Point[] = [];
  monitor(points, [-3.2, 0.2, 0.5], 0.74);
  monitor(points, [3.3, -0.4, -0.8], 0.57);
  const nodes: Point[] = [
    [0, 2.9, 0],
    [-2.7, 3.7, -1],
    [2.8, 3.5, -1],
    [0.6, 0.3, 0],
    [0.4, -2.8, 0],
    [3.1, -3.3, -1],
  ];
  for (const [index, center] of nodes.entries()) {
    tube(
      points,
      [center[0], center[1] - 0.13, center[2]],
      [center[0], center[1] + 0.13, center[2]],
      0.24,
    );
    if (index > 0) line(points, nodes[Math.floor((index - 1) / 2)], center, 100);
  }
  line(points, [-3.2, 2.3, 0.5], nodes[1], 100);
  line(points, [3.3, 1.2, -0.8], nodes[2], 100);
  return points;
}

function sphereScene(count: number) {
  const points: Point[] = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const a = i * Math.PI * (3 - Math.sqrt(5));
    const radial = Math.sqrt(1 - y * y);
    const nx = Math.cos(a) * radial;
    const nz = Math.sin(a) * radial;
    const poleAngle = Math.acos(Math.max(-1, Math.min(1, nx * 0.35 + y * 0.88 + nz * 0.32)));
    const wave = 0.5 + 0.5 * Math.sin(poleAngle * 28 - 0.6);
    const ridge = 1 - 2 * (1 - wave) ** 2.2;
    const envelope =
      Math.min(1, poleAngle / 0.32) *
      (0.3 + 0.7 * Math.max(0, Math.min(1, (Math.PI - poleAngle) / (Math.PI - 0.7))));
    const radius = 3.45 * (1 + 0.075 * ridge * envelope);
    points.push([nx * radius, y * radius, nz * radius]);
  }
  return points;
}

function resample(points: Point[], count: number) {
  // Shared spatial ordering keeps nearby particles together during the morph.
  points.sort((a, b) => Math.floor(a[1] * 8) - Math.floor(b[1] * 8) || a[0] - b[0] || a[2] - b[2]);
  const output = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const point = points[Math.floor((i * points.length) / count)];
    output.set(point, i * 3);
  }
  return output;
}

export function createModels(count: number): Float32Array[] {
  const workstation: Point[] = [];
  monitor(workstation, [0, 0.6, 0]);
  return [
    codeScene(),
    workstation,
    telescopeScene(),
    councilScene(),
    networkScene(),
    sphereScene(count),
  ].map((points) => resample(points, count));
}
