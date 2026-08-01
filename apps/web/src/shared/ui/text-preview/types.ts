export type PreviewSegment = {
  text: string;
  char_count: number;
  offset: number;
  truncated: boolean;
};

export type PreviewSearchHit = {
  offset: number;
  length: number;
  snippet: string;
};

export type PreviewSearchPage = {
  total: number;
  offset: number;
  hits: PreviewSearchHit[];
};
