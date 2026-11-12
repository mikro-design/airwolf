export function touchDissection(recent: Set<number>, id: number, capacity = 32) {
  recent.delete(id);
  recent.add(id);
  while (recent.size > capacity) recent.delete(recent.values().next().value!);
}
