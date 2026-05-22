// Maximum phone candidates a single audience operation (carve segment,
// duplicate campaign) will materialize before refusing. Shared between
// /api/audience/segments and /api/campaigns-v2/[id]/duplicate so both
// paths enforce the same ceiling.
export const MAX_CANDIDATES = 5000;
