export type LegalBlock =
  | {
      type: "paragraph";
      text: string;
    }
  | {
      type: "subheading";
      text: string;
    }
  | {
      type: "bullets";
      items: string[];
      code?: boolean;
    }
  | {
      type: "contact";
      lines: string[];
    }
  | {
      type: "definitions";
      items: Array<{
        term: string;
        description: string;
      }>;
    };

export type LegalSection = {
  title: string;
  blocks?: LegalBlock[];
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
