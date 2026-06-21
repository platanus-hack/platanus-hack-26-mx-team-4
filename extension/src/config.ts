// Default ranking weights (design + spec: Pure quality index v2).
//   w1     = shrunk-rating weight (dominant trust signal)
//   w2     = price-quality ratio weight
//   w3     = sponsored penalty (strong enough to sink an otherwise-top ad)
//   w4     = log-sold volume weight
//   priorC = Bayesian shrinkage prior (confidence in the page mean)
//   w5     = free-shipping boost ("Envío gratis")
//   w6     = Mercado Envíos Full boost (fast fulfillment)
//   w7     = real-discount boost (fraction off a struck previous price)
//
// With priorC = 0 and w4 = 0 the score reduces to the v1 formula
// (w1*ratingNorm + w2*priceNorm - w3*sponsoredPenalty).
//
// w5/w6/w7 are kept MODEST so the convenience signals (free shipping, Full,
// discount) nudge ties and near-ties without overriding the dominant rating /
// price / volume signals.

import type { RankConfig } from './ranking/types';

export const RANK_CONFIG: RankConfig = {
  w1: 0.6,
  w2: 0.3,
  w3: 0.4,
  w4: 0.3,
  priorC: 5,
  w5: 0.15,
  w6: 0.15,
  w7: 0.1,
};
