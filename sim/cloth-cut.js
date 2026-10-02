// Непрерывное согласование семейства сечений с нижней и верхней границами.
// Это геометрическая гипотеза кроя, а не закон деформации ткани.
// Сечения уже обязаны лежать на передней/задней кромках при u=0/1;
// крайние сечения и заданные границы имеют одни и те же углы.
export function matchedCutSurface(section, bottom, top) {
  const low = [0, 0, 0], high = [0, 0, 0], edge = [0, 0, 0];
  return (u, v, out) => {
    if (v === 0) return bottom(u, out);
    if (v === 1) return top(u, out);
    section(u, v, out);
    if (u === 0 || u === 1) return out;
    section(u, 0, low); section(u, 1, high);
    bottom(u, edge);
    for (let k = 0; k < 3; k++) out[k] += (1 - v) * (edge[k] - low[k]);
    top(u, edge);
    for (let k = 0; k < 3; k++) out[k] += v * (edge[k] - high[k]);
    return out;
  };
}
