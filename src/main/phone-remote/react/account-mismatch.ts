export function accountsDiffer(phone: string | null, mac: string | null): boolean {
  return phone !== null && mac !== null && phone !== mac
}
