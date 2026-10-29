import * as THREE from 'three';
export function diceHull(sides: number) {
  let geometry: THREE.BufferGeometry;
  if (sides === 4) geometry = new THREE.TetrahedronGeometry(0.64);
  else if (sides === 6) geometry = new THREE.BoxGeometry(0.82, 0.82, 0.82);
  else if (sides === 8) geometry = new THREE.OctahedronGeometry(0.65);
  else if (sides === 12) geometry = new THREE.DodecahedronGeometry(0.62);
  else if (sides === 20) geometry = new THREE.IcosahedronGeometry(0.64);
  else {
    // Equal-faced pentagonal bipyramid, ten numbered faces.
    const vertices = [0, 0.68, 0, 0, -0.68, 0];
    for (let i = 0; i < 5; i++) vertices.push(Math.cos(i * Math.PI * 2 / 5) * .62, 0, Math.sin(i * Math.PI * 2 / 5) * .62);
    const indices: number[] = [];
    for (let i = 0; i < 5; i++) { const a = i + 2, b = (i + 1) % 5 + 2; indices.push(0, b, a, 1, a, b); }
    geometry = new THREE.PolyhedronGeometry(vertices, indices, .64, 0);
  }
  const flat = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const positions = flat.getAttribute('position'), vertices: THREE.Vector3[] = [], groups = new Map<string, { normal: THREE.Vector3; ids: Set<number> }>();
  for (let i = 0; i < positions.count; i += 3) {
    const triangle = [0,1,2].map(offset => new THREE.Vector3().fromBufferAttribute(positions, i + offset));
    const normal = triangle[1].clone().sub(triangle[0]).cross(triangle[2].clone().sub(triangle[0])).normalize();
    const center = triangle[0].clone().add(triangle[1]).add(triangle[2]).multiplyScalar(1/3);
    if (normal.dot(center) < 0) normal.negate();
    const key = [normal.x, normal.y, normal.z].map(v => Math.round(v * 1000)).join(':');
    const group = groups.get(key) ?? { normal, ids: new Set<number>() }; groups.set(key, group);
    for (const p of triangle) { let id = vertices.findIndex(v => v.distanceToSquared(p) < 1e-8); if (id < 0) { id = vertices.length; vertices.push(p); } group.ids.add(id); }
  }
  const faces = [...groups.values()].map(({ normal, ids }) => {
    const list = [...ids], center = list.reduce((p, id) => p.add(vertices[id]), new THREE.Vector3()).multiplyScalar(1/list.length);
    const u = vertices[list[0]].clone().sub(center).normalize(), v = normal.clone().cross(u);
    list.sort((a,b) => { const pa=vertices[a].clone().sub(center), pb=vertices[b].clone().sub(center); return Math.atan2(pa.dot(v),pa.dot(u))-Math.atan2(pb.dot(v),pb.dot(u)); });
    return { ids: list, normal, center };
  });
  geometry.dispose(); flat.dispose();
  return { vertices, faces };
}
