/** The shape the home-page example passes around. */
export interface Product {
  id: string;
  name: string;
  /** Trusted, pre-built markup — the example interpolates it raw. */
  blurb: string;
  price: number;
  tags: string[];
}
