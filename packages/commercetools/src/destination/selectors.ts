export type CommercetoolsResourceSelector =
  | {
      readonly id: string;
      readonly kind: "id";
    }
  | {
      readonly key: string;
      readonly kind: "key";
    };

export type CommercetoolsBusinessUnitSelector = CommercetoolsResourceSelector;

export type CommercetoolsCustomerSelector = CommercetoolsResourceSelector;

export type CommercetoolsProductSelector = CommercetoolsResourceSelector;
