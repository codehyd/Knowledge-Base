export function pickRecommended(
  models: { id: string; recommended?: boolean }[],
  fallback: string,
) {
  return models.find((m) => m.recommended)?.id ?? models[0]?.id ?? fallback;
}
