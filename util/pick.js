export default function pick(object, properties) {
  const source = object && typeof object === "object" ? object : {};
  const allowed = new Set(properties || []);
  return Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key)));
}
