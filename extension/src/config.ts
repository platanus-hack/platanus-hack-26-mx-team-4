// Hardcoded ranking weights (design section 5).
// w1 = rating weight (dominant trust signal)
// w2 = price-quality ratio weight (tie-breaker nudge)
// w3 = sponsored penalty (strong enough to sink an otherwise-top ad)

import type { RankConfig } from './ranking/types';

export const RANK_CONFIG: RankConfig = {
  w1: 0.6,
  w2: 0.3,
  w3: 0.4,
};
