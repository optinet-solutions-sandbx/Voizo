// Extract the region token from a Voizo campaign name.
//
// Convention: "L7_<REGION>_VOIZO_..." where <REGION> is a 2-3 letter country
// code (CA, AU, UAE, DE, IT, DK, GI, PH, ...). Legacy names ("L7_VOIZO_...")
// and ad-hoc names ("test campaign ...") have no region → null. Used by the
// Reviews list to filter/group campaigns by region.
export function campaignRegion(name: string): string | null {
  const m = /^l7_([a-z]{2,3})_/i.exec(name ?? "");
  return m ? m[1].toUpperCase() : null;
}
