function normalizeVietnameseText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(chi|anh|co|chu|bac|em|khach|lay|mua|them|voi|va|roi|cho)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTextMatch(input, target) {
  const a = normalizeVietnameseText(input);
  const b = normalizeVietnameseText(target);

  if (!a || !b) return 0;
  if (a === b) return 100;
  if (b.includes(a)) return 90;
  if (a.includes(b)) return 80;

  const aParts = a.split(' ').filter(Boolean);
  const bParts = b.split(' ').filter(Boolean);

  let score = 0;
  for (const part of aParts) {
    if (bParts.includes(part)) score += 20;
    else if (b.includes(part)) score += 10;
  }

  return score;
}

function findBestMatch(input, candidates, getText, minScore = 20) {
  let best = null;

  for (const candidate of candidates || []) {
    const score = scoreTextMatch(input, getText(candidate));

    if (!best || score > best.score) {
      best = {
        item: candidate,
        score
      };
    }
  }

  if (!best || best.score < minScore) {
    return null;
  }

  return best;
}

module.exports = {
  normalizeVietnameseText,
  scoreTextMatch,
  findBestMatch
};
