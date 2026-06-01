export type LegalSection = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
};

export type LegalDocument = {
  eyebrow: string;
  title: string;
  effectiveDate: string;
  company: string;
  contact: string;
  intro: string[];
  sections: LegalSection[];
};
